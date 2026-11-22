import type { SetDocument } from "../api/sets";

// WHERE A FOLLOWED SET'S PROGRESS GOES under --watch: a strategy chosen by where ax prints. Off a terminal (a pipe,
// CI, a test) the lines ax always printed: one per change. On a terminal, the live view (live-watch.ts): a panel
// that repaints in place. Following (journey-set.ts) hands each document to whichever was chosen and never knows
// which; a third (a JSON-lines feed, say) is one more implementation, not an edit to following.

export interface SetProgress {
	/** A document of the set, as the platform sent or answered it. */
	show(set: SetDocument): void;
	/** One sentence for the person: the live stream falling back to reading, say. */
	note(text: string): void;
	/** Following ended: release the screen before the report is printed. */
	close(): void;
	/** Closing left the set's rows on the person's screen: a report printed to that screen need not repeat them. */
	leftOnScreen(): boolean;
}

/** What moved between two documents of one set, as lines: its state, then each cell whose counts changed. */
export function progressLines(before: SetDocument | null, after: SetDocument): string[] {
	const lines: string[] = [];
	const stateLine = (set: SetDocument) =>
		`${set.state}: ${set.runs.started} of ${set.runs.planned} runs started`;
	if (before === null || stateLine(before) !== stateLine(after)) lines.push(stateLine(after));
	const labelOf = (key: string) => after.levels.find((level) => level.key === key)?.label ?? key;
	const keyOf = (cell: SetDocument["cells"][number]) => `${cell.goal}|${cell.level}|${cell.agent}`;
	const earlier = new Map((before?.cells ?? []).map((cell) => [keyOf(cell), cell]));
	for (const cell of after.cells) {
		const was = earlier.get(keyOf(cell));
		const moved =
			was === undefined
				? cell.graded > 0 || cell.inFlight > 0
				: was.graded !== cell.graded ||
					was.passed !== cell.passed ||
					was.inFlight !== cell.inFlight;
		if (!moved) continue;
		const goal = after.goals.length > 1 ? `goal ${cell.goal} · ` : "";
		const going = cell.inFlight > 0 ? `, ${cell.inFlight} still running` : "";
		lines.push(
			`${goal}${labelOf(cell.level)} · ${cell.agent}: ${cell.passed ?? 0} of ${cell.graded} graded${going}`,
		);
	}
	return lines;
}

/** Off a terminal: a line for each change, on stderr (stdout keeps the report and --json). */
export class LineProgress implements SetProgress {
	private printed: SetDocument | null = null;

	constructor(private readonly print: (line: string) => void = (line) => console.error(line)) {}

	show(set: SetDocument): void {
		for (const line of progressLines(this.printed, set)) this.print(`  ${line}`);
		this.printed = set;
	}

	note(text: string): void {
		this.print(`  ${text}`);
	}

	close(): void {}

	leftOnScreen(): boolean {
		return false;
	}
}
