// A trial's spec: the command-line values checked against the caps, and the
// cells it plans (task x level, with the prompt each one sends). Every value
// is validated here, so a bad flag is a usage error before anything launches.

import {
	brandPrompt,
	DOCS_SKIP_NOTE,
	defaultBrand,
	docsPrompt,
	EXACT_SKIP_NOTE,
	exactPrompt,
	LEVELS,
	type Level,
	needPrompt,
	needSkipNote,
	siteTermIn,
} from "./levels";
import { normalizeDomain } from "./vendor/domain-normalize";

export const MAX_TASKS = 5;
export const MAX_AGENTS = 4;
export const MAX_REPEAT = 10;
export const MAX_RUNS = 200;
export const DEFAULT_REPEAT = 1;
export const DEFAULT_WAIT_MINUTES = 60;

/** The values as the command line gave them, unchecked. */
export interface TrialSpecInput {
	/** A bare domain or a URL. */
	site: string;
	/** Every --task, in order. */
	tasks: readonly string[];
	/** Raw --agents: comma separated `harness[/model]`. */
	agents?: string;
	brand?: string;
	docs?: string;
	exact?: string;
	/** Raw --repeat. */
	repeat?: string;
	/** Raw --wait, in minutes. */
	wait?: string;
}

export interface AgentChoice {
	harness: string;
	model?: string;
}

export interface TrialSpec {
	/** The host alone: NFKC, trimmed, lowercase, without a leading `www.`. */
	site: string;
	tasks: string[];
	/** Empty when --agents was not given: the catalog default, resolved by the preview. */
	agents: AgentChoice[];
	/** --brand, or defaultBrand(site). */
	brand: string;
	docs?: string;
	exact?: string;
	repeat: number;
	waitMinutes: number;
}

export type ParsedTrialSpec = { ok: true; spec: TrialSpec } | { ok: false; error: string };

export type Parsed<T> = { value: T } | { error: string };

/** One planned cell. `task` is the index into `TrialSpec.tasks`. */
export interface PlannedCell {
	task: number;
	level: Level;
	prompt: string;
}

export interface SkippedCell {
	task: number;
	level: Level;
	note: string;
}

export interface CellPlan {
	cells: PlannedCell[];
	skipped: SkippedCell[];
}

function isHttp(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

/** The trial's site from a domain or URL; `ax deep-journey` reduces its target with it too. */
export function parseTrialSite(raw: string): Parsed<string> {
	const trimmed = raw.trim();
	const url =
		trimmed && !/\s/.test(trimmed)
			? URL.parse(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
			: null;
	const host = (url && isHttp(url) && normalizeDomain(url.hostname)) || "";
	const site = host.replace(/^www\./, "");
	if (!site.includes(".")) {
		return {
			error: `the site must be a domain like linear.app or an http(s) URL, got ${JSON.stringify(raw)}`,
		};
	}
	return { value: site };
}

function parseTasks(raw: readonly string[]): Parsed<string[]> {
	if (raw.length === 0) return { error: "at least one --task is required" };
	if (raw.length > MAX_TASKS) {
		return { error: `at most ${MAX_TASKS} --task values, got ${raw.length}` };
	}
	const tasks = raw.map((task) => task.trim());
	const empty = tasks.indexOf("");
	if (empty !== -1) return { error: `--task ${empty + 1} is empty` };
	return { value: tasks };
}

function parseAgent(entry: string): AgentChoice | undefined {
	const slash = entry.indexOf("/");
	if (slash === -1) return entry ? { harness: entry } : undefined;
	const harness = entry.slice(0, slash).trim();
	const model = entry.slice(slash + 1).trim();
	return harness && model ? { harness, model } : undefined;
}

function parseAgents(raw: string | undefined): Parsed<AgentChoice[]> {
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

function parseRepeat(raw: string | undefined): Parsed<number> {
	if (raw === undefined) return { value: DEFAULT_REPEAT };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > MAX_REPEAT) {
		return {
			error: `--repeat must be an integer between 1 and ${MAX_REPEAT}, got ${JSON.stringify(raw)}`,
		};
	}
	return { value };
}

/** Raw --wait to minutes; `ax trial view` takes --wait without a spec, so it calls this directly. */
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

function fail(part: { error: string }): ParsedTrialSpec {
	return { ok: false, error: part.error };
}

/** The first invalid value is the usage error; otherwise the spec, defaults filled. */
export function parseTrialSpec(input: TrialSpecInput): ParsedTrialSpec {
	const site = parseTrialSite(input.site);
	if ("error" in site) return fail(site);
	const tasks = parseTasks(input.tasks);
	if ("error" in tasks) return fail(tasks);
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
	const spec: TrialSpec = {
		site: site.value,
		tasks: tasks.value,
		agents: agents.value,
		brand: brand.value,
		...(docs.value !== undefined && { docs: docs.value }),
		...(exact.value !== undefined && { exact: exact.value }),
		repeat: repeat.value,
		waitMinutes: wait.value,
	};
	return { ok: true, spec };
}

/**
 * One level of one task: its prompt, or the note saying why it is skipped.
 * Need runs only when the task does not name the site; brand always runs;
 * docs only with --docs; exact only with --exact.
 */
function planLevel(
	level: Level,
	task: string,
	spec: TrialSpec,
): { prompt: string } | { note: string } {
	switch (level) {
		case "need": {
			const term = siteTermIn(task, spec.site, spec.brand);
			return term === null ? { prompt: needPrompt(task) } : { note: needSkipNote(term) };
		}
		case "brand":
			return { prompt: brandPrompt(task, spec.brand) };
		case "docs":
			return spec.docs
				? { prompt: docsPrompt(task, spec.brand, spec.docs) }
				: { note: DOCS_SKIP_NOTE };
		case "exact":
			return spec.exact ? { prompt: exactPrompt(task, spec.exact) } : { note: EXACT_SKIP_NOTE };
	}
}

/** Every task's levels in ladder order: the cells that run and the ones skipped, with their notes. */
export function planCells(spec: TrialSpec): CellPlan {
	const plan: CellPlan = { cells: [], skipped: [] };
	for (const [task, text] of spec.tasks.entries()) {
		for (const level of LEVELS) {
			const planned = planLevel(level, text, spec);
			if ("prompt" in planned) plan.cells.push({ task, level, prompt: planned.prompt });
			else plan.skipped.push({ task, level, note: planned.note });
		}
	}
	return plan;
}

/** Runs a trial launches: every planned cell, for every agent, every repeat. */
export function plannedRuns(
	cells: readonly PlannedCell[],
	agentCount: number,
	repeat: number,
): number {
	return cells.length * agentCount * repeat;
}

/** True when the runs are more than one trial may launch (MAX_RUNS), whatever the plan allows. */
export function exceedsRunCap(runs: number): boolean {
	return runs > MAX_RUNS;
}
