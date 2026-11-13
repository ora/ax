import { describe, expect, it } from "vitest";
import studioOraAi from "./__fixtures__/studio-trajectories/run-49ab0c88.json";
import {
	type CountedRun,
	countTrial,
	GAP_MIN_DIFFERENCE,
	LEVEL_LAYER,
	RATE_FLOOR,
	type TrialCount,
	type TrialShape,
} from "./count";
import { deriveTrialFlags, type TrialStep } from "./flags";
import type { Level } from "./levels";
import type { Bucket } from "./outcome";
import blockedFirst403 from "./vendor/__fixtures__/run-flags/blocked-first-403.json";

// count.ts is arithmetic over runs, so every input here is a CountedRun array built in this file
// and named for what it isolates; there is no recorded payload to copy. Where a run needs a
// server value, it is Studio's own: FAILED_TO_START is the start error in oramono
// apps/studio-service/src/journeys/journeys-service.test.ts:629 (the value outcome.test.ts uses).
// Flags come from deriveTrialFlags over flags.test.ts's fixtures, so their shape is the producer's.

const AGENT_ONE = "agent-one/model-a";
const AGENT_TWO = "agent-two/model-b";
const FAILED_TO_START = "run gate unavailable";

const BLOCKED = deriveTrialFlags(
	blockedFirst403.trajectory.steps as TrialStep[],
	blockedFirst403.domain,
);
const NEVER_VISITED = deriveTrialFlags(studioOraAi.steps, "linear.app");
const CLEAN = deriveTrialFlags(studioOraAi.steps, "ora.ai");

function run(
	level: Level,
	bucket: Bucket,
	repeat: number,
	fields: Partial<CountedRun> = {},
): CountedRun {
	return { task: 0, level, agent: AGENT_ONE, repeat, bucket, flags: null, ...fields };
}

/** One run per bucket listed, repeats numbered from 1. */
function runsOf(level: Level, buckets: Bucket[], fields: Partial<CountedRun> = {}): CountedRun[] {
	return buckets.map((bucket, index) => run(level, bucket, index + 1, fields));
}

function shape(
	levelsByTask: Level[][],
	agents: string[] = [AGENT_ONE],
	plannedPerCell = 1,
): TrialShape {
	return {
		tasks: levelsByTask.map((_, index) => `Task ${index + 1}`),
		levelsByTask,
		agents,
		plannedPerCell,
	};
}

function cellOf(count: TrialCount, level: Level, agent = AGENT_ONE, task = 0) {
	const cell = count.cells.find(
		(entry) => entry.task === task && entry.level === level && entry.agent === agent,
	);
	if (!cell) throw new Error(`no cell for task ${task}, ${level}, ${agent}`);
	return cell;
}

describe("constants", () => {
	it("pins the rate floor, the gap threshold and each upper level's layer", () => {
		expect(RATE_FLOOR).toBe(5);
		expect(GAP_MIN_DIFFERENCE).toBe(2);
		expect(LEVEL_LAYER).toEqual({
			brand: "Discovery",
			docs: "Discovery",
			exact: "Access and Usability",
		});
	});
});

describe("cells", () => {
	it("an empty trial has no cells, gaps or short levels", () => {
		expect(countTrial([], shape([]))).toEqual({ cells: [], gaps: [], shortLevels: [] });
	});

	it("plans one cell per task, level and agent in ladder order, each with no data before runs", () => {
		const LEVELS_GIVEN_OUT_OF_ORDER: Level[][] = [["exact", "brand"], ["need"]];
		const count = countTrial([], shape(LEVELS_GIVEN_OUT_OF_ORDER, [AGENT_ONE, AGENT_TWO]));
		expect(count.cells.map((cell) => [cell.task, cell.level, cell.agent])).toEqual([
			[0, "brand", AGENT_ONE],
			[0, "brand", AGENT_TWO],
			[0, "exact", AGENT_ONE],
			[0, "exact", AGENT_TWO],
			[1, "need", AGENT_ONE],
			[1, "need", AGENT_TWO],
		]);
		for (const cell of count.cells) {
			expect(cell).toMatchObject({ runs: 0, gradable: 0, rate: null });
		}
	});

	it("a cell with 5 gradable runs shows a rate of satisfied over gradable", () => {
		const FIVE_GRADABLE = runsOf("brand", [
			"satisfied",
			"satisfied",
			"satisfied",
			"partial",
			"unsatisfied",
		]);
		expect(
			cellOf(countTrial(FIVE_GRADABLE, shape([["brand"]], [AGENT_ONE], 5)), "brand"),
		).toMatchObject({ runs: 5, satisfied: 3, partial: 1, unsatisfied: 1, gradable: 5, rate: 0.6 });
	});

	it("a cell with 3 gradable runs shows counts only", () => {
		const THREE_GRADABLE = runsOf("brand", ["satisfied", "satisfied", "unsatisfied"]);
		expect(
			cellOf(countTrial(THREE_GRADABLE, shape([["brand"]], [AGENT_ONE], 3)), "brand"),
		).toMatchObject({ runs: 3, satisfied: 2, partial: 0, unsatisfied: 1, gradable: 3, rate: null });
	});

	it("one gradable run under the floor still shows counts only", () => {
		const FOUR_GRADABLE = runsOf("brand", ["satisfied", "satisfied", "satisfied", "satisfied"]);
		expect(
			cellOf(countTrial(FOUR_GRADABLE, shape([["brand"]], [AGENT_ONE], 4)), "brand").rate,
		).toBe(null);
	});

	it("runs outside the three gradable buckets never reach the rate", () => {
		const FIVE_GRADABLE_AND_ONE_OF_EACH_OTHER = [
			...runsOf("brand", ["satisfied", "satisfied", "satisfied", "partial", "unsatisfied"]),
			run("brand", "not_graded_yet", 6),
			run("brand", "in_flight", 7),
			run("brand", "excluded", 8, { rawStatus: "lost" }),
			run("brand", "excluded", 9, { reason: FAILED_TO_START }),
			run("brand", "not_gradable", 10, { rawVerdict: "abandoned" }),
		];
		const cell = cellOf(
			countTrial(FIVE_GRADABLE_AND_ONE_OF_EACH_OTHER, shape([["brand"]], [AGENT_ONE], 10)),
			"brand",
		);
		expect(cell).toMatchObject({
			runs: 10,
			gradable: 5,
			rate: 0.6,
			notGradedYet: 1,
			inFlight: 1,
		});
	});

	it("tallies excluded runs by raw status, never started runs by reason, and not gradable by verdict", () => {
		const EXCLUDED_NEVER_STARTED_AND_UNGRADABLE: CountedRun[] = [
			run("brand", "excluded", 1, { rawStatus: "failed" }),
			run("brand", "excluded", 2, { rawStatus: "lost" }),
			run("brand", "excluded", 3, { rawStatus: "failed" }),
			run("brand", "excluded", 4, { reason: FAILED_TO_START }),
			run("brand", "excluded", 5, { reason: FAILED_TO_START }),
			run("brand", "not_gradable", 6, { rawVerdict: "constructor" }),
			run("brand", "not_gradable", 7, { rawVerdict: "abandoned" }),
		];
		const cell = cellOf(
			countTrial(EXCLUDED_NEVER_STARTED_AND_UNGRADABLE, shape([["brand"]], [AGENT_ONE], 7)),
			"brand",
		);
		expect(cell.excluded).toEqual([
			{ value: "failed", count: 2 },
			{ value: "lost", count: 1 },
		]);
		expect(cell.neverStarted).toEqual([{ value: FAILED_TO_START, count: 2 }]);
		expect(cell.notGradable).toEqual([
			{ value: "abandoned", count: 1 },
			{ value: "constructor", count: 1 },
		]);
		expect(cell).toMatchObject({ runs: 7, gradable: 0, rate: null });
	});

	it("counts the blocked and never visited flags per cell, and a run with no flags as neither", () => {
		expect([BLOCKED.blocked.flagged, BLOCKED.never_visited.flagged]).toEqual([true, false]);
		expect([NEVER_VISITED.blocked.flagged, NEVER_VISITED.never_visited.flagged]).toEqual([
			false,
			true,
		]);
		expect([CLEAN.blocked.flagged, CLEAN.never_visited.flagged]).toEqual([false, false]);
		const FLAGGED_RUNS_ACROSS_TWO_AGENTS: CountedRun[] = [
			run("need", "unsatisfied", 1, { flags: BLOCKED }),
			run("need", "unsatisfied", 2, { flags: NEVER_VISITED }),
			run("need", "unsatisfied", 3, { flags: NEVER_VISITED }),
			run("need", "satisfied", 4, { flags: CLEAN }),
			run("need", "unsatisfied", 5, { flags: null }),
			run("need", "unsatisfied", 1, { agent: AGENT_TWO, flags: BLOCKED }),
		];
		const count = countTrial(
			FLAGGED_RUNS_ACROSS_TWO_AGENTS,
			shape([["need"]], [AGENT_ONE, AGENT_TWO], 5),
		);
		expect(cellOf(count, "need").flags).toEqual({ blocked: 1, never_visited: 2 });
		expect(cellOf(count, "need", AGENT_TWO).flags).toEqual({ blocked: 1, never_visited: 0 });
	});

	it("refuses a run that has no cell in the trial instead of dropping it", () => {
		const trial = shape([["brand"]]);
		expect(() => countTrial([run("brand", "satisfied", 1, { agent: AGENT_TWO })], trial)).toThrow(
			RangeError,
		);
		expect(() => countTrial([run("docs", "satisfied", 1)], trial)).toThrow(RangeError);
		expect(() => countTrial([run("brand", "satisfied", 1, { task: 1 })], trial)).toThrow(
			RangeError,
		);
	});
});

describe("gap lines", () => {
	it("fires when adjacent levels differ by exactly 2 satisfied runs, naming the upper level's layer", () => {
		const NEED_ONE_BRAND_THREE = [
			...runsOf("need", ["satisfied", "unsatisfied", "unsatisfied"]),
			...runsOf("brand", ["satisfied", "satisfied", "satisfied"]),
		];
		expect(
			countTrial(NEED_ONE_BRAND_THREE, shape([["need", "brand"]], [AGENT_ONE], 3)).gaps,
		).toEqual([
			{
				task: 0,
				lower: { level: "need", satisfied: 1, gradable: 3 },
				upper: { level: "brand", satisfied: 3, gradable: 3 },
				difference: 2,
				layer: "Discovery",
				earlySignal: true,
			},
		]);
	});

	it("does not fire at a difference of 1", () => {
		const NEED_ONE_BRAND_TWO = [
			...runsOf("need", ["satisfied", "unsatisfied", "unsatisfied"]),
			...runsOf("brand", ["satisfied", "satisfied", "unsatisfied"]),
		];
		expect(countTrial(NEED_ONE_BRAND_TWO, shape([["need", "brand"]], [AGENT_ONE], 3)).gaps).toEqual(
			[],
		);
	});

	it("fires when more help satisfies fewer runs, with a negative difference", () => {
		const DOCS_THREE_EXACT_ONE = [
			...runsOf("docs", ["satisfied", "satisfied", "satisfied"]),
			...runsOf("exact", ["satisfied", "unsatisfied", "unsatisfied"]),
		];
		const [gap] = countTrial(DOCS_THREE_EXACT_ONE, shape([["docs", "exact"]], [AGENT_ONE], 3)).gaps;
		expect(gap).toMatchObject({ difference: -2, layer: "Access and Usability" });
	});

	it("names the layer of the upper level at every rung of the ladder", () => {
		const EACH_RUNG_TWO_MORE_SATISFIED = [
			...runsOf("need", [
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
			]),
			...runsOf("brand", [
				"satisfied",
				"satisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
			]),
			...runsOf("docs", [
				"satisfied",
				"satisfied",
				"satisfied",
				"satisfied",
				"unsatisfied",
				"unsatisfied",
			]),
			...runsOf("exact", [
				"satisfied",
				"satisfied",
				"satisfied",
				"satisfied",
				"satisfied",
				"satisfied",
			]),
		];
		const count = countTrial(
			EACH_RUNG_TWO_MORE_SATISFIED,
			shape([["need", "brand", "docs", "exact"]], [AGENT_ONE], 6),
		);
		expect(count.gaps.map((gap) => [gap.lower.level, gap.upper.level, gap.layer])).toEqual([
			["need", "brand", "Discovery"],
			["brand", "docs", "Discovery"],
			["docs", "exact", "Access and Usability"],
		]);
	});

	it("compares brand to exact when the docs level was skipped", () => {
		const BRAND_ONE_EXACT_THREE = [
			...runsOf("brand", ["satisfied", "unsatisfied", "unsatisfied"]),
			...runsOf("exact", ["satisfied", "satisfied", "satisfied"]),
		];
		const [gap] = countTrial(
			BRAND_ONE_EXACT_THREE,
			shape([["brand", "exact"]], [AGENT_ONE], 3),
		).gaps;
		expect(gap).toMatchObject({
			lower: { level: "brand" },
			upper: { level: "exact" },
			layer: "Access and Usability",
		});
	});

	it("skips a planned level with no gradable run, comparing the levels on either side", () => {
		const DOCS_ALL_EXCLUDED_OR_IN_FLIGHT = [
			...runsOf("brand", ["satisfied", "unsatisfied", "unsatisfied"]),
			run("docs", "excluded", 1, { rawStatus: "lost" }),
			run("docs", "excluded", 2, { reason: FAILED_TO_START }),
			run("docs", "in_flight", 3),
			...runsOf("exact", ["satisfied", "satisfied", "satisfied"]),
		];
		const count = countTrial(
			DOCS_ALL_EXCLUDED_OR_IN_FLIGHT,
			shape([["brand", "docs", "exact"]], [AGENT_ONE], 3),
		);
		expect(count.gaps.map((gap) => [gap.lower.level, gap.upper.level])).toEqual([
			["brand", "exact"],
		]);
	});

	it("sums satisfied and gradable runs over the agents, so a gap never compares agents", () => {
		const NO_AGENT_DIFFERS_BY_TWO_BUT_THE_TASK_DOES = [
			...runsOf("need", ["satisfied", "unsatisfied", "unsatisfied"]),
			...runsOf("need", ["unsatisfied", "unsatisfied", "unsatisfied"], { agent: AGENT_TWO }),
			...runsOf("brand", ["satisfied", "satisfied", "unsatisfied"]),
			...runsOf("brand", ["satisfied", "unsatisfied", "unsatisfied"], { agent: AGENT_TWO }),
		];
		expect(
			countTrial(
				NO_AGENT_DIFFERS_BY_TWO_BUT_THE_TASK_DOES,
				shape([["need", "brand"]], [AGENT_ONE, AGENT_TWO], 3),
			).gaps,
		).toEqual([
			{
				task: 0,
				lower: { level: "need", satisfied: 1, gradable: 6 },
				upper: { level: "brand", satisfied: 3, gradable: 6 },
				difference: 2,
				layer: "Discovery",
				earlySignal: false,
			},
		]);
	});

	it("tags an early signal when either level has fewer than 5 gradable runs", () => {
		const NEED_FOUR_GRADABLE_BRAND_FIVE = [
			...runsOf("need", ["unsatisfied", "unsatisfied", "unsatisfied", "unsatisfied"]),
			run("need", "excluded", 5, { rawStatus: "timeout" }),
			...runsOf("brand", ["satisfied", "satisfied", "satisfied", "unsatisfied", "unsatisfied"]),
		];
		const NEED_FIVE_GRADABLE_BRAND_FOUR = [
			...runsOf("need", [
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
			]),
			...runsOf("brand", ["satisfied", "satisfied", "satisfied", "satisfied"]),
			run("brand", "not_graded_yet", 5),
		];
		const BOTH_FIVE_GRADABLE = [
			...runsOf("need", [
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
				"unsatisfied",
			]),
			...runsOf("brand", ["satisfied", "satisfied", "satisfied", "unsatisfied", "unsatisfied"]),
		];
		const trial = shape([["need", "brand"]], [AGENT_ONE], 5);
		expect(countTrial(NEED_FOUR_GRADABLE_BRAND_FIVE, trial).gaps[0].earlySignal).toBe(true);
		expect(countTrial(NEED_FIVE_GRADABLE_BRAND_FOUR, trial).gaps[0].earlySignal).toBe(true);
		expect(countTrial(BOTH_FIVE_GRADABLE, trial).gaps[0].earlySignal).toBe(false);
	});

	it("keeps each task's gaps to its own levels", () => {
		const TASK_ONE_GAP_TASK_TWO_FLAT = [
			...runsOf("need", ["unsatisfied", "unsatisfied"]),
			...runsOf("brand", ["satisfied", "satisfied"]),
			...runsOf("brand", ["satisfied", "unsatisfied"], { task: 1 }),
			...runsOf("exact", ["satisfied", "satisfied"], { task: 1 }),
		];
		const count = countTrial(
			TASK_ONE_GAP_TASK_TWO_FLAT,
			shape(
				[
					["need", "brand"],
					["brand", "exact"],
				],
				[AGENT_ONE],
				2,
			),
		);
		expect(count.gaps.map((gap) => [gap.task, gap.lower.level, gap.upper.level])).toEqual([
			[0, "need", "brand"],
		]);
	});
});

describe("short levels", () => {
	it("marks a level a 402 stopped short, counting a run that failed to start as launched", () => {
		// Repeat first over brand and exact with two agents and --repeat 3: repeats 1 and 2 launched
		// both levels, repeat 3 launched brand and the 402 came at exact.
		const STOPPED_BEFORE_EXACT_REPEAT_3: CountedRun[] = [1, 2, 3].flatMap((repeat) => [
			run("brand", "satisfied", repeat),
			run("brand", "excluded", repeat, { agent: AGENT_TWO, reason: FAILED_TO_START }),
			...(repeat < 3
				? [
						run("exact", "satisfied", repeat),
						run("exact", "satisfied", repeat, { agent: AGENT_TWO }),
					]
				: []),
		]);
		const count = countTrial(
			STOPPED_BEFORE_EXACT_REPEAT_3,
			shape([["brand", "exact"]], [AGENT_ONE, AGENT_TWO], 3),
		);
		expect(count.shortLevels).toEqual([{ task: 0, level: "exact", launched: 4, planned: 6 }]);
	});

	it("marks every planned level short when the stop came before the first create", () => {
		const count = countTrial([], shape([["need", "brand"], ["brand"]], [AGENT_ONE], 2));
		expect(count.shortLevels).toEqual([
			{ task: 0, level: "need", launched: 0, planned: 2 },
			{ task: 0, level: "brand", launched: 0, planned: 2 },
			{ task: 1, level: "brand", launched: 0, planned: 2 },
		]);
		expect(count.gaps).toEqual([]);
	});

	it("marks nothing short when every planned run launched", () => {
		const EVERY_PLANNED_RUN = [
			...runsOf("brand", ["satisfied", "in_flight"]),
			...runsOf("exact", ["not_graded_yet", "unsatisfied"]),
		];
		expect(
			countTrial(EVERY_PLANNED_RUN, shape([["brand", "exact"]], [AGENT_ONE], 2)).shortLevels,
		).toEqual([]);
	});
});
