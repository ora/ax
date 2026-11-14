// A set's spec: the command-line values checked against the caps, and the cells it plans (goal x
// level, with the prompt each one sends). Every value is validated here, so a bad flag is a usage
// error before anything launches. The rule for whether `ax journey` runs one journey or a set
// lives here too, so the command and the spec read the flags the same way.

import {
	brandPrompt,
	DOCS_SKIP_NOTE,
	defaultBrand,
	docsPrompt,
	EXACT_SKIP_NOTE,
	exactPrompt,
	LADDER,
	type LadderLevel,
	type Level,
	needPrompt,
	needSkipNote,
	siteTermIn,
	writtenPrompt,
} from "./levels";
import { normalizeDomain } from "./vendor/domain-normalize";

export const MAX_GOALS = 5;
export const MAX_AGENTS = 4;
export const MAX_REPEAT = 10;
export const MAX_RUNS = 200;
export const DEFAULT_REPEAT = 1;
export const DEFAULT_WAIT_MINUTES = 60;

/** The harness a single journey runs, and the one a set prefers when no agent is named. */
export const DEFAULT_HARNESS = "claude-code";

/** The flags that turn levels on: `--levels` itself, or any value a level prompt needs. */
export interface LevelFlags {
	levels: boolean;
	brand?: string;
	docs?: string;
	exact?: string;
}

/** The values as the command line gave them, unchecked. */
export interface SetSpecInput extends LevelFlags {
	/** --domain: a bare domain or a URL. A set needs one. */
	site?: string;
	/** Every goal, in order. */
	goals: readonly string[];
	/** Raw --agents: comma separated `harness[/model]`. */
	agents?: string;
	/** Raw --repeat. */
	repeat?: string;
	/** Raw --wait, in minutes. */
	wait?: string;
}

export interface AgentChoice {
	harness: string;
	model?: string;
}

export interface SetSpec {
	/** The host alone: NFKC, trimmed, lowercase, without a leading `www.`. */
	site: string;
	goals: string[];
	/** Empty when --agents was not given: the catalog default, resolved by the preview. */
	agents: AgentChoice[];
	/** True when each goal climbs the ladder; false runs each goal once, as written. */
	levels: boolean;
	/** --brand, or defaultBrand(site). Only the level prompts use it. */
	brand: string;
	docs?: string;
	exact?: string;
	repeat: number;
	waitMinutes: number;
}

export type ParsedSetSpec = { ok: true; spec: SetSpec } | { ok: false; error: string };

export type Parsed<T> = { value: T } | { error: string };

/** One planned cell. `goalIndex` is the index into `SetSpec.goals`. */
export interface PlannedCell {
	goalIndex: number;
	level: Level;
	prompt: string;
}

export interface SkippedCell {
	goalIndex: number;
	level: Level;
	note: string;
}

export interface CellPlan {
	cells: PlannedCell[];
	skipped: SkippedCell[];
}

export const MISSING_DOMAIN =
	"a set of journeys needs --domain, the site the agents work on (e.g. --domain linear.app)";

function isHttp(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

/** The set's site from a domain or URL; `ax deep-journey` reduces its target with it too. */
export function parseSetSite(raw: string): Parsed<string> {
	const trimmed = raw.trim();
	const url =
		trimmed && !/\s/.test(trimmed)
			? URL.parse(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
			: null;
	const host = (url && isHttp(url) && normalizeDomain(url.hostname)) || "";
	const site = host.replace(/^www\./, "");
	if (!site.includes(".")) {
		return {
			error: `--domain must be a domain like linear.app or an http(s) URL, got ${JSON.stringify(raw)}`,
		};
	}
	return { value: site };
}

function parseGoals(raw: readonly string[]): Parsed<string[]> {
	if (raw.length === 0) return { error: "at least one goal is required" };
	if (raw.length > MAX_GOALS) {
		return { error: `at most ${MAX_GOALS} goals, got ${raw.length}` };
	}
	const goals = raw.map((goal) => goal.trim());
	const empty = goals.indexOf("");
	if (empty !== -1) return { error: `goal ${empty + 1} is empty` };
	return { value: goals };
}

function parseAgent(entry: string): AgentChoice | undefined {
	const slash = entry.indexOf("/");
	if (slash === -1) return entry ? { harness: entry } : undefined;
	const harness = entry.slice(0, slash).trim();
	const model = entry.slice(slash + 1).trim();
	return harness && model ? { harness, model } : undefined;
}

export function parseAgents(raw: string | undefined): Parsed<AgentChoice[]> {
	if (raw === undefined) return { value: [] };
	const usage = `--agents takes 1 to ${MAX_AGENTS} agents as harness[/model], comma separated, got ${JSON.stringify(raw)}`;
	const entries = raw.split(",").map((entry) => entry.trim());
	if (entries.length > MAX_AGENTS) return { error: usage };
	const agents: AgentChoice[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const agent = parseAgent(entry);
		if (!agent) return { error: usage };
		const key = `${agent.harness}/${agent.model ?? ""}`;
		if (seen.has(key)) return { error: `--agents lists ${entry} twice` };
		seen.add(key);
		agents.push(agent);
	}
	return { value: agents };
}

function parseBrand(raw: string | undefined, site: string): Parsed<string> {
	if (raw === undefined) return { value: defaultBrand(site) };
	const brand = raw.trim();
	return brand ? { value: brand } : { error: "--brand must not be empty" };
}

function parseHttpUrl(raw: string | undefined, flag: string): Parsed<string | undefined> {
	if (raw === undefined) return { value: undefined };
	const value = raw.trim();
	const url = value && !/\s/.test(value) ? URL.parse(value) : null;
	if (!url || !isHttp(url)) {
		return { error: `${flag} must be an http or https URL, got ${JSON.stringify(raw)}` };
	}
	return { value };
}

export function parseRepeat(raw: string | undefined): Parsed<number> {
	if (raw === undefined) return { value: DEFAULT_REPEAT };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > MAX_REPEAT) {
		return {
			error: `--repeat must be an integer between 1 and ${MAX_REPEAT}, got ${JSON.stringify(raw)}`,
		};
	}
	return { value };
}

/** Raw --wait to minutes; `ax journey view` takes --wait without a spec, so it calls this directly. */
export function parseWaitMinutes(raw: string | undefined): Parsed<number> {
	if (raw === undefined) return { value: DEFAULT_WAIT_MINUTES };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		return {
			error: `--wait must be a positive whole number of minutes, got ${JSON.stringify(raw)}`,
		};
	}
	return { value };
}

/** Levels are on with --levels, and with any of --brand, --docs or --exact, which imply it. */
export function levelsOn(flags: LevelFlags): boolean {
	return (
		flags.levels ||
		flags.brand !== undefined ||
		flags.docs !== undefined ||
		flags.exact !== undefined
	);
}

/** The flags that decide between one journey and a set, unchecked. */
export interface ModeInput extends LevelFlags {
	goals: readonly string[];
	agents?: string;
	repeat?: string;
}

/** Whether the flags ask for a set, and the agents --agents named (empty without it). */
export interface JourneyMode {
	set: boolean;
	agents: AgentChoice[];
}

/**
 * One journey, drawn live, for one goal and at most one agent, with no --repeat above 1 and levels
 * off; a set of journeys for anything more. A bad --agents or --repeat is the usage error, since
 * the mode cannot be told without them.
 */
export function journeyMode(input: ModeInput): Parsed<JourneyMode> {
	const agents = parseAgents(input.agents);
	if ("error" in agents) return agents;
	const repeat = parseRepeat(input.repeat);
	if ("error" in repeat) return repeat;
	const set =
		input.goals.length > 1 || agents.value.length > 1 || repeat.value > 1 || levelsOn(input);
	return { value: { set, agents: agents.value } };
}

function fail(part: { error: string }): ParsedSetSpec {
	return { ok: false, error: part.error };
}

/** The first invalid value is the usage error; otherwise the spec, defaults filled. */
export function parseSetSpec(input: SetSpecInput): ParsedSetSpec {
	if (input.site === undefined) return fail({ error: MISSING_DOMAIN });
	const site = parseSetSite(input.site);
	if ("error" in site) return fail(site);
	const goals = parseGoals(input.goals);
	if ("error" in goals) return fail(goals);
	const agents = parseAgents(input.agents);
	if ("error" in agents) return fail(agents);
	const brand = parseBrand(input.brand, site.value);
	if ("error" in brand) return fail(brand);
	const docs = parseHttpUrl(input.docs, "--docs");
	if ("error" in docs) return fail(docs);
	const exact = parseHttpUrl(input.exact, "--exact");
	if ("error" in exact) return fail(exact);
	const repeat = parseRepeat(input.repeat);
	if ("error" in repeat) return fail(repeat);
	const wait = parseWaitMinutes(input.wait);
	if ("error" in wait) return fail(wait);
	const spec: SetSpec = {
		site: site.value,
		goals: goals.value,
		agents: agents.value,
		levels: levelsOn(input),
		brand: brand.value,
		...(docs.value !== undefined && { docs: docs.value }),
		...(exact.value !== undefined && { exact: exact.value }),
		repeat: repeat.value,
		waitMinutes: wait.value,
	};
	return { ok: true, spec };
}

/**
 * One ladder level of one goal: its prompt, or the note saying why it is skipped.
 * Need runs only when the goal does not name the site; brand always runs;
 * docs only with --docs; exact only with --exact.
 */
function planLevel(
	level: LadderLevel,
	goal: string,
	spec: SetSpec,
): { prompt: string } | { note: string } {
	switch (level) {
		case "need": {
			const term = siteTermIn(goal, spec.site, spec.brand);
			return term === null ? { prompt: needPrompt(goal) } : { note: needSkipNote(term) };
		}
		case "brand":
			return { prompt: brandPrompt(goal, spec.brand) };
		case "docs":
			return spec.docs
				? { prompt: docsPrompt(goal, spec.brand, spec.docs) }
				: { note: DOCS_SKIP_NOTE };
		case "exact":
			return spec.exact ? { prompt: exactPrompt(goal, spec.exact) } : { note: EXACT_SKIP_NOTE };
	}
}

/**
 * Every goal's cells: with levels on, its ladder levels in order, plus the ones skipped with their
 * notes; with levels off, one written cell per goal and nothing skipped.
 */
export function planCells(spec: SetSpec): CellPlan {
	const plan: CellPlan = { cells: [], skipped: [] };
	for (const [goalIndex, text] of spec.goals.entries()) {
		if (!spec.levels) {
			plan.cells.push({ goalIndex, level: "written", prompt: writtenPrompt(text) });
			continue;
		}
		for (const level of LADDER) {
			const planned = planLevel(level, text, spec);
			if ("prompt" in planned) plan.cells.push({ goalIndex, level, prompt: planned.prompt });
			else plan.skipped.push({ goalIndex, level, note: planned.note });
		}
	}
	return plan;
}

/** Runs a set launches: every planned cell, for every agent, every repeat. */
export function plannedRuns(
	cells: readonly PlannedCell[],
	agentCount: number,
	repeat: number,
): number {
	return cells.length * agentCount * repeat;
}

/** True when the runs are more than one set may launch (MAX_RUNS), whatever the plan allows. */
export function exceedsRunCap(runs: number): boolean {
	return runs > MAX_RUNS;
}
