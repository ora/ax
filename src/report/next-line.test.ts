import { afterEach, describe, expect, it, vi } from "vitest";
import { axCall, nextLine, placeholder, printNext, shellWord } from "./next-line";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("shellWord", () => {
	it("leaves a word bare when a shell would read it unchanged", () => {
		expect(shellWord("stripe.com")).toBe("stripe.com");
		expect(shellWord("https://docs.example.com/v2")).toBe("https://docs.example.com/v2");
		expect(shellWord("--min-score")).toBe("--min-score");
	});

	it("single quotes anything a shell would split or expand", () => {
		expect(shellWord("Find pricing")).toBe("'Find pricing'");
		expect(shellWord("$HOME")).toBe("'$HOME'");
		expect(shellWord("ngrok http 3000 --log stdout")).toBe("'ngrok http 3000 --log stdout'");
	});

	it("escapes a single quote inside the word", () => {
		expect(shellWord("what's new")).toBe("'what'\\''s new'");
	});
});

describe("axCall", () => {
	it("renders placeholders unquoted and real arguments quoted", () => {
		expect(axCall(["deep-journey", "stripe.com", "--task", "Find the pricing page"])).toBe(
			"ax deep-journey stripe.com --task 'Find the pricing page'",
		);
		expect(axCall(["audit", placeholder("domain")])).toBe("ax audit <domain>");
		expect(axCall(["audit", "stripe.com", "--api-key", placeholder("key")])).toBe(
			"ax audit stripe.com --api-key <key>",
		);
	});
});

describe("nextLine", () => {
	it("puts the reason after the call as a shell comment", () => {
		expect(nextLine({ call: "ax audit stripe.com", why: "score the site" })).toBe(
			"Next: ax audit stripe.com  # score the site",
		);
		expect(nextLine({ call: "ax learn" })).toBe("Next: ax learn");
	});

	it("blanks control characters a server value could carry", () => {
		expect(nextLine({ call: "ax audit evil.com\u001b[2J", why: "a\nb" })).toBe(
			"Next: ax audit evil.com [2J  # a b",
		);
	});
});

describe("printNext", () => {
	it("goes to stdout after a report and to stderr when stdout carries a payload", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		printNext({ call: "ax learn" }, { stderr: false });
		expect(log).toHaveBeenCalledWith("Next: ax learn");
		expect(error).not.toHaveBeenCalled();
		printNext({ call: "ax learn" }, { stderr: true });
		expect(error).toHaveBeenCalledWith("Next: ax learn");
		expect(log).toHaveBeenCalledTimes(1);
	});
});
