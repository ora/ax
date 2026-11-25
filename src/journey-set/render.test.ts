import { describe, expect, it } from "vitest";
import type { SetDocument, SetList, SetPreview } from "../api/sets";
import list from "./__fixtures__/list.json";
import preview from "./__fixtures__/preview.json";
import complete from "./__fixtures__/set-complete.json";
import running from "./__fixtures__/set-running.json";
import { cellText, previewProblem, renderList, renderPreview, renderReport } from "./render";

// The fixtures are the platform's real answers for one set (linear.app, 2 goals, 3 levels, 2 agents,
// 1 repeat), captured from a local ora on 2026-11-22. Variations are explicit deltas from them.
const PREVIEW = preview as SetPreview;
const COMPLETE = complete as SetDocument;
const RUNNING = running as SetDocument;

describe("renderPreview", () => {
	const text = renderPreview(PREVIEW);

	it("names the site, each goal, the brand, each level's prompt, the agents and the run total", () => {
		expect(text).toContain("linear.app: a set of journeys");
		expect(text).toContain("Goal 1: Find how to create an issue from the API");
		expect(text).toContain("Brand: Linear");
		expect(text).toContain("Need only     the goal as written");
		expect(text).toContain('Brand named   the goal, then "Use Linear."');
		expect(text).toContain("Runs: 10 (a set may start at most 200)");
		expect(text).toContain(`Your plan has ${PREVIEW.runs.left} runs left.`);
	});

	it("says which goal a level leaves out and why, in the platform's own words", () => {
		expect(text).toContain("Goal 2: The goal names Linear, so the need level is skipped.");
		expect(text).toContain("No --docs URL, so the docs level is skipped.");
	});

	it("says so when the agent was chosen for the caller", () => {
		const chosen = {
			...PREVIEW,
			agents: [{ id: "claude-code/claude-haiku-4-5", chosen: "default" as const }],
		};
		expect(renderPreview(chosen)).toContain("claude-code/claude-haiku-4-5 (chosen for you)");
	});
});

describe("previewProblem", () => {
	it("is nothing for a set that fits", () => {
		expect(previewProblem(PREVIEW)).toBeNull();
	});

	it("is the platform's own numbers when the set is over the limit or over the plan", () => {
		expect(
			previewProblem({ ...PREVIEW, runs: { total: 240, limit: 200, left: 9000, fits: false } })
				?.message,
		).toContain("would start 240 runs; a set may start at most 200");
		expect(
			previewProblem({ ...PREVIEW, runs: { total: 10, limit: 200, left: 4, fits: false } })
				?.message,
		).toBe("This set needs 10 runs and your plan has 4 left.");
	});
});

describe("cellText", () => {
	const cell = COMPLETE.cells[0];

	it("prints the counts alone where the platform gives no rate, and the rate with them where it does", () => {
		expect(cellText({ ...cell, graded: 4, passed: 3, rate: null })).toBe("3 of 4");
		expect(cellText({ ...cell, graded: 5, passed: 3, rate: 0.6 })).toBe("60% (3 of 5)");
	});

	it("says what an ungraded cell is waiting for", () => {
		expect(cellText({ ...cell, graded: 0, passed: null, rate: null, inFlight: 1 })).toBe("running");
		expect(cellText({ ...cell, graded: 0, passed: null, rate: null, inFlight: 0 })).toBe(
			"no grade yet",
		);
		expect(cellText(undefined)).toBe("-");
	});

	it("does not promise a grade that cannot come: in a set that is over, an ungraded cell has no grade", () => {
		const ungraded = { ...cell, graded: 0, passed: null, rate: null, inFlight: 0 };
		expect(cellText(ungraded, true)).toBe("no grade");
		expect(cellText(ungraded, false)).toBe("no grade yet");
	});
});

describe("a stopped set", () => {
	// A set stopped right after launch, as a local ora answered it on 2026-11-22: every run cancelled, none graded.
	const stopped: SetDocument = {
		...RUNNING,
		state: "stopped",
		complete: false,
		cells: RUNNING.cells.map((c) => ({ ...c, graded: 0, passed: null, rate: null, inFlight: 0 })),
	};

	it("says it was stopped, and prints no cell as still waiting for a grade", () => {
		const text = renderReport(stopped);
		expect(text).toContain("The set was stopped before it finished.");
		expect(text).toContain("no grade");
		expect(text).not.toContain("no grade yet");
	});
});

describe("renderReport", () => {
	const text = renderReport(COMPLETE);

	it("is one block per goal with only the levels that goal ran", () => {
		expect(text.startsWith(`linear.app  set ${COMPLETE.setId}`)).toBe(true);
		const [, goal1, goal2] = text.split(/\nGoal \d: /);
		expect(goal1).toContain("Need only");
		expect(goal2.split("\n\n")[0]).not.toContain("Need only");
		expect(goal2).toContain("Brand named");
	});

	it("prints every cell from the served counts, and the flags the platform counted", () => {
		for (const c of COMPLETE.cells) expect(text).toContain(`${c.passed ?? 0} of ${c.graded}`);
		expect(text).toContain("never visited your site");
		expect(text).not.toContain("blocked by your site");
	});

	it("ends with the platform's gap line, the skipped levels and the notes, as served", () => {
		for (const gap of COMPLETE.gaps) expect(text).toContain(gap.line);
		expect(text).toContain("An early signal: not enough runs to decide.");
		for (const note of COMPLETE.notes) expect(text).toContain(note);
	});

	it("says a set that is still going is still going", () => {
		expect(renderReport(RUNNING)).toMatch(
			/Runs are still going\.|being prepared|grades are still being written/,
		);
	});

	it("without its cells (the live view left them on screen): the set's id and state, then what the set found", () => {
		const short = renderReport(COMPLETE, { cells: false });
		expect(short.startsWith(`linear.app  set ${COMPLETE.setId}`)).toBe(true);
		expect(short).not.toMatch(/\nGoal \d: /);
		expect(short).not.toContain("never visited your site");
		for (const gap of COMPLETE.gaps) expect(short).toContain(gap.line);
		for (const note of COMPLETE.notes) expect(short).toContain(note);
		expect(renderReport(RUNNING, { cells: false })).toMatch(
			/Runs are still going\.|being prepared|grades are still being written/,
		);
	});

	it("drops terminal control bytes from text the platform sent", () => {
		const hostile = {
			...COMPLETE,
			goals: [{ ...COMPLETE.goals[0], text: "Find pricing\u001b[2J" }, COMPLETE.goals[1]],
		};
		expect(renderReport(hostile)).not.toContain("\u001b");
	});
});

describe("renderList", () => {
	it("lists each set with its id, site, state and size, in the order served", () => {
		const text = renderList(list as SetList);
		const ids = (list as SetList).sets.map((s) => s.setId);
		expect(text.split("\n").map((line) => line.split(/\s+/)[0])).toEqual(ids);
		expect(text).toContain("linear.app");
		expect(renderList({ sets: [] })).toBe("No sets yet.");
	});

	it("prints when each set was created to the minute, in UTC", () => {
		const [first] = (list as SetList).sets;
		const text = renderList({
			sets: [{ ...first, createdAt: "2026-11-22T05:38:37.144632+00:00" }],
		});
		expect(text).toContain("2026-11-22 05:38 UTC");
		expect(text).not.toContain("37.144632");
	});

	it("prints a creation time it cannot read exactly as served", () => {
		const [first] = (list as SetList).sets;
		expect(renderList({ sets: [{ ...first, createdAt: "last Tuesday" }] })).toContain(
			"last Tuesday",
		);
	});
});
