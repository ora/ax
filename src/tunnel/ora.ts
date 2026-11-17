import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import pkg from "../../package.json";
import { PlatformApiError, platformBase, resolvePlatformCredential } from "../api/platform";
import { NotSignedInError, type PlatformCredential, SignInEndedError } from "../auth/credential";
import { scopeList, TUNNEL_FEATURE } from "../auth/platform-features";
import { type Tunnel, TunnelError, waitRoutable } from "../tunnel";
import {
	type HeaderMap,
	type ISocket,
	type LocalForwarder,
	type LocalRequest,
	type LocalResponse,
	TunnelConnector,
	V1Codec,
} from "./vendor";

// ora's own reverse tunnel (`ax audit --tunnel ora`): create a tunnel row on
// the platform API, dial its WebSocket data plane, forward every proxied
// request to the local server, audit the public hostname, delete the row.
//
// This is protocol code, not a vendor: ./vendor is the client half of ora's
// own wire protocol (copied from @ora-ai/tunnel-protocol, see vendor/index.ts
// for why it is a copy), the transport is Node's built-in WebSocket, and
// nothing is downloaded at runtime. The tunnel is created `public` because
// ora's scanner cannot yet present a per-tunnel credential; the hostname is
// an unguessable UUID that stops answering the moment the row is deleted.

export interface OraTunnelOptions {
	/** The ora_sk_ platform key; falls back to $ORA_API_KEY, then the sign-in `ax login` stored. */
	apiKey?: string;
	/** How to sign the calls, instead of resolving one from apiKey/ORA_API_KEY/ax login. */
	credential?: PlatformCredential;
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

/** The scopes the tunnel's credential needs, quoted in every credential error. */
export const ORA_TUNNEL_SCOPES = scopeList(TUNNEL_FEATURE);

export const MISSING_KEY_HINT = [
	"--tunnel ora needs you signed in to ora's platform: run ax login to sign in through your browser,",
	`or set ORA_API_KEY to an ora platform key (ora_sk_...) with the ${ORA_TUNNEL_SCOPES} scopes`,
	"(Settings, API keys), exported or in a local .env.",
	"Or bring your own tunnel instead: --tunnel-cmd 'ngrok http 3000 --log stdout'",
].join("\n");

/**
 * The credential `--tunnel ora` signs its calls with: a platform key (the option, else
 * $ORA_API_KEY), else the sign-in `ax login` stored for this platform. Resolved before anything is
 * sent; with neither, a TunnelError that says both ways in.
 */
export function oraTunnelCredential(
	opts: Pick<OraTunnelOptions, "apiKey" | "platformUrl"> = {},
): PlatformCredential {
	const base = platformBase(opts.platformUrl);
	try {
		return resolvePlatformCredential({ base, apiKey: opts.apiKey });
	} catch (cause) {
		if (!(cause instanceof NotSignedInError)) throw cause;
		const elsewhere = cause.signedInFor
			? `\nYour ax sign-in is for ${cause.signedInFor}, not ${base}.`
			: "";
		throw new TunnelError(`${MISSING_KEY_HINT}${elsewhere}`);
	}
}

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
	const base = platformBase(opts.platformUrl);
	const credential = opts.credential ?? oraTunnelCredential(opts);

	let bearer: string;
	try {
		bearer = await credential.bearer();
	} catch (cause) {
		throw new TunnelError(
			`${cause instanceof Error ? cause.message : String(cause)}\n(--tunnel ora needs ax login, or a platform key with the ${ORA_TUNNEL_SCOPES} scopes)`,
			{ payload: cause instanceof PlatformApiError ? cause.payload : undefined },
		);
	}
	if (opts.signal?.aborted) throw interrupted();
	const row = await createTunnel(base, bearer, credential.kind);
	// From here on the row exists and every exit path must delete it. The
	// bearer lives ~15 minutes and a deep audit can outlast it, so the delete
	// renews it once on 401 (a key traded again, a sign-in refreshed): a
	// tunnel that survives the audit is the one outcome this module exists to
	// prevent.
	const remove = () => deleteTunnel(base, bearer, row.id, () => credential.renew());

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
		const socket = adaptSocket(ws);
		connector = new TunnelConnector({
			socket,
			codec: new V1Codec(),
			hello: {
				agentVersion: `ax/${pkg.version}`,
				target: { protocol: "http", host: target.host, port: target.port },
				maxStreams: MAX_STREAMS,
			},
			forwarder: localForwarder(target.host, target.port),
			onConnectionClosed: (reason) => {
				if (!closing) reportDrop(droppedError(socket.closed, reason.message));
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

/**
 * ora closes the connection of a tunnel whose browser sign-in ended (disconnected, signed out
 * everywhere, removed from the organization) with {@link CREDENTIAL_ENDED_CLOSE_CODE}: that one
 * says what to do. Any other close is a plain drop. The code decides, never the reason's words.
 */
function droppedError(close: TunnelSocket["closed"], message: string): TunnelError {
	if (close?.code === CREDENTIAL_ENDED_CLOSE_CODE) {
		return new TunnelError(
			`ora closed the tunnel: your sign-in ended (${close.reason || close.code}). Run ax login.`,
			{ signInEnded: true },
		);
	}
	return new TunnelError(`ora tunnel connection dropped: ${message}`);
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

async function createTunnel(
	base: string,
	bearer: string,
	kind: PlatformCredential["kind"],
): Promise<CreateResponse> {
	const res = await fetch(`${base}/tunnels/v1`, {
		method: "POST",
		headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
		body: JSON.stringify({ name: `ax-${randomBytes(4).toString("hex")}`, access: "public" }),
	});
	const text = await res.text();
	let payload: Partial<CreateResponse> & { error?: string; message?: string } = {};
	let served: unknown;
	try {
		payload = JSON.parse(text);
		served = payload;
	} catch {
		// non-JSON error page - the status alone is the message
	}
	if (!res.ok) {
		const detail = payload.error ?? payload.message ?? text.trim().slice(0, 200);
		throw new TunnelError(`${createHint(res.status, kind)}${detail ? `: ${detail}` : ""}`, {
			payload: served,
		});
	}
	// Without an id there is nothing to delete and nothing to connect; every
	// other shape problem is checked after the caller can delete the row.
	if (!payload.id) throw new TunnelError("ora created a tunnel but returned no id");
	return payload as CreateResponse;
}

function createHint(status: number, kind: PlatformCredential["kind"]): string {
	switch (status) {
		case 401:
			return kind === "sign_in"
				? "ora no longer accepts your sign-in (401). Run ax login"
				: "ora rejected the platform key (401). Check ORA_API_KEY";
		case 403:
			return kind === "sign_in"
				? `your sign-in cannot open tunnels (403): it needs the ${ORA_TUNNEL_SCOPES} scopes, which a viewer cannot grant. Ask for a developer role, or use a platform key`
				: `the platform key lacks the ${ORA_TUNNEL_SCOPES} scopes (403). Issue one with them and retry`;
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
		const why =
			cause instanceof SignInEndedError
				? "deleting it needs your sign-in, which ended; it carries no traffic"
				: cause instanceof Error
					? cause.message
					: String(cause);
		console.error(
			`could not delete ora tunnel ${id} (${why}); remove it with: ora tunnels delete ${id}`,
		);
	}
}

// --- Data plane ---

/**
 * Dial the tunnel's WebSocket. The bearer rides the upgrade's Authorization
 * header and never the URL, which lands in access logs: Node's WebSocket
 * takes headers (from 22.4, ax's floor), and the tunnel id is the only thing
 * in the query string. A pre-upgrade rejection (401/403/429) reaches us only
 * as a bare `error` event - the status never surfaces - so the message names
 * all three causes.
 */
function dial(created: CreatedTunnel, bearer: string): Promise<WebSocket> {
	const url = new URL(created.connection.url);
	url.searchParams.set("tunnelId", created.id);
	return new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url, {
			protocols: [created.connection.subprotocol],
			headers: { authorization: `Bearer ${bearer}` },
		});
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
 * The close code ora's tunnel service ends a held connection with once the credential it was
 * admitted for no longer stands (a sign-in that ended): 4401, the code it refuses a connection
 * with for the same reason, so one code means "this credential no longer works here". It is the
 * server's value, copied: @ora-ai/tunnel-protocol does not export it yet, and a lockstep test
 * against the package can only come once it does.
 */
export const CREDENTIAL_ENDED_CLOSE_CODE = 4401;

/** RFC 6455 §7.1.5: the code for a connection that closed without a close frame. */
const ABNORMAL_CLOSURE = 1006;

/** The protocol's socket over Node's WebSocket, which also keeps the close the server sent. */
export interface TunnelSocket extends ISocket {
	/** How the connection closed, once it has: its code says what a drop means. */
	readonly closed: { code: number; reason: string } | undefined;
}

/**
 * Node's WebSocket as the protocol's transport. The ISocket contract is that
 * every `on*` call REPLACES the previous handler (the handshake hands the
 * socket over to the multiplexer): one listener per event is registered
 * here, once, and dispatches to a mutable slot - registering a new listener
 * per call would deliver every frame to every handler ever installed. The
 * close is kept before it is handed on: the vendored multiplexer folds the
 * code into a message, and the code is what a caller has to read.
 */
export function adaptSocket(ws: WebSocket): TunnelSocket {
	let onMessage: ((data: Uint8Array) => void) | undefined;
	let onClose: ((code: number, reason: string) => void) | undefined;
	let onError: ((error: Error) => void) | undefined;
	let closed: TunnelSocket["closed"];
	ws.addEventListener("message", (event) => {
		const data = (event as MessageEvent).data;
		if (data instanceof ArrayBuffer) onMessage?.(new Uint8Array(data));
		else if (ArrayBuffer.isView(data))
			onMessage?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	});
	ws.addEventListener("close", (event) => {
		const { code, reason } = event as Partial<{ code: number; reason: string }>;
		closed = { code: code ?? ABNORMAL_CLOSURE, reason: reason ?? "" };
		onClose?.(closed.code, closed.reason);
	});
	ws.addEventListener("error", () => onError?.(new Error("tunnel socket error")));
	return {
		get closed() {
			return closed;
		},
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
