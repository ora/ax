// The go or refuse decision before a set launches: a pure function over data the command
// fetched (the key's scopes, the agent catalog, this month's usage) and the planned cells.
// It resolves each requested agent to a catalog pair, totals the runs, and lists every reason
// the set cannot start. It prints nothing; the preview renderer words the result.

import {
	STUDIO_SCOPES,
	type StudioAgent,
	type StudioScope,
	type StudioUsage,
} from "../api/studio-types";
import {
	type AgentChoice,
	DEFAULT_HARNESS,
	exceedsRunCap,
	MAX_RUNS,
	type PlannedCell,
	plannedRuns,
	type SetSpec,
} from "./spec";

export interface PreviewInput {
	spec: SetSpec;
	cells: readonly PlannedCell[];
	/** The scopes the key's bearer carries. */
	scopes: readonly string[];
	/** The catalog in the order Studio lists it. Required unless a scope refusal blocks the fetch. */
	agents?: readonly StudioAgent[];
	/** This month's usage. Required unless a scope refusal blocks the fetch. */
	usage?: StudioUsage;
}

/** An agent resolved to the catalog's pair; launch sends `{ harness, model }`. */
export interface ResolvedAgent {
	harness: string;
	model: string;
	/** `harness/model`, the form --agents accepts and every report column uses. */
	label: string;
	harnessName: string;
	modelName: string;
}

export interface PreviewTotals {
	/** Runs the set launches: cells x resolved agents x repeats. */
	runs: number;
	/** One per goal, level and repeat. */
	journeys: number;
	runsPerRepeat: number;
}

/** What is left of the plan's monthly runs, for the renderer. */
export type Allowance =
	| { kind: "limited"; limit: number | null; remaining: number; resetsAt: string | null }
	| { kind: "unlimited"; resetsAt: string | null };

export type Refusal =
	| { kind: "missing_scopes"; missing: StudioScope[] }
	/** `requested` is the text form of the choice: `harness` or `harness/model`. */
	| { kind: "unknown_agent"; requested: string }
	| { kind: "unavailable_agent"; requested: string; reason: string | null }
	| { kind: "duplicate_agent"; requested: string[]; label: string }
	| { kind: "no_agent_offered" }
	| { kind: "over_cap"; runs: number; maxRuns: number }
	| {
			kind: "over_allowance";
			runs: number;
			remaining: number;
			resetsAt: string | null;
			/** The largest repeat count that fits, with its runs; null when not even one repeat fits. */
			fits: { repeat: number; runs: number } | null;
	  };

export type PreviewResult =
	| {
			ok: true;
			agents: ResolvedAgent[];
			/** True when --agents was omitted and the default rule picked the agent (resolveDefault). */
			defaultedAgent: boolean;
			totals: PreviewTotals;
			allowance: Allowance;
	  }
	| { ok: false; refusals: Refusal[] };

function requestText(choice: AgentChoice): string {
	return choice.model ? `${choice.harness}/${choice.model}` : choice.harness;
}

function resolved(entry: StudioAgent): ResolvedAgent {
	return {
		harness: entry.harness,
		model: entry.model,
		label: `${entry.harness}/${entry.model}`,
		harnessName: entry.harnessName,
		modelName: entry.modelName,
	};
}

/** The catalog entry a choice names, or the refusal for why none can run. */
function lookup(
	choice: AgentChoice,
	catalog: readonly StudioAgent[],
): { entry: StudioAgent } | { refusal: Refusal } {
	const requested = requestText(choice);
	const sameHarness = catalog.filter((entry) => entry.harness === choice.harness);
	const candidates = choice.model
		? sameHarness.filter((entry) => entry.model === choice.model)
		: sameHarness;
	if (candidates.length === 0) return { refusal: { kind: "unknown_agent", requested } };
	const entry = candidates.find((candidate) => candidate.available);
	if (entry) return { entry };
	return { refusal: { kind: "unavailable_agent", requested, reason: candidates[0].reason } };
}

interface Resolution {
	agents: ResolvedAgent[];
	defaultedAgent: boolean;
	refusals: Refusal[];
}

/** The plan's first Claude Code agent, the harness a single journey defaults to, else its first. */
function resolveDefault(catalog: readonly StudioAgent[]): Resolution {
	const offered = catalog.filter((entry) => entry.available);
	const chosen = offered.find((entry) => entry.harness === DEFAULT_HARNESS) ?? offered[0];
	if (!chosen) {
		return { agents: [], defaultedAgent: false, refusals: [{ kind: "no_agent_offered" }] };
	}
	return { agents: [resolved(chosen)], defaultedAgent: true, refusals: [] };
}

/** Every requested agent against the catalog; two requests landing on one pair are refused. */
function resolveAgents(spec: SetSpec, catalog: readonly StudioAgent[]): Resolution {
	if (spec.agents.length === 0) return resolveDefault(catalog);
	const agents: ResolvedAgent[] = [];
	const refusals: Refusal[] = [];
	const requestsByLabel = new Map<string, string[]>();
	for (const choice of spec.agents) {
		const found = lookup(choice, catalog);
		if ("refusal" in found) {
			refusals.push(found.refusal);
			continue;
		}
		const agent = resolved(found.entry);
		const earlier = requestsByLabel.get(agent.label);
		if (earlier) {
			earlier.push(requestText(choice));
			continue;
		}
		requestsByLabel.set(agent.label, [requestText(choice)]);
		agents.push(agent);
	}
	for (const [label, requested] of requestsByLabel) {
		if (requested.length > 1) refusals.push({ kind: "duplicate_agent", requested, label });
	}
	return { agents, defaultedAgent: false, refusals };
}

/** The largest repeat count below the requested one that fits the allowance and the run cap. */
function largestFittingRepeat(
	perRepeat: number,
	remaining: number,
	requestedRepeat: number,
): { repeat: number; runs: number } | null {
	for (let repeat = requestedRepeat - 1; repeat >= 1; repeat--) {
		const runs = repeat * perRepeat;
		if (runs <= remaining && !exceedsRunCap(runs)) return { repeat, runs };
	}
	return null;
}

function allowanceOf(usage: StudioUsage): Allowance {
	const { limit, remaining } = usage.runs;
	if (remaining === null) return { kind: "unlimited", resetsAt: usage.resetsAt };
	return { kind: "limited", limit, remaining, resetsAt: usage.resetsAt };
}

function limitRefusals(totals: PreviewTotals, repeat: number, allowance: Allowance): Refusal[] {
	const refusals: Refusal[] = [];
	if (exceedsRunCap(totals.runs)) {
		refusals.push({ kind: "over_cap", runs: totals.runs, maxRuns: MAX_RUNS });
	}
	if (allowance.kind === "limited" && allowance.remaining < totals.runs) {
		refusals.push({
			kind: "over_allowance",
			runs: totals.runs,
			remaining: allowance.remaining,
			resetsAt: allowance.resetsAt,
			fits: largestFittingRepeat(totals.runsPerRepeat, allowance.remaining, repeat),
		});
	}
	return refusals;
}

/**
 * Decide go or refuse. Every refusal that the data allows is returned together. An agent refusal
 * hides the cap and allowance checks, because their totals depend on an agent count not yet
 * known. A missing scope blocks the fetch of the agents and usage, so a caller that could not
 * fetch them omits them; omitting them while no scope is missing is a caller bug and throws.
 */
export function previewSet(input: PreviewInput): PreviewResult {
	const { spec, cells, scopes, agents: catalog, usage } = input;
	const refusals: Refusal[] = [];

	const missing = STUDIO_SCOPES.filter((scope) => !scopes.includes(scope));
	if (missing.length > 0) refusals.push({ kind: "missing_scopes", missing });
	else if (!catalog || !usage) {
		throw new Error("previewSet needs the agent catalog and usage once no scope is missing");
	}

	const resolution = catalog ? resolveAgents(spec, catalog) : undefined;
	if (resolution) refusals.push(...resolution.refusals);
	if (!resolution || resolution.refusals.length > 0) return { ok: false, refusals };

	const perRepeat = cells.length * resolution.agents.length;
	const totals: PreviewTotals = {
		runs: plannedRuns(cells, resolution.agents.length, spec.repeat),
		journeys: cells.length * spec.repeat,
		runsPerRepeat: perRepeat,
	};
	const allowance = usage ? allowanceOf(usage) : undefined;
	// Without usage the allowance check is skipped, but the cap still applies.
	refusals.push(
		...limitRefusals(totals, spec.repeat, allowance ?? { kind: "unlimited", resetsAt: null }),
	);
	if (refusals.length > 0 || !allowance) return { ok: false, refusals };

	return {
		ok: true,
		agents: resolution.agents,
		defaultedAgent: resolution.defaultedAgent,
		totals,
		allowance,
	};
}
