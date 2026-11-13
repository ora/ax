import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import studioOraAi from "./__fixtures__/studio-trajectories/run-49ab0c88.json";
import { type CountedRun, countTrial, RATE_FLOOR, type TrialShape } from "./count";
import { deriveTrialFlags, type TrialStep } from "./flags";
import type { FollowEnd } from "./follow";
import { LEVEL_LABELS, type Level } from "./levels";
import type { Bucket } from "./outcome";
import { appendJourney, createRecord, markStopped, type StoppedReason } from "./record";
import { NEED_LEVEL_NOTE, renderTrialReport } from "./render-report";
import type { ReportInput } from "./report-json";
import { parseTrialSpec, planCells } from "./spec";
import blockedFirst403 from "./vendor/__fixtures__/run-flags/blocked-first-403.json";

// Every input is built in this file and fed through the production code: the spec through
// parseTrialSpec and planCells, the record through createRecord and appendJourney in a temp
// directory, the counts through countTrial. Runs are CountedRuns (the real type from count.ts)
// with a bucket named for what the case isolates. Flags come from deriveTrialFlags over the
// fixtures count.test.ts uses (a blocked first request, and a run that stayed off linear.app).
// Server strings use the shapes outcome.test.ts uses: "timeout" is an excluded status, and
// "run gate unavailable" is Studio's start error (oramono apps/studio-service/src/journeys/
// journeys-service.test.ts:629).

const A = "claude-code/sonnet";
const B = "codex/gpt-5";
const FAILED_TO_START = "run gate unavailable";

const BLOCKED = deriveTrialFlags(
	blockedFirst403.trajectory.steps as TrialStep[],
	blockedFirst403.domain,
);
const NEVER_VISITED = deriveTrialFlags(studioOraAi.steps, "linear.app");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ax-trial-report-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
	tasks?: string[];
	agents?: string[];
	repeat?: number;
	docs?: string;
	exact?: string;
	runs: CountedRun[];
	stopped?: { reason: StoppedReason; notLaunched: number };
	ended?: FollowEnd;
}

const NEED_TASK = "Find how to create an issue from the API";
const BRAND_TASK = "Find how to create a Linear issue from the API";

function build(scenario: Scenario): ReportInput {
	const agents = scenario.agents ?? [A];
	const parsed = parseTrialSpec({
		site: "linear.app",
		tasks: scenario.tasks ?? [NEED_TASK],
		agents: agents.join(","),
		docs: scenario.docs,
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
	return {
		record,
		count: countTrial(scenario.runs, shape),
		ended: scenario.ended ?? "settled",
	};
}

function run(level: Level, bucket: Bucket, fields: Partial<CountedRun> = {}): CountedRun {
	return { task: 0, level, agent: A, repeat: 1, bucket, flags: null, ...fields };
}

/** `n` runs of one bucket in one cell, repeats numbered from 1. */
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the color codes picocolors may add
const COLOR = /\u001b\[[0-9;]*m/g;

function text(input: ReportInput): string {
	return renderTrialReport(input).join("\n").replace(COLOR, "");
}

function rowOf(report: string, label: string): string {
	const row = report.split("\n").find((line) => line.trim().startsWith(label));
	if (!row) throw new Error(`no row ${label} in:\n${report}`);
	return row;
}

describe("the matrix", () => {
	it("lays out a mixed trial by task, level and agent, with every bucket and flag", () => {
		const input = build({
			tasks: [NEED_TASK, BRAND_TASK],
			agents: [A, B],
			repeat: 5,
			exact: "https://linear.app/developers",
			runs: [
				// Task 1, need: A has 5 gradable runs; B has 2 gradable and one of each other bucket.
				...many("need", "satisfied", 1),
				...many("need", "unsatisfied", 4, { repeat: 2 }),
				run("need", "partial", { agent: B, repeat: 1 }),
				run("need", "unsatisfied", { agent: B, repeat: 2 }),
				run("need", "excluded", { agent: B, repeat: 3, rawStatus: "timeout" }),
				run("need", "excluded", { agent: B, repeat: 4, reason: FAILED_TO_START }),
				run("need", "not_graded_yet", { agent: B, repeat: 5 }),
				// Task 1, brand: A is all satisfied, one run blocked and one never visited; B has no runs.
				...many("brand", "satisfied", 3),
				run("brand", "satisfied", { repeat: 4, flags: BLOCKED }),
				run("brand", "satisfied", { repeat: 5, flags: NEVER_VISITED }),
				// Task 2 has no need level (it names the brand).
				...many("brand", "satisfied", 2, { task: 1 }),
			],
		});
		const report = text(input);
		expect(report).toContain("linear.app");
		expect(report).toContain(`trial ${input.record.id}`);
		expect(report).toContain(`Task 1: ${NEED_TASK}`);
		expect(report).toContain(`Task 2: ${BRAND_TASK}`);
		expect(report).toMatch(/Level\s+claude-code\/sonnet\s+codex\/gpt-5/);
		const need = report.split("Task 2")[0];
		expect(rowOf(need, "Need only")).toContain("20% (1 of 5)");
		expect(need).toContain("0 of 2");
		expect(need).toContain("excluded: timeout (1)");
		expect(need).toContain(`never started: ${FAILED_TO_START} (1)`);
		expect(need).toContain("not graded yet 1");
		expect(rowOf(need, "Brand named")).toContain("100% (5 of 5)");
		expect(need).toContain("blocked 1");
		expect(need).toContain("never visited 1");
		const second = report.split("Task 2")[1].split("Journeys")[0];
		expect(second).not.toMatch(/^\s+Need only\s{2,}/m);
		expect(rowOf(second, "Brand named")).toContain("2 of 2");
	});

	it("shows counts below the gradable floor and a percent from it", () => {
		const below = text(
			build({
				repeat: RATE_FLOOR,
				runs: [...many("need", "satisfied", 3), run("need", "unsatisfied", { repeat: 4 })],
			}),
		);
		expect(rowOf(below, "Need only")).toContain("3 of 4");
		expect(rowOf(below, "Need only")).not.toContain("%");
		const at = text(
			build({
				repeat: RATE_FLOOR,
				runs: [...many("need", "satisfied", 3), ...many("need", "unsatisfied", 2, { repeat: 4 })],
			}),
		);
		expect(rowOf(at, "Need only")).toContain("60% (3 of 5)");
	});

	it("rounds the rate to a whole percent", () => {
		const report = text(
			build({
				repeat: 6,
				runs: [...many("need", "satisfied", 4), ...many("need", "unsatisfied", 2, { repeat: 5 })],
			}),
		);
		expect(rowOf(report, "Need only")).toContain("67% (4 of 6)");
	});

	it("prints a hyphen for a cell with no data", () => {
		const report = text(build({ agents: [A, B], runs: [run("need", "satisfied")] }));
		expect(rowOf(report, "Need only")).toMatch(/1 of 1\s+-$/);
	});

	it("marks a level that launched fewer runs than planned", () => {
		const report = text(
			build({
				agents: [A, B],
				repeat: 2,
				runs: [
					run("need", "satisfied"),
					run("need", "satisfied", { repeat: 2 }),
					run("need", "satisfied", { agent: B }),
					run("need", "unsatisfied", { agent: B, repeat: 2 }),
					run("brand", "satisfied"),
				],
			}),
		);
		expect(report).toContain("Fewer runs than planned: Brand named (1 of 4).");
		expect(report).not.toContain("Need only (");
	});

	it("says excluded runs never count against the site, only when some were excluded", () => {
		const some = text(build({ runs: [run("need", "excluded", { rawStatus: "failed" })] }));
		expect(some).toContain(
			"Excluded runs never count against linear.app, although the platform's own verdict counts some of them as failed.",
		);
		const none = text(build({ runs: [run("need", "satisfied")] }));
		expect(none).not.toContain("Excluded runs never count");
	});

	it("tallies not gradable runs by their raw verdict and in flight runs", () => {
		const report = text(
			build({
				runs: [
					run("need", "not_gradable", { rawVerdict: "inconclusive" }),
					run("need", "in_flight", { repeat: 2 }),
				],
				ended: "wait_limit",
			}),
		);
		expect(report).toContain("not gradable: inconclusive (1)");
		expect(report).toContain("in flight 1");
	});
});

describe("the need level note", () => {
	it("prints once, only when the need level ran", () => {
		const ran = text(build({ runs: [run("need", "satisfied")] }));
		expect(ran.split(NEED_LEVEL_NOTE)).toHaveLength(2);
		const skipped = text(build({ tasks: [BRAND_TASK], runs: [run("brand", "satisfied")] }));
		expect(skipped).not.toContain(NEED_LEVEL_NOTE);
	});

	it("claims nothing about how the platform judges", () => {
		expect(NEED_LEVEL_NOTE).not.toMatch(/judge|credit|counts as/i);
		expect(NEED_LEVEL_NOTE).not.toMatch(/[\u2013\u2014]/);
	});
});

describe("gap lines", () => {
	it("names the Discovery layer for a gap that closes at the brand level", () => {
		const report = text(
			build({
				repeat: 5,
				runs: [...many("need", "unsatisfied", 5), ...many("brand", "satisfied", 5)],
			}),
		);
		expect(report).toContain(
			"linear.app loses agents at the Discovery layer: 0 of 5 runs satisfied at Need only, 5 of 5 at Brand named.",
		);
		expect(report).not.toContain("early signal");
		expect(report).not.toMatch(/Agent \d|claude-code\/sonnet (loses|did)/);
	});

	it("names the Access and Usability layers for a gap that closes at the exact level", () => {
		const report = text(
			build({
				tasks: [BRAND_TASK],
				repeat: 5,
				exact: "https://linear.app/developers",
				runs: [...many("brand", "unsatisfied", 5), ...many("exact", "satisfied", 5)],
			}),
		);
		expect(report).toContain(
			"linear.app loses agents at the Access and Usability layers: 0 of 5 runs satisfied at Brand named, 5 of 5 at Exact target.",
		);
		expect(report).not.toContain("the Access and Usability layer:");
	});

	it("names Discovery, singular, for the docs level", () => {
		const report = text(
			build({
				tasks: [BRAND_TASK],
				repeat: 5,
				docs: "https://linear.app/docs",
				runs: [...many("brand", "unsatisfied", 5), ...many("docs", "satisfied", 5)],
			}),
		);
		expect(report).toContain("loses agents at the Discovery layer:");
		expect(report).not.toContain("Discovery layers");
	});

	it("reads a negative difference as worse with help, with both counts and no layer", () => {
		const report = text(
			build({
				repeat: 5,
				runs: [...many("need", "satisfied", 5), ...many("brand", "unsatisfied", 5)],
			}),
		);
		expect(report).toContain(
			"On linear.app, agents did worse with the help at Brand named than at Need only: 5 of 5 runs satisfied at Need only, 0 of 5 at Brand named.",
		);
		expect(report).not.toContain("loses agents");
		expect(report).not.toContain("layer");
	});

	it("tags an early signal when either level has fewer than the floor of gradable runs", () => {
		const report = text(
			build({
				repeat: 2,
				runs: [...many("need", "unsatisfied", 2), ...many("brand", "satisfied", 2)],
			}),
		);
		expect(report).toContain(
			`(early signal: fewer than ${RATE_FLOOR} gradable runs at one of these levels)`,
		);
	});

	it("sums over agents, so a gap line never names one", () => {
		const report = text(
			build({
				agents: [A, B],
				repeat: 3,
				runs: [
					...many("need", "unsatisfied", 3),
					...many("need", "satisfied", 1, { agent: B }),
					...many("need", "unsatisfied", 2, { agent: B, repeat: 2 }),
					...many("brand", "satisfied", 3),
					...many("brand", "satisfied", 3, { agent: B }),
				],
			}),
		);
		const gap = report.split("\n").find((line) => line.includes("loses agents"));
		expect(gap).toContain("1 of 6 runs satisfied at Need only, 6 of 6 at Brand named");
		expect(gap).not.toMatch(/claude-code|codex/);
	});

	it("prints a gap under its own task", () => {
		const report = text(
			build({
				tasks: [NEED_TASK, "Plan a sprint with the API"],
				repeat: 5,
				runs: [
					...many("need", "unsatisfied", 5),
					...many("brand", "satisfied", 5),
					...many("need", "satisfied", 5, { task: 1 }),
					...many("brand", "satisfied", 5, { task: 1 }),
				],
			}),
		);
		const [first, second] = report.split("Task 2");
		expect(first).toContain("loses agents");
		expect(second).not.toContain("loses agents");
	});
});

describe("journeys and skipped levels", () => {
	it("lists journey ids as plain ids with no links", () => {
		const report = text(
			build({
				exact: "https://linear.app/developers",
				runs: [run("need", "satisfied")],
			}),
		);
		expect(report).toContain("Journeys");
		expect(report).toMatch(/journey-0-need\s+Task 1, Need only, repeat 1/);
		expect(report).toMatch(/journey-0-exact\s+Task 1, Exact target, repeat 1/);
		expect(report).not.toMatch(/https?:\/\/(?!linear\.app)/);
	});

	it("prints each skip note under its task, verbatim", () => {
		const report = text(build({ tasks: [BRAND_TASK], runs: [run("brand", "satisfied")] }));
		expect(report).toContain(
			"The task names Linear, so the need level is skipped. Write the task without it to include that level.",
		);
		expect(report).toContain(
			"No --docs URL, so the docs level is skipped. Add --docs <url> to include it.",
		);
	});
});

describe("complete and the incomplete line", () => {
	it("is complete when launch ran, following settled and nothing is in flight or ungraded", () => {
		const input = build({ runs: [run("need", "satisfied")] });
		expect(text(input)).not.toContain("not complete");
	});

	it("is incomplete after a quota stop, and says the plan's run limit and how many runs never started", () => {
		const input = build({
			runs: [run("need", "satisfied")],
			stopped: { reason: "quota", notLaunched: 7 },
		});
		expect(text(input)).toContain(
			"This report is not complete: launching stopped at your plan's run limit. 7 runs never started.",
		);
	});

	it("is incomplete at the wait limit, and says how many runs are still going", () => {
		const input = build({
			runs: [run("need", "satisfied"), run("need", "in_flight", { repeat: 2 })],
			repeat: 2,
			ended: "wait_limit",
		});
		expect(text(input)).toContain(
			"This report is not complete: the wait limit ran out with 1 run still going.",
		);
	});

	it("is incomplete when a grade is pending, even if following said settled", () => {
		const input = build({ runs: [run("need", "not_graded_yet")] });
		expect(text(input)).toContain("This report is not complete:");
	});

	it.each<[FollowEnd, string]>([
		["settle_limit", "no grade yet and the wait for grading ran out."],
		["detached", "you stopped following before every run finished."],
		["read_failed", "the platform could not be read, so some runs may be missing."],
	])("says why when following ended %s", (ended, why) => {
		const input = build({ runs: [run("need", "not_graded_yet")], ended });
		expect(text(input)).toContain(why);
	});

	it.each<[StoppedReason, string]>([
		["platform_down", "launching stopped because the platform did not answer."],
		["api_error", "launching stopped on an error from the platform."],
		["interrupted", "launching was interrupted."],
	])("says why when launching stopped with %s", (reason, why) => {
		const input = build({
			runs: [run("need", "satisfied")],
			stopped: { reason, notLaunched: 0 },
		});
		expect(text(input)).toContain(why);
	});

	it("puts the stop reason ahead of the follow ending", () => {
		const input = build({
			runs: [run("need", "in_flight")],
			stopped: { reason: "quota", notLaunched: 1 },
			ended: "wait_limit",
		});
		const line = text(input)
			.split("\n")
			.find((l) => l.includes("not complete"));
		expect(line).toContain("run limit");
		expect(line).not.toContain("wait limit");
	});
});

describe("server strings", () => {
	const ESCAPE = "\u001b[2J";
	const EVIL_AGENT = `evil/mod${ESCAPE}el`;

	function hostile(): ReportInput {
		return build({
			agents: [EVIL_AGENT],
			runs: [
				run("need", "excluded", { agent: EVIL_AGENT, rawStatus: `time${ESCAPE}out` }),
				run("need", "excluded", { agent: EVIL_AGENT, repeat: 2, reason: `gate${ESCAPE}down` }),
				run("need", "not_gradable", {
					agent: EVIL_AGENT,
					repeat: 3,
					rawVerdict: `odd${ESCAPE}verdict`,
				}),
			],
		});
	}

	it("strips terminal control sequences in the text form", () => {
		const report = text(hostile());
		expect(report).not.toContain("\u001b");
		expect(report).toContain("mod [2Jel");
		expect(report).toContain("excluded: time [2Jout (1)");
		expect(report).toContain("never started: gate [2Jdown (1)");
		expect(report).toContain("not gradable: odd [2Jverdict (1)");
	});
});

describe("labels", () => {
	it("prints the level labels the ladder pins", () => {
		const report = text(
			build({
				repeat: 1,
				docs: "https://linear.app/docs",
				exact: "https://linear.app/developers",
				runs: [run("need", "satisfied")],
			}),
		);
		for (const level of ["need", "brand", "docs", "exact"] as const) {
			expect(report).toContain(LEVEL_LABELS[level]);
		}
	});
});
