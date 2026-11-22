// LINES FOR A TERMINAL, from segments (a text and its tint): cut to the terminal's width on their plain text first,
// then painted, so a line never wraps whatever its colors. Shared by the set's live view and its end view.

export type Tint = (text: string) => string;

export interface Segment {
	text: string;
	tint?: Tint;
}

/** One line from segments, cut to `width` on its plain text (an ellipsis marks the cut), then painted. */
export function lineOf(segments: readonly Segment[], width: number, color: boolean): string {
	let budget = width;
	const out: string[] = [];
	for (const segment of segments) {
		if (budget <= 0) break;
		let text = segment.text;
		if (text.length > budget) text = budget > 1 ? `${text.slice(0, budget - 1)}…` : "…";
		budget -= text.length;
		out.push(color && segment.tint ? segment.tint(text) : text);
	}
	return out.join("");
}

export const pad = (text: string, width: number): string =>
	text + " ".repeat(Math.max(0, width - text.length));
