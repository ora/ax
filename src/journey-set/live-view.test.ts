import { describe, expect, it } from "vitest";
import type { SetCell, SetDocument } from "../api/sets";
import { liveSetLines } from "./live-view";
import { boxStatesOf } from "./set-boxes";

// The live view of a set, as text: a header that says what was asked, one row per agent under each level with a
// box per repeat that fills as its runs end, and a status line. Every count comes from the platform's document;
// the view only lays it out (ax invariant 1). Plain text here (color off), so the assertions read the words.

const AGENTS = ["claude-code/claude-haiku-4-5-20251001", "codex/gpt-5.4-mini"];
const LEVELS = [
	{ key: "need", label: "Need only" },
	{ key: "brand", label: "Brand named" },
	{ key: "exact", label: "Exact target" },
];

function cell(over: Partial<SetCell> & Pick<SetCell, "level" | "agent">): SetCell {
	return {
		goal: 1,
		runs: 0,
		graded: 0,
		passed: null,
		rate: null,
		excluded: 0,
		inFlight: 0,
		blocked: 0,
		neverVisited: 0,
		...over,
	};
}

function set(over: Partial<SetDocument> = {}): SetDocument {
	return {
		setId: "8e716c09-3ad7-4690-9501-5e8cb8b2d900",
		site: "linear.app",
		brand: "Linear",
		createdAt: "2026-11-22T19:00:00.000Z",
		state: "running",
		complete: false,
		error: null,
		goals: [
			{
				index: 1,
				text: "Find how to create an issue from the API",
				levels: ["need", "brand", "exact"],
			},
		],
		levels: LEVELS,
		skippedLevels: [],
		agents: AGENTS,
		repeat: 5,
		runs: { planned: 30, started: 12, notStarted: 0 },
		cells: [],
		gaps: [],
		notes: [],
		next: { command: "view", line: "ax run set view 8e716c09-3ad7-4690-9501-5e8cb8b2d900" },
		...over,
	};
}

const NOW = Date.parse("2026-11-22T19:02:14.000Z");
const plainLines = (
	doc: SetDocument,
	over: { width?: number; height?: number; frame?: number } = {},
) =>
	liveSetLines(doc, {
		now: NOW,
		frame: over.frame ?? 0,
		width: over.width ?? 120,
		height: over.height ?? 60,
		color: false,
	});

describe("boxStatesOf: one box per repeat, filled left to right as runs end", () => {
	it("a cell nobody started is all waiting", () => {
		expect(boxStatesOf(undefined, 5)).toEqual([
			"waiting",
			"waiting",
			"waiting",
			"waiting",
			"waiting",
		]);
	});

	it("passed, then not passed, then excluded, then grading, then running, then waiting", () => {
		const states = boxStatesOf(
			cell({
				level: "need",
				agent: AGENTS[0],
				runs: 8,
				graded: 4,
				passed: 3,
				excluded: 1,
				inFlight: 2,
			}),
			10,
		);
		expect(states).toEqual([
			"passed",
			"passed",
			"passed",
			"failed",
			"excluded",
			"grading",
			"running",
			"running",
			"waiting",
			"waiting",
		]);
	});

	it("never more boxes than repeats, whatever the counts say", () => {
		expect(
			boxStatesOf(cell({ level: "need", agent: AGENTS[0], runs: 9, graded: 9, passed: 9 }), 5),
		).toHaveLength(5);
	});
});

describe("liveSetLines: what a person watching the set sees", () => {
	it("a header that says what was asked: the site, the set, the goal, the levels, the agents, the repeats", () => {
		const text = plainLines(set()).join("\n");
		expect(text).toContain("linear.app");
		expect(text).toContain("8e716c09");
		expect(text).toContain("Find how to create an issue from the API");
		expect(text).toContain("Need only › Brand named › Exact target");
		expect(text).toContain("claude-code/claude-haiku-4-5-20251001");
		expect(text).toContain("codex/gpt-5.4-mini");
		expect(text).toContain("Brand    Linear");
		expect(text).toMatch(/Runs\s+30\b.*5 repeats/);
	});

	it("one row per agent under each level, with a box per repeat", () => {
		const lines = plainLines(
			set({
				cells: [
					cell({ level: "need", agent: AGENTS[0], runs: 3, graded: 2, passed: 1, inFlight: 1 }),
					cell({ level: "need", agent: AGENTS[1], runs: 5, graded: 5, passed: 3, rate: 0.6 }),
				],
			}),
		);
		const need = lines.findIndex((line) => line.trim() === "Need only");
		expect(need).toBeGreaterThan(0);
		const [first, second] = [lines[need + 1], lines[need + 2]];
		// Each harness is named once in the set, so its row says the harness; the header names the model.
		expect(first).toMatch(/ claude-code\s/);
		expect(first).not.toContain("claude-haiku");
		expect(first).toContain("■ × ▸ □ □");
		expect(first).toContain("1 of 2 passed");
		expect(second).toMatch(/ codex\s/);
		expect(second).not.toContain("gpt-5.4-mini");
		expect(second).toContain("■ ■ ■ × ×");
		expect(second).toContain("3 of 5 passed · 60%");
		// A row whose runs have all ended and been graded is done; a row still going spins.
		expect(second.trimStart().startsWith("✓")).toBe(true);
		expect(first.trimStart().startsWith("✓")).toBe(false);
	});

	it("a harness the set names with two models keeps each model on its row", () => {
		const twice = [
			"claude-code/claude-haiku-4-5-20251001",
			"claude-code/claude-sonnet-4-5",
			"codex/gpt-5.4-mini",
		];
		const rows = plainLines(set({ agents: twice })).filter((line) => line.includes("□ □ □ □ □"));
		expect(rows.slice(0, 3).map((row) => row.trim().split(/\s+/)[1])).toEqual([
			"claude-code/claude-haiku-4-5-20251001",
			"claude-code/claude-sonnet-4-5",
			"codex",
		]);
	});

	it("rows still going turn out of step, so each one reads as its own loader", () => {
		const rows = plainLines(
			set({ cells: AGENTS.map((agent) => cell({ level: "need", agent, runs: 1, inFlight: 1 })) }),
		).filter(
			(line) => line.includes("▸") && line.includes("claude-code") !== line.includes("codex"),
		);
		const glyphs = rows.map((row) => row.trim()[0]);
		expect(glyphs).toHaveLength(2);
		expect(glyphs[0]).not.toBe(glyphs[1]);
	});

	it("opens with a blank line, so the panel stands apart from what was printed above it", () => {
		expect(plainLines(set())[0]).toBe("");
	});

	it("each level of each goal gets its rows, and a cell with no runs yet is waiting", () => {
		const text = plainLines(set()).join("\n");
		for (const level of ["Need only", "Brand named", "Exact target"]) expect(text).toContain(level);
		expect(text.match(/□ □ □ □ □/g)).toHaveLength(6);
		expect(text).toContain("waiting");
	});

	it("the flags beside the verdicts: blocked and never visited are counted on the row", () => {
		const text = plainLines(
			set({
				cells: [
					cell({
						level: "exact",
						agent: AGENTS[0],
						runs: 5,
						graded: 5,
						passed: 0,
						blocked: 2,
						neverVisited: 1,
					}),
				],
			}),
		).join("\n");
		expect(text).toContain("0 of 5 passed · 2 blocked · 1 never visited");
	});

	it("a status line: the state, how many started and graded, and the time since the set was made", () => {
		const text = plainLines(
			set({
				runs: { planned: 30, started: 12, notStarted: 0 },
				cells: [cell({ level: "need", agent: AGENTS[0], runs: 5, graded: 4, passed: 2 })],
			}),
		).join("\n");
		expect(text).toMatch(/running\s.*4 of 30 graded · 12 started/);
		expect(text).toContain("2m 14s");
	});

	it("a set of several goals heads each goal's block with its text", () => {
		const text = plainLines(
			set({
				goals: [
					{ index: 1, text: "Find how to create an issue from the API", levels: ["need", "brand"] },
					{ index: 2, text: "Find how to receive a webhook from Linear", levels: ["brand"] },
				],
			}),
		).join("\n");
		expect(text).toContain("Goal 1 · Find how to create an issue from the API");
		expect(text).toContain("Goal 2 · Find how to receive a webhook from Linear");
	});

	it("says how to leave and come back, and what the boxes mean", () => {
		const text = plainLines(set()).join("\n");
		expect(text).toContain("■ passed");
		expect(text).toContain("□ waiting");
		expect(text).toContain("Ctrl-C stops watching; the runs go on");
		expect(text).toContain("ax run set view 8e716c09-3ad7-4690-9501-5e8cb8b2d900 --watch");
	});

	it("a complete set says so, and every row is done", () => {
		const full = AGENTS.flatMap((agent) =>
			LEVELS.map((level) =>
				cell({ level: level.key, agent, runs: 5, graded: 5, passed: 4, rate: 0.8 }),
			),
		);
		const lines = plainLines(
			set({
				state: "complete",
				complete: true,
				runs: { planned: 30, started: 30, notStarted: 0 },
				cells: full,
			}),
		);
		expect(lines.join("\n")).toMatch(/complete\s.*30 of 30 graded/);
		const rows = lines.filter((line) => line.includes("of 5 passed"));
		expect(rows).toHaveLength(6);
		for (const row of rows) expect(row.trimStart().startsWith("✓")).toBe(true);
	});

	it("an excluded run is over: the status counts it apart from the graded ones, and the set can be complete with it", () => {
		const full = AGENTS.flatMap((agent) =>
			LEVELS.map((level) =>
				cell({ level: level.key, agent, runs: 5, graded: 5, passed: 4, rate: 0.8 }),
			),
		);
		full[0] = cell({ level: "need", agent: AGENTS[0], runs: 5, graded: 4, passed: 4, excluded: 1 });
		const text = plainLines(
			set({
				state: "complete",
				complete: true,
				runs: { planned: 30, started: 30, notStarted: 0 },
				cells: full,
			}),
		).join("\n");
		expect(text).toMatch(/29 of 30 graded · 1 excluded · 30 started/);
		// The bar has no part left "started, not yet graded" once the set is complete.
		expect(text).not.toContain("▒");
	});

	it("the last frame, the one left on screen when watching ends: every row, the legend, nothing that turns, no how-to-leave lines", () => {
		const doc = set({ cells: [cell({ level: "need", agent: AGENTS[0], runs: 2, inFlight: 2 })] });
		const lines = liveSetLines(doc, {
			now: NOW,
			frame: 3,
			width: 120,
			height: 14,
			color: false,
			final: true,
		});
		const text = lines.join("\n");
		// The height bounds a frame that repaints; one that stays scrolls like any output, so no row is left out.
		// A row names one harness (the header's Agents line names both): 3 levels x 2 agents.
		const rows = lines.filter((line) => line.includes("claude-code") !== line.includes("codex"));
		expect(rows).toHaveLength(6);
		expect(text).not.toMatch(/more rows/);
		expect(text).toContain("■ passed");
		expect(text).not.toContain("Ctrl-C stops watching");
		expect(text).not.toContain("Pick it up again");
		// A spinner frozen mid-turn would claim the view is still live: the frame that stays is the same at any tick.
		const atTick = (frame: number) =>
			liveSetLines(doc, { now: NOW, frame, width: 120, height: 14, color: false, final: true });
		expect(atTick(0)).toEqual(lines);
		expect(atTick(5)).toEqual(lines);
	});

	it("the bar's parts are the boxes' colors: graded green, grading cyan, running yellow", () => {
		const doc = set({
			runs: { planned: 30, started: 6, notStarted: 0 },
			cells: [
				cell({ level: "need", agent: AGENTS[0], runs: 6, graded: 2, passed: 1, inFlight: 2 }),
			],
		});
		const status =
			liveSetLines(doc, { now: NOW, frame: 0, width: 120, height: 60, color: true }).find((line) =>
				line.includes("graded"),
			) ?? "";
		expect(status).toContain("\u001b[32m━");
		expect(status).toContain("\u001b[36m━");
		expect(status).toContain("\u001b[33m━");
	});

	it("the last frame ends with a blank line, so what is printed under it stands apart", () => {
		const lines = liveSetLines(set(), {
			now: NOW,
			frame: 0,
			width: 120,
			height: 60,
			color: false,
			final: true,
		});
		expect(lines.at(-1)).toBe("");
		expect(lines.at(-2)).toContain("■ passed");
	});

	it("on a narrow terminal the bar gives way, so the status keeps its counts and its time whole", () => {
		const doc = set({
			runs: { planned: 30, started: 26, notStarted: 0 },
			cells: [
				cell({ level: "need", agent: AGENTS[0], runs: 5, graded: 4, passed: 2, excluded: 1 }),
			],
		});
		const status = plainLines(doc, { width: 79 }).find((line) => line.includes("graded")) ?? "";
		expect(status.length).toBeLessThanOrEqual(79);
		expect(status).toContain("4 of 30 graded · 1 excluded · 26 started");
		expect(status).toContain("2m 14s");
		expect(status).not.toContain("…");
	});

	it("never prints a line wider than the terminal", () => {
		for (const line of plainLines(set(), { width: 60 }))
			expect(line.length).toBeLessThanOrEqual(60);
	});

	it("never prints more lines than fit, and says how many rows it left out", () => {
		const lines = plainLines(set(), { height: 14 });
		expect(lines.length).toBeLessThanOrEqual(13);
		expect(lines.join("\n")).toMatch(/… \d+ more rows/);
	});

	it("text the platform sent cannot move the cursor", () => {
		const text = plainLines(set({ site: "evil.example\u001b[2J" })).join("\n");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
		expect(text).not.toMatch(/\u001b/);
	});

	it("with color on, the same words are there, painted", () => {
		const colored = liveSetLines(set(), {
			now: NOW,
			frame: 0,
			width: 120,
			height: 60,
			color: true,
		}).join("\n");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: color is ANSI
		expect(colored).toMatch(/\u001b\[/);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping color to read the words
		expect(colored.replace(/\u001b\[[0-9;]*m/g, "")).toContain(
			"Need only › Brand named › Exact target",
		);
	});
});
