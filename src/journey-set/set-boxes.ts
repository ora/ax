import picocolors from "picocolors";
import type { SetCell } from "../api/sets";
import type { Segment, Tint } from "./segments";

/** Colors applied when the caller asks for them (picocolors' own switch follows stdout, not the caller). */
const pc = picocolors.createColors(true);

// THE BOXES OF A ROW in a set's live view: one per repeat, filled left to right as its runs end, and the words beside
// them. Every count is the platform's (ax invariant 1). Drawn as segments, text and a tint, so the live view
// (live-view.ts) can cut them to the terminal's width on their plain text before painting them.

export type BoxState = "passed" | "failed" | "excluded" | "grading" | "running" | "waiting";

/** How each box is drawn, with color and without: without color the shape alone tells them apart. */
const BOX: Readonly<
	Record<BoxState, { colored: string; bare: string; tint: Tint; words: string }>
> = {
	passed: { colored: "■", bare: "■", tint: pc.green, words: "passed" },
	failed: { colored: "■", bare: "×", tint: pc.red, words: "not passed" },
	excluded: { colored: "■", bare: "·", tint: pc.gray, words: "excluded" },
	grading: { colored: "▣", bare: "▣", tint: pc.cyan, words: "grading" },
	running: { colored: "▣", bare: "▸", tint: pc.yellow, words: "running" },
	waiting: { colored: "□", bare: "□", tint: pc.dim, words: "waiting" },
};
const BOX_ORDER: readonly BoxState[] = [
	"passed",
	"failed",
	"excluded",
	"grading",
	"running",
	"waiting",
];

/** A cell's runs as boxes, one per repeat: the ones that ended first (by verdict), then those still going, then the rest. */
export function boxStatesOf(cell: SetCell | undefined, repeat: number): BoxState[] {
	const counts: Record<BoxState, number> = {
		passed: 0,
		failed: 0,
		excluded: 0,
		grading: 0,
		running: 0,
		waiting: repeat,
	};
	if (cell) {
		const passed = Math.max(0, cell.passed ?? 0);
		const graded = Math.max(passed, cell.graded);
		counts.passed = passed;
		counts.failed = graded - passed;
		counts.excluded = Math.max(0, cell.excluded);
		counts.running = Math.max(0, cell.inFlight);
		counts.grading = Math.max(0, cell.runs - graded - counts.excluded - counts.running);
		counts.waiting = Math.max(0, repeat - cell.runs);
	}
	return BOX_ORDER.flatMap((state) => Array<BoxState>(counts[state]).fill(state)).slice(0, repeat);
}

/** Every box of the row has ended: graded either way, or excluded. */
export const rowDone = (states: readonly BoxState[]): boolean =>
	states.every((state) => state === "passed" || state === "failed" || state === "excluded");

const boxOf = (state: BoxState, color: boolean): Segment => ({
	text: color ? BOX[state].colored : BOX[state].bare,
	tint: BOX[state].tint,
});

/** A row's boxes, a space apart. */
export function boxSegments(states: readonly BoxState[], color: boolean): Segment[] {
	return states.flatMap((state, i) => [...(i > 0 ? [{ text: " " }] : []), boxOf(state, color)]);
}

/** What the boxes mean: each one beside its words. */
export function legendSegments(color: boolean): Segment[] {
	return BOX_ORDER.flatMap((state) => [
		boxOf(state, color),
		{ text: ` ${BOX[state].words}  `, tint: pc.dim },
	]);
}

/** The words of a row: its verdicts and flags once a run is graded, else what its runs are doing. */
export function rowSummary(
	cell: SetCell | undefined,
	states: readonly BoxState[],
	over: boolean,
): Segment[] {
	if (cell && cell.graded > 0) {
		const parts: Segment[] = [
			{ text: `${cell.passed ?? 0} of ${cell.graded} passed`, tint: pc.dim },
		];
		const add = (text: string, tint: Tint) =>
			parts.push({ text: " · ", tint: pc.dim }, { text, tint });
		if (cell.rate !== null) add(`${Math.round(cell.rate * 100)}%`, pc.bold);
		if ((cell.blocked ?? 0) > 0) add(`${cell.blocked} blocked`, pc.yellow);
		if ((cell.neverVisited ?? 0) > 0) add(`${cell.neverVisited} never visited`, pc.yellow);
		if (cell.excluded > 0) add(`${cell.excluded} excluded`, pc.gray);
		return parts;
	}
	const word = states.includes("running")
		? "running"
		: states.includes("grading")
			? "grading"
			: states.includes("excluded") && !states.includes("waiting")
				? "excluded"
				: over
					? "no runs"
					: "waiting";
	return [{ text: word, tint: pc.dim }];
}
