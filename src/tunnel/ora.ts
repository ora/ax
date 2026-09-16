import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import {
	type HeaderMap,
	type ISocket,
	type LocalForwarder,
	type LocalRequest,
	type LocalResponse,
	TunnelConnector,
	V1Codec,
} from "@ora-ai/tunnel-protocol";
import pkg from "../../package.json";
import { exchangeKey, platformBase } from "../api/platform";
import { type Tunnel, TunnelError, waitRoutable } from "../tunnel";

// ora's own reverse tunnel (`ax audit --tunnel ora`): create a tunnel row on
// the platform API, dial its WebSocket data plane, forward every proxied
// request to the local server, audit the public hostname, delete the row.
//
// This is protocol code, not a vendor: @ora-ai/tunnel-protocol is the wire
// format ora's tunnel service speaks (zod only, bundled into the bin), the
// transport is Node's built-in WebSocket, and nothing is downloaded at
// runtime. The tunnel is created `public` because ora's scanner cannot yet
// present a per-tunnel credential; the hostname is an unguessable UUID that
// stops answering the moment the row is deleted.

export interface OraTunnelOptions {
	/** The ora_sk_ platform key; falls back to $ORA_API_KEY. */
	apiKey?: string;
	/** Platform API base; falls back to $ORA_PLATFORM_URL, then production. */
	platformUrl?: string;
	/** How long to wait for the public hostname to route (default 90s). */
	routableMs?: number;
	/** Spacing between routability probes (default 5s; tests shorten it). */
	probeEveryMs?: number;
	/**
	 * Interrupts setup (Ctrl-C while creating, dialing, or waiting for the
	 * edge): whatever was created so far is deleted before the rejection.
	 */
	signal?: AbortSignal;
}

/** The scopes the platform key needs, quoted in every credential error. */
export const ORA_TUNNEL_SCOPES = "tunnels:write + tunnels:connect";

export const MISSING_KEY_HINT = [
	`--tunnel ora needs ORA_API_KEY: an ora platform key (ora_sk_...) with the ${ORA_TUNNEL_SCOPES} scopes.`,
	"Create one at https://agentfront.sh (API keys), export it or put it in a local .env,",
	"or bring your own tunnel instead: --tunnel-cmd 'ngrok http 3000 --log stdout'",
].join("\n");

const WS_OPEN = 1;
const MAX_STREAMS = 32;

interface CreatedTunnel {
	id: string;
	publicUrl: string;
	connection: { kind: string; url: string; subprotocol: string };
}

/** What POST /tunnels/v1 answered: only `id` is trusted before validation. */
type CreateResponse = { id: string } & Partial<Omit<CreatedTunnel, "id">> & {
		connection?: Partial<CreatedTunnel["connection"]>;
	};

const interrupted = () => new TunnelError("interrupted before the tunnel was ready");

/** `localhost:3000` -> 127.0.0.1:3000; plain http only, port 80 when absent. */
export function parseLocalTarget(target: string): { host: string; port: number } {
	let url: URL;
	try {
		url = new URL(target.includes("://") ? target : `http://${target}`);
	} catch {
		throw new TunnelError(`not a local target: ${JSON.stringify(target)}`);
	}
	if (url.protocol !== "http:") {
		throw new TunnelError(
			`--tunnel ora forwards plain http only; ${url.protocol}// targets are not supported`,
		);
	}
	// The connector binds to an address, not a name: "localhost" resolves to
	// ::1 first on some machines while the dev server listens on IPv4 only.
	const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
	const host = hostname === "localhost" ? "127.0.0.1" : hostname;
	const port = url.port ? Number(url.port) : 80;
	return { host, port };
}

/**
 * Open ora's own tunnel to `localTarget`, wait until the public hostname
 * routes, and return the same handle shape as `openTunnel`. Every failure
 * after the row exists deletes it before rethrowing, so a refused connect or
 * an unroutable edge never leaves an `ax-*` tunnel counting against the
 * account's active-tunnel limit.
 */
export async function openOraTunnel(
	localTarget: string,
	opts: OraTunnelOptions = {},
): Promise<Tunnel> {
	const target = parseLocalTarget(localTarget);
	const apiKey = opts.apiKey ?? process.env.ORA_API_KEY;
	if (!apiKey) throw new TunnelError(MISSING_KEY_HINT);
	const base = platformBase(opts.platformUrl);

	let bearer: string;
	try {
		bearer = await exchangeKey(base, apiKey);
	} catch (cause) {
		throw new TunnelError(
			`${cause instanceof Error ? cause.message : String(cause)}\n(--tunnel ora needs a platform key with the ${ORA_TUNNEL_SCOPES} scopes)`,
		);
	}
	if (opts.signal?.aborted) throw interrupted();
	const row = await createTunnel(base, bearer);
	// From here on the row exists and every exit path must delete it. The
	// bearer lives ~15 minutes and a deep audit can outlast it, so the delete
	// re-exchanges the key once on 401: a tunnel that survives the audit is
	// the one outcome this module exists to prevent.
	const remove = () => deleteTunnel(base, bearer, row.id, () => exchangeKey(base, apiKey));

	let ws: WebSocket | undefined;
	let connector: TunnelConnector | undefined;
	let closing = false;
	let reportDrop: (error: TunnelError) => void = () => {};
	const dropped = new Promise<TunnelError>((resolve) => {
		reportDrop = resolve;
	});
	const abortRace = new Promise<never>((_, reject) => {
		if (opts.signal?.aborted) reject(interrupted());
		opts.signal?.addEventListener("abort", () => reject(interrupted()), { once: true });
	});
	let created: CreatedTunnel;
	try {
		created = validateCreated(row);
		ws = await Promise.race([dial(created, bearer), abortRace]);
		connector = new TunnelConnector({
			socket: adaptSocket(ws),
			codec: new V1Codec(),
			hello: {
				agentVersion: `ax/${pkg.version}`,
				target: { protocol: "http", host: target.host, port: target.port },
				maxStreams: MAX_STREAMS,
			},
			forwarder: localForwarder(target.host, target.port),
			onConnectionClosed: (reason) => {
				if (!closing)
					reportDrop(new TunnelError(`ora tunnel connection dropped: ${reason.message}`));
			},
		});
		await Promise.race([connector.start(), abortRace]);
		await waitRoutable(created.publicUrl, opts.routableMs, opts.probeEveryMs, opts.signal);
	} catch (cause) {
		closing = true;
		try {
			if (connector) connector.close(1000, "ax setup failed");
			else ws?.close();
		} catch {
			// already gone
		}
		await remove();
		throw cause;
	}

	const open = connector;
	let closed: Promise<void> | undefined;
	const close = () => {
		if (!closed) {
			closing = true;
			closed = (async () => {
				try {
					open.close(1000, "ax exit");
				} catch {
					// the socket is already closed - the DELETE below still matters
				}
				await remove();
			})();
		}
		return closed;
	};
	return { url: created.publicUrl, close, dropped };
}

/** The create response must describe a tunnel this ax can connect to. */
function validateCreated(row: CreateResponse): CreatedTunnel {
	if (!row.publicUrl || !row.connection?.url || !row.connection.subprotocol) {
		throw new TunnelError("ora created a tunnel but returned no public URL to connect to");
	}
	if (row.connection.kind !== "ora-ws") {
		throw new TunnelError(
			`ora returned a "${row.connection.kind}" tunnel, which this version of ax cannot connect; upgrade ax`,
		);
	}
	return row as CreatedTunnel;
}

// --- Control plane ---

async function createTunnel(base: string, bearer: string): Promise<CreateResponse> {
	const res = await fetch(`${base}/tunnels/v1`, {
		method: "POST",
		headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
		body: JSON.stringify({ name: `ax-${randomBytes(4).toString("hex")}`, access: "public" }),
	});
	const text = await res.text();
	let payload: Partial<CreateResponse> & { error?: string; message?: string } = {};
	try {
		payload = JSON.parse(text);
	} catch {
		// non-JSON error page - the status alone is the message
	}
	if (!res.ok) {
		const detail = payload.error ?? payload.message ?? text.trim().slice(0, 200);
		throw new TunnelError(`${createHint(res.status)}${detail ? `: ${detail}` : ""}`);
	}
	// Without an id there is nothing to delete and nothing to connect; every
	// other shape problem is checked after the caller can delete the row.
	if (!payload.id) throw new TunnelError("ora created a tunnel but returned no id");
	return payload as CreateResponse;
}

function createHint(status: number): string {
	switch (status) {
		case 401:
			return "ora rejected the platform key (401). Check ORA_API_KEY";
		case 403:
			return `the platform key lacks the ${ORA_TUNNEL_SCOPES} scopes (403). Issue one with both and retry`;
		case 429:
			return "ora rate-limited the tunnel request (429). Wait a moment and retry";
		default:
			return `ora could not create a tunnel (${status})`;
	}
}

async function deleteTunnel(
	base: string,
	bearer: string,
	id: string,
	refresh: () => Promise<string>,
): Promise<void> {
	const attempt = (token: string) =>
		fetch(`${base}/tunnels/v1/${id}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		});
	try {
		let res = await attempt(bearer);
		if (res.status === 401) res = await attempt(await refresh());
		if (!res.ok && res.status !== 404) {
			console.error(
				`could not delete ora tunnel ${id} (${res.status}); remove it with: ora tunnels delete ${id}`,
			);
		}
	} catch (cause) {
		console.error(
			`could not delete ora tunnel ${id} (${cause instanceof Error ? cause.message : String(cause)}); remove it with: ora tunnels delete ${id}`,
		);
	}
}

// --- Data plane ---

/**
 * Dial the tunnel's WebSocket. The bearer rides the query string because
 * the browser-style WebSocket cannot set headers; the service accepts either.
 * A pre-upgrade rejection (401/403/429) reaches us only as a bare `error`
 * event - the status never surfaces - so the message names all three causes.
 */
function dial(created: CreatedTunnel, bearer: string): Promise<WebSocket> {
	const url = new URL(created.connection.url);
	url.searchParams.set("tunnelId", created.id);
	url.searchParams.set("token", bearer);
	return new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url, [created.connection.subprotocol]);
		ws.binaryType = "arraybuffer";
		const settle = (outcome: () => void) => {
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("error", onError);
			ws.removeEventListener("close", onClose);
			outcome();
		};
		const onOpen = () => settle(() => resolve(ws));
		const onError = () =>
			settle(() =>
				reject(
					new TunnelError(
						[
							"ora refused the tunnel connection.",
							`Either the platform key lacks the tunnels:connect scope, the bearer expired (401/403),`,
							"or the account's active-tunnel limit is reached (429): check `ora tunnels list`.",
						].join("\n"),
					),
				),
			);
		const onClose = (event: Event) => {
			const { code, reason } = event as Partial<{ code: number; reason: string }>;
			settle(() =>
				reject(
					new TunnelError(`ora closed the tunnel connection (${code ?? "?"} ${reason ?? ""})`),
				),
			);
		};
		ws.addEventListener("open", onOpen);
		ws.addEventListener("error", onError);
		ws.addEventListener("close", onClose);
	});
}

/**
 * Node's WebSocket as the protocol's transport. The ISocket contract is that
 * every `on*` call REPLACES the previous handler (the handshake hands the
 * socket over to the multiplexer): one listener per event is registered
 * here, once, and dispatches to a mutable slot - registering a new listener
 * per call would deliver every frame to every handler ever installed.
 */
export function adaptSocket(ws: WebSocket): ISocket {
	let onMessage: ((data: Uint8Array) => void) | undefined;
	let onClose: ((code: number, reason: string) => void) | undefined;
	let onError: ((error: Error) => void) | undefined;
	ws.addEventListener("message", (event) => {
		const data = (event as MessageEvent).data;
		if (data instanceof ArrayBuffer) onMessage?.(new Uint8Array(data));
		else if (ArrayBuffer.isView(data))
			onMessage?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	});
	ws.addEventListener("close", (event) => {
		const { code, reason } = event as Partial<{ code: number; reason: string }>;
		onClose?.(code ?? 1006, reason ?? "");
	});
	ws.addEventListener("error", () => onError?.(new Error("tunnel socket error")));
	return {
		get bufferedAmount() {
			return ws.bufferedAmount;
		},
		send(data) {
			if (ws.readyState === WS_OPEN) ws.send(data);
		},
		close(code, reason) {
			try {
				ws.close(code, reason);
			} catch {
				// invalid close code/reason or already closed - either way it is going away
			}
		},
		onMessage: (handler) => {
			onMessage = handler;
		},
		onClose: (handler) => {
			onClose = handler;
		},
		onError: (handler) => {
			onError = handler;
		},
	};
}

/** Hop-by-hop request headers (plus host) that must not reach the local server. */
const REQUEST_HEADERS_STRIPPED = new Set([
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"te",
]);

/**
 * The connector's only egress: bound to host:port at construction, so
 * nothing the server sends can steer a request anywhere else on this machine.
 */
export function localForwarder(host: string, port: number): LocalForwarder {
	return {
		forward: (req: LocalRequest) =>
			new Promise<LocalResponse>((resolve, reject) => {
				const out = httpRequest(
					{
						host,
						port,
						path: req.path,
						method: req.method,
						headers: stripRequestHeaders(req.headers),
					},
					(res: IncomingMessage) =>
						resolve({
							status: res.statusCode ?? 502,
							headers: responseHeaders(res),
							body: res as AsyncIterable<Uint8Array>,
						}),
				);
				out.on("error", reject);
				pipeBody(req.body, out).catch((cause) => {
					out.destroy(cause instanceof Error ? cause : new Error(String(cause)));
					reject(cause);
				});
			}),
	};
}

async function pipeBody(body: AsyncIterable<Uint8Array>, out: ClientRequest): Promise<void> {
	try {
		for await (const chunk of body) {
			if (!out.write(chunk)) await once(out, "drain");
		}
	} finally {
		out.end();
	}
}

function stripRequestHeaders(headers: HeaderMap): HeaderMap {
	return Object.fromEntries(
		Object.entries(headers).filter(([key]) => !REQUEST_HEADERS_STRIPPED.has(key.toLowerCase())),
	);
}

/** Keep multi-valued headers (set-cookie) as arrays; the wire format allows them. */
function responseHeaders(res: IncomingMessage): HeaderMap {
	const out: HeaderMap = {};
	for (const [key, value] of Object.entries(res.headers)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}
