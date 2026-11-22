import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetDocument } from "../api/sets";
import running from "./__fixtures__/set-running.json";
import { createLiveSetView, progressFor } from "./live-watch";
import { LineProgress } from "./set-progress";

// The live view on a terminal: painted on each document, repainted on each animation tick between them (the
// spinners turn; no document is asked for), a note shown when following falls back to reading, and the screen
// handed back on close. Off a terminal, and on a dumb one, the lines instead.

const RUNNING = running as SetDocument;

function terminal(isTTY = true) {
	const writes: string[] = [];
	return {
		writes,
		out: {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 100,
			rows: 40,
			isTTY,
		},
	};
}

describe("createLiveSetView", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("paints nothing before the first document, then paints it", () => {
		const { writes, out } = terminal();
		const view = createLiveSetView({ out, color: false, now: () => Date.parse(RUNNING.createdAt) });
		vi.advanceTimersByTime(500);
		expect(writes).toEqual([]);
		view.show(RUNNING);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain(RUNNING.site);
		view.close();
	});

	it("repaints on each tick so the spinners turn, without being handed anything new", () => {
		const { writes, out } = terminal();
		const view = createLiveSetView({
			out,
			color: false,
			now: () => Date.parse(RUNNING.createdAt),
			tickMs: 100,
		});
		view.show(RUNNING);
		vi.advanceTimersByTime(300);
		expect(writes.length).toBe(4);
		expect(writes[1]).not.toBe(writes[2]);
		view.close();
	});

	it("shows a note under the status", () => {
		const { writes, out } = terminal();
		const view = createLiveSetView({ out, color: false, now: () => Date.parse(RUNNING.createdAt) });
		view.show(RUNNING);
		view.note("Live updates are not available right now; checking every few seconds.");
		expect(writes.at(-1)).toContain("Live updates are not available right now");
		view.close();
	});

	it("close stops the ticks and leaves the set's last frame on screen, without the how-to-leave lines", () => {
		const { writes, out } = terminal();
		const view = createLiveSetView({
			out,
			color: false,
			now: () => Date.parse(RUNNING.createdAt),
			tickMs: 100,
		});
		view.show(RUNNING);
		view.close();
		const after = writes.length;
		vi.advanceTimersByTime(1_000);
		expect(writes.length).toBe(after);
		const last = writes.at(-1) ?? "";
		expect(last).toContain(RUNNING.site);
		expect(last).toContain("passed");
		expect(last).not.toContain("Ctrl-C stops watching");
		expect(last.endsWith("\u001b[?25h")).toBe(true);
	});

	it("close before any document leaves nothing behind", () => {
		const { writes, out } = terminal();
		const view = createLiveSetView({ out, color: false });
		view.close();
		expect(writes).toEqual([]);
		expect(view.leftOnScreen()).toBe(false);
	});

	it("says the set's rows are on screen once closing left them there, and not before", () => {
		const { out } = terminal();
		const view = createLiveSetView({ out, color: false, now: () => Date.parse(RUNNING.createdAt) });
		view.show(RUNNING);
		expect(view.leftOnScreen()).toBe(false);
		view.close();
		expect(view.leftOnScreen()).toBe(true);
	});
});

describe("progressFor", () => {
	it("off a terminal: the lines, which leave no rows on screen", () => {
		const lines = progressFor(terminal(false).out, {});
		expect(lines).toBeInstanceOf(LineProgress);
		lines.close();
		expect(lines.leftOnScreen()).toBe(false);
	});

	it("on a dumb terminal: the lines", () => {
		expect(progressFor(terminal(true).out, { TERM: "dumb" })).toBeInstanceOf(LineProgress);
	});

	it("on a terminal: the live view, without color when NO_COLOR is set", () => {
		vi.useFakeTimers();
		try {
			const { writes, out } = terminal(true);
			const view = progressFor(out, { NO_COLOR: "1" });
			expect(view).not.toBeInstanceOf(LineProgress);
			view.show(RUNNING);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: no color means no SGR sequence
			expect(writes[0]).not.toMatch(/\u001b\[[0-9;]*m/);
			view.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
