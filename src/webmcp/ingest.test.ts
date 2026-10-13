import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestCapture, preflightCapture, prepareForIngest, WebmcpIngestError } from "./ingest";
import type { PublicWebmcpAudit } from "./vendor/projection";
import type { WebmcpAuditEvent, WebmcpCaptureResult } from "./vendor/types";

// Both fixtures are real: this CLI's own capture of the smoke page
// (scripts/smoke-webmcp.mjs) on Chromium 141, run through ora's real admission,
// engine and projection (shim 3). Per this repo's rule, fixtures come from real
// responses - variations below are explicit deltas off these, never
// hand-rolled payloads.
const CAPTURE = JSON.parse(
	readFileSync(new URL("./__fixtures__/local-catalogue-capture.json", import.meta.url), "utf8"),
) as WebmcpCaptureResult;
const AUDIT = (
	JSON.parse(
		readFileSync(new URL("./__fixtures__/local-catalogue-audit.json", import.meta.url), "utf8"),
	) as { audit: PublicWebmcpAudit }
).audit;

/** Data-only SSE, the shape the ingest endpoint answers with. */
const sse = (events: WebmcpAuditEvent[], status = 200) =>
	new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
		status,
		headers: { "content-type": "text/event-stream" },
	});

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("preflightCapture", () => {
	it("passes the real capture ora's own admission accepted", () => {
		expect(preflightCapture(CAPTURE)).toBeNull();
	});

	it("rejects a shim version this build did not capture with", () => {
		// The server refuses this with 400 SHIM_VERSION_MISMATCH; catching it
		// here saves a 4 MB upload to be told so.
		expect(preflightCapture({ ...CAPTURE, shimVersion: "2" })).toMatch(/shim version 2/);
	});

	it("rejects the WHOLE capture for one oversized description", () => {
		// Deliberately mirrors the server: dropping the offending tool instead
		// would score the page as one that never registered it, which is a worse
		// answer than declining to score.
		const page = CAPTURE.pages[0];
		const capture = {
			...CAPTURE,
			pages: [
				{
					...page,
					tools: [{ ...page.tools[0], description: "x".repeat(4097) }, ...page.tools.slice(1)],
				},
			],
		};
		expect(preflightCapture(capture)).toMatch(/description for .* 4097 characters/);
	});

	it("rejects a schema that serializes past the cap", () => {
		const page = CAPTURE.pages[0];
		const capture = {
			...CAPTURE,
			pages: [
				{
					...page,
					tools: [{ ...page.tools[0], inputSchema: { blob: "y".repeat(33_000) } }],
				},
			],
		};
		expect(preflightCapture(capture)).toMatch(/inputSchema .* characters/);
	});

	it("carries $ref, $defs and oneOf through untouched", () => {
		// Bounded structurally, never by vocabulary. Stripping keywords would
		// change what the server scores.
		const page = CAPTURE.pages[0];
		const schema = {
			$defs: { q: { type: "string" } },
			oneOf: [{ $ref: "#/$defs/q" }, { type: "number" }],
		};
		const capture = {
			...CAPTURE,
			pages: [{ ...page, tools: [{ ...page.tools[0], inputSchema: schema }] }],
		};
		expect(preflightCapture(capture)).toBeNull();
	});
});

describe("prepareForIngest", () => {
	it("leaves the real capture's screenshot alone", () => {
		const { capture, droppedScreenshot } = prepareForIngest(CAPTURE);
		expect(droppedScreenshot).toBe(false);
		expect(capture.screenshot).not.toBeNull();
	});

	it("drops an oversized screenshot rather than failing the audit", () => {
		// The server does the same silently; dropping it here is what lets the
		// CLI say so, instead of the developer seeing `page-experience:
		// unmeasured` and blaming ora.
		const screenshot = CAPTURE.screenshot;
		if (!screenshot) throw new Error("fixture lost its screenshot");
		const { capture, droppedScreenshot } = prepareForIngest({
			...CAPTURE,
			screenshot: { ...screenshot, data: "z".repeat(2 * 1024 * 1024 + 1) },
		});
		expect(droppedScreenshot).toBe(true);
		expect(capture.screenshot).toBeNull();
	});
});

describe("ingestCapture", () => {
	it("returns the audit from the terminal done frame", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse([
					{ type: "phase", phase: "checks" },
					{ type: "tool-discovered", tool: CAPTURE.pages[0].tools[0] },
					{ type: "done", audit: AUDIT },
				]),
			),
		);
		const seen: string[] = [];
		const audit = await ingestCapture("http://localhost:3000", CAPTURE, {
			onEvent: (e) => seen.push(e.type),
		});
		expect(audit.score).toBe(73);
		// A withheld grade beside a real score is a normal state, not an error:
		// coverage 51 sits under the threshold because four model-dependent
		// checks went unmeasured.
		expect(audit.grade).toBeNull();
		expect(audit.evidenceCoverage).toBe(51);
		// Availability is on the published shape only - the stored record does
		// not carry it.
		expect(audit.availability.status).toBe("ready");
		expect(audit.source).toBe("local");
		expect(seen).toEqual(["phase", "tool-discovered", "done"]);
	});

	it("posts the capture to the ingest path with the url beside it", async () => {
		const fetchMock = vi.fn(async () => sse([{ type: "done", audit: AUDIT }]));
		vi.stubGlobal("fetch", fetchMock);
		await ingestCapture("http://localhost:3000/", CAPTURE, { baseUrl: "http://127.0.0.1:9999" });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:9999/api/webmcp/audit/ingest");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body)).url).toBe("http://localhost:3000/");
	});

	it("sends an api key as a bearer token when given one", async () => {
		const fetchMock = vi.fn(async () => sse([{ type: "done", audit: AUDIT }]));
		vi.stubGlobal("fetch", fetchMock);
		await ingestCapture("http://localhost:3000", CAPTURE, { apiKey: "sk-test" });
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer sk-test");
	});

	it("tells the user to upgrade on a shim mismatch, not that the API broke", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json({ code: "SHIM_VERSION_MISMATCH", error: "capture is shim 1, server scores 3" }, 400),
			),
		);
		const err = await ingestCapture("http://localhost:3000", CAPTURE).catch((e) => e);
		expect(err).toBeInstanceOf(WebmcpIngestError);
		expect(err.code).toBe("SHIM_VERSION_MISMATCH");
		expect(err.message).toMatch(/Upgrade/);
		expect(err.message).not.toMatch(/ingest failed/);
	});

	it("surfaces retry_after_ms from a 429", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json(
					{ error: "rate limited", bucket: "webmcp.audit_ingest", retry_after_ms: 42_000 },
					429,
					{
						"retry-after": "42",
					},
				),
			),
		);
		const err = await ingestCapture("http://localhost:3000", CAPTURE).catch((e) => e);
		expect(err.retryAfterMs).toBe(42_000);
		expect(err.message).toMatch(/retry in 42s/);
	});

	it("says nothing was spent when scoring is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ code: "SCORING_UNAVAILABLE", error: "no model credentials" }, 503)),
		);
		const err = await ingestCapture("http://localhost:3000", CAPTURE).catch((e) => e);
		expect(err.code).toBe("SCORING_UNAVAILABLE");
		expect(err.message).toMatch(/Nothing was spent/);
	});

	it("surfaces a terminal error frame instead of reporting a truncated stream", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse([
					{ type: "phase", phase: "checks" },
					{ type: "error", message: "capture worker unreachable", status: "error" },
				]),
			),
		);
		const err = await ingestCapture("http://localhost:3000", CAPTURE).catch((e) => e);
		expect(err.message).toMatch(/capture worker unreachable/);
	});

	it("refuses to treat a stream that ended early as a passing audit", async () => {
		// No terminal frame: reporting a grade nobody computed would be worse
		// than any error message.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sse([{ type: "phase", phase: "checks" }])),
		);
		await expect(ingestCapture("http://localhost:3000", CAPTURE)).rejects.toThrow(
			/ended before the audit completed/,
		);
	});
});
