import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CountedRun, countTrial, type TrialShape } from "./count";
import type { FollowEnd } from "./follow";
import type { Level } from "./levels";
import type { Bucket } from "./outcome";
import { appendJourney, createRecord, markStopped, type StoppedReason } from "./record";
import { agentsOf, isComplete, type ReportInput, reportJson } from "./report-json";
import { parseTrialSpec, planCells } from "./spec";

// The inputs are built the way render-report.test.ts builds them (a spec from parseTrialSpec, a
// record from createRecord and appendJourney in a temp directory, counts from the real countTrial)
// with the runs trimmed to what the document and the completeness rule read. The server strings
// are the shapes outcome.test.ts uses: "timeout" is an excluded status, and "run gate unavailable"
// is Studio's start error (oramono apps/studio-service/src/journeys/journeys-service.test.ts:629).

const A = "claude-code/sonnet";
const B = "codex/gpt-5";
const FAILED_TO_START = "run gate unavailable";
const NEED_TASK = "Find how to create an issue from the API";
const BRAND_TASK = "Find how to create a Linear issue from the API";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-trial-json-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
	tasks?: string[];
	agents?: string[];
	repeat?: number;
	exact?: string;
	runs: CountedRun[];
	stopped?: { reason: StoppedReason; notLaunched: number };
	ended?: FollowEnd;
}

function build(scenario: Scenario): ReportInput {
	const agents = scenario.agents ?? [A];
	const parsed = parseTrialSpec({
		site: "linear.app",
		tasks: scenario.tasks ?? [NEED_TASK],
		agents: agents.join(","),
		exact: scenario.exact,
		repeat: String(scenario.repeat ?? 1),
	});
	if (!parsed.ok) throw new Error(parsed.error);
	const { spec } = parsed;
	const { cells } = planCells(spec);
	let record = createRecord(
		{
			spec,
			agents: agents.map((label) => {
				const [harness, model] = label.split("/");
				return { harness, model };
			}),
			cells,
		},
		dir,
	);
	for (const cell of cells) {
		record = appendJourney(
			record.id,
			{
				journeyId: `journey-${cell.task}-${cell.level}`,
				task: cell.task,
				level: cell.level,
				repeat: 1,
				runIds: [],
				failed: [],
				createdAt: record.createdAt,
			},
			dir,
		);
	}
	if (scenario.stopped) {
		record = markStopped(record.id, scenario.stopped.reason, scenario.stopped.notLaunched, dir);
	}
	const shape: TrialShape = {
		tasks: spec.tasks,
		levelsByTask: spec.tasks.map((_, task) =>
			cells.filter((cell) => cell.task === task).map((cell) => cell.level),
		),
		agents,
		plannedPerCell: spec.repeat,
	};
	return { record, count: countTrial(scenario.runs, shape), ended: scenario.ended ?? "settled" };
}

function run(level: Level, bucket: Bucket, fields: Partial<CountedRun> = {}): CountedRun {
	return { task: 0, level, agent: A, repeat: 1, bucket, flags: null, ...fields };
}

function many(
	level: Level,
	bucket: Bucket,
	n: number,
	fields: Partial<CountedRun> = {},
): CountedRun[] {
	return Array.from({ length: n }, (_, index) =>
		run(level, bucket, { repeat: index + 1, ...fields }),
	);
}

describe("reportJson", () => {
	it("has the documented keys, raw values and the fraction rate", () => {
		const input = build({
			tasks: [NEED_TASK, BRAND_TASK],
			agents: [A, B],
			repeat: 5,
			exact: "https://linear.app/developers",
			runs: [
				...many("need", "satisfied", 4),
				...many("need", "unsatisfied", 1, { repeat: 5 }),
				run("need", "excluded", { agent: B, rawStatus: "timeout" }),
				run("need", "not_gradable", { agent: B, repeat: 2, rawVerdict: "inconclusive" }),
				run("brand", "excluded", { agent: B, reason: FAILED_TO_START }),
			],
			stopped: { reason: "quota", notLaunched: 3 },
			ended: "detached",
		});
		const doc = reportJson(input);
		expect(Object.keys(doc)).toEqual([
			"trialId",
			"site",
			"createdAt",
			"complete",
			"levels",
			"skippedLevels",
			"agents",
			"cells",
			"gaps",
			"shortLevels",
			"journeys",
			"notLaunched",
			"stoppedReason",
			"ended",
		]);
		expect(doc.trialId).toBe(input.record.id);
		expect(doc.site).toBe("linear.app");
		expect(doc.createdAt).toBe(input.record.createdAt);
		expect(doc.agents).toEqual([A, B]);
		expect(doc.levels).toEqual([
			{ task: 0, text: NEED_TASK, levels: ["need", "brand", "exact"] },
			{ task: 1, text: BRAND_TASK, levels: ["brand", "exact"] },
		]);
		expect(doc.skippedLevels).toEqual([
			expect.objectContaining({ task: 0, level: "docs" }),
			expect.objectContaining({ task: 1, level: "need" }),
			expect.objectContaining({ task: 1, level: "docs" }),
		]);
		const first = doc.cells.find((c) => c.task === 0 && c.level === "need" && c.agent === A);
		expect(first?.rate).toBe(0.8);
		const second = doc.cells.find((c) => c.task === 0 && c.level === "need" && c.agent === B);
		expect(second?.excluded).toEqual([{ value: "timeout", count: 1 }]);
		expect(second?.notGradable).toEqual([{ value: "inconclusive", count: 1 }]);
		const brand = doc.cells.find((c) => c.task === 0 && c.level === "brand" && c.agent === B);
		expect(brand?.neverStarted).toEqual([{ value: FAILED_TO_START, count: 1 }]);
		expect(doc.journeys[0]).toEqual({
			journeyId: "journey-0-need",
			task: 0,
			level: "need",
			repeat: 1,
		});
		expect(Object.keys(doc.journeys[0])).toEqual(["journeyId", "task", "level", "repeat"]);
		expect(doc.notLaunched).toBe(3);
		expect(doc.stoppedReason).toBe("quota");
		expect(doc.ended).toBe("detached");
		expect(doc.complete).toBe(false);
		expect(doc.gaps).toEqual(input.count.gaps);
		expect(doc.shortLevels).toEqual(input.count.shortLevels);
	});

	it("reports no stop as null and zero runs not launched, and a null rate below the floor", () => {
		const doc = reportJson(build({ runs: [run("need", "satisfied")] }));
		expect(doc.stoppedReason).toBeNull();
		expect(doc.notLaunched).toBe(0);
		expect(doc.ended).toBe("settled");
		expect(doc.cells[0].rate).toBeNull();
	});

	it("keeps a journey with no id as null", () => {
		const input = build({ runs: [run("need", "satisfied")] });
		const record = appendJourney(
			input.record.id,
			{
				journeyId: null,
				task: 0,
				level: "need",
				repeat: 2,
				runIds: [],
				failed: [],
				createdAt: input.record.createdAt,
			},
			dir,
		);
		const withNull = { ...input, record };
		expect(reportJson(withNull).journeys.at(-1)).toEqual({
			journeyId: null,
			task: 0,
			level: "need",
			repeat: 2,
		});
	});

	it("round trips through JSON", () => {
		const doc = reportJson(build({ runs: [run("need", "satisfied")] }));
		expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
	});

	it("keeps server strings raw, esc sequences included", () => {
		const esc = "\u001b[2J";
		const agent = `evil/mod${esc}el`;
		const doc = reportJson(
			build({
				agents: [agent],
				runs: [
					run("need", "excluded", { agent, rawStatus: `time${esc}out` }),
					run("need", "excluded", { agent, repeat: 2, reason: `gate${esc}down` }),
					run("need", "not_gradable", { agent, repeat: 3, rawVerdict: `odd${esc}verdict` }),
				],
			}),
		);
		expect(doc.agents).toEqual([agent]);
		expect(doc.cells[0].excluded[0].value).toBe(`time${esc}out`);
		expect(doc.cells[0].neverStarted[0].value).toBe(`gate${esc}down`);
		expect(doc.cells[0].notGradable[0].value).toBe(`odd${esc}verdict`);
	});
});

describe("isComplete", () => {
	it("is true when launch ran, following settled and nothing is in flight or ungraded", () => {
		expect(isComplete(build({ runs: [run("need", "satisfied")] }))).toBe(true);
		expect(reportJson(build({ runs: [run("need", "satisfied")] })).complete).toBe(true);
	});

	it.each<StoppedReason>(["quota", "platform_down", "api_error", "interrupted"])(
		"is false after a %s stop, however following ended",
		(reason) => {
			const input = build({
				runs: [run("need", "satisfied")],
				stopped: { reason, notLaunched: 1 },
			});
			expect(isComplete(input)).toBe(false);
		},
	);

	it.each<FollowEnd>(["settle_limit", "wait_limit", "detached", "read_failed"])(
		"is false when following ended %s",
		(ended) => {
			expect(isComplete(build({ runs: [run("need", "satisfied")], ended }))).toBe(false);
		},
	);

	it("is false with a run in flight, even if following said settled", () => {
		expect(isComplete(build({ runs: [run("need", "in_flight")] }))).toBe(false);
	});

	it("is false with a run awaiting a grade, even if following said settled", () => {
		expect(isComplete(build({ runs: [run("need", "not_graded_yet")] }))).toBe(false);
	});

	it("stays true with excluded and not gradable runs, which are final", () => {
		const input = build({
			repeat: 3,
			runs: [
				run("need", "satisfied"),
				run("need", "excluded", { repeat: 2, rawStatus: "timeout" }),
				run("need", "not_gradable", { repeat: 3, rawVerdict: "inconclusive" }),
			],
		});
		expect(isComplete(input)).toBe(true);
	});
});

describe("agentsOf", () => {
	it("lists the columns in order, extra labels included", () => {
		const input = build({ agents: [A, B], runs: [] });
		expect(agentsOf(input.count)).toEqual([A, B]);
	});
});
