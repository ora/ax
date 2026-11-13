// The `--json` document for a trial, and the one rule for when a report is complete. ax builds
// this document itself because no single server payload exists for a trial (it is many journeys
// and a local record); every value is raw: statuses, verdicts and reasons as the platform sent
// them, `rate` as a fraction from 0 to 1 (null below the gradable floor). The text report reads
// `isComplete` and `agentsOf` from here so the two forms cannot disagree.

import type { CellCount, GapLine, ShortLevel, TrialCount } from "./count";
import type { FollowEnd } from "./follow";
import { LEVELS, type Level } from "./levels";
import type { StoppedReason, TrialRecord } from "./record";
import { planCells, type SkippedCell } from "./spec";

/** What the command has once it has followed, collected and counted a trial. */
export interface ReportInput {
	record: TrialRecord;
	count: TrialCount;
	/** How following ended (`FollowResult.ended`). */
	ended: FollowEnd;
}

/** One task and the levels that ran for it, in ladder order. `task` indexes the record's tasks. */
export interface TaskLevels {
	task: number;
	text: string;
	levels: Level[];
}

export interface JourneyRef {
	/** Null when a create answered with no journey (see the record). */
	journeyId: string | null;
	/** 0-based index into the trial's tasks, as in `levels[].task`. */
	task: number;
	level: Level;
	/** 1-based. */
	repeat: number;
}

export interface ReportDocument {
	trialId: string;
	site: string;
	createdAt: string;
	/** Launch was not stopped, following ended `settled`, and no run is in flight or awaiting a grade. */
	complete: boolean;
	/** The levels each task ran, in ladder order, with the task's text. */
	levels: TaskLevels[];
	/** The levels left out of the plan, each with the note the preview printed. */
	skippedLevels: SkippedCell[];
	/** The report's columns, `harness/model`; also the `agent` of every cell. */
	agents: string[];
	cells: CellCount[];
	gaps: GapLine[];
	shortLevels: ShortLevel[];
	journeys: JourneyRef[];
	/** Runs that never started because launching stopped; 0 when it did not. */
	notLaunched: number;
	stoppedReason: StoppedReason | null;
	ended: FollowEnd;
}

/** The trial's agents in column order. Cells list every agent for every level, so the first level's do. */
export function agentsOf(count: TrialCount): string[] {
	const agents: string[] = [];
	for (const cell of count.cells) {
		if (!agents.includes(cell.agent)) agents.push(cell.agent);
	}
	return agents;
}

function sum(cells: readonly CellCount[], pick: (cell: CellCount) => number): number {
	return cells.reduce((total, cell) => total + pick(cell), 0);
}

/** Runs still going, summed over every cell. */
export function runsInFlight(count: TrialCount): number {
	return sum(count.cells, (cell) => cell.inFlight);
}

/** Runs that finished but have no grade yet. */
export function runsAwaitingGrade(count: TrialCount): number {
	return sum(count.cells, (cell) => cell.notGradedYet);
}

/** True only when launching ran to its end, following settled, and nothing is in flight or ungraded. */
export function isComplete(input: ReportInput): boolean {
	return (
		!input.record.stoppedReason &&
		input.ended === "settled" &&
		runsInFlight(input.count) === 0 &&
		runsAwaitingGrade(input.count) === 0
	);
}

function levelsRan(record: TrialRecord): TaskLevels[] {
	return record.spec.tasks.map((text, task) => ({
		task,
		text,
		levels: LEVELS.filter((level) =>
			record.cells.some((cell) => cell.task === task && cell.level === level),
		),
	}));
}

/** The `--json` document: raw values throughout, so scripts key on what the platform said. */
export function reportJson(input: ReportInput): ReportDocument {
	const { record, count } = input;
	return {
		trialId: record.id,
		site: record.spec.site,
		createdAt: record.createdAt,
		complete: isComplete(input),
		levels: levelsRan(record),
		skippedLevels: planCells(record.spec).skipped,
		agents: agentsOf(count),
		cells: count.cells,
		gaps: count.gaps,
		shortLevels: count.shortLevels,
		journeys: record.journeys.map(({ journeyId, task, level, repeat }) => ({
			journeyId,
			task,
			level,
			repeat,
		})),
		notLaunched: record.notLaunched ?? 0,
		stoppedReason: record.stoppedReason || null,
		ended: input.ended,
	};
}
