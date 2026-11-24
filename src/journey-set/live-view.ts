import picocolors from "picocolors";

/** Colors this module applies when the caller asks for them (picocolors' own switch follows stdout, not the caller). */
const pc = picocolors.createColors(true);

import type { SetDocument } from "../api/sets";
import { plain, SPINNER_FRAMES } from "../ui/ansi";
import { rowLabelsOf } from "./agent-labels";
import { lineOf, pad, type Segment, type Tint } from "./segments";
import { boxSegments, boxStatesOf, legendSegments, rowDone, rowSummary } from "./set-boxes";

// THE LIVE VIEW OF A SET, as lines for a terminal: a header that says what was asked, a status line, then one row
// per agent under each level of each goal, with one box per repeat that fills left to right as its runs end. Every
// count is the platform's (ax invariant 1); this module only lays them out. Pure: the caller owns the screen
// (live-region.ts), the clock and the animation frame. Text the platform sent goes through `plain` so it cannot
// move the cursor, and every width is measured on plain text before any color is applied, so a line never wraps.

export interface LiveViewOptions {
	/** Now, in ms since the epoch: the time since the set was made is shown. */
	now: number;
	/** The animation frame: the spinners of rows still going. */
	frame: number;
	/** The terminal's columns and rows: no line is wider, and no more lines are printed than fit. */
	width: number;
	height: number;
	color: boolean;
	/** One line said under the status, such as the live stream falling back to reading. */
	note?: string | null;
	/**
	 * The frame left on screen when watching ends: nothing turns, every row is shown (it scrolls like any output, so
	 * `height` does not bound it), and the how-to-leave lines are dropped (the report's Next line says what is next).
	 */
	final?: boolean;
}

const OVER = new Set<SetDocument["state"]>(["complete", "stopped", "failed"]);

function elapsedOf(createdAt: string, now: number): string {
	const at = Date.parse(createdAt);
	if (Number.isNaN(at)) return "";
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The status bar: graded, excluded, grading and running runs, in the boxes' colors (without color, shades: the two
 * kinds of run not graded yet share one), then the runs still to start.
 */
function statusBar(
	runs: { graded: number; excluded: number; grading: number; running: number },
	planned: number,
	barWidth: number,
	color: boolean,
): Segment[] {
	const of = Math.max(1, planned);
	const cellsFor = (n: number) => Math.min(barWidth, Math.round((Math.min(n, of) / of) * barWidth));
	const parts: [number, string, Tint][] = [
		[runs.graded, "█", pc.green],
		[runs.excluded, "▓", pc.gray],
		[runs.grading, "▒", pc.cyan],
		[runs.running, "▒", pc.yellow],
	];
	const segments: Segment[] = [];
	let sum = 0;
	let drawn = 0;
	for (const [n, bare, tint] of parts) {
		sum += Math.max(0, n);
		const end = Math.max(drawn, cellsFor(sum));
		segments.push({ text: (color ? "━" : bare).repeat(end - drawn), tint });
		drawn = end;
	}
	segments.push({ text: (color ? "─" : "░").repeat(barWidth - drawn), tint: pc.dim });
	return segments;
}

/** Rows a spinner frame apart turn out of step: down the rows, the turning reads as a wave. */
const ROW_STEP = 2;
/** The status bar's cells: this many where there is room, never fewer than the least. */
const BAR_MAX = 24;
const BAR_MIN = 8;
/** What comes before the bar on the status line: "  ◆ " and the state, padded. */
const STATUS_LEAD = 4 + 10;

/** The set as it stands, for a terminal `options.width` wide and `options.height` tall. */
export function liveSetLines(set: SetDocument, options: LiveViewOptions): string[] {
	const { width, color } = options;
	const final = options.final === true;
	const over = OVER.has(set.state);
	// What is left on screen does not turn: a row or a set still going when watching ended reads as paused.
	const spinAt = (step: number) =>
		final ? "◌" : SPINNER_FRAMES[(options.frame + step) % SPINNER_FRAMES.length];
	const spin = spinAt(0);
	const line = (segments: Segment[]) => lineOf(segments, width, color);
	const field = (label: string, value: string) =>
		line([{ text: `    ${pad(label, 9)}`, tint: pc.dim }, { text: value }]);

	// The header: what was asked.
	const site = plain(set.site);
	const shortId = plain(set.setId).slice(0, 8);
	const left = `  ◆ ${site} · a set of journeys`;
	const right = `set ${shortId}`;
	const gap = width - left.length - right.length;
	const header = [
		line([
			{ text: "  ◆ ", tint: pc.cyan },
			{ text: site, tint: pc.bold },
			{ text: " · a set of journeys", tint: pc.dim },
			{ text: gap >= 2 ? `${" ".repeat(gap)}${right}` : `  ${right}`, tint: pc.dim },
		]),
		set.goals.length === 1
			? field("Goal", plain(set.goals[0].text))
			: field("Goals", String(set.goals.length)),
		field("Levels", set.levels.map((level) => plain(level.label)).join(" › ")),
		...(set.brand !== null ? [field("Brand", plain(set.brand))] : []),
		field("Agents", set.agents.map(plain).join(" · ")),
		field(
			"Runs",
			`${set.runs.planned} · ${set.repeat} ${set.repeat === 1 ? "repeat" : "repeats"} of each goal, level and agent`,
		),
	];

	// The status: the state, how far it got, how long it has taken.
	const total = (count: (cell: SetDocument["cells"][number]) => number) =>
		set.cells.reduce((n, cell) => n + Math.max(0, count(cell)), 0);
	const graded = total((cell) => cell.graded);
	const excluded = total((cell) => cell.excluded);
	const running = total((cell) => cell.inFlight);
	const grading = Math.max(0, set.runs.started - graded - excluded - running);
	const counts = `  ${graded} of ${set.runs.planned} graded${excluded > 0 ? ` · ${excluded} excluded` : ""} · ${set.runs.started} started`;
	const elapsed = `   ${elapsedOf(set.createdAt, options.now)}`;
	// The bar gives way on a narrow terminal (down to a few cells), so the counts and the time stay whole.
	const barWidth = Math.max(
		BAR_MIN,
		Math.min(BAR_MAX, width - STATUS_LEAD - counts.length - elapsed.length),
	);
	const statusGlyph =
		set.state === "complete"
			? "✓"
			: set.state === "stopped"
				? "■"
				: set.state === "failed"
					? "✗"
					: spin;
	const statusTint =
		set.state === "complete"
			? pc.green
			: set.state === "failed"
				? pc.red
				: set.state === "stopped"
					? pc.yellow
					: pc.cyan;
	const status = line([
		{ text: `  ${statusGlyph} `, tint: statusTint },
		{ text: pad(set.state, 10), tint: pc.bold },
		...statusBar({ graded, excluded, grading, running }, set.runs.planned, barWidth, color),
		{ text: counts },
		{ text: elapsed, tint: pc.dim },
	]);
	const note = options.note
		? [line([{ text: `    ${plain(options.note)}`, tint: pc.yellow }])]
		: [];

	// The rows: under each goal, each level; under each level, each agent, with its boxes.
	const many = set.goals.length > 1;
	const rowLabels = rowLabelsOf(set.agents);
	const rowLabel = (agent: string) => rowLabels.get(agent) ?? plain(agent);
	const agentWidth = Math.min(40, Math.max(...set.agents.map((agent) => rowLabel(agent).length)));
	const labelOf = (key: string) =>
		plain(set.levels.find((level) => level.key === key)?.label ?? key);
	const rows: string[] = [];
	let agentRows = 0;
	for (const goal of set.goals) {
		if (many)
			rows.push(
				line([
					{ text: `    Goal ${goal.index} · `, tint: pc.dim },
					{ text: plain(goal.text), tint: pc.bold },
				]),
			);
		const levelIndent = many ? "      " : "    ";
		for (const level of goal.levels) {
			rows.push(line([{ text: `${levelIndent}${labelOf(level)}`, tint: pc.bold }]));
			for (const agent of set.agents) {
				const cell = set.cells.find(
					(c) => c.goal === goal.index && c.level === level && c.agent === agent,
				);
				const states = boxStatesOf(cell, set.repeat);
				const done = rowDone(states);
				agentRows += 1;
				const glyph = done ? "✓" : over ? "–" : spinAt(agentRows * ROW_STEP);
				const glyphTint = done ? pc.green : over ? pc.dim : pc.cyan;
				rows.push(
					line([
						{ text: `${levelIndent}  ` },
						{ text: glyph, tint: glyphTint },
						{ text: ` ${pad(rowLabel(agent).slice(0, agentWidth), agentWidth)}   ` },
						...boxSegments(states, color),
						{ text: "   " },
						...rowSummary(cell, states, over),
					]),
				);
			}
		}
	}

	// What the boxes mean, and how to leave and come back.
	const footer = [
		line([{ text: "    " }, ...legendSegments(color)]),
		...(final
			? []
			: [
					line([{ text: "    Ctrl-C stops watching; the runs go on.", tint: pc.dim }]),
					line([
						{
							text: `    Pick it up again: ax run set view ${plain(set.setId)} --watch`,
							tint: pc.dim,
						},
					]),
				]),
	];

	// Fit the screen: the header and the status always; then the rows, and the footer as far as room allows (the
	// "how to leave" lines go first, then the legend); as many rows as fit, and a word for the rest. The last frame
	// stays and scrolls, so it is not fitted.
	const height = final ? Number.POSITIVE_INFINITY : options.height;
	// Above the rows: the opening blank line, the header, a blank, the status, the note, a blank.
	const roomWith = (footerLines: number) =>
		height -
		1 -
		(1 + header.length + 1 + 1 + note.length + 1 + (footerLines > 0 ? 1 + footerLines : 0));
	while (footer.length > 0 && roomWith(footer.length) < Math.min(rows.length, 3)) footer.pop();
	const room = Math.max(1, roomWith(footer.length));
	const shown = rows.length <= room ? rows : rows.slice(0, room - 1);
	const left_out = rows.length - shown.length;
	if (left_out > 0)
		shown.push(
			line([
				{
					text: `    … ${left_out} more rows; the report at the end lists every cell`,
					tint: pc.dim,
				},
			]),
		);
	return [
		"",
		...header,
		"",
		status,
		...note,
		"",
		...shown,
		...(footer.length > 0 ? ["", ...footer] : []),
		// The frame that stays is ordinary output from here on: a blank line sets what is printed under it apart.
		...(final ? [""] : []),
	];
}
