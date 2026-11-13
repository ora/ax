import { describe, expect, it } from "vitest";
import { DOCS_SKIP_NOTE, EXACT_SKIP_NOTE, needSkipNote } from "./levels";
import {
	DEFAULT_REPEAT,
	DEFAULT_WAIT_MINUTES,
	exceedsRunCap,
	MAX_AGENTS,
	MAX_REPEAT,
	MAX_RUNS,
	MAX_TASKS,
	parseTrialSpec,
	parseWaitMinutes,
	planCells,
	plannedRuns,
	type TrialSpec,
	type TrialSpecInput,
} from "./spec";

const TASK = "Find how to create an issue from the API";
const BASE: TrialSpecInput = { site: "linear.app", tasks: [TASK] };

function parsed(input: Partial<TrialSpecInput>): TrialSpec {
	const result = parseTrialSpec({ ...BASE, ...input });
	if (!result.ok) throw new Error(`expected a valid spec, got: ${result.error}`);
	return result.spec;
}

function errorOf(input: Partial<TrialSpecInput>): string {
	const result = parseTrialSpec({ ...BASE, ...input });
	if (result.ok) throw new Error("expected a usage error, got a valid spec");
	return result.error;
}

describe("caps and defaults", () => {
	it("pins the shared numbers", () => {
		expect({
			MAX_TASKS,
			MAX_AGENTS,
			MAX_REPEAT,
			MAX_RUNS,
			DEFAULT_REPEAT,
			DEFAULT_WAIT_MINUTES,
		}).toEqual({
			MAX_TASKS: 5,
			MAX_AGENTS: 4,
			MAX_REPEAT: 10,
			MAX_RUNS: 200,
			DEFAULT_REPEAT: 1,
			DEFAULT_WAIT_MINUTES: 60,
		});
	});
});

describe("parseTrialSpec: defaults", () => {
	it("fills every optional value", () => {
		expect(parsed({})).toEqual({
			site: "linear.app",
			tasks: [TASK],
			agents: [],
			brand: "Linear",
			repeat: 1,
			waitMinutes: 60,
		});
	});
});

describe("parseTrialSpec: site", () => {
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

	it("keeps every other subdomain, since the trial targets that host", () => {
		expect(parsed({ site: "docs.stripe.com" }).site).toBe("docs.stripe.com");
		expect(parsed({ site: "www2.example.com" }).site).toBe("www2.example.com");
	});

	it("folds a fullwidth spelling to its plain form", () => {
		expect(parsed({ site: "ｌｉｎｅａｒ．ａｐｐ" }).site).toBe("linear.app");
	});

	it("rejects anything that is not a domain or an http(s) URL", () => {
		for (const site of ["", "   ", "linear", "linear app", "ftp://linear.app", "https://"]) {
			expect(errorOf({ site })).toMatch(/site/);
		}
	});
});

describe("parseTrialSpec: tasks", () => {
	it("trims each task", () => {
		expect(parsed({ tasks: ["  Find the pricing page  "] }).tasks).toEqual([
			"Find the pricing page",
		]);
	});

	it("accepts 1 and 5 tasks", () => {
		expect(parsed({ tasks: ["a"] }).tasks).toHaveLength(1);
		expect(parsed({ tasks: ["a", "b", "c", "d", "e"] }).tasks).toHaveLength(5);
	});

	it("rejects 0 and 6 tasks", () => {
		expect(errorOf({ tasks: [] })).toMatch(/--task/);
		expect(errorOf({ tasks: ["a", "b", "c", "d", "e", "f"] })).toMatch(/at most 5/);
	});

	it("rejects a task that is empty after trimming, naming which one", () => {
		expect(errorOf({ tasks: ["Find the pricing page", "   "] })).toMatch(/task 2/);
	});
});

describe("parseTrialSpec: agents", () => {
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

describe("parseTrialSpec: brand", () => {
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

describe("parseTrialSpec: docs and exact URLs", () => {
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

describe("parseTrialSpec: repeat", () => {
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

describe("parseTrialSpec: wait", () => {
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

	it("is the same parser `ax trial view` uses on its own", () => {
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
				{ task: 0, level: "need", prompt: TASK },
				{ task: 0, level: "brand", prompt: `${TASK}. Use Linear.` },
				{
					task: 0,
					level: "docs",
					prompt: `${TASK}. Use Linear. Its documentation is at https://linear.app/docs.`,
				},
				{ task: 0, level: "exact", prompt: `${TASK}. Start at https://linear.app/developers.` },
			],
			skipped: [],
		});
	});

	it("skips docs and exact without their URLs, each with its note", () => {
		expect(planCells(parsed({}))).toEqual({
			cells: [
				{ task: 0, level: "need", prompt: TASK },
				{ task: 0, level: "brand", prompt: `${TASK}. Use Linear.` },
			],
			skipped: [
				{ task: 0, level: "docs", note: DOCS_SKIP_NOTE },
				{ task: 0, level: "exact", note: EXACT_SKIP_NOTE },
			],
		});
	});

	it("skips the need level when the task names the brand", () => {
		const plan = planCells(parsed({ tasks: ["Find the Linear API rate limits"] }));
		expect(plan.cells.map((cell) => cell.level)).toEqual(["brand"]);
		expect(plan.skipped[0]).toEqual({ task: 0, level: "need", note: needSkipNote("Linear") });
	});

	it("names the domain in the note when only the domain matched", () => {
		const plan = planCells(
			parsed({ brand: "Acme", tasks: ["Open linear.app and find the rate limits"] }),
		);
		expect(plan.skipped[0]).toEqual({
			task: 0,
			level: "need",
			note: needSkipNote("linear.app"),
		});
	});

	it("checks the leak against --brand when given, not the default", () => {
		const plan = planCells(parsed({ brand: "Acme", tasks: ["Find the Linear API rate limits"] }));
		expect(plan.cells.map((cell) => cell.level)).toEqual(["need", "brand"]);
		expect(plan.cells[1].prompt).toBe("Find the Linear API rate limits. Use Acme.");
	});

	it("plans each task on its own, so two tasks can run different levels", () => {
		const plan = planCells(
			parsed({
				tasks: ["Find the Linear API rate limits", TASK],
				exact: "https://linear.app/developers",
			}),
		);
		expect(plan.cells.map((cell) => [cell.task, cell.level])).toEqual([
			[0, "brand"],
			[0, "exact"],
			[1, "need"],
			[1, "brand"],
			[1, "exact"],
		]);
		expect(plan.skipped.map((skip) => [skip.task, skip.level])).toEqual([
			[0, "need"],
			[0, "docs"],
			[1, "docs"],
		]);
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

	it("puts a trial at the cap within it and one more repeat over it", () => {
		const tasks = [
			"a Linear task",
			"b Linear task",
			"c Linear task",
			"d Linear task",
			"e Linear task",
		];
		const { cells } = planCells(parsed({ tasks, exact: "https://linear.app/developers" }));
		expect(cells).toHaveLength(10);
		expect(exceedsRunCap(plannedRuns(cells, 4, 5))).toBe(false);
		expect(exceedsRunCap(plannedRuns(cells, 4, 6))).toBe(true);
	});
});
