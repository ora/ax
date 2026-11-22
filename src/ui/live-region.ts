// A block of lines that repaints itself in place at the bottom of a terminal stream (stderr for a set, so stdout
// keeps the report and --json clean). Every frame is ONE write: move up over the last frame, erase each line and
// write the new one, then erase whatever a taller last frame left below. The cursor is hidden while the region
// lives and shown again on close, and on process exit if close never ran (a crash must not leave it hidden).
// The caller keeps every line within the terminal's width and the frame within its height (live-view.ts does):
// a line that wraps, or a frame taller than the screen, would defeat the cursor-up arithmetic.

/** The part of a terminal stream the region uses. */
export interface TerminalStream {
	write(chunk: string): boolean;
	columns?: number;
	rows?: number;
	isTTY?: boolean;
}

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

export class LiveRegion {
	private rows = 0;
	private hidden = false;
	private readonly restore = () => {
		if (this.hidden) this.out.write(SHOW_CURSOR);
	};

	constructor(private readonly out: TerminalStream) {}

	/** Paint `lines` over the last frame. */
	draw(lines: readonly string[]): void {
		let chunk = "";
		if (!this.hidden) {
			chunk += HIDE_CURSOR;
			this.hidden = true;
			process.once("exit", this.restore);
		}
		this.out.write(chunk + this.over(lines));
		this.rows = lines.length;
	}

	/**
	 * Paint `lines` over the last frame and leave them: they are ordinary output from here on (any height: nothing
	 * moves up over them again), and what is printed next goes below them.
	 */
	settle(lines: readonly string[]): void {
		this.out.write(this.over(lines) + (this.hidden ? SHOW_CURSOR : ""));
		process.removeListener("exit", this.restore);
		this.rows = 0;
		this.hidden = false;
	}

	/** Up over the last frame, each line erased and written, then whatever a taller last frame left below erased. */
	private over(lines: readonly string[]): string {
		const up = this.rows > 0 ? `\u001b[${this.rows}A\r` : "";
		return `${up}${lines.map((line) => `\u001b[2K${line}\n`).join("")}\u001b[0J`;
	}

	/** Erase the region and show the cursor again: what is printed next starts where the region began. */
	close(): void {
		let chunk = "";
		if (this.rows > 0) chunk += `\u001b[${this.rows}A\r\u001b[0J`;
		if (this.hidden) chunk += SHOW_CURSOR;
		if (chunk) this.out.write(chunk);
		process.removeListener("exit", this.restore);
		this.rows = 0;
		this.hidden = false;
	}
}
