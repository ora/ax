import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import quota402 from "../api/__fixtures__/studio/error-402-quota.json";
import { PlatformApiError } from "../api/platform";
import { createStudioClient, StudioConnectionError, StudioShapeError } from "../api/studio";
import { studioError } from "../api/studio-errors";
import { createRecord, markStopped, readRecord, type SetRecord } from "./record";
import {
	cancelStep,
	failureCode,
	followAndReport,
	launchAndReport,
	pickUpRecord,
	viewStep,
	withInterrupt,
} from "./report-flow";
import { parseSetSpec, planCells } from "./spec";

// The path from a written record to its report, below the commands. The full paths (launch,
// follow, every exit) run in src/commands/set.test.ts; these cases pin the pieces that test
// reaches only indirectly. The client is a real createStudioClient over a mocked fetch; error
// bodies are the fixtures in src/api/__fixtures__/studio/ (provenance in studio.test.ts).

const BASE = "https://platform.test";
const SITE = "linear.app";
const AGENTS = [
	{ harness: "claude-code", model: "claude-haiku-4-5-20251001" },
	{ harness: "claude-code", model: "claude-sonnet-5-5" },
];
const RUN_CALL = "ax journey 'Create an issue' --domain linear.app --levels --yes";

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers the key exchange and each create from `creates` in turn; any other call fails loudly. */
function studioMock(creates: Array<() => Response> = []) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const at = String(url).slice(BASE.length);
			if (at === "/auth/token") return asJson({ token: "bearer" });
			calls.push(`${init.method ?? "GET"} ${at}`);
			const reply = at === "/studio/v1/journeys" ? creates[calls.length - 1] : undefined;
			if (!reply) throw new Error(`unrouted ${init.method} ${at}`);
			return reply();
		}),
	);
	return { calls };
}

const client = () => createStudioClient({ apiKey: "ora_sk_local", baseUrl: BASE });

let dir: string;

function newSet(): SetRecord {
	const parsed = parseSetSpec({
		site: SITE,
		goals: ["Create an issue"],
		agents: "claude-code",
		levels: true,
	});
	if (!parsed.ok) throw new Error(parsed.error);
	const { cells } = planCells(parsed.spec);
	return createRecord({ spec: parsed.spec, agents: AGENTS, cells }, dir);
}

const flow = { waitMinutes: 30, json: false, now: () => 0, sleep: async () => {} };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-report-flow-"));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const logged = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
const errored = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

describe("withInterrupt", () => {
	it("aborts the phase's signal on Ctrl-C and takes its listener off after", async () => {
		const before = process.listenerCount("SIGINT");
		const aborted = await withInterrupt(async (signal) => {
			expect(process.listenerCount("SIGINT")).toBe(before + 1);
			process.emit("SIGINT");
			return signal.aborted;
		});
		expect(aborted).toBe(true);
		expect(process.listenerCount("SIGINT")).toBe(before);
	});

	it("takes its listener off when the phase throws", async () => {
		const before = process.listenerCount("SIGINT");
		await expect(
			withInterrupt(async () => {
				throw new RangeError("a bug in the phase");
			}),
		).rejects.toThrow(RangeError);
		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});

describe("failureCode", () => {
	it("is Studio's code, or the CLI's own for a failure that carries none", () => {
		expect(
			failureCode(studioError({ status: 500, payload: { error: "boom", code: "internal" } })),
		).toBe("internal");
		expect(failureCode(studioError({ status: 502, payload: null }))).toBe("API_ERROR");
		expect(failureCode(new StudioConnectionError(BASE, new TypeError("fetch failed")))).toBe(
			"API_UNREACHABLE",
		);
		expect(failureCode(new StudioShapeError("GET /studio/v1/usage", "a runs meter"))).toBe(
			"API_BAD_ANSWER",
		);
		const rejected = new PlatformApiError("ora rejected the API key (401). Check ORA_API_KEY.", {
			status: 401,
			payload: null,
		});
		expect(failureCode(rejected)).toBe("API_ERROR");
	});
});

describe("viewStep and cancelStep", () => {
	it("name the set and carry --json when it was given", () => {
		expect(viewStep("j-0123456789", false).call).toBe("ax journey view j-0123456789");
		expect(viewStep("j-0123456789", true).call).toBe("ax journey view j-0123456789 --json");
		expect(cancelStep("j-0123456789", true).call).toBe("ax journey cancel j-0123456789 --json");
	});
});

describe("pickUpRecord", () => {
	it("reads the record back and prints nothing", () => {
		const record = newSet();
		expect(pickUpRecord(record.id, false, dir)).toEqual(record);
		expect(errored()).toEqual([]);
	});
});

describe("followAndReport", () => {
	it("reports a set with no journey without a read, the stop on its incomplete line", async () => {
		const record = markStopped(newSet().id, "quota", 2, dir);
		const mock = studioMock();

		expect(await followAndReport({ ...flow, client: client(), record })).toBe("reported");

		expect(mock.calls).toEqual([]);
		expect(logged()).toContain(
			"This report is not complete: launching stopped at your plan's run limit. 2 runs never started.",
		);
		expect(logged().at(-1)).toMatch(/^Next: ax audit linear\.app {2}# /);
	});
});

describe("launchAndReport", () => {
	const launchInput = (record: SetRecord) => ({
		...flow,
		client: client(),
		record,
		agents: AGENTS,
		runCall: RUN_CALL,
		dir,
	});

	it("a gateway 502 on the first create: no journey, so Next is the run again", async () => {
		const record = newSet();
		studioMock([() => new Response("<html>bad gateway</html>", { status: 502 })]);

		expect(await launchAndReport(launchInput(record))).toBe("failed");

		expect(readRecord(record.id, dir)).toMatchObject({
			journeys: [],
			stoppedReason: "platform_down",
		});
		expect(errored().at(-1)).toBe(`Next: ${RUN_CALL}  # launches the same set again`);
		expect(errored().join("\n")).not.toContain("ax journey cancel");
		expect(logged()).toEqual([]);
	});

	it("a 402 on the first create says no run started, then reports, with no read", async () => {
		const record = newSet();
		const mock = studioMock([() => asJson(quota402, 402)]);

		expect(await launchAndReport(launchInput(record))).toBe("reported");

		// Two levels (need, brand) times two agents, and none of the four started.
		expect(mock.calls).toEqual(["POST /studio/v1/journeys"]);
		expect(errored()).toContain(
			"Your plan's run limit was reached, so launching stopped. 4 runs were not launched.",
		);
		expect(errored()).toContain("No run started.");
		expect(logged()).toContain(
			"This report is not complete: launching stopped at your plan's run limit. 4 runs never started.",
		);
	});
});
