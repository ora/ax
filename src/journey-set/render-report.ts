// The finished set as text: one matrix per goal (levels down, agents across), the gap lines
// between levels, and the journey ids. Everything here is arithmetic count.ts already did, laid
// out for a terminal; it derives no grade and ranks no agent. Server strings (agent labels, raw
// statuses, raw verdicts, never started reasons, journey ids) go through plain() on the way out.
// The Next line is not built here: the command renders it with axCall. The JSON form lives in
// report-json.ts and keeps raw values.

import pc from "picocolors";
import { plain, squeeze } from "../ui/ansi";
import { type CellCount, type GapLine, RATE_FLOOR, type Tally } from "./count";
import { LEVEL_LABELS } from "./levels";
import type { StoppedReason } from "./record";
import {
	agentsOf,
	isComplete,
	type ReportInput,
	runsAwaitingGrade,
	runsInFlight,
} from "./report-json";
import { planCells } from "./spec";

/**
 * What satisfied means at the need level. Provisional: it states only what the prompt does, and
 * claims nothing about how the platform judges a run that used another product. The first real
 * need level run grounds it (plan M9.2).
 */
export const NEED_LEVEL_NOTE =
	"Need only prompts do not name the site, so an agent can reach the goal without using it. Satisfied there is the platform's verdict on the goal.";

const GOAL_TEXT_MAX = 120;
const GAP = "  ";

/** `3 of 4` below RATE_FLOOR gradable runs, `75% (3 of 4)` from it, a hyphen with none. */
function headline(cell: CellCount): string {
	if (cell.gradable === 0) return "-";
	const counts = `${cell.satisfied} of ${cell.gradable}`;
	return cell.rate === null ? counts : `${Math.round(cell.rate * 100)}% (${counts})`;
}

/** `excluded: failed (1), timeout (2)`; the values are server strings. */
function tallyLine(label: string, tally: Tally, empty: string): string {
	const parts = tally.map((entry) => `${plain(entry.value).trim() || empty} (${entry.count})`);
	return `${label}: ${parts.join(", ")}`;
}

/** The lines under a cell's headline: counts, never warnings. Zero counts are left out. */
function detailLines(cell: CellCount): string[] {
	const lines: string[] = [];
	const flags = [
		cell.flags.blocked > 0 ? `blocked ${cell.flags.blocked}` : "",
		cell.flags.never_visited > 0 ? `never visited ${cell.flags.never_visited}` : "",
	].filter(Boolean);
	if (flags.length > 0) lines.push(flags.join(", "));
	if (cell.excluded.length > 0) lines.push(tallyLine("excluded", cell.excluded, "no status"));
	if (cell.neverStarted.length > 0) {
		lines.push(tallyLine("never started", cell.neverStarted, "no reason given"));
	}
	if (cell.notGradedYet > 0) lines.push(`not graded yet ${cell.notGradedYet}`);
	if (cell.notGradable.length > 0) {
		lines.push(tallyLine("not gradable", cell.notGradable, "no value"));
	}
	if (cell.inFlight > 0) lines.push(`in flight ${cell.inFlight}`);
	return lines;
}

/** Columns padded on plain text; color goes on whole padded segments, so widths never skew. */
function table(header: string[], rows: string[][][]): string[] {
	const widths = header.map((title, col) =>
		Math.max(title.length, ...rows.map((row) => Math.max(...row[col].map((line) => line.length)))),
	);
	const line = (segments: string[], paint: (value: string) => string) =>
		`  ${segments.map((text, col) => paint(text.padEnd(widths[col]))).join(GAP)}`.trimEnd();
	const out = [line(header, pc.bold)];
	for (const row of rows) {
		const height = Math.max(...row.map((cell) => cell.length));
		for (let index = 0; index < height; index++) {
			out.push(
				line(
					row.map((cell) => cell[index] ?? ""),
					index === 0 ? (v) => v : pc.dim,
				),
			);
		}
	}
	return out;
}

function levelRows(cells: readonly CellCount[], agents: readonly string[]): string[][][] {
	const levels = [...new Set(cells.map((cell) => cell.level))];
	return levels.map((level) => [
		[LEVEL_LABELS[level]],
		...agents.map((agent) => {
			const cell = cells.find((c) => c.level === level && c.agent === agent);
			return cell ? [headline(cell), ...detailLines(cell)] : ["-"];
		}),
	]);
}

/** The layer a gap sits at; `ax audit` prints Access and Usability as two layers. */
function layerPhrase(layer: GapLine["layer"]): string {
	return layer === "Access and Usability"
		? "the Access and Usability layers"
		: `the ${layer} layer`;
}

function counts(total: { satisfied: number; gradable: number }): string {
	return `${total.satisfied} of ${total.gradable}`;
}

/** About the site, never an agent: positive loses agents at a layer, negative claims no layer. */
function gapLine(gap: GapLine, site: string): string {
	const lower = LEVEL_LABELS[gap.lower.level];
	const upper = LEVEL_LABELS[gap.upper.level];
	const early = gap.earlySignal
		? ` (early signal: fewer than ${RATE_FLOOR} gradable runs at one of these levels)`
		: "";
	if (gap.difference > 0) {
		return `${site} loses agents at ${layerPhrase(gap.layer)}: ${counts(gap.lower)} runs satisfied at ${lower}, ${counts(gap.upper)} at ${upper}.${early}`;
	}
	return `On ${site}, agents did worse with the help at ${upper} than at ${lower}: ${counts(gap.lower)} runs satisfied at ${lower}, ${counts(gap.upper)} at ${upper}.${early}`;
}

function shortLine(input: ReportInput, goalIndex: number): string[] {
	const short = input.count.shortLevels.filter((level) => level.goalIndex === goalIndex);
	if (short.length === 0) return [];
	const parts = short.map(
		(level) => `${LEVEL_LABELS[level.level]} (${level.launched} of ${level.planned})`,
	);
	return [pc.dim(`  Fewer runs than planned: ${parts.join(", ")}.`)];
}

function goalBlock(input: ReportInput, goalIndex: number, skipped: string[]): string[] {
	const cells = input.count.cells.filter((cell) => cell.goalIndex === goalIndex);
	const text = squeeze(plain(input.record.spec.goals[goalIndex] ?? ""), GOAL_TEXT_MAX);
	const lines = ["", pc.bold(`Goal ${goalIndex + 1}: ${text}`)];
	lines.push(
		...table(
			["Level", ...agentsOf(input.count).map(plain)],
			levelRows(cells, agentsOf(input.count)),
		),
	);
	lines.push(...shortLine(input, goalIndex));
	for (const gap of input.count.gaps.filter((g) => g.goalIndex === goalIndex)) {
		lines.push("", `  ${gapLine(gap, input.record.spec.site)}`);
	}
	for (const note of skipped) lines.push(pc.dim(`  ${note}`));
	return lines;
}

function journeyLines(input: ReportInput): string[] {
	const listed = input.record.journeys.flatMap((entry) =>
		entry.journeyId === null ? [] : [{ ...entry, journeyId: plain(entry.journeyId) }],
	);
	if (listed.length === 0) return [];
	const width = Math.max(...listed.map((entry) => entry.journeyId.length));
	return [
		"",
		pc.bold("Journeys"),
		...listed.map(
			(entry) =>
				`  ${entry.journeyId.padEnd(width)}  Goal ${entry.goalIndex + 1}, ${LEVEL_LABELS[entry.level]}, repeat ${entry.repeat}`,
		),
	];
}

function hasExcluded(input: ReportInput): boolean {
	return input.count.cells.some((cell) => cell.excluded.length > 0 || cell.neverStarted.length > 0);
}

function ranNeedLevel(input: ReportInput): boolean {
	return input.count.cells.some((cell) => cell.level === "need");
}

function stopReason(reason: StoppedReason, notLaunched: number | undefined): string {
	const left = notLaunched
		? ` ${notLaunched} ${notLaunched === 1 ? "run" : "runs"} never started.`
		: "";
	switch (reason) {
		case "quota":
			return `launching stopped at your plan's run limit.${left}`;
		case "platform_down":
			return `launching stopped because the platform did not answer.${left}`;
		case "api_error":
			return `launching stopped on an error from the platform.${left}`;
		case "interrupted":
			return `launching was interrupted.${left}`;
	}
}

function followReason(input: ReportInput): string {
	const going = runsInFlight(input.count);
	const ungraded = runsAwaitingGrade(input.count);
	switch (input.ended) {
		case "settle_limit":
			return `${ungraded} ${ungraded === 1 ? "run has" : "runs have"} no grade yet and the wait for grading ran out.`;
		case "wait_limit":
			return `the wait limit ran out with ${going} ${going === 1 ? "run" : "runs"} still going.`;
		case "detached":
			return "you stopped following before every run finished.";
		case "read_failed":
			return "the platform could not be read, so some runs may be missing.";
		case "settled":
			return `${going + ungraded} ${going + ungraded === 1 ? "run is" : "runs are"} still going or waiting for a grade.`;
	}
}

/** One line: the stop reason when launching stopped, otherwise how following ended. */
function incompleteLine(input: ReportInput): string {
	const { stoppedReason, notLaunched } = input.record;
	const why = stoppedReason ? stopReason(stoppedReason, notLaunched) : followReason(input);
	return `This report is not complete: ${why}`;
}

/** The report for stdout, one string per line. Prints nothing itself. */
export function renderSetReport(input: ReportInput): string[] {
	const { record } = input;
	const site = record.spec.site;
	const skipped = planCells(record.spec).skipped;
	const lines = [`${pc.bold(site)}  ${pc.dim(`set ${record.id}`)}`];
	for (const goalIndex of record.spec.goals.keys()) {
		const notes = skipped.filter((cell) => cell.goalIndex === goalIndex).map((cell) => cell.note);
		lines.push(...goalBlock(input, goalIndex, notes));
	}
	if (hasExcluded(input)) {
		lines.push(
			"",
			`Excluded runs never count against ${site}, although the platform's own verdict counts some of them as failed.`,
		);
	}
	if (ranNeedLevel(input)) lines.push("", NEED_LEVEL_NOTE);
	if (!isComplete(input)) {
		lines.push("", pc.yellow(incompleteLine(input)));
	}
	lines.push(...journeyLines(input));
	return lines;
}
