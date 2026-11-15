// Small terminal-text helpers shared by the journey renderer. All width math in
// this package operates on plain strings; color is applied to whole lines only,
// after wrapping, so ANSI escapes can never skew column calculations.

/** Current stdout width clamped into [lo, hi]; 100 when not a terminal. */
export function stdoutWidth(lo: number, hi: number): number {
	const cols = process.stdout.columns ?? 100;
	return Math.min(hi, Math.max(lo, cols));
}

/** Collapse runs of whitespace and cap at `max` chars with a trailing ellipsis. */
export function squeeze(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Greedy word wrap (no hard-breaking); collapses whitespace first. */
export function flow(value: string, max: number): string[] {
	const out: string[] = [];
	let current = "";
	for (const word of value.replace(/\s+/g, " ").trim().split(" ")) {
		if (current && current.length + 1 + word.length > max) {
			out.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) out.push(current);
	return out;
}

/**
 * Pulse frames shared by the scan spinner and the journey panel — a breathing
 * diamond, echoing the ◆ intent marker in the journey graph. Every frame is a
 * single-cell glyph so `.length` math stays valid; frames are doubled so the
 * pulse breathes smoothly at the 80ms tick.
 */
export const SPINNER_FRAMES = ["◇", "◇", "◈", "◈", "◆", "◆", "◈", "◈"];

/**
 * Strip terminal control characters from text this process did not author.
 *
 * Tool names, descriptions and schemas are third-party page content: a page can
 * register a tool whose description contains an erase-display sequence and,
 * printed raw, it clears the reader's screen - or recolors the rest of the
 * report to hide a failure. `flow` and `squeeze` do not help, because the
 * whitespace class does not match ESC.
 *
 * Every C0 and C1 control character and the DEL become a space; printable text
 * is untouched, and callers wrap with `flow`, which collapses the runs. This is
 * NOT a reinterpretation of a payload the server decided (design decision #1):
 * the words stay verbatim, and only the bytes that drive the terminal rather
 * than appear in it are dropped.
 */
export function plain(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** `plain` for a message printed as it is, not reflowed: tabs and line breaks stay. */
export function plainLines(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
	return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
}
