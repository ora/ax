import { describe, expect, it } from "vitest";
import { decodeEventBlock } from "./platform";

describe("decodeEventBlock", () => {
	it("reads the event name and payload", () => {
		expect(decodeEventBlock('event: result\ndata: {"ok":1}')).toEqual({
			event: "result",
			data: '{"ok":1}',
		});
	});

	it("ignores heartbeat comments", () => {
		expect(decodeEventBlock(": ping")).toBeNull();
	});

	it("defaults to 'message' and concatenates data lines", () => {
		expect(decodeEventBlock("data: one\ndata: two")).toEqual({
			event: "message",
			data: "one\ntwo",
		});
	});
});
