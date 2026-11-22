import { describe, expect, it } from "vitest";
import { LiveRegion } from "./live-region";

// The region's contract with the terminal: one write per frame, each frame painted over the last, the cursor
// hidden while it lives and shown again when it closes, and nothing of it left behind once closed.

function terminal() {
	const writes: string[] = [];
	return {
		writes,
		stream: {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 80,
			rows: 24,
			isTTY: true,
		},
	};
}

describe("LiveRegion", () => {
	it("hides the cursor and paints the first frame in one write", () => {
		const { writes, stream } = terminal();
		const region = new LiveRegion(stream);
		region.draw(["one", "two"]);
		region.close();
		expect(writes).toHaveLength(2);
		expect(writes[0].startsWith("\u001b[?25l")).toBe(true);
		expect(writes[0]).toContain("\u001b[2Kone\n\u001b[2Ktwo\n");
		// The first frame has nothing above it to move up over.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the cursor-up sequence starts with ESC
		expect(writes[0]).not.toMatch(/\u001b\[\d+A/);
	});

	it("paints each next frame over the last: up by the last frame's height, then the new lines", () => {
		const { writes, stream } = terminal();
		const region = new LiveRegion(stream);
		region.draw(["one", "two", "three"]);
		region.draw(["four"]);
		expect(writes[1].startsWith("\u001b[3A\r")).toBe(true);
		expect(writes[1]).toContain("\u001b[2Kfour\n");
		// A shorter frame erases what the taller one left below it.
		expect(writes[1].endsWith("\u001b[0J")).toBe(true);
		// The cursor is hidden once, not on every frame.
		expect(writes[1]).not.toContain("\u001b[?25l");
		region.close();
	});

	it("close erases the region and shows the cursor again", () => {
		const { writes, stream } = terminal();
		const region = new LiveRegion(stream);
		region.draw(["one", "two"]);
		region.close();
		expect(writes[1]).toBe("\u001b[2A\r\u001b[0J\u001b[?25h");
	});

	it("settle paints a last frame over the last one and leaves it on screen, cursor shown", () => {
		const { writes, stream } = terminal();
		const region = new LiveRegion(stream);
		region.draw(["one", "two"]);
		region.settle(["done", "for", "good"]);
		expect(writes[1].startsWith("\u001b[2A\r")).toBe(true);
		expect(writes[1]).toContain("\u001b[2Kdone\n\u001b[2Kfor\n\u001b[2Kgood\n");
		expect(writes[1].endsWith("\u001b[?25h")).toBe(true);
		// What stays is no longer the region's: closing afterwards erases nothing.
		region.close();
		expect(writes).toHaveLength(2);
	});

	it("close on a region that never painted writes nothing", () => {
		const { writes, stream } = terminal();
		new LiveRegion(stream).close();
		expect(writes).toEqual([]);
	});

	it("shows the cursor again on process exit if close never ran", () => {
		const { writes, stream } = terminal();
		const before = process.listenerCount("exit");
		const region = new LiveRegion(stream);
		region.draw(["one"]);
		expect(process.listenerCount("exit")).toBe(before + 1);
		process.emit("exit", 0);
		expect(writes.at(-1)).toBe("\u001b[?25h");
		region.close();
		expect(process.listenerCount("exit")).toBe(before);
	});
});
