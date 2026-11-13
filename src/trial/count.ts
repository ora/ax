// A trial's counts: one cell per task, level and agent, and the gap lines between adjacent levels.
// Pure arithmetic over runs whose bucket outcome.ts already derived; this decides no run's grade.

import type { TrialFlags } from "./flags";
import { LEVELS, type Level } from "./levels";
import type { Bucket } from "./outcome";

/** Gradable runs a cell needs to show a rate, and a level needs for its gap lines not to be early signals. */
export const RATE_FLOOR = 5;

/** Satisfied runs two adjacent levels must differ by before a gap line prints, at the smaller level's size. */
export const GAP_MIN_DIFFERENCE = 2;

/** The score layer that covers a gap, named by its upper level. Need is never the upper level. */
export const LEVEL_LAYER = {
	brand: "Discovery",
	docs: "Discovery",
	exact: "Access and Usability",
} as const satisfies Readonly<Record<Exclude<Level, "need">, string>>;

export type Layer = (typeof LEVEL_LAYER)[keyof typeof LEVEL_LAYER];

/** One launched run, as collect.ts produces it from the record and the journey reads. */
export type CountedRun = {
	/** Index into `TrialShape.tasks`. */
	task: number;
	level: Level;
	agent: string;
	repeat: number;
	bucket: Bucket;
	rawStatus?: string;
	rawVerdict?: string;
	reason?: string;
	flags: TrialFlags | null;
};

/** What the trial planned, so cells with no runs and levels stopped short still show. */
export interface TrialShape {
	/** The trial's tasks in order; a run's `task` indexes this list. */
	tasks: readonly string[];
	/** The levels each task runs (skipped levels absent), indexed like `tasks`. */
	levelsByTask: readonly (readonly Level[])[];
	/** One report column per agent, in order; a run's `agent` is one of these. */
	agents: readonly string[];
	/** Runs each task x level x agent cell was planned to launch: the repeat count. */
	plannedPerCell: number;
}

/** Server strings with how many runs carried each, most first, then by value. */
export type Tally = { value: string; count: number }[];

/** Runs in the cell that carry each flag. A run whose flags were not read counts as neither. */
export type FlagCounts = Record<keyof TrialFlags, number>;

export interface CellCount {
	task: number;
	level: Level;
	agent: string;
	/** Every run counted here, whatever its bucket; 0 means no data. */
	runs: number;
	satisfied: number;
	partial: number;
	unsatisfied: number;
	/** satisfied + partial + unsatisfied. */
	gradable: number;
	/** satisfied / gradable, 0 to 1, from RATE_FLOOR gradable runs; null below it. */
	rate: number | null;
	notGradedYet: number;
	inFlight: number;
	/** Runs that started and ended in an excluded status, by raw status. */
	excluded: Tally;
	/** Runs that never started, by reason. Excluded too: never counted against the site. */
	neverStarted: Tally;
	/** Graded runs whose verdict maps to no bucket, by raw verdict. */
	notGradable: Tally;
	flags: FlagCounts;
}

/** One level of one task, summed over the trial's agents. */
export interface LevelTotal {
	level: Level;
	satisfied: number;
	gradable: number;
}

export interface GapLine {
	task: number;
	lower: LevelTotal;
	upper: LevelTotal;
	/**
	 * The rate gap in satisfied runs at the smaller level's size (upper.satisfied - lower.satisfied
	 * when both have the same gradable runs): positive when more help satisfied more runs.
	 */
	difference: number;
	layer: Layer;
	/** Either level has fewer than RATE_FLOOR gradable runs. */
	earlySignal: boolean;
}

/** A level that launched fewer runs than planned, because launching stopped (a 402, for one). */
export interface ShortLevel {
	task: number;
	level: Level;
	launched: number;
	planned: number;
}

export interface TrialCount {
	cells: CellCount[];
	gaps: GapLine[];
	shortLevels: ShortLevel[];
}

/** A task's levels in ladder order, whatever order the shape lists them in. */
function plannedLevels(shape: TrialShape, task: number): Level[] {
	const planned = shape.levelsByTask[task] ?? [];
	return LEVELS.filter((level) => planned.includes(level));
}

function hasCell(shape: TrialShape, run: CountedRun): boolean {
	return (
		Number.isInteger(run.task) &&
		run.task >= 0 &&
		run.task < shape.tasks.length &&
		plannedLevels(shape, run.task).includes(run.level) &&
		shape.agents.includes(run.agent)
	);
}

/** A run outside the plan is a producer bug; dropping it silently would miscount the trial. */
function assertEveryRunHasACell(runs: readonly CountedRun[], shape: TrialShape): void {
	const stray = runs.find((run) => !hasCell(shape, run));
	if (stray) {
		throw new RangeError(
			`a run of task ${stray.task}, level ${stray.level}, agent ${stray.agent} has no cell in the trial`,
		);
	}
}

// A Map, not an object: the values are server strings, and "constructor" must not resolve.
function tally(values: readonly string[]): Tally {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

function countBucket(runs: readonly CountedRun[], bucket: Bucket): number {
	return runs.filter((run) => run.bucket === bucket).length;
}

function flagCounts(runs: readonly CountedRun[]): FlagCounts {
	return {
		blocked: runs.filter((run) => run.flags?.blocked.flagged).length,
		never_visited: runs.filter((run) => run.flags?.never_visited.flagged).length,
	};
}

/** A started run that was excluded carries its raw status; one that never started, its reason. */
function excludedTallies(
	runs: readonly CountedRun[],
): Pick<CellCount, "excluded" | "neverStarted"> {
	const excluded = runs.filter((run) => run.bucket === "excluded");
	return {
		excluded: tally(excluded.flatMap((run) => (run.rawStatus ? [run.rawStatus] : []))),
		neverStarted: tally(excluded.flatMap((run) => (run.rawStatus ? [] : [run.reason ?? ""]))),
	};
}

function countCell(
	runs: readonly CountedRun[],
	task: number,
	level: Level,
	agent: string,
): CellCount {
	const inCell = runs.filter(
		(run) => run.task === task && run.level === level && run.agent === agent,
	);
	const satisfied = countBucket(inCell, "satisfied");
	const partial = countBucket(inCell, "partial");
	const unsatisfied = countBucket(inCell, "unsatisfied");
	const gradable = satisfied + partial + unsatisfied;
	const notGradable = inCell.filter((run) => run.bucket === "not_gradable");
	return {
		task,
		level,
		agent,
		runs: inCell.length,
		satisfied,
		partial,
		unsatisfied,
		gradable,
		rate: gradable >= RATE_FLOOR ? satisfied / gradable : null,
		notGradedYet: countBucket(inCell, "not_graded_yet"),
		inFlight: countBucket(inCell, "in_flight"),
		...excludedTallies(inCell),
		notGradable: tally(notGradable.map((run) => run.rawVerdict ?? "")),
		flags: flagCounts(inCell),
	};
}

function countCells(runs: readonly CountedRun[], shape: TrialShape): CellCount[] {
	return shape.tasks.flatMap((_, task) =>
		plannedLevels(shape, task).flatMap((level) =>
			shape.agents.map((agent) => countCell(runs, task, level, agent)),
		),
	);
}

function levelTotal(cells: readonly CellCount[], task: number, level: Level): LevelTotal {
	const atLevel = cells.filter((cell) => cell.task === task && cell.level === level);
	return {
		level,
		satisfied: atLevel.reduce((sum, cell) => sum + cell.satisfied, 0),
		gradable: atLevel.reduce((sum, cell) => sum + cell.gradable, 0),
	};
}

/**
 * The rate gap between two levels, in satisfied runs at the smaller level's size: the plain
 * difference in satisfied runs when both levels have the same gradable runs. The threshold is
 * compared in whole numbers, so no rounding decides whether a line prints.
 */
function gapBetween(task: number, lower: LevelTotal, upper: LevelTotal): GapLine | null {
	const crossed = upper.satisfied * lower.gradable - lower.satisfied * upper.gradable;
	const larger = Math.max(lower.gradable, upper.gradable);
	if (upper.level === "need" || Math.abs(crossed) < GAP_MIN_DIFFERENCE * larger) return null;
	return {
		task,
		lower,
		upper,
		difference: crossed / larger,
		layer: LEVEL_LAYER[upper.level],
		earlySignal: lower.gradable < RATE_FLOOR || upper.gradable < RATE_FLOOR,
	};
}

/**
 * Gaps between adjacent levels among those that ran for the task, summed over agents, so a gap
 * line is about the site and never compares agents. A level with no gradable run has no satisfied
 * count to compare (skipped, stopped before launch, or every run excluded or in flight).
 */
function taskGaps(cells: readonly CellCount[], shape: TrialShape, task: number): GapLine[] {
	const ran = plannedLevels(shape, task)
		.map((level) => levelTotal(cells, task, level))
		.filter((total) => total.gradable > 0);
	return ran.slice(1).flatMap((upper, index) => gapBetween(task, ran[index], upper) ?? []);
}

function shortLevels(runs: readonly CountedRun[], shape: TrialShape): ShortLevel[] {
	const planned = shape.plannedPerCell * shape.agents.length;
	return shape.tasks.flatMap((_, task) =>
		plannedLevels(shape, task).flatMap((level) => {
			const launched = runs.filter((run) => run.task === task && run.level === level).length;
			return launched < planned ? [{ task, level, launched, planned }] : [];
		}),
	);
}

/** Every cell of the plan (task, ladder level, agent), the gap lines per task, and the short levels. */
export function countTrial(runs: readonly CountedRun[], shape: TrialShape): TrialCount {
	assertEveryRunHasACell(runs, shape);
	const cells = countCells(runs, shape);
	return {
		cells,
		gaps: shape.tasks.flatMap((_, task) => taskGaps(cells, shape, task)),
		shortLevels: shortLevels(runs, shape),
	};
}
