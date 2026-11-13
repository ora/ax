import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cancel from "../api/__fixtures__/studio/cancel.json";
import missingScope403 from "../api/__fixtures__/studio/error-403-missing-scope.json";
import { createStudioClient } from "../api/studio";
import { appendJourney, createRecord, type JourneyEntry, type TrialRecord } from "../trial/record";
import { GET_A_KEY, PRODUCT_NOT_GRANTED_MESSAGE } from "../trial/render-preview";
import { parseTrialSpec, planCells } from "../trial/spec";
import { EXIT } from "./audit";
import { type TrialCancelInput, trialCancelCommand, trialListCommand } from "./trial-records";

// Records are real files in a temp directory, written with createRecord and appendJourney. The
// cancel call goes through a real createStudioClient over a mocked fetch, so each error has the
// shape the client really throws. Fixtures: src/api/__fixtures__/studio/ (provenance in
// src/api/studio.test.ts): cancel.json answers the happy path, error-403-missing-scope.json the
// missing scope. The PRODUCT_NOT_GRANTED body is that 403 with its code swapped, and the 500 is a
// plain Studio error body.

const BASE = "https://platform.test";
const KEY_NEXT = "ORA_API_KEY=<Front API key> ax trial cancel";

const asJson = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const PRODUCT_403 = { error: "Forbidden", code: "PRODUCT_NOT_GRANTED" };
const SERVER_500 = { error: "boom", code: "internal" };

type Reply = () => Response | Promise<Response>;

/** Answers the key exchange, then records every other call; a call with no reply fails loudly. */
function studioMock(reply?: Reply) {
	const bodies: Array<{ url: string; method: string; body: unknown }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const at = String(url);
			if (at.endsWith("/auth/token")) return asJson({ token: "bearer" });
			bodies.push({
				url: at,
				method: init.method ?? "GET",
				body: init.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (!reply) throw new Error(`unrouted ${init.method} ${at}`);
			return reply();
		}),
	);
	return { calls: bodies };
}

const client = () => createStudioClient({ apiKey: "ora_sk_local", baseUrl: BASE });

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-trial-records-"));
	vi.stubEnv("ORA_API_KEY", "ora_sk_local");
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	process.exitCode = undefined;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

const stdoutWrites = () =>
	vi
		.mocked(process.stdout.write)
		.mock.calls.map((c) => String(c[0]))
		.join("");
const logged = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
const errored = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

function newTrial(site = "linear.app"): TrialRecord {
	const parsed = parseTrialSpec({
		site,
		tasks: ["Create an issue", "Plan a sprint"],
		exact: `https://${site}/developers`,
	});
	if (!parsed.ok) throw new Error(parsed.error);
	return createRecord(
		{
			spec: parsed.spec,
			agents: [{ harness: "claude-code", model: "claude-sonnet-5-5" }],
			cells: planCells(parsed.spec).cells,
		},
		dir,
	);
}

function entry(n: number, runIds: string[]): JourneyEntry {
	return {
		journeyId: `j-${n}`,
		task: 0,
		level: "brand",
		repeat: 1,
		runIds,
		failed: [],
		createdAt: `2026-11-13T10:00:0${n}.000Z`,
	};
}

/** A trial with two journeys holding the three run ids cancel.json answers for. */
function launchedTrial(): { record: TrialRecord; runIds: string[] } {
	const record = newTrial();
	const runIds = [...cancel.canceled, ...cancel.alreadyTerminal, ...cancel.skipped];
	appendJourney(record.id, entry(1, runIds.slice(0, 2)), dir);
	appendJourney(record.id, entry(2, runIds.slice(2)), dir);
	return { record, runIds };
}

const cancelIt = (id: string, json = false, extra: { client?: TrialCancelInput["client"] } = {}) =>
	trialCancelCommand({ id, json, trialsDir: dir, client: extra.client ?? client });

describe("trialListCommand", () => {
	it("prints one line per record and asks no server", () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const a = newTrial("linear.app");
		appendJourney(a.id, entry(1, ["r1", "r2"]), dir);
		const b = newTrial("stripe.com");

		expect(trialListCommand({ json: false, trialsDir: dir })).toBe(EXIT.OK);

		const lines = logged();
		expect(lines).toHaveLength(3);
		const lineA = lines.find((line) => line.startsWith(a.id));
		const lineB = lines.find((line) => line.startsWith(b.id));
		expect(lineA).toContain(a.createdAt);
		expect(lineA).toContain("linear.app");
		expect(lineA).toContain("1 journey, 2 runs");
		expect(lineB).toContain("stripe.com");
		expect(lineB).toContain("0 journeys, 0 runs");
		expect(lines[2]).toMatch(/^Next: ax trial view t-[a-z0-9]{10} {2}# /);
		expect(errored()).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(stdoutWrites()).toBe("");
	});

	it("--json prints ax's own summaries on stdout and nothing else there", () => {
		const a = newTrial();
		appendJourney(a.id, entry(1, ["r1", "r2", "r3"]), dir);

		expect(trialListCommand({ json: true, trialsDir: dir })).toBe(EXIT.OK);

		expect(JSON.parse(stdoutWrites())).toEqual({
			records: [{ id: a.id, createdAt: a.createdAt, site: "linear.app", journeys: 1, runs: 3 }],
			skipped: [],
		});
		expect(console.log).not.toHaveBeenCalled();
		expect(errored()).toHaveLength(1);
		expect(errored()[0]).toBe(`Next: ax trial view ${a.id}  # read the newest trial's report`);
	});

	it("says there are no trials yet, with a Next line to start one", () => {
		expect(trialListCommand({ json: false, trialsDir: join(dir, "missing") })).toBe(EXIT.OK);
		expect(logged()).toEqual([
			"No trials on this machine yet.",
			"Next: ax trial run <site> --task <task>  # start a trial; it is recorded here",
		]);
		expect(errored()).toEqual([]);
	});

	it("names a corrupt file on stderr and still lists the rest", () => {
		const a = newTrial();
		writeFileSync(join(dir, "t-abcdef0123.json"), "{not json");

		expect(trialListCommand({ json: false, trialsDir: dir })).toBe(EXIT.OK);

		expect(logged()).toHaveLength(2);
		expect(errored()).toHaveLength(1);
		expect(errored()[0]).toBe(
			"Skipped 1 file that is not a readable trial record: t-abcdef0123.json",
		);

		vi.mocked(process.stdout.write).mockClear();
		expect(trialListCommand({ json: true, trialsDir: dir })).toBe(EXIT.OK);
		expect(JSON.parse(stdoutWrites())).toMatchObject({
			records: [{ id: a.id }],
			skipped: ["t-abcdef0123.json"],
		});
	});
});

describe("trialCancelCommand refusals", () => {
	it("refuses an id that is not a trial id (exit 2), without reading anything", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		expect(await cancelIt("../../etc/passwd")).toBe(EXIT.USAGE);
		expect(errored()[0]).toBe('"../../etc/passwd" is not a trial id. Ids look like t-0123456789.');
		expect(errored()[1]).toMatch(/^Next: ax trial list {2}# /);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refuses an unknown id (exit 2)", async () => {
		expect(await cancelIt("t-0000000000")).toBe(EXIT.USAGE);
		expect(errored()[0]).toBe("No trial t-0000000000 on this machine.");
		expect(errored()[1]).toMatch(/^Next: ax trial list {2}# /);
	});

	it("refuses a corrupt record and names the file (exit 2)", async () => {
		writeFileSync(join(dir, "t-abcdef0123.json"), "{not json");
		expect(await cancelIt("t-abcdef0123")).toBe(EXIT.USAGE);
		expect(errored()[0]).toContain("The record t-abcdef0123.json is damaged");
		expect(errored()[0]).toContain(join(dir, "t-abcdef0123.json"));
	});

	it("rethrows a read failure that is not a corrupt record", async () => {
		// A directory where the record file should be: readFileSync fails with EISDIR, not ENOENT.
		mkdirSync(join(dir, "t-abcdef0123.json"));
		await expect(cancelIt("t-abcdef0123")).rejects.toThrow(/EISDIR/);
	});

	it("exits 2 with the key copy and a Next line when ORA_API_KEY is unset", async () => {
		const { record } = launchedTrial();
		vi.stubEnv("ORA_API_KEY", "");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		expect(await cancelIt(record.id)).toBe(EXIT.USAGE);

		expect(errored()[0]).toBe(GET_A_KEY);
		expect(errored()[1]).toMatch(new RegExp(`^Next: ${KEY_NEXT} ${record.id} {2}# `));
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("says nothing started when the record has no run ids, and makes no call (exit 0)", async () => {
		const record = newTrial();
		appendJourney(record.id, entry(1, []), dir);
		vi.stubEnv("ORA_API_KEY", "");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		expect(await cancelIt(record.id)).toBe(EXIT.OK);

		expect(logged()).toEqual([
			`Trial ${record.id} started no runs, so there is nothing to cancel.`,
		]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(stdoutWrites()).toBe("");
	});

	it("--json with no run ids prints an empty report as the one document", async () => {
		const record = newTrial();
		expect(await cancelIt(record.id, true)).toBe(EXIT.OK);
		expect(JSON.parse(stdoutWrites())).toEqual({
			requested: 0,
			canceled: [],
			alreadyTerminal: [],
			skipped: [],
		});
		expect(console.log).not.toHaveBeenCalled();
		expect(errored()).toEqual([
			`Trial ${record.id} started no runs, so there is nothing to cancel.`,
		]);
	});
});

describe("trialCancelCommand against Studio", () => {
	it("sends every recorded run id in one call and prints the four counts (exit 0)", async () => {
		const { record, runIds } = launchedTrial();
		const mock = studioMock(() => asJson(cancel));

		expect(await cancelIt(record.id)).toBe(EXIT.OK);

		expect(mock.calls).toEqual([
			{ url: `${BASE}/studio/v1/runs/cancel`, method: "POST", body: { runIds } },
		]);
		expect(logged()).toEqual([
			`Asked to cancel 3 runs for trial ${record.id}.`,
			"  canceled          1",
			"  already finished  1",
			"  skipped           1",
			`Next: ax trial view ${record.id}  # read the report for what finished`,
		]);
		expect(errored()).toEqual([]);
		expect(stdoutWrites()).toBe("");
	});

	it("--json prints Studio's answer as the fixture, with every person line on stderr", async () => {
		const { record } = launchedTrial();
		studioMock(() => asJson(cancel));

		expect(await cancelIt(record.id, true)).toBe(EXIT.OK);

		expect(JSON.parse(stdoutWrites())).toEqual(cancel);
		expect(console.log).not.toHaveBeenCalled();
		expect(errored()).toEqual([
			`Next: ax trial view ${record.id} --json  # read the report for what finished`,
		]);
	});

	it("names the missing scope and prints the key copy on a 403 (exit 2)", async () => {
		const { record } = launchedTrial();
		const missing = { ...missingScope403, details: { missing: ["runs:write"] } };
		studioMock(() => asJson(missing, 403));

		expect(await cancelIt(record.id)).toBe(EXIT.USAGE);

		expect(errored()[0]).toBe(`Your API key is missing this scope: runs:write.\n${GET_A_KEY}`);
		expect(errored()[1]).toMatch(new RegExp(`^Next: ${KEY_NEXT} ${record.id} {2}# `));
	});

	it("--json on a 403 prints Studio's error body untouched", async () => {
		const { record } = launchedTrial();
		const missing = { ...missingScope403, details: { missing: ["runs:write"] } };
		studioMock(() => asJson(missing, 403));

		expect(await cancelIt(record.id, true)).toBe(EXIT.USAGE);

		expect(JSON.parse(stdoutWrites())).toEqual(missing);
		expect(console.log).not.toHaveBeenCalled();
	});

	it("prints the product message on a PRODUCT_NOT_GRANTED 403 (exit 2)", async () => {
		const { record } = launchedTrial();
		studioMock(() => asJson(PRODUCT_403, 403));

		expect(await cancelIt(record.id)).toBe(EXIT.USAGE);

		expect(errored()[0]).toBe(PRODUCT_NOT_GRANTED_MESSAGE);
		expect(errored()[1]).toMatch(new RegExp(`^Next: ${KEY_NEXT} ${record.id} {2}# `));
	});

	it("exits 3 with the same cancel call as the Next line on a 500", async () => {
		const { record } = launchedTrial();
		studioMock(() => asJson(SERVER_500, 500));

		expect(await cancelIt(record.id)).toBe(EXIT.API);

		expect(errored()[0]).toMatch(/^Could not cancel the runs: /);
		expect(errored()[1]).toBe(
			`Next: ax trial cancel ${record.id}  # retry; runs that already stopped are reported, not canceled twice`,
		);
		expect(stdoutWrites()).toBe("");
	});

	it("--json on a 500 keeps stdout to Studio's error body and the retry keeps --json", async () => {
		const { record } = launchedTrial();
		studioMock(() => asJson(SERVER_500, 500));

		expect(await cancelIt(record.id, true)).toBe(EXIT.API);

		expect(JSON.parse(stdoutWrites())).toEqual(SERVER_500);
		expect(errored()[1]).toContain(`Next: ax trial cancel ${record.id} --json  # retry`);
	});

	it("exits 3 with the envelope under --json when Studio cannot be reached", async () => {
		const { record } = launchedTrial();
		studioMock(() => {
			throw new TypeError("fetch failed");
		});

		expect(await cancelIt(record.id, true)).toBe(EXIT.API);

		expect(JSON.parse(stdoutWrites())).toEqual({
			error: {
				code: "API_UNREACHABLE",
				message: expect.stringContaining("could not reach ora at"),
				next: `ax trial cancel ${record.id} --json`,
			},
		});
	});

	it("exits 3 when the key exchange fails", async () => {
		const { record } = launchedTrial();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => asJson({ error: "Unauthorized" }, 401)),
		);
		expect(await cancelIt(record.id)).toBe(EXIT.API);
		expect(errored()[1]).toMatch(/^Next: ax trial cancel /);
	});

	it("lets an error that is not the platform's propagate", async () => {
		const { record } = launchedTrial();
		const broken = () => ({
			cancelRuns: async () => {
				throw new TypeError("a bug in ax");
			},
		});
		await expect(cancelIt(record.id, false, { client: broken })).rejects.toThrow("a bug in ax");
	});

	it("blanks control characters in what Studio says before it reaches the terminal", async () => {
		const { record } = launchedTrial();
		studioMock(() => asJson({ error: "bad\u001b[31m news", code: "internal" }, 500));
		expect(await cancelIt(record.id)).toBe(EXIT.API);
		expect(errored()[0]).not.toContain("\u001b");
	});
});
