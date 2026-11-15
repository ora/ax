import { describe, expect, it } from "vitest";
import agentsFixture from "../api/__fixtures__/studio/agents.json";
import usageFixture from "../api/__fixtures__/studio/usage.json";
import usageUnlimitedFixture from "../api/__fixtures__/studio/usage-unlimited.json";
import { STUDIO_SCOPES, type StudioAgent, type StudioUsage } from "../api/studio-types";
import { type PreviewInput, type PreviewResult, previewSet, type Refusal } from "./preview";
import { MAX_RUNS, parseSetSpec, planCells, type SetSpecInput } from "./spec";

// The recorded Studio bodies, unwrapped from their `{ success, data }` envelope.
const catalog: StudioAgent[] = agentsFixture.data.agents;
const usage: StudioUsage = usageFixture.data;
const usageUnlimited: StudioUsage = usageUnlimitedFixture.data;

// Named deltas from the recorded catalog and usage.
const claudeCodeUnavailable = catalog.map((entry) =>
	entry.harness === "claude-code"
		? { ...entry, available: false, reason: "needs the Pro plan" }
		: entry,
);
const haikuUnavailable = catalog.map((entry) =>
	entry.model === "claude-haiku-4-5-20251001"
		? { ...entry, available: false, reason: "needs the Standard plan" }
		: entry,
);
const everyAgentAvailable = catalog.map((entry) => ({ ...entry, available: true, reason: null }));
const nothingAvailable = catalog.map((entry) => ({
	...entry,
	available: false,
	reason: "needs the Standard plan",
}));
const withRemaining = (remaining: number): StudioUsage => ({
	...usage,
	runs: { ...usage.runs, remaining },
});

const ALL_SCOPES = [...STUDIO_SCOPES];
const HAIKU = "claude-code/claude-haiku-4-5-20251001";
const SONNET = "claude-code/claude-sonnet-5-5";

const GOAL = "Find how to create an issue from the API";

/** A spec and its cells from the real parser and planner. */
function planned(overrides: Partial<SetSpecInput> = {}, extraTasks = 0) {
	const parsed = parseSetSpec({
		site: "linear.app",
		levels: true,
		goals: [GOAL, ...Array.from({ length: extraTasks }, (_, i) => `Goal number ${i + 2}`)],
		...overrides,
	});
	if (!parsed.ok) throw new Error(parsed.error);
	return { spec: parsed.spec, cells: planCells(parsed.spec).cells };
}

function preview(
	overrides: Partial<SetSpecInput> = {},
	rest: Partial<PreviewInput> = {},
	extraTasks = 0,
): PreviewResult {
	const { spec, cells } = planned(overrides, extraTasks);
	return previewSet({ spec, cells, scopes: ALL_SCOPES, agents: catalog, usage, ...rest });
}

function refusalsOf(result: PreviewResult): Refusal[] {
	if (result.ok) throw new Error("expected a refusal");
	return result.refusals;
}

function kindsOf(result: PreviewResult): string[] {
	return refusalsOf(result).map((refusal) => refusal.kind);
}

describe("previewSet go", () => {
	it("uses the plan's first available Claude Code agent when --agents was omitted", () => {
		const result = preview();
		expect(result).toEqual({
			ok: true,
			agents: [
				{
					harness: "claude-code",
					model: "claude-haiku-4-5-20251001",
					label: HAIKU,
					harnessName: "Claude Code",
					modelName: "Claude Haiku 4.5",
				},
			],
			defaultedAgent: true,
			totals: { runs: 2, journeys: 2, runsPerRepeat: 2 },
			allowance: {
				kind: "limited",
				limit: 50,
				remaining: 38,
				resetsAt: "2026-12-01T00:00:00.000Z",
			},
		});
	});

	it("prefers the Claude Code agent over an available agent listed before it", () => {
		const offered = catalog.map((agent) => ({ ...agent, available: true }));
		expect(offered[0].harness).toBe("codex");
		const result = preview({}, { agents: offered });
		if (!result.ok) throw new Error("expected go");
		expect(result.defaultedAgent).toBe(true);
		expect(result.agents.map((agent) => agent.label)).toEqual([HAIKU]);
	});

	it("falls back to the first available agent when the plan offers no Claude Code agent", () => {
		const offered = catalog
			.filter((agent) => agent.harness !== "claude-code")
			.map((agent) => ({ ...agent, available: true }));
		const result = preview({}, { agents: offered });
		if (!result.ok) throw new Error("expected go");
		expect(result.defaultedAgent).toBe(true);
		expect(result.agents.map((agent) => agent.harness)).toEqual(["codex"]);
	});

	it("resolves explicit pairs to the catalog entries and labels them harness/model", () => {
		const result = preview({ agents: `${HAIKU},${SONNET}` });
		if (!result.ok) throw new Error("expected go");
		expect(result.defaultedAgent).toBe(false);
		expect(result.agents.map((agent) => agent.label)).toEqual([HAIKU, SONNET]);
		expect(result.agents[1]).toMatchObject({
			harness: "claude-code",
			model: "claude-sonnet-5-5",
			modelName: "Claude Sonnet 5.5",
		});
		expect(result.totals.runsPerRepeat).toBe(4);
	});

	it("resolves a bare harness to its first available entry in catalog order", () => {
		const result = preview({ agents: "claude-code" });
		if (!result.ok) throw new Error("expected go");
		expect(result.agents.map((agent) => agent.label)).toEqual([HAIKU]);
	});

	it("skips an unavailable entry when resolving a bare harness", () => {
		const result = preview({ agents: "claude-code" }, { agents: haikuUnavailable });
		if (!result.ok) throw new Error("expected go");
		expect(result.agents.map((agent) => agent.label)).toEqual([SONNET]);
	});

	it("totals runs, journeys and runs per repeat with the resolved agent count", () => {
		const result = preview({
			agents: `${HAIKU},${SONNET}`,
			repeat: "3",
			docs: "https://linear.app/docs",
		});
		if (!result.ok) throw new Error("expected go");
		// 3 cells (need, brand, docs) x 2 agents x 3 repeats.
		expect(result.totals).toEqual({ runs: 18, journeys: 9, runsPerRepeat: 6 });
	});

	it("counts the default agent once however many repeats", () => {
		const result = preview({ repeat: "4" });
		if (!result.ok) throw new Error("expected go");
		expect(result.totals).toEqual({ runs: 8, journeys: 8, runsPerRepeat: 2 });
	});
});

describe("previewSet allowance", () => {
	it("returns a no-limit marker with its reset time when the plan sets no limit", () => {
		const result = preview({}, { usage: usageUnlimited });
		if (!result.ok) throw new Error("expected go");
		expect(result.allowance).toEqual({ kind: "unlimited", resetsAt: null });
	});

	it("skips the allowance check when remaining is null, while the cap still applies", () => {
		const allowed = preview({ repeat: "10" }, { usage: usageUnlimited }, 4);
		expect(allowed.ok).toBe(true);
		const over = preview(
			{
				repeat: "10",
				agents: `${HAIKU},${SONNET}`,
				docs: "https://a.dev",
				exact: "https://a.dev/x",
			},
			{ usage: usageUnlimited },
			4,
		);
		expect(kindsOf(over)).toEqual(["over_cap"]);
	});

	it("refuses with what fits when a smaller repeat count fits", () => {
		// 4 cells x 5 goals = 20 cells, 1 agent, 3 repeats = 60 runs; 38 remain.
		const result = preview(
			{ repeat: "3", docs: "https://linear.app/docs", exact: "https://linear.app/developers" },
			{},
			4,
		);
		expect(refusalsOf(result)).toEqual([
			{
				kind: "over_allowance",
				runs: 60,
				remaining: 38,
				resetsAt: "2026-12-01T00:00:00.000Z",
				fits: { repeat: 1, runs: 20 },
				// Levels are on, so --repeat 1 is still a set.
				oneJourney: false,
			},
		]);
	});

	it("picks the largest repeat count that fits", () => {
		// 2 cells x 1 agent = 2 per repeat; 10 repeats = 20 runs; 7 remain, so 3 repeats = 6 runs.
		const result = preview({ repeat: "10" }, { usage: withRemaining(7) });
		expect(refusalsOf(result)).toMatchObject([
			{ kind: "over_allowance", runs: 20, remaining: 7, fits: { repeat: 3, runs: 6 } },
		]);
	});

	it("says not even one repeat fits with a null fit", () => {
		const result = preview({ repeat: "2" }, { usage: withRemaining(1) });
		expect(refusalsOf(result)).toMatchObject([
			{ kind: "over_allowance", runs: 4, remaining: 1, fits: null },
		]);
	});

	it("allows a set that uses exactly what remains", () => {
		expect(preview({ repeat: "2" }, { usage: withRemaining(4) }).ok).toBe(true);
	});
});

describe("previewSet run cap", () => {
	// 5 goals x 4 levels = 20 cells.
	const full = { docs: "https://linear.app/docs", exact: "https://linear.app/developers" };

	it("allows exactly MAX_RUNS", () => {
		const result = preview({ ...full, repeat: "10" }, { usage: usageUnlimited }, 4);
		if (!result.ok) throw new Error("expected go");
		expect(result.totals.runs).toBe(MAX_RUNS);
	});

	it("refuses one past MAX_RUNS even with no allowance limit", () => {
		// 17 cells x 3 agents x 4 repeats = 204.
		const { spec, cells } = planned(
			{ ...full, repeat: "4", agents: `${HAIKU},${SONNET},codex/gpt-5.6-luna` },
			4,
		);
		const result = previewSet({
			spec,
			cells: cells.slice(0, 17),
			scopes: ALL_SCOPES,
			agents: everyAgentAvailable,
			usage: usageUnlimited,
		});
		expect(refusalsOf(result)).toEqual([{ kind: "over_cap", runs: 204, maxRuns: MAX_RUNS }]);
	});

	it("reports the cap and the allowance together", () => {
		const { spec, cells } = planned(
			{ ...full, repeat: "4", agents: `${HAIKU},${SONNET},codex/gpt-5.6-luna` },
			4,
		);
		const result = previewSet({
			spec,
			cells: cells.slice(0, 17),
			scopes: ALL_SCOPES,
			agents: everyAgentAvailable,
			usage,
		});
		expect(kindsOf(result)).toEqual(["over_cap", "over_allowance"]);
	});

	it("never suggests a repeat count that would itself exceed the cap", () => {
		// 20 cells x 3 agents = 60 per repeat; 10 repeats = 600 runs; 550 remain. 9 repeats (540)
		// fit the allowance but not the cap, so the largest suggestion is 3 repeats (180).
		const result = previewSet({
			...planned({ ...full, repeat: "10", agents: `${HAIKU},${SONNET},codex/gpt-5.6-luna` }, 4),
			scopes: ALL_SCOPES,
			agents: everyAgentAvailable,
			usage: withRemaining(550),
		});
		expect(refusalsOf(result)).toMatchObject([
			{ kind: "over_cap", runs: 600 },
			{ kind: "over_allowance", fits: { repeat: 3, runs: 180 } },
		]);
	});
});

describe("previewSet scopes", () => {
	it("names every missing scope in STUDIO_SCOPES order", () => {
		const { spec, cells } = planned();
		const result = previewSet({ spec, cells, scopes: ["runs:write", "journeys:read"] });
		expect(refusalsOf(result)).toEqual([
			{ kind: "missing_scopes", missing: ["journeys:write", "runs:read", "intents:read"] },
		]);
	});

	it("still checks agents and totals with the data it has", () => {
		const { spec, cells } = planned({ agents: "nope" });
		const result = previewSet({
			spec,
			cells,
			scopes: ["journeys:write"],
			agents: catalog,
			usage,
		});
		expect(kindsOf(result)).toEqual(["missing_scopes", "unknown_agent"]);
	});

	it("refuses a clean set that lacks a scope", () => {
		const { spec, cells } = planned();
		const scopes = ALL_SCOPES.filter((scope) => scope !== "runs:write");
		const result = previewSet({ spec, cells, scopes, agents: catalog, usage });
		expect(refusalsOf(result)).toEqual([{ kind: "missing_scopes", missing: ["runs:write"] }]);
	});

	it("throws when the data is absent although no scope is missing", () => {
		const { spec, cells } = planned();
		expect(() => previewSet({ spec, cells, scopes: ALL_SCOPES })).toThrow(/agent catalog/);
	});
});

describe("previewSet agent refusals", () => {
	it("refuses an unknown harness", () => {
		expect(refusalsOf(preview({ agents: "gemini-cli" }))).toEqual([
			{ kind: "unknown_agent", requested: "gemini-cli" },
		]);
	});

	it("refuses a pair whose model the catalog does not list", () => {
		expect(refusalsOf(preview({ agents: "claude-code/claude-opus-9" }))).toEqual([
			{ kind: "unknown_agent", requested: "claude-code/claude-opus-9" },
		]);
	});

	it("refuses an unavailable pair with the catalog's reason", () => {
		expect(refusalsOf(preview({ agents: "codex/gpt-5.6-luna" }))).toEqual([
			{
				kind: "unavailable_agent",
				requested: "codex/gpt-5.6-luna",
				reason: "needs the Standard plan",
			},
		]);
	});

	it("refuses a bare harness with no available entry, carrying the first entry's reason", () => {
		const result = preview({ agents: "claude-code" }, { agents: claudeCodeUnavailable });
		expect(refusalsOf(result)).toEqual([
			{ kind: "unavailable_agent", requested: "claude-code", reason: "needs the Pro plan" },
		]);
	});

	it("refuses a default when the catalog offers no available agent", () => {
		const result = preview({}, { agents: nothingAvailable });
		expect(refusalsOf(result)).toEqual([{ kind: "no_agent_offered" }]);
	});

	it("refuses an empty catalog as no agent offered", () => {
		expect(refusalsOf(preview({}, { agents: [] }))).toEqual([{ kind: "no_agent_offered" }]);
	});

	it("refuses a bare harness and the pair it resolves to as a duplicate", () => {
		expect(refusalsOf(preview({ agents: `claude-code,${HAIKU}` }))).toEqual([
			{ kind: "duplicate_agent", requested: ["claude-code", HAIKU], label: HAIKU },
		]);
	});

	it("does not call two different models of one harness a duplicate", () => {
		expect(preview({ agents: `${HAIKU},${SONNET}` }).ok).toBe(true);
	});

	it("reports every agent refusal in the order requested", () => {
		const result = preview({ agents: "gemini-cli,codex/gpt-5.6-luna" });
		expect(kindsOf(result)).toEqual(["unknown_agent", "unavailable_agent"]);
	});

	it("hides the cap and allowance checks behind an agent refusal", () => {
		// 20 cells x 10 repeats would break the cap and the allowance, but the agent is unknown.
		const result = preview(
			{
				agents: "gemini-cli",
				repeat: "10",
				docs: "https://linear.app/docs",
				exact: "https://linear.app/developers",
			},
			{ usage: withRemaining(0) },
			4,
		);
		expect(kindsOf(result)).toEqual(["unknown_agent"]);
	});
});
