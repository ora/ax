import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyCredential } from "../auth/api-key-credential";
import { KeyRejectedError } from "../auth/errors";
import { KeyDestinationError } from "./key-destination";
import { decodeEventBlock, launchJourney, type RawRunStep, type RunRequest } from "./platform";
import { PlatformApiError } from "./platform-error";

// The run stream is *named* SSE — `event: X` + `data: {json}` blocks with
// `: ping` heartbeat comments in between. A different framing from the scan
// stream on purpose; the decoders must never be shared.
const runStream = (events: Array<[string, unknown]>): Response =>
	new Response(
		events
			.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
			.join(": ping\n\n"),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

// Answers the platform's four endpoints: token exchange, run create, stream, list.
function platformMock(config: { created?: unknown; stream?: Response; spendRows?: unknown[] }) {
	return vi.fn(async (url: string | URL, init?: { method?: string }) => {
		const at = String(url);
		if (at.endsWith("/auth/token")) {
			return asJson({ token: "jwt.test", expiresIn: 900, tokenType: "Bearer" });
		}
		if (at.endsWith("/experiment/v1/runs") && init?.method === "POST") {
			return asJson(
				config.created ?? {
					runId: "run_9",
					status: "pending",
					streamUrl: "/experiment/v1/runs/run_9/stream",
				},
			);
		}
		if (at.includes("/runs?pageSize=")) return asJson({ results: config.spendRows ?? [] });
		if (at.includes("/stream") && config.stream) return config.stream;
		return asJson({});
	});
}

const BASE = "https://platform.test";

/** A run on a platform key, with a credential of its own: a traded token is kept per credential. */
const request = (over: Partial<RunRequest> = {}): RunRequest => ({
	intent: "Locate the REST API reference",
	domain: "acme.dev",
	harness: "claude-code",
	baseUrl: BASE,
	credential: new ApiKeyCredential(over.baseUrl ?? BASE, "ora_sk_local"),
	...over,
});

const FINALE: Array<[string, unknown]> = [
	[
		"result",
		{ runId: "run_9", outcome: "success", result: { run_id: "run_9", outcome: "success" } },
	],
	["insight", { runId: "run_9", insight: { visibility_score: 77 } }],
];

describe("decodeEventBlock", () => {
	it("reads the event name and payload", () => {
		expect(decodeEventBlock('event: result\ndata: {"ok":1}')).toEqual({
			event: "result",
			data: '{"ok":1}',
		});
	});

	it("ignores heartbeat comments", () => {
		expect(decodeEventBlock(": ping")).toBeNull();
	});

	it("defaults to 'message' and concatenates data lines", () => {
		expect(decodeEventBlock("data: one\ndata: two")).toEqual({
			event: "message",
			data: "one\ntwo",
		});
	});
});

describe("launchJourney", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("walks the whole pipeline: token → create → stream → spend", async () => {
		const fetchMock = platformMock({
			stream: runStream([
				["run", { runId: "run_9" }],
				[
					"trajectory",
					{ steps: [{ id: 0, turn: 1, type: "text", kind: "reasoning", thinking: "…" }] },
				],
				["step", { runId: "run_9", seq: 1, step: { type: "thinking", turn: 1, thinking: "…" } }],
				[
					"step",
					{ runId: "run_9", seq: 2, step: { type: "tool_call", turn: 2, tool: "WebSearch" } },
				],
				...FINALE,
			]),
		});
		vi.stubGlobal("fetch", fetchMock);

		const burst: RawRunStep[] = [];
		const run = await launchJourney(request(), { step: (s) => burst.push(s) });

		// Raw `step` events are the end-of-run burst — collected, never merged
		// with trajectory snapshots.
		expect(run.steps).toHaveLength(2);
		expect(burst).toHaveLength(2);
		expect(run.steps[1]).toMatchObject({ type: "tool_call", tool: "WebSearch" });
		expect(run.result?.outcome).toBe("success");
		expect(run.insight?.visibility_score).toBe(77);

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(String(fetchMock.mock.calls[0][0])).toContain("/auth/token");
		expect(String(fetchMock.mock.calls[2][0])).toContain("/experiment/v1/runs/run_9/stream");
		expect(String(fetchMock.mock.calls[3][0])).toContain("/runs?pageSize=");
	});

	it("with a browser sign-in: no key trade, the access token on every call, asked again for the totals", async () => {
		const fetchMock = platformMock({ stream: runStream(FINALE) });
		vi.stubGlobal("fetch", fetchMock);
		const bearers = ["access-1", "access-2"];
		const credential = { bearer: vi.fn(async () => bearers.shift() ?? "x") };
		await launchJourney(request({ credential }));

		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls.some((url) => url.endsWith("/auth/token"))).toBe(false);
		const auth = (i: number) =>
			(fetchMock.mock.calls[i][1] as { headers: Record<string, string> }).headers.authorization;
		expect(auth(0)).toBe("Bearer access-1");
		// The totals are read after the run: the credential is asked again (a sign-in renews there).
		expect(auth(fetchMock.mock.calls.length - 1)).toBe("Bearer access-2");
		expect(credential.bearer).toHaveBeenCalledTimes(2);
	});

	it("relays every growing trajectory snapshot and keeps the last", async () => {
		const one = [{ id: 0, turn: 1, type: "text", kind: "reasoning", thinking: "look" }];
		const two = [
			...one,
			{ id: 1, turn: 2, type: "tool_call", tool: "WebSearch", input_display: "acme docs" },
		];
		vi.stubGlobal(
			"fetch",
			platformMock({
				stream: runStream([
					["run", { runId: "run_9" }],
					["trajectory", { steps: one }],
					["trajectory", { steps: two }],
					...FINALE,
				]),
			}),
		);

		const sizes: number[] = [];
		const run = await launchJourney(request(), { snapshot: (s) => sizes.push(s.length) });
		expect(sizes).toEqual([1, 2]);
		expect(run.trajectory).toHaveLength(2);
		expect(run.trajectory[1]).toMatchObject({ type: "tool_call", tool: "WebSearch" });
	});

	it("reads tokens and cost off the runs list after the stream", async () => {
		vi.stubGlobal(
			"fetch",
			platformMock({
				stream: runStream(FINALE),
				spendRows: [
					{ id: "someone_else", total_tokens: 5, cost_usd: 9.9 },
					{
						id: "run_9",
						total_tokens: 119_100,
						input_tokens: 101_000,
						output_tokens: 4_100,
						cost_usd: 0.031,
					},
				],
			}),
		);

		const run = await launchJourney(request());
		expect(run.usage).toMatchObject({
			totalTokens: 119_100,
			inputTokens: 101_000,
			outputTokens: 4_100,
			costUsd: 0.031,
		});
	});

	it("fires `opened` exactly once, ignoring the stream's own run event", async () => {
		vi.stubGlobal(
			"fetch",
			platformMock({ stream: runStream([["run", { runId: "run_9" }], ...FINALE]) }),
		);
		const openings: string[] = [];
		await launchJourney(request(), { opened: (id) => openings.push(id) });
		expect(openings).toEqual(["run_9"]);
	});

	it("posts exactly the provided run parameters", async () => {
		const fetchMock = platformMock({ stream: runStream(FINALE) });
		vi.stubGlobal("fetch", fetchMock);

		await launchJourney(request({ model: "claude-haiku-4-5-20251001" }));
		const create = fetchMock.mock.calls.find(
			([at, init]) =>
				String(at).endsWith("/experiment/v1/runs") &&
				(init as { method?: string })?.method === "POST",
		);
		// Assert the call exists before reaching into it, so a missing POST fails
		// as a missing POST rather than a TypeError three frames deep.
		expect(create).toBeDefined();

		const [, init] = create as [unknown, { body: string }];
		expect(JSON.parse(init.body)).toEqual({
			intent: "Locate the REST API reference",
			domain: "acme.dev",
			harness: "claude-code",
			model: "claude-haiku-4-5-20251001",
		});
	});

	it("translates a 401 token exchange into the key's own refusal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 401 })),
		);
		const failure = launchJourney(request());
		await expect(failure).rejects.toThrow(KeyRejectedError);
		await expect(failure).rejects.toThrow(/platform key was rejected\. Check ORA_API_KEY/);
	});

	it("translates a 429 on create into a rate-limit hint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				if (String(url).endsWith("/auth/token")) return asJson({ token: "t" });
				return new Response("{}", { status: 429 });
			}),
		);
		await expect(launchJourney(request())).rejects.toThrow(/rate limit/i);
	});

	it("keeps the platform's JSON error body on the error, and none for a non-JSON one", async () => {
		const served = { error: "invalid_harness", message: "unknown harness: nope" };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				if (String(url).endsWith("/auth/token")) return asJson({ token: "t" });
				return asJson(served, 422);
			}),
		);
		const failure = launchJourney(request());
		await expect(failure).rejects.toThrow(PlatformApiError);
		await expect(failure).rejects.toMatchObject({ status: 422, payload: served });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })),
		);
		await expect(launchJourney(request())).rejects.toMatchObject({ status: 502, payload: null });
	});

	it("times out when the run stream goes silent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init?: { signal?: AbortSignal }) => {
				if (String(url).endsWith("/auth/token")) return asJson({ token: "t" });
				if (String(url).endsWith("/experiment/v1/runs")) {
					return asJson({ runId: "run_9", status: "pending", streamUrl: "/x/stream" });
				}
				const silent = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
					},
				});
				return new Response(silent, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);
		await expect(launchJourney(request({ idleMs: 40 }))).rejects.toThrow(/timed out/i);
	});
});

describe("a journey's key", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is held to the destination rule before the run is created", async () => {
		const fetchMock = vi.fn(async () => asJson({ token: "t" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(launchJourney(request({ baseUrl: "http://collector.example" }))).rejects.toThrow(
			KeyDestinationError,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
