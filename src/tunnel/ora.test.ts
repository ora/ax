import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createMemorySocketPair,
	type ISocket,
	type MemorySocket,
	TunnelSession,
	V1Codec,
} from "@ora-ai/tunnel-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TunnelError } from "../tunnel";
import { adaptSocket, openOraTunnel, parseLocalTarget } from "./ora";

const BASE = "https://platform.test";
const TUNNEL_ID = "0f3c1c1e-6a1b-4c1f-9a2e-000000000001";
const PUBLIC_URL = `https://${TUNNEL_ID}.t.agentfront.test`;
const CONNECT_URL = "wss://tunnel.agentfront.test/connect";

// --- A stand-in for Node's WebSocket, bridged to the protocol's server half
// over the package's in-memory socket pair, so the HELLO handshake and the
// proxied requests really run through TunnelConnector <-> TunnelSession.

type DialOutcome = "accept" | "reject" | "close";
let dialOutcome: DialOutcome = "accept";

class FakeWebSocket extends EventTarget {
	static instances: FakeWebSocket[] = [];
	readonly url: string;
	readonly protocols: string[];
	readyState = 0;
	binaryType = "blob";
	bufferedAmount = 0;
	closedWith: { code?: number; reason?: string } | undefined;
	readonly session: TunnelSession;
	readonly accepted: Promise<unknown>;
	private readonly client: MemorySocket;

	constructor(url: string | URL, protocols: string[]) {
		super();
		this.url = String(url);
		this.protocols = protocols;
		FakeWebSocket.instances.push(this);
		const [server, client] = createMemorySocketPair();
		this.client = client;
		client.onMessage((data) =>
			this.dispatchEvent(
				new MessageEvent("message", {
					data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
				}),
			),
		);
		client.onClose((code, reason) => {
			this.readyState = 3;
			this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
		});
		this.session = new TunnelSession({
			socket: server,
			codec: new V1Codec(),
			limits: { maxStreams: 8, heartbeatMs: 30_000 },
		});
		this.accepted =
			dialOutcome === "accept" ? this.session.accept({ tunnelId: TUNNEL_ID }) : Promise.resolve();
		queueMicrotask(() => {
			if (dialOutcome === "accept") {
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
			} else if (dialOutcome === "reject") {
				// undici: a non-101 upgrade response is an `error` then a `close`
				this.dispatchEvent(new Event("error"));
				this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }));
			} else {
				this.dispatchEvent(Object.assign(new Event("close"), { code: 4001, reason: "revoked" }));
			}
		});
	}

	send(data: Uint8Array) {
		this.client.send(data);
	}

	close(code?: number, reason?: string) {
		this.closedWith = { code, reason };
		this.client.close(code, reason);
	}
}

// --- The platform API: auth exchange, create, delete, plus the routability probe.

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}
let calls: Call[] = [];
let probeStatuses: number[] = [];
let createOverride: Record<string, unknown> = {};

function stubPlatform() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const headers = Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
					k.toLowerCase(),
					v,
				]),
			);
			calls.push({ method, url, headers, body: init?.body as string | undefined });
			if (url === `${BASE}/auth/token`) return Response.json({ token: "bearer-1" });
			if (url === `${BASE}/tunnels/v1` && method === "POST") {
				return Response.json(
					{
						id: TUNNEL_ID,
						name: JSON.parse(String(init?.body)).name,
						status: "created",
						access: "public",
						publicUrl: PUBLIC_URL,
						accessToken: null,
						connection: { kind: "ora-ws", url: CONNECT_URL, subprotocol: "ora-tunnel.v1" },
						...createOverride,
					},
					{ status: 201 },
				);
			}
			if (url === `${BASE}/tunnels/v1/${TUNNEL_ID}` && method === "DELETE") {
				return Response.json({ id: TUNNEL_ID, deleted: true });
			}
			if (url === PUBLIC_URL) {
				return new Response("", { status: probeStatuses.shift() ?? 200 });
			}
			return new Response("not found", { status: 404 });
		}),
	);
}

const deletes = () => calls.filter((c) => c.method === "DELETE");
const open = (target: string) =>
	openOraTunnel(target, { apiKey: "ora_sk_test", platformUrl: BASE, probeEveryMs: 10 });

describe("parseLocalTarget", () => {
	it("binds localhost to 127.0.0.1 and defaults the port to 80", () => {
		expect(parseLocalTarget("localhost:3000")).toEqual({ host: "127.0.0.1", port: 3000 });
		expect(parseLocalTarget("http://localhost:3000")).toEqual({ host: "127.0.0.1", port: 3000 });
		expect(parseLocalTarget("127.0.0.1:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
		expect(parseLocalTarget("my-app.local")).toEqual({ host: "my-app.local", port: 80 });
	});

	it("rejects https and garbage as a TunnelError", () => {
		expect(() => parseLocalTarget("https://localhost:3000")).toThrow(TunnelError);
		expect(() => parseLocalTarget("http://")).toThrow(TunnelError);
	});
});

describe("openOraTunnel", () => {
	let local: Server;
	let localPort: number;
	let seen: { headers: Record<string, string | string[] | undefined>; path: string }[];

	beforeEach(async () => {
		calls = [];
		probeStatuses = [];
		createOverride = {};
		dialOutcome = "accept";
		FakeWebSocket.instances = [];
		seen = [];
		stubPlatform();
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.spyOn(console, "error").mockImplementation(() => {});
		local = createServer((req, res) => {
			seen.push({ headers: req.headers, path: req.url ?? "" });
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				res.setHeader("set-cookie", ["a=1", "b=2"]);
				res.setHeader("content-type", "text/plain");
				res.end(`local:${req.method} ${req.url} body=${body}`);
			});
		});
		await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
		localPort = (local.address() as AddressInfo).port;
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await new Promise<void>((r) => local.close(() => r()));
	});

	it("creates, connects, waits for the edge, and proxies requests to the local server", async () => {
		probeStatuses = [530, 200];
		const tunnel = await open(`localhost:${localPort}`);
		expect(tunnel.url).toBe(PUBLIC_URL);

		// control plane: key exchanged, tunnel created public with an ax-* name
		const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/tunnels/v1"));
		expect(create?.headers.authorization).toBe("Bearer bearer-1");
		expect(JSON.parse(String(create?.body))).toMatchObject({
			access: "public",
			name: expect.stringMatching(/^ax-[0-9a-f]{8}$/),
		});
		// data plane: dialed with the bearer + tunnel id and the negotiated subprotocol
		const [ws] = FakeWebSocket.instances;
		expect(ws.url).toBe(`${CONNECT_URL}?tunnelId=${TUNNEL_ID}&token=bearer-1`);
		expect(ws.protocols).toEqual(["ora-tunnel.v1"]);
		expect(ws.binaryType).toBe("arraybuffer");
		await ws.accepted;
		expect(ws.session.clientHello?.target).toEqual({
			protocol: "http",
			host: "127.0.0.1",
			port: localPort,
		});
		// the edge was probed until it routed
		expect(calls.filter((c) => c.url === PUBLIC_URL)).toHaveLength(2);

		// a proxied request round-trips through the real protocol to the local server
		const res = await ws.session.request(
			{
				method: "POST",
				path: "/hello?x=1",
				headers: { host: PUBLIC_URL, connection: "x-marker", "x-probe": "yes" },
			},
			(async function* () {
				yield new TextEncoder().encode("ping");
			})(),
		);
		expect(res.status).toBe(200);
		expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
		let body = "";
		for await (const chunk of res.body) body += new TextDecoder().decode(chunk);
		expect(body).toBe("local:POST /hello?x=1 body=ping");
		expect(seen[0].path).toBe("/hello?x=1");
		expect(seen[0].headers["x-probe"]).toBe("yes");
		expect(seen[0].headers.host).not.toBe(PUBLIC_URL);
		expect(seen[0].headers.connection).not.toBe("x-marker");

		expect(deletes()).toHaveLength(0);
		await tunnel.close();
		expect(deletes()).toHaveLength(1);
		expect(deletes()[0].url).toBe(`${BASE}/tunnels/v1/${TUNNEL_ID}`);
		expect(ws.closedWith).toEqual({ code: 1000, reason: "ax exit" });
	});

	it("close() deletes the row exactly once, however often it is called", async () => {
		const tunnel = await open(`localhost:${localPort}`);
		await Promise.all([tunnel.close(), tunnel.close()]);
		await tunnel.close();
		expect(deletes()).toHaveLength(1);
	});

	it("deletes the row and throws a TunnelError when ora refuses the connect", async () => {
		dialOutcome = "reject";
		await expect(open(`localhost:${localPort}`)).rejects.toThrow(TunnelError);
		await expect(open(`localhost:${localPort}`)).rejects.toThrow(/active-tunnel limit/);
		expect(deletes()).toHaveLength(2);
	});

	it("deletes the row and throws a TunnelError when the edge never routes", async () => {
		probeStatuses = [530, 530, 530, 530, 530, 530, 530, 530];
		await expect(
			openOraTunnel(`localhost:${localPort}`, {
				apiKey: "ora_sk_test",
				platformUrl: BASE,
				routableMs: 30,
				probeEveryMs: 10,
			}),
		).rejects.toThrow(/never became routable/);
		expect(deletes()).toHaveLength(1);
		expect(FakeWebSocket.instances[0].closedWith?.code).toBe(1000);
	});

	it("deletes the row when the create response cannot be connected to", async () => {
		createOverride = { publicUrl: null };
		await expect(open(`localhost:${localPort}`)).rejects.toThrow(/no public URL/);
		createOverride = { connection: { kind: "ngrok", url: "x", subprotocol: "y" } };
		await expect(open(`localhost:${localPort}`)).rejects.toThrow(/upgrade ax/);
		expect(deletes()).toHaveLength(2);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("an interrupt during setup deletes the row exactly once and rejects", async () => {
		probeStatuses = [530, 530, 530, 530, 530, 530, 530, 530, 530, 530];
		const interrupt = new AbortController();
		const opening = openOraTunnel(`localhost:${localPort}`, {
			apiKey: "ora_sk_test",
			platformUrl: BASE,
			routableMs: 5_000,
			probeEveryMs: 10,
			signal: interrupt.signal,
		});
		// let create + dial + handshake happen, then Ctrl-C while probing the edge
		await vi.waitFor(() => expect(calls.some((c) => c.url === PUBLIC_URL)).toBe(true));
		interrupt.abort();
		await expect(opening).rejects.toThrow(/interrupted/);
		expect(deletes()).toHaveLength(1);
		expect(FakeWebSocket.instances[0].closedWith?.code).toBe(1000);
	});

	it("an interrupt before create never creates a row", async () => {
		const interrupt = new AbortController();
		interrupt.abort();
		await expect(
			openOraTunnel(`localhost:${localPort}`, {
				apiKey: "ora_sk_test",
				platformUrl: BASE,
				signal: interrupt.signal,
			}),
		).rejects.toThrow(/interrupted/);
		expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/tunnels/v1"))).toHaveLength(
			0,
		);
	});

	it("reports a connection that ora drops mid-audit, and close() still deletes the row", async () => {
		const tunnel = await open(`localhost:${localPort}`);
		const [ws] = FakeWebSocket.instances;
		await ws.accepted;
		ws.session.close(4001, "revoked");
		const error = await tunnel.dropped;
		expect(error).toBeInstanceOf(TunnelError);
		expect(error?.message).toMatch(/dropped/);
		await tunnel.close();
		expect(deletes()).toHaveLength(1);
	});

	it("resets a proxied request when the local server refuses the connection", async () => {
		await new Promise<void>((r) => local.close(() => r()));
		const tunnel = await open(`localhost:${localPort}`);
		const [ws] = FakeWebSocket.instances;
		await ws.accepted;
		await expect(ws.session.request({ method: "GET", path: "/", headers: {} })).rejects.toThrow(
			/ECONNREFUSED|FORWARD/i,
		);
		await tunnel.close();
		// afterEach closes the server again; make that a no-op
		local = createServer();
	});

	it("re-exchanges the key when the bearer has expired by the time the row is deleted", async () => {
		const tunnel = await open(`localhost:${localPort}`);
		const original = vi.mocked(fetch).getMockImplementation();
		let first = true;
		vi.mocked(fetch).mockImplementation(async (input, init) => {
			if (init?.method === "DELETE" && first) {
				first = false;
				calls.push({ method: "DELETE", url: String(input), headers: {} });
				return new Response("", { status: 401 });
			}
			return original?.(input, init) as Promise<Response>;
		});
		await tunnel.close();
		expect(deletes()).toHaveLength(2);
		expect(calls.filter((c) => c.url === `${BASE}/auth/token`)).toHaveLength(2);
	});

	it("is a TunnelError naming the scopes when the key is missing, without any request", async () => {
		const saved = process.env.ORA_API_KEY;
		delete process.env.ORA_API_KEY;
		try {
			await expect(openOraTunnel("localhost:3000", { platformUrl: BASE })).rejects.toThrow(
				/tunnels:write \+ tunnels:connect/,
			);
			expect(calls).toHaveLength(0);
		} finally {
			if (saved !== undefined) process.env.ORA_API_KEY = saved;
		}
	});

	it("maps 401/403/429 on create to actionable hints without dialing", async () => {
		for (const [status, pattern] of [
			[401, /rejected the platform key/],
			[403, /tunnels:write \+ tunnels:connect/],
			[429, /rate-limited/],
		] as const) {
			const original = vi.mocked(fetch).getMockImplementation();
			vi.mocked(fetch).mockImplementation(async (input, init) => {
				if (init?.method === "POST" && String(input).endsWith("/tunnels/v1")) {
					return Response.json({ error: "nope" }, { status });
				}
				return original?.(input, init) as Promise<Response>;
			});
			await expect(open(`localhost:${localPort}`)).rejects.toThrow(pattern);
			expect(FakeWebSocket.instances).toHaveLength(0);
		}
	});
});

describe("adaptSocket", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("replaces the previous handler on re-registration instead of stacking listeners", () => {
		const ws = new EventTarget() as unknown as WebSocket & EventTarget;
		Object.assign(ws, { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
		const socket: ISocket = adaptSocket(ws);
		const first = vi.fn();
		const second = vi.fn();
		socket.onMessage(first);
		socket.onMessage(second);
		ws.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([1, 2]).buffer }));
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
		expect(second.mock.calls[0][0]).toEqual(new Uint8Array([1, 2]));

		const closeA = vi.fn();
		const closeB = vi.fn();
		socket.onClose(closeA);
		socket.onClose(closeB);
		ws.dispatchEvent(Object.assign(new Event("close"), { code: 1001, reason: "bye" }));
		expect(closeA).not.toHaveBeenCalled();
		expect(closeB).toHaveBeenCalledWith(1001, "bye");
	});

	it("only sends while the socket is open and never throws from close()", () => {
		const send = vi.fn();
		const ws = Object.assign(new EventTarget(), {
			readyState: 0,
			bufferedAmount: 7,
			send,
			close: () => {
				throw new Error("bad code");
			},
		}) as unknown as WebSocket;
		const socket = adaptSocket(ws);
		socket.send(new Uint8Array([1]));
		expect(send).not.toHaveBeenCalled();
		(ws as { readyState: number }).readyState = 1;
		socket.send(new Uint8Array([1]));
		expect(send).toHaveBeenCalledTimes(1);
		expect(socket.bufferedAmount).toBe(7);
		expect(() => socket.close(1000, "x")).not.toThrow();
	});
});
