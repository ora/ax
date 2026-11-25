import { describe, expect, it } from "vitest";
import { setRequestOf, wholeNumber } from "./args";

const flags = (over: Record<string, unknown> = {}) => ({
	domain: "linear.app",
	levels: false,
	...over,
});

describe("setRequestOf", () => {
	it("is the request the platform takes: the site and goals as typed, and only the flags given", () => {
		expect(setRequestOf(["Find pricing"], flags())).toEqual({
			request: { site: "linear.app", goals: ["Find pricing"] },
		});
		expect(
			setRequestOf(
				["a", "b"],
				flags({
					agents: "claude-code, codex/gpt-5.4-mini",
					levels: true,
					brand: " Linear ",
					docs: "https://linear.app/docs",
					exact: "https://linear.app/developers",
					repeat: "3",
				}),
			),
		).toEqual({
			request: {
				site: "linear.app",
				goals: ["a", "b"],
				agents: ["claude-code", "codex/gpt-5.4-mini"],
				levels: true,
				brand: "Linear",
				docs: "https://linear.app/docs",
				exact: "https://linear.app/developers",
				repeat: 3,
			},
		});
	});

	it("--harness and --model name the set's one agent", () => {
		expect(setRequestOf(["a"], flags({ harness: "codex", model: "gpt-5.4-mini" }))).toMatchObject({
			request: { agents: ["codex/gpt-5.4-mini"] },
		});
		expect(setRequestOf(["a"], flags({ harness: "codex" }))).toMatchObject({
			request: { agents: ["codex"] },
		});
		expect(setRequestOf(["a"], flags({ model: "claude-sonnet-5" }))).toMatchObject({
			request: { agents: ["claude-code/claude-sonnet-5"] },
		});
	});

	it("refuses what cannot be a request: no site, no goal, both ways of naming agents, a repeat that is no number", () => {
		expect(setRequestOf(["a"], flags({ domain: undefined }))).toMatchObject({
			problem: expect.stringContaining("--domain"),
		});
		expect(setRequestOf([], flags())).toMatchObject({
			problem: expect.stringContaining("at least one goal"),
		});
		expect(setRequestOf(["a"], flags({ agents: "codex", harness: "codex" }))).toMatchObject({
			problem: expect.stringContaining("--agents"),
		});
		expect(setRequestOf(["a"], flags({ agents: " , " }))).toMatchObject({
			problem: expect.stringContaining("--agents"),
		});
		expect(setRequestOf(["a"], flags({ repeat: "three" }))).toMatchObject({
			problem: expect.stringContaining("--repeat"),
		});
	});

	it("leaves every limit to the platform: 6 goals and repeat 99 are a request, refused by its preview", () => {
		expect(setRequestOf(["1", "2", "3", "4", "5", "6"], flags({ repeat: "99" }))).toMatchObject({
			request: { repeat: 99 },
		});
	});
});

describe("wholeNumber", () => {
	it("is a whole number of 1 or more", () => {
		expect([
			wholeNumber("1"),
			wholeNumber(" 60 "),
			wholeNumber("0"),
			wholeNumber("1.5"),
			wholeNumber("-2"),
			wholeNumber("x"),
		]).toEqual([1, 60, undefined, undefined, undefined, undefined]);
	});
});
