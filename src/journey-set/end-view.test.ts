import { describe, expect, it } from "vitest";
import type { SetBreakdown, SetDocument } from "../api/sets";
import { endNextWhy, endViewLines } from "./end-view";

// The end of a watched set, under the panel: where agents drop off, why runs did not pass, each agent, the change
// since the last run of the same set, and a link to every run's journey. Every number is the platform's (ax
// invariant 1): the view chooses words, order and bars, never a count. Fixture: the real dev run of 2026-11-22.

const CC = "claude-code/claude-haiku-4-5-20251001";
const CX = "codex/gpt-5.4-mini";
const BREAKDOWN: SetBreakdown = {
	levels: [
		{ key: "need", graded: 4, passed: 0 },
		{ key: "brand", graded: 4, passed: 3 },
		{ key: "exact", graded: 4, passed: 3 },
	],
	agents: [
		{ agent: CC, graded: 6, passed: 3 },
		{ agent: CX, graded: 6, passed: 3 },
	],
	notPassed: { runs: 6, neverVisited: 5, visited: 1, blocked: 0, unclear: 0 },
	passedWithoutVisiting: 1,
	previous: null,
};

function set(over: Partial<SetDocument> = {}): SetDocument {
	return {
		setId: "ebafe3d5-8a74-4eb4-b532-2732055d31c0",
		site: "linear.app",
		brand: "Linear",
		createdAt: "2026-11-22T20:00:00.000Z",
		state: "complete",
		complete: true,
		error: null,
		goals: [
			{
				index: 1,
				text: "Find how to create an issue from the API",
				levels: ["need", "brand", "exact"],
			},
		],
		levels: [
			{ key: "need", label: "Need only" },
			{ key: "brand", label: "Brand named" },
			{ key: "exact", label: "Exact target" },
		],
		skippedLevels: [
			{
				level: "docs",
				goal: null,
				note: "No --docs URL, so the docs level is skipped. Add --docs <url> to include it.",
			},
		],
		agents: [CC, CX],
		repeat: 2,
		runs: { planned: 12, started: 12, notStarted: 0 },
		cells: [],
		gaps: [
			{
				from: "need",
				to: "brand",
				direction: "better",
				layer: "discovery",
				earlySignal: true,
				line: "linear.app loses agents at the Discovery layer: 0 of 4 runs satisfied at Need only, 3 of 4 at Brand named. An early signal: not enough runs to decide.",
			},
		],
		notes: [
			"At the need level the prompt does not name your site, so an agent can reach the goal without using it.",
		],
		next: { command: "audit", line: "ax audit linear.app" },
		breakdown: BREAKDOWN,
		links: { set: "https://study.ora.ai/studies/manage/ebafe3d5-8a74-4eb4-b532-2732055d31c0" },
		...over,
	};
}

const plainLines = (doc: SetDocument, width = 120) => endViewLines(doc, { width, color: false });
const text = (doc: SetDocument) => plainLines(doc).join("\n");

describe("endViewLines: where agents drop off", () => {
	it("one bar per level, its served count, and the step that gained or lost agents named by its layer", () => {
		const lines = plainLines(set());
		const at = (label: string) => lines.find((line) => line.trimStart().startsWith(label)) ?? "";
		expect(lines.join("\n")).toContain("◆ Where agents drop off");
		expect(at("Need only")).toMatch(/░{12}\s+0 of 4$/);
		expect(at("Brand named")).toMatch(
			/█{9}░{3}\s+3 of 4\s+▲ Discovery — naming Linear got agents to your site/,
		);
		// The platform names no difference between brand and exact: no arrow claims one.
		expect(at("Exact target")).toContain("─ no clear change from Brand named");
	});

	it("says when the gap is only an early signal, and how to make it a measurement", () => {
		expect(text(set())).toContain(
			"An early signal: 4 runs a level. More repeats (--repeat) turn it into a measurement.",
		);
		const decided = set({ gaps: set().gaps.map((gap) => ({ ...gap, earlySignal: false })) });
		expect(text(decided)).not.toContain("An early signal");
	});

	it("the access step and a level that did worse are said as such", () => {
		const doc = set({
			gaps: [
				{
					from: "need",
					to: "brand",
					direction: "worse",
					layer: null,
					earlySignal: false,
					line: "",
				},
				{
					from: "brand",
					to: "exact",
					direction: "better",
					layer: "access_usability",
					earlySignal: false,
					line: "",
				},
			],
		});
		expect(text(doc)).toContain("▼ worse than Need only");
		expect(text(doc)).toContain("▲ Access and Usability — the exact page got agents through");
	});
});

describe("endViewLines: why runs did not pass", () => {
	it("each reason is the platform's count, of the runs that did not pass", () => {
		const out = text(set());
		expect(out).toContain("◆ Why runs did not pass");
		expect(out).toContain(
			"5 of 6 never visited linear.app — they answered from memory or other sites (Discovery)",
		);
		expect(out).toContain("1 of 6 visited and still missed it — see their journeys");
		expect(out).toContain("0 were blocked by the site");
		expect(out).toContain(
			"1 run passed without visiting linear.app — the agent already knew the answer, not from your pages",
		);
	});

	it("a reason with no runs, a blocked count the platform does not read, and an unclear count are each said only when there is one", () => {
		const doc = set({
			breakdown: {
				...BREAKDOWN,
				notPassed: { runs: 6, neverVisited: 6, visited: 0, blocked: null, unclear: 2 },
				passedWithoutVisiting: 0,
			},
		});
		const out = text(doc);
		expect(out).not.toContain("visited and still missed");
		expect(out).not.toContain("blocked by the site");
		expect(out).not.toContain("passed without visiting");
		expect(out).toContain("2 of 6: whether they used linear.app could not be told");
	});

	it("when every graded run passed, it says so", () => {
		const doc = set({
			breakdown: {
				...BREAKDOWN,
				notPassed: { runs: 0, neverVisited: 0, visited: 0, blocked: 0, unclear: 0 },
				passedWithoutVisiting: 0,
			},
		});
		expect(text(doc)).toContain("Every graded run passed.");
	});
});

describe("endViewLines: agents, the last run, the link", () => {
	it("each agent over the whole set, by its harness where the set names it once", () => {
		expect(plainLines(set()).find((line) => line.includes("◆ Agents"))).toMatch(
			/◆ Agents\s+claude-code 3 of 6\s+codex 3 of 6/,
		);
	});

	it("since the last run of the same set: each level now and then, and the change where ora states one", () => {
		const previous = {
			setId: "prev",
			createdAt: "2026-11-21T09:00:00.000Z",
			levels: [
				{
					key: "need",
					graded: 4,
					passed: 0,
					change: { points: 0, interval: [-30, 30] as [number, number], goals: 2 },
				},
				{
					key: "brand",
					graded: 4,
					passed: 1,
					change: { points: 50, interval: [5, 80] as [number, number], goals: 2 },
				},
				{
					key: "exact",
					graded: 4,
					passed: 4,
					change: { points: -25.4, interval: [-60, -2] as [number, number], goals: 2 },
				},
			],
		};
		const lines = plainLines(set({ breakdown: { ...BREAKDOWN, previous } }));
		const block = lines.slice(
			lines.findIndex((line) => line.includes("◆ Since the last run of this set")),
		);
		expect(block[0]).toContain("◆ Since the last run of this set (Nov 21)");
		expect(block.find((line) => line.includes("Need only"))).toMatch(
			/0 of 4\s+was 0 of 4\s+≈ 0 pp, within noise/,
		);
		expect(block.find((line) => line.includes("Brand named"))).toMatch(
			/3 of 4\s+was 1 of 4\s+▲ \+50 pp/,
		);
		expect(block.find((line) => line.includes("Exact target"))).toMatch(
			/3 of 4\s+was 4 of 4\s+▼ -25 pp/,
		);
	});

	it("no line ends in padding: a level with no change stops after its last count", () => {
		const previous = {
			setId: "prev",
			createdAt: "2026-11-21T09:00:00.000Z",
			levels: [{ key: "need", graded: 4, passed: 0, change: null }],
		};
		for (const line of plainLines(set({ breakdown: { ...BREAKDOWN, previous } })))
			expect(line).toBe(line.trimEnd());
	});

	it("with one goal ora states no change between runs: the counts side by side, and why", () => {
		const previous = {
			setId: "prev",
			createdAt: "2026-11-21T09:00:00.000Z",
			levels: [
				{ key: "need", graded: 4, passed: 0, change: null },
				{ key: "brand", graded: 4, passed: 1, change: null },
				{ key: "exact", graded: 4, passed: 4, change: null },
			],
		};
		const out = text(set({ breakdown: { ...BREAKDOWN, previous } }));
		expect(out).toMatch(/Brand named\s+3 of 4\s+was 1 of 4/);
		expect(out).not.toMatch(/\d pp/);
		expect(out).toContain(
			"ora states a change between runs from two goals up; with one goal, these are the counts side by side.",
		);
	});

	it("no last run: no such section", () => {
		expect(text(set())).not.toContain("Since the last run");
	});

	it("links to every run's journey on ora when the platform gives the link", () => {
		expect(text(set())).toContain(
			"Every run's journey, step by step:  https://study.ora.ai/studies/manage/ebafe3d5-8a74-4eb4-b532-2732055d31c0",
		);
		expect(text(set({ links: { set: null } }))).not.toContain("Every run's journey");
	});
});

describe("endViewLines: the screen", () => {
	it("never prints a line wider than the terminal, but the link", () => {
		for (const line of plainLines(set(), 80).filter((l) => !l.includes("https://")))
			expect(line.length).toBeLessThanOrEqual(80);
	});

	it("never cuts the link, however narrow the terminal: a cut link opens nothing (the view is ordinary output, so a long line wraps)", () => {
		const url =
			"https://study.ws-a-b.dev.example.sh/studies/manage/103e2b77-f72b-409d-bfc4-c0199aea324f";
		const lines = plainLines(set({ links: { set: url } }), 60);
		// Too narrow for words and link on one line: the link stands whole on a line of its own.
		expect(lines).toContain(`  ${url}`);
	});

	it("text the platform sent cannot move the cursor", () => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
		expect(text(set({ site: "evil.example\u001b[2J" }))).not.toMatch(/\u001b/);
	});

	it("with color on, the same words, painted", () => {
		const colored = endViewLines(set(), { width: 120, color: true }).join("\n");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: color is ANSI
		expect(colored).toMatch(/\u001b\[/);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping color to read the words
		expect(colored.replace(/\u001b\[[0-9;]*m/g, "")).toContain("5 of 6 never visited linear.app");
	});
});

describe("endNextWhy", () => {
	it("points the Next line at the layer where agents dropped off", () => {
		expect(endNextWhy(set())).toBe("the Discovery checks behind the drop at Need only");
	});

	it("says nothing when the platform named no drop", () => {
		expect(endNextWhy(set({ gaps: [] }))).toBeUndefined();
	});
});
