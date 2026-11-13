import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendJourney,
	createRecord,
	DEFAULT_TRIALS_DIR,
	isTrialId,
	type JourneyEntry,
	listRecords,
	markStopped,
	readRecord,
	TRIAL_ID_PATTERN,
	type TrialRecord,
} from "./record";
import { parseTrialSpec, planCells, type TrialSpec } from "./spec";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-trial-record-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function specFor(site = "linear.app"): TrialSpec {
	const parsed = parseTrialSpec({
		site,
		tasks: ["Track a bug", "Plan a sprint"],
		agents: "claude-code/sonnet,codex/gpt-5",
		exact: `https://${site}/docs`,
		repeat: "2",
	});
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.spec;
}

function newRecord(site = "linear.app"): TrialRecord {
	const spec = specFor(site);
	return createRecord(
		{
			spec,
			agents: [
				{ harness: "claude-code", model: "sonnet" },
				{ harness: "codex", model: "gpt-5" },
			],
			cells: planCells(spec).cells,
		},
		dir,
	);
}

function entry(n: number, overrides: Partial<JourneyEntry> = {}): JourneyEntry {
	return {
		journeyId: `j-${n}`,
		task: 0,
		level: "brand",
		repeat: 1,
		runIds: [`r-${n}a`, `r-${n}b`],
		failed: [],
		createdAt: `2026-11-13T10:00:0${n}.000Z`,
		...overrides,
	};
}

describe("the id", () => {
	it("is t- plus ten lowercase characters", () => {
		const record = newRecord();
		expect(record.id).toMatch(TRIAL_ID_PATTERN);
		expect(TRIAL_ID_PATTERN.source).toBe("^t-[a-z0-9]{10}$");
	});

	it("differs between records", () => {
		expect(newRecord().id).not.toBe(newRecord().id);
	});

	it("accepts a well formed id and nothing else", () => {
		expect(isTrialId("t-abc123def0")).toBe(true);
		for (const bad of [
			"",
			"t-short",
			"t-ABC123DEF0",
			"t-abc123def01",
			"x-abc123def0",
			"t-../../",
		]) {
			expect(isTrialId(bad)).toBe(false);
		}
	});
});

describe("createRecord", () => {
	it("writes the record before any journey exists", () => {
		const record = newRecord();
		expect(record.journeys).toEqual([]);
		expect(record.stoppedReason).toBeUndefined();
		expect(readdirSync(dir)).toEqual([`${record.id}.json`]);
	});

	it("round trips the spec, the resolved agents and the cells", () => {
		const record = newRecord();
		const spec = specFor();
		expect(readRecord(record.id, dir)).toEqual({
			id: record.id,
			createdAt: record.createdAt,
			spec,
			agents: [
				{ harness: "claude-code", model: "sonnet" },
				{ harness: "codex", model: "gpt-5" },
			],
			cells: planCells(spec).cells,
			journeys: [],
		});
		expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);
	});

	it("creates the directory when it is missing", () => {
		const nested = join(dir, "a", "b");
		const spec = specFor();
		const record = createRecord({ spec, agents: [], cells: [] }, nested);
		expect(readRecord(record.id, nested)?.id).toBe(record.id);
	});
});

describe("appendJourney", () => {
	it("keeps entries in the order they were appended", () => {
		const { id } = newRecord();
		appendJourney(id, entry(1), dir);
		appendJourney(id, entry(2, { level: "exact" }), dir);
		appendJourney(id, entry(3, { repeat: 2 }), dir);
		const record = readRecord(id, dir);
		expect(record?.journeys.map((journey) => journey.journeyId)).toEqual(["j-1", "j-2", "j-3"]);
		expect(record?.journeys[1].level).toBe("exact");
	});

	it("stores a null journey id and per agent failures", () => {
		const { id } = newRecord();
		const failed = [{ harness: "codex", model: "gpt-5", reason: "gateway timeout" }];
		appendJourney(id, entry(1, { journeyId: null, runIds: [], failed }), dir);
		const stored = readRecord(id, dir)?.journeys[0];
		expect(stored?.journeyId).toBeNull();
		expect(stored?.failed).toEqual(failed);
	});

	it("returns the updated record", () => {
		const { id } = newRecord();
		expect(appendJourney(id, entry(1), dir).journeys).toHaveLength(1);
	});

	it("throws for a record that does not exist", () => {
		expect(() => appendJourney("t-aaaaaaaaaa", entry(1), dir)).toThrow(/no trial record/);
	});

	it("throws for an invalid id without touching the disk", () => {
		expect(() => appendJourney("../x", entry(1), dir)).toThrow(/invalid trial id/);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("markStopped", () => {
	it("records why launching stopped and how many runs never started", () => {
		const { id } = newRecord();
		appendJourney(id, entry(1), dir);
		const stopped = markStopped(id, "quota", 6, dir);
		expect(stopped.stoppedReason).toBe("quota");
		expect(stopped.notLaunched).toBe(6);
		const stored = readRecord(id, dir);
		expect(stored?.stoppedReason).toBe("quota");
		expect(stored?.notLaunched).toBe(6);
		expect(stored?.journeys).toHaveLength(1);
	});

	it("accepts every stop reason", () => {
		for (const reason of ["quota", "platform_down", "api_error", "interrupted"] as const) {
			const { id } = newRecord();
			expect(markStopped(id, reason, 0, dir).stoppedReason).toBe(reason);
		}
	});

	it("throws for an invalid id", () => {
		expect(() => markStopped("t-../../", "interrupted", 1, dir)).toThrow(/invalid trial id/);
	});
});

describe("atomic writes", () => {
	it("leaves no temp file behind after create, append or stop", () => {
		const { id } = newRecord();
		appendJourney(id, entry(1), dir);
		markStopped(id, "interrupted", 3, dir);
		expect(readdirSync(dir)).toEqual([`${id}.json`]);
	});

	it("leaves the old record intact and no temp file when a write fails", () => {
		const { id } = newRecord();
		const before = readFileSync(join(dir, `${id}.json`), "utf8");
		const circular: JourneyEntry = entry(1);
		(circular as unknown as { self: unknown }).self = circular;
		expect(() => appendJourney(id, circular, dir)).toThrow();
		expect(readFileSync(join(dir, `${id}.json`), "utf8")).toBe(before);
		expect(readdirSync(dir)).toEqual([`${id}.json`]);
	});
});

describe("readRecord", () => {
	it("returns null for an id that has no record", () => {
		expect(readRecord("t-aaaaaaaaaa", dir)).toBeNull();
	});

	it("returns null for a missing directory", () => {
		expect(readRecord("t-aaaaaaaaaa", join(dir, "nope"))).toBeNull();
	});

	it("rejects traversal ids before building a path", () => {
		const outside = join(dir, "x.json");
		writeFileSync(outside, JSON.stringify({ id: "x" }));
		const inner = join(dir, "inner");
		mkdirSync(inner);
		expect(readRecord("../x", inner)).toBeNull();
		expect(readRecord("t-../../", inner)).toBeNull();
		expect(readRecord("../x.json", inner)).toBeNull();
	});

	it("throws a named error for a file that is not a trial record", () => {
		writeFileSync(join(dir, "t-aaaaaaaaaa.json"), "{ not json");
		expect(() => readRecord("t-aaaaaaaaaa", dir)).toThrow(/t-aaaaaaaaaa/);
		writeFileSync(join(dir, "t-bbbbbbbbbb.json"), JSON.stringify({ id: "t-bbbbbbbbbb" }));
		expect(() => readRecord("t-bbbbbbbbbb", dir)).toThrow(/t-bbbbbbbbbb/);
	});
});

describe("listRecords", () => {
	it("returns one summary per file, newest first", () => {
		const first = newRecord("linear.app");
		appendJourney(first.id, entry(1), dir);
		appendJourney(first.id, entry(2, { runIds: ["r-x"] }), dir);
		const second = newRecord("stripe.com");
		const stored = readRecord(second.id, dir) as TrialRecord;
		writeFileSync(
			join(dir, `${second.id}.json`),
			JSON.stringify({ ...stored, createdAt: "2099-01-01T00:00:00.000Z" }),
		);
		const { records, skipped } = listRecords(dir);
		expect(skipped).toEqual([]);
		expect(records).toEqual([
			{
				id: second.id,
				createdAt: "2099-01-01T00:00:00.000Z",
				site: "stripe.com",
				journeys: 0,
				runs: 0,
			},
			{ id: first.id, createdAt: first.createdAt, site: "linear.app", journeys: 2, runs: 3 },
		]);
	});

	it("skips a file that does not parse and names it", () => {
		const good = newRecord();
		writeFileSync(join(dir, "t-corruptaaa.json"), "{ not json");
		writeFileSync(join(dir, "t-wrongshape.json"), JSON.stringify({ hello: "world" }));
		const { records, skipped } = listRecords(dir);
		expect(records.map((summary) => summary.id)).toEqual([good.id]);
		expect(skipped).toEqual(["t-corruptaaa.json", "t-wrongshape.json"]);
	});

	it("ignores files that are not trial records", () => {
		const good = newRecord();
		writeFileSync(join(dir, "notes.txt"), "hi");
		writeFileSync(join(dir, `.${good.id}.1234.tmp`), "{}");
		const { records, skipped } = listRecords(dir);
		expect(records).toHaveLength(1);
		expect(skipped).toEqual([]);
	});

	it("is empty when the directory does not exist", () => {
		expect(listRecords(join(dir, "nope"))).toEqual({ records: [], skipped: [] });
	});
});

describe("secrets", () => {
	function keysOf(value: unknown): string[] {
		if (Array.isArray(value)) return value.flatMap(keysOf);
		if (value && typeof value === "object") {
			return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
		}
		return [];
	}

	it("never serializes a key or token field", () => {
		const { id } = newRecord();
		appendJourney(id, entry(1), dir);
		markStopped(id, "api_error", 2, dir);
		const text = readFileSync(join(dir, `${id}.json`), "utf8");
		const keys = keysOf(JSON.parse(text)).map((key) => key.toLowerCase());
		expect(keys).not.toContain("ora_api_key");
		expect(keys.filter((key) => key.includes("token") || key.includes("bearer"))).toEqual([]);
		expect(text).not.toMatch(/ORA_API_KEY|Bearer/);
	});
});

describe("the default directory", () => {
	it("is ~/.ax/trials", () => {
		expect(DEFAULT_TRIALS_DIR).toMatch(/[\\/]\.ax[\\/]trials$/);
	});
});
