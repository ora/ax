import type { SetDocument } from "../api/sets";
import { LiveRegion, type TerminalStream } from "../ui/live-region";
import { liveSetLines } from "./live-view";
import { LineProgress, type SetProgress } from "./set-progress";

// THE LIVE VIEW ON A TERMINAL: the set's panel (live-view.ts) painted in place (live-region.ts), repainted on every
// document the platform sends and on an animation tick between them so the spinners of rows still going turn. The
// tick only animates: no document is ever asked for on it (the documents come from the live stream, or from the
// reads following falls back to).

const TICK_MS = 100;

export interface LiveSetViewOptions {
	out: TerminalStream;
	color: boolean;
	now?: () => number;
	tickMs?: number;
}

class LiveSetView implements SetProgress {
	private set: SetDocument | null = null;
	private frame = 0;
	private noted: string | null = null;
	private settled = false;
	private readonly region: LiveRegion;
	private readonly ticker: ReturnType<typeof setInterval>;

	constructor(private readonly options: LiveSetViewOptions) {
		this.region = new LiveRegion(options.out);
		this.ticker = setInterval(() => {
			this.frame += 1;
			this.paint();
		}, options.tickMs ?? TICK_MS);
		this.ticker.unref?.();
	}

	show(set: SetDocument): void {
		this.set = set;
		this.paint();
	}

	note(text: string): void {
		this.noted = text;
		this.paint();
	}

	/** Watching ended: the set's last frame stays on screen (still, every row), and the report prints under it. */
	close(): void {
		clearInterval(this.ticker);
		if (this.set) {
			this.region.settle(this.lines(this.set, true));
			this.settled = true;
		} else this.region.close();
	}

	leftOnScreen(): boolean {
		return this.settled;
	}

	private paint(): void {
		if (this.set) this.region.draw(this.lines(this.set, false));
	}

	private lines(set: SetDocument, final: boolean): string[] {
		const { out, color } = this.options;
		return liveSetLines(set, {
			now: (this.options.now ?? Date.now)(),
			frame: this.frame,
			// One column short of the edge: a line that fills the last column wraps on some terminals.
			width: Math.max(40, (out.columns ?? 100) - 1),
			height: Math.max(12, out.rows ?? 40),
			color,
			note: this.noted,
			final,
		});
	}
}

export function createLiveSetView(options: LiveSetViewOptions): SetProgress {
	return new LiveSetView(options);
}

/** The progress for a stream: the live view on a terminal, the lines everywhere else. */
export function progressFor(
	out: TerminalStream & { isTTY?: boolean },
	env: NodeJS.ProcessEnv = process.env,
): SetProgress {
	if (!out.isTTY || env.TERM === "dumb") return new LineProgress();
	return createLiveSetView({ out, color: !("NO_COLOR" in env) });
}
