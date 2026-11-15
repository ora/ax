import { describe, expect, it } from "vitest";
import { DOCS_SKIP_NOTE, EXACT_SKIP_NOTE, needSkipNote } from "./levels";
import {
	DEFAULT_REPEAT,
	DEFAULT_WAIT_MINUTES,
	exceedsRunCap,
	journeyMode,
	MAX_AGENTS,
	MAX_GOALS,
	MAX_REPEAT,
	MAX_RUNS,
	MISSING_DOMAIN,
	parseSetSpec,
	parseWaitMinutes,
	planCells,
	plannedRuns,
	type SetSpec,
	type SetSpecInput,
} from "./spec";

const GOAL = "Find how to create an issue from the API";
const BASE: SetSpecInput = { site: "linear.app", goals: [GOAL], levels: true };

function parsed(input: Partial<SetSpecInput>): SetSpec {
	const result = parseSetSpec({ ...BASE, ...input });
	if (!result.ok) throw new Error(`expected a valid spec, got: ${result.error}`);
	return result.spec;
}

function errorOf(input: Partial<SetSpecInput>): string {
	const result = parseSetSpec({ ...BASE, ...input });
	if (result.ok) throw new Error("expected a usage error, got a valid spec");
	return result.error;
}

describe("caps and defaults", () => {
	it("pins the shared numbers", () => {
		expect({
			MAX_GOALS,
			MAX_AGENTS,
			MAX_REPEAT,
			MAX_RUNS,
			DEFAULT_REPEAT,
			DEFAULT_WAIT_MINUTES,
		}).toEqual({
			MAX_GOALS: 5,
			MAX_AGENTS: 4,
			MAX_REPEAT: 10,
			MAX_RUNS: 200,
			DEFAULT_REPEAT: 1,
			DEFAULT_WAIT_MINUTES: 60,
		});
	});
});

describe("parseSetSpec: defaults", () => {
	it("fills every optional value", () => {
		expect(parsed({})).toEqual({
			site: "linear.app",
			goals: [GOAL],
			agents: [],
			levels: true,
			brand: "Linear",
			repeat: 1,
			waitMinutes: 60,
		});
	});
});

describe("parseSetSpec: levels", () => {
	it("is off without --levels, --brand, --docs or --exact", () => {
		expect(parsed({ levels: false }).levels).toBe(false);
	});

	it("is on with --levels, and with any value a level prompt needs", () => {
		expect(parsed({ levels: true }).levels).toBe(true);
		expect(parsed({ levels: false, brand: "Linear" }).levels).toBe(true);
		expect(parsed({ levels: false, docs: "https://linear.app/docs" }).levels).toBe(true);
		expect(parsed({ levels: false, exact: "https://linear.app/developers" }).levels).toBe(true);
	});
});

describe("parseSetSpec: site", () => {
	it("keeps a bare domain", () => {
		expect(parsed({ site: "linear.app" }).site).toBe("linear.app");
	});

	it("reduces a URL to its host and lowercases it", () => {
		expect(parsed({ site: "https://Linear.App/developers?ref=x" }).site).toBe("linear.app");
		expect(parsed({ site: "http://linear.app:8080/" }).site).toBe("linear.app");
		expect(parsed({ site: "  LINEAR.app/docs  " }).site).toBe("linear.app");
	});

	it("drops a leading www, so on-site steps on the apex count", () => {
		expect(parsed({ site: "https://www.linear.app/developers" }).site).toBe("linear.app");
		expect(parsed({ site: "WWW.linear.app" }).site).toBe("linear.app");
		expect(parsed({ site: "https://www.linear.app" }).brand).toBe("Linear");
	});

	it("keeps every other subdomain, since the set targets that host", () => {
		expect(parsed({ site: "docs.stripe.com" }).site).toBe("docs.stripe.com");
		expect(parsed({ site: "www2.example.com" }).site).toBe("www2.example.com");
	});

	it("folds a fullwidth spelling to its plain form", () => {
		expect(parsed({ site: "ｌｉｎｅａｒ．ａｐｐ" }).site).toBe("linear.app");
	});

	it("rejects anything that is not a domain or an http(s) URL", () => {
		for (const site of ["", "   ", "linear", "linear app", "ftp://linear.app", "https://"]) {
			expect(errorOf({ site })).toMatch(/^--domain must be a domain like linear\.app/);
		}
	});

	it("needs --domain at all", () => {
		expect(errorOf({ site: undefined })).toBe(MISSING_DOMAIN);
		expect(MISSING_DOMAIN).toMatch(/--domain/);
	});
});

describe("parseSetSpec: goals", () => {
	it("trims each goal", () => {
		expect(parsed({ goals: ["  Find the pricing page  "] }).goals).toEqual([
			"Find the pricing page",
		]);
	});

	it("accepts 1 and 5 goals", () => {
		expect(parsed({ goals: ["a"] }).goals).toHaveLength(1);
		expect(parsed({ goals: ["a", "b", "c", "d", "e"] }).goals).toHaveLength(5);
	});

	it("rejects 0 and 6 goals", () => {
		expect(errorOf({ goals: [] })).toBe("at least one goal is required");
		expect(errorOf({ goals: ["a", "b", "c", "d", "e", "f"] })).toMatch(/at most 5/);
	});

	it("rejects a goal that is empty after trimming, naming which one", () => {
		expect(errorOf({ goals: ["Find the pricing page", "   "] })).toMatch(/goal 2/);
	});
});

describe("parseSetSpec: agents", () => {
	it("is empty without --agents, meaning the catalog default", () => {
		expect(parsed({}).agents).toEqual([]);
	});

	it("reads comma separated harness[/model] pairs", () => {
		expect(parsed({ agents: "claude-code/claude-sonnet-5, codex" }).agents).toEqual([
			{ harness: "claude-code", model: "claude-sonnet-5" },
			{ harness: "codex" },
		]);
	});

	it("splits on the first slash, so a model may contain one", () => {
		expect(parsed({ agents: "eve/anthropic/claude-sonnet-5" }).agents).toEqual([
			{ harness: "eve", model: "anthropic/claude-sonnet-5" },
		]);
	});

	it("accepts 1 and 4 agents", () => {
		expect(parsed({ agents: "codex" }).agents).toHaveLength(1);
		expect(
			parsed({
				agents: "claude-code,codex/gpt-5.5,eve/claude-sonnet-5,claude-code/claude-sonnet-5",
			}).agents,
		).toHaveLength(4);
	});

	it("rejects 5 agents", () => {
		expect(
			errorOf({
				agents: "claude-code,codex,eve,codex/gpt-5.5,eve/claude-sonnet-5",
			}),
		).toMatch(/--agents/);
	});

	it("rejects an empty --agents and empty entries", () => {
		for (const agents of ["", " ", "codex,", ",codex", "codex,,eve"]) {
			expect(errorOf({ agents })).toMatch(/--agents/);
		}
	});

	it("rejects a pair with an empty harness or model", () => {
		expect(errorOf({ agents: "/gpt-5.5" })).toMatch(/--agents/);
		expect(errorOf({ agents: "codex/" })).toMatch(/--agents/);
	});

	it("rejects the same agent listed twice", () => {
		expect(errorOf({ agents: "codex/gpt-5.5, codex/gpt-5.5" })).toMatch(/twice/);
	});
});

describe("parseSetSpec: brand", () => {
	it("defaults to the site's name label, capitalized", () => {
		expect(parsed({ site: "stripe.com" }).brand).toBe("Stripe");
	});

	it("takes --brand over the default, trimmed", () => {
		expect(parsed({ brand: "  Linear App " }).brand).toBe("Linear App");
	});

	it("rejects an empty --brand", () => {
		expect(errorOf({ brand: "  " })).toMatch(/--brand/);
	});
});

describe("parseSetSpec: docs and exact URLs", () => {
	it("keeps http and https URLs as written, trimmed", () => {
		const spec = parsed({
			docs: " https://linear.app/docs ",
			exact: "http://linear.app/developers",
		});
		expect(spec.docs).toBe("https://linear.app/docs");
		expect(spec.exact).toBe("http://linear.app/developers");
	});

	it("rejects anything that is not an http or https URL", () => {
		for (const value of [
			"",
			"linear.app/docs",
			"ftp://linear.app/docs",
			"javascript:alert(1)",
			"https://linear.app/a b",
		]) {
			expect(errorOf({ docs: value })).toMatch(/--docs/);
			expect(errorOf({ exact: value })).toMatch(/--exact/);
		}
	});
});

describe("parseSetSpec: repeat", () => {
	it("defaults to 1", () => {
		expect(parsed({}).repeat).toBe(1);
	});

	it("accepts 1 and 10", () => {
		expect(parsed({ repeat: "1" }).repeat).toBe(1);
		expect(parsed({ repeat: "10" }).repeat).toBe(10);
	});

	it("rejects 0, 11, fractions and non numbers", () => {
		for (const repeat of ["0", "11", "2.5", "", " ", "three", "-1"]) {
			expect(errorOf({ repeat })).toMatch(/--repeat must be an integer between 1 and 10/);
		}
	});
});

describe("parseSetSpec: wait", () => {
	it("defaults to 60 minutes", () => {
		expect(parsed({}).waitMinutes).toBe(60);
	});

	it("accepts any positive whole number of minutes", () => {
		expect(parsed({ wait: "1" }).waitMinutes).toBe(1);
		expect(parsed({ wait: "240" }).waitMinutes).toBe(240);
	});

	it("rejects 0, negatives, fractions and non numbers", () => {
		for (const wait of ["0", "-5", "1.5", "", "soon"]) {
			expect(errorOf({ wait })).toMatch(/--wait/);
		}
	});

	it("is the same parser `ax journey view` uses on its own", () => {
		expect(parseWaitMinutes(undefined)).toEqual({ value: 60 });
		expect(parseWaitMinutes("15")).toEqual({ value: 15 });
		expect(parseWaitMinutes("0")).toEqual({ error: expect.stringMatching(/--wait/) });
	});
});

describe("planCells", () => {
	it("plans every level in ladder order when nothing is skipped", () => {
		const spec = parsed({
			docs: "https://linear.app/docs",
			exact: "https://linear.app/developers",
		});
		expect(planCells(spec)).toEqual({
			cells: [
				{ goalIndex: 0, level: "need", prompt: GOAL },
				{ goalIndex: 0, level: "brand", prompt: `${GOAL}. Use Linear.` },
				{
					goalIndex: 0,
					level: "docs",
					prompt: `${GOAL}. Use Linear. Its documentation is at https://linear.app/docs.`,
				},
				{
					goalIndex: 0,
					level: "exact",
					prompt: `${GOAL}. Start at https://linear.app/developers.`,
				},
			],
			skipped: [],
		});
	});

	it("skips docs and exact without their URLs, each with its note", () => {
		expect(planCells(parsed({}))).toEqual({
			cells: [
				{ goalIndex: 0, level: "need", prompt: GOAL },
				{ goalIndex: 0, level: "brand", prompt: `${GOAL}. Use Linear.` },
			],
			skipped: [
				{ goalIndex: 0, level: "docs", note: DOCS_SKIP_NOTE },
				{ goalIndex: 0, level: "exact", note: EXACT_SKIP_NOTE },
			],
		});
	});

	it("skips the need level when the goal names the brand", () => {
		const plan = planCells(parsed({ goals: ["Find the Linear API rate limits"] }));
		expect(plan.cells.map((cell) => cell.level)).toEqual(["brand"]);
		expect(plan.skipped[0]).toEqual({ goalIndex: 0, level: "need", note: needSkipNote("Linear") });
	});

	it("names the domain in the note when only the domain matched", () => {
		const plan = planCells(
			parsed({ brand: "Acme", goals: ["Open linear.app and find the rate limits"] }),
		);
		expect(plan.skipped[0]).toEqual({
			goalIndex: 0,
			level: "need",
			note: needSkipNote("linear.app"),
		});
	});

	it("checks the leak against --brand when given, not the default", () => {
		const plan = planCells(parsed({ brand: "Acme", goals: ["Find the Linear API rate limits"] }));
		expect(plan.cells.map((cell) => cell.level)).toEqual(["need", "brand"]);
		expect(plan.cells[1].prompt).toBe("Find the Linear API rate limits. Use Acme.");
	});

	it("plans each goal on its own, so two goals can run different levels", () => {
		const plan = planCells(
			parsed({
				goals: ["Find the Linear API rate limits", GOAL],
				exact: "https://linear.app/developers",
			}),
		);
		expect(plan.cells.map((cell) => [cell.goalIndex, cell.level])).toEqual([
			[0, "brand"],
			[0, "exact"],
			[1, "need"],
			[1, "brand"],
			[1, "exact"],
		]);
		expect(plan.skipped.map((skip) => [skip.goalIndex, skip.level])).toEqual([
			[0, "need"],
			[0, "docs"],
			[1, "docs"],
		]);
	});

	it("without levels, plans one written cell per goal and skips nothing", () => {
		const plan = planCells(
			parsed({ levels: false, goals: ["Find the Linear API rate limits", `  ${GOAL}  `] }),
		);
		expect(plan).toEqual({
			cells: [
				{ goalIndex: 0, level: "written", prompt: "Find the Linear API rate limits" },
				{ goalIndex: 1, level: "written", prompt: GOAL },
			],
			skipped: [],
		});
	});
});

describe("journeyMode", () => {
	const one = { goals: [GOAL], levels: false };

	it("is one journey for one goal, at most one agent, no repeat above 1 and levels off", () => {
		expect(journeyMode(one)).toEqual({ value: { set: false, agents: [] } });
		expect(journeyMode({ ...one, repeat: "1" })).toEqual({ value: { set: false, agents: [] } });
		expect(journeyMode({ ...one, agents: "codex/gpt-5.5" })).toEqual({
			value: { set: false, agents: [{ harness: "codex", model: "gpt-5.5" }] },
		});
	});

	it("is a set for several goals, several agents or a repeat above 1", () => {
		expect(journeyMode({ ...one, goals: [GOAL, "Plan a sprint"] })).toMatchObject({
			value: { set: true },
		});
		expect(journeyMode({ ...one, agents: "codex,claude-code" })).toMatchObject({
			value: { set: true },
		});
		expect(journeyMode({ ...one, repeat: "2" })).toMatchObject({ value: { set: true } });
	});

	it("is a set whenever levels are on", () => {
		for (const flags of [
			{ levels: true },
			{ brand: "Linear" },
			{ docs: "https://linear.app/docs" },
			{ exact: "https://linear.app/developers" },
		]) {
			expect(journeyMode({ ...one, ...flags })).toMatchObject({ value: { set: true } });
		}
	});

	it("refuses a bad --agents or --repeat, since the mode cannot be told without them", () => {
		expect(journeyMode({ ...one, agents: "codex," })).toEqual({
			error: expect.stringMatching(/--agents/),
		});
		expect(journeyMode({ ...one, repeat: "0" })).toEqual({
			error: expect.stringMatching(/--repeat/),
		});
	});
});

describe("plannedRuns and the run cap", () => {
	it("multiplies cells by agents by repeats", () => {
		const { cells } = planCells(parsed({ exact: "https://linear.app/developers" }));
		expect(cells).toHaveLength(3);
		expect(plannedRuns(cells, 2, 3)).toBe(18);
		expect(plannedRuns([], 4, 10)).toBe(0);
	});

	it("allows exactly 200 runs and refuses 201", () => {
		expect(exceedsRunCap(200)).toBe(false);
		expect(exceedsRunCap(201)).toBe(true);
	});

	it("puts a set at the cap within it and one more repeat over it", () => {
		const goals = [
			"a Linear goal",
			"b Linear goal",
			"c Linear goal",
			"d Linear goal",
			"e Linear goal",
		];
		const { cells } = planCells(parsed({ goals, exact: "https://linear.app/developers" }));
		expect(cells).toHaveLength(10);
		expect(exceedsRunCap(plannedRuns(cells, 4, 5))).toBe(false);
		expect(exceedsRunCap(plannedRuns(cells, 4, 6))).toBe(true);
	});
});
