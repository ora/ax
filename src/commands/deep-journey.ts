import pc from "picocolors";
import {
	apiBase,
	DeepJourneyApiError,
	type DeepJourneyOutcome,
	fetchJourneyAgents,
	fetchJourneyIntents,
	formatWait,
	JOURNEY_RUNS_PATH,
	type JourneyAgentOption,
	performDeepJourney,
	servedNextAction,
} from "../api/deep-journey";
import type { JourneyStep } from "../api/platform";
import type {
	JourneyNextAction,
	JourneyRunDetail,
	JourneyRunResult,
	JourneyTrajectoryStep,
} from "../contract";
import { type CommandError, reportError } from "../report/json-error";
import {
	axCall,
	type NextStep,
	placeholder,
	printNext,
	servedNextStep,
	shellWord,
	type Word,
} from "../report/next-line";
import { flow, plain, stdoutWidth } from "../ui/ansi";
import { buildJourneyTree, drawJourneyTree, journeySummary } from "../ui/graph";
import { LivePanel } from "../ui/panel";
import { spinner } from "../ui/spinner";

// `ax journey --domain <site>` with no goal of its own (and the older
// `ax deep-journey <url>`): run a real agent at a site through ora's PUBLIC
// journey API (no key, no workspace - unlike `ax run "<goal>"`, which
// drives the authenticated platform). Thin client: verdict, step_count, and insight are
// rendered exactly as the contract delivers them; nothing is re-judged here.

export const EXIT = { OK: 0, RUN_FAILED: 1, USAGE: 2, API: 3 } as const;

// The documented caps, shown up front so a CI author can budget runs before
// spending one. The live remaining allowance comes from the response headers
// after the trigger. One line per tier - which one the caller is on is known
// locally (key present or not).
const CAPS_LINE = "public caps: 100 runs/24h per target · 20 runs/24h per IP";
const KEYED_CAPS_LINE = "keyed caps: 1000 runs/24h per key · no per-target cap";

// The CLI's default agent: Claude Code on Haiku 4.5 - fast and frugal, the right
// default for a terminal that runs many journeys. The public roster currently
// headlines Sonnet (its `defaultId` is cas-sonnet), but the engine accepts the
// claude-agent-sdk + claude-haiku-4-5 pair all the same, so we default to it and
// add it to the selectable set. `--agent <id>` overrides. Once the roster lists a
// haiku Claude Code agent of its own, that one is preferred over this constant.
const DEFAULT_HAIKU_AGENT: JourneyAgentOption = {
	id: "cas-haiku",
	label: "Claude Code",
	variant: "Haiku 4.5",
	harness: "claude-agent-sdk",
	model: "claude-haiku-4-5",
	blurb: "Fast, frugal navigator — the CLI default.",
};

export interface DeepJourneyCommandInput {
	url: string;
	intent?: string;
	/** Free-text task (keyed tier); mutually exclusive with `intent`. */
	task?: string;
	/** Partner API key (--api-key); falls back to $ORA_PARTNER_API_KEY, then $ORA_SCAN_API_KEY. */
	apiKey?: string;
	agent?: string;
	json: boolean;
	noStream: boolean;
	/** The command typed: `ax journey` with no goal of its own, or the older `ax deep-journey`. */
	via?: "journey" | "deep-journey";
}

/**
 * The next call after a failed run request: the request ora named, when it
 * named one. Otherwise a run that is still executing is read, never started
 * again; a missing key is named; everything else is the same call, after the
 * wait the message names.
 */
function failureNext(
	error: unknown,
	sameCall: string,
	keyed: string,
	served: (action: JourneyNextAction) => NextStep,
): NextStep {
	if (error instanceof DeepJourneyApiError && error.nextAction) return served(error.nextAction);
	const code = error instanceof DeepJourneyApiError ? error.code : null;
	if (code === "RUN_STILL_RUNNING" && error instanceof DeepJourneyApiError && error.runUrl) {
		return {
			call: `curl -s ${shellWord(error.runUrl)}`,
			why: "read the run; starting another one would not finish this one sooner",
		};
	}
	switch (code) {
		case "NEEDS_KEY":
			return { call: keyed, why: "ora did not recognise the key; partner keys come from ora" };
		case "RATE_LIMITED":
		case "USAGE_LIMIT_REACHED":
			return { call: sameCall, why: "after the wait the message names" };
		case "ENGINE_UNAVAILABLE":
			return { call: sameCall, why: "in about a minute" };
		default:
			return { call: sameCall, why: "retry; ora may be briefly unreachable" };
	}
}

function verdictLine(verdict: string | undefined, status: string): string {
	if (status === "failed") return pc.red("✗ run failed");
	switch (verdict) {
		case "satisfied":
			return pc.green("✓ task satisfied");
		case "partial":
			return pc.yellow("◐ partially satisfied");
		case "unsatisfied":
			return pc.red("✗ task not satisfied");
		default:
			return pc.dim("· not gradable");
	}
}

function agentLine(agent: JourneyAgentOption): string {
	return `${agent.label} · ${agent.variant}`;
}

// The notes ora raised beside the verdict (the site refused the agent, the
// answer came from memory), in ora's words and order. They never change the
// verdict. A raised flag that came without a reason shows its id instead.
function flagLines(flags: JourneyRunDetail["flags"]): string[] {
	if (!flags) return [];
	return Object.entries(flags)
		.filter(([, flag]) => flag?.flagged)
		.map(([id, flag]) => `${pc.yellow("!")} ${plain(flag.reason || id.replaceAll("_", " "))}`);
}

// The live graph (ui/graph) is written against the platform `JourneyStep`
// shape; the public journey stream speaks the contract `JourneyTrajectoryStep`.
// This bridges the two so `deep-journey` draws the very same attribution tree
// `ax journey` does. Two field-name gaps to close:
//   · the graph reads `input_display` for the box label — searches carry it in
//     `search_query`, fetches in `url_host`/`url_path` (which we re-assemble
//     into a scheme-qualified URL so the graph's splitUrl can parse it).
//   · the tree edge lives in `attribution.referrer.step_id` for the graph;
//     the contract also exposes it as the top-level `parent_id`, so fall back.
function toGraphStep(step: JourneyTrajectoryStep): JourneyStep {
	const isSearch = step.action === "search";
	const inputDisplay = isSearch
		? step.search_query
		: step.url_host || step.url_path
			? `https://${step.url_host ?? ""}${step.url_path ?? ""}`
			: step.url;
	return {
		id: step.id,
		turn: step.turn ?? 0,
		type: step.type,
		// Contract text steps are the agent's narrative reasoning between actions;
		// tag them so the graph attaches them as (…) notes above the next box.
		kind: step.type === "text" ? "reasoning" : undefined,
		text: step.text,
		thinking: step.text,
		tool: step.tool,
		action: step.action,
		input_display: inputDisplay,
		status: step.status,
		duration_ms: step.duration_ms,
		attribution: step.attribution
			? {
					kind: step.attribution.kind,
					referrer: { step_id: step.attribution.referrer?.step_id ?? step.parent_id },
				}
			: undefined,
	};
}

// The attribution tree plus its one-line tally, indented to match the report.
// `settled` false paints the newest box as the live/active node.
function graphLines(steps: JourneyStep[], intent: string, settled: boolean): string[] {
	return [
		`  ${journeySummary(steps)}`,
		"",
		...drawJourneyTree(buildJourneyTree(steps, intent, settled)).map((row) => `  ${row}`),
	];
}

// --- Finale ---

const chipTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function chipCost(usd: number): string {
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

/** input + output; the meaningful "how big was this run" figure (cache is separate). */
function totalTokens(result: JourneyRunResult | undefined): number | undefined {
	if (!result) return undefined;
	const { input_tokens: i, output_tokens: o } = result;
	if (i == null && o == null) return undefined;
	return (i ?? 0) + (o ?? 0);
}

function countSearches(result: JourneyRunResult | undefined): number {
	return (result?.trajectory?.steps ?? []).filter((s) => s.action === "search").length;
}

// The three answer-quality metrics the product shows, matched to run-recap.tsx:
//   · answer from your site  = answer_basis.site_share       (green ≥70, amber ≥40)
//   · answer efficiency      = answer_efficiency              (green ≥70, amber ≥30)
//   · followed site links    = link_following_rate            (green ≥70, amber ≥35)
// Each renders only when the relevant signal is present.
interface JourneyMetric {
	label: string;
	pct: number;
	paint: (s: string) => string;
}

function tierColor(pct: number, good: number, warn: number): (s: string) => string {
	return pct >= good ? pc.green : pct >= warn ? pc.yellow : pc.red;
}

function answerMetrics(result: JourneyRunResult): JourneyMetric[] {
	const sig = result.run_signals;
	const steps = result.trajectory?.steps ?? [];
	const paths = steps.filter(
		(s) => s.type === "tool_call" && (s.action === "fetch" || s.action === "api_call"),
	);

	const metrics: JourneyMetric[] = [];

	if (sig?.answer_basis != null) {
		const pct = Math.round(sig.answer_basis.site_share * 100);
		metrics.push({ label: "answer from your site", pct, paint: tierColor(pct, 70, 40) });
	}

	if (sig?.answer_efficiency != null) {
		const pct = Math.round(sig.answer_efficiency * 100);
		metrics.push({ label: "answer efficiency", pct, paint: tierColor(pct, 70, 30) });
	}

	if (paths.length) {
		const rate =
			sig?.link_following_rate ??
			paths.filter((s) => s.attribution?.kind === "previous_artifact").length / paths.length;
		const pct = Math.round(rate * 100);
		metrics.push({ label: "followed site links", pct, paint: tierColor(pct, 70, 35) });
	}

	return metrics;
}

// A labelled 0–100% bar, tinted by the metric's own score tier. The stacked
// fallback for terminals too narrow to lay the score cards out side by side.
function metricLine(metric: JourneyMetric, cells = 20, labelW = 21): string {
	const lit = Math.max(0, Math.min(cells, Math.round((metric.pct / 100) * cells)));
	const bar = `${metric.paint("▰".repeat(lit))}${pc.dim("▱".repeat(cells - lit))}`;
	const pct = `${metric.pct}%`.padStart(4);
	return `  ${pc.dim(metric.label.padEnd(labelW))}  ${bar}  ${metric.paint(pc.bold(pct))}`;
}

// Center `content` (a plain, un-colored string) in a `width`-wide cell, then
// tint it. Padding is measured on the raw text and added OUTSIDE the color codes
// so ANSI escapes never skew the column math (same discipline as ui/ansi).
function cell(content: string, width: number, paint: (s: string) => string): string {
	const pad = Math.max(0, width - content.length);
	const left = Math.floor(pad / 2);
	return `${" ".repeat(left)}${paint(content)}${" ".repeat(pad - left)}`;
}

// The headline metrics as a row of score cards (mirrors the product's
// scorecards): a big tinted percent over a proportional underline rule over the
// label. Returns null when the terminal is too narrow for one column per metric,
// so the caller falls back to stacked metricLine bars.
function metricCards(metrics: JourneyMetric[], wide: number): string[] | null {
	const n = metrics.length;
	if (n === 0) return null;
	const gap = 4;
	const avail = Math.min(wide, 100) - 2; // 2-space left indent
	const colW = Math.floor((avail - gap * (n - 1)) / n);
	if (colW < 18) return null; // too tight to read a card — use the bars instead

	const pctRow: string[] = [];
	const barRow: string[] = [];
	const labelRows: string[][] = [];
	let labelHeight = 1;
	for (const m of metrics) {
		pctRow.push(cell(`${m.pct}%`, colW, (s) => m.paint(pc.bold(s))));
		// A thin underline rule: the tinted portion runs to the score, the rest is
		// a dim track, framed by one space each side so cards breathe.
		const barW = colW - 2;
		const lit = Math.max(1, Math.min(barW, Math.round((m.pct / 100) * barW)));
		barRow.push(` ${m.paint("▔".repeat(lit))}${pc.dim("▔".repeat(barW - lit))} `);
		const wrapped = flow(m.label.toUpperCase(), colW).map((line) => cell(line, colW, pc.dim));
		labelRows.push(wrapped);
		labelHeight = Math.max(labelHeight, wrapped.length);
	}
	const join = (cells: string[]) => `  ${cells.join(" ".repeat(gap))}`;
	const lines = ["", join(pctRow), join(barRow)];
	for (let r = 0; r < labelHeight; r++) {
		lines.push(join(labelRows.map((rows) => rows[r] ?? cell("", colW, pc.dim))));
	}
	return lines;
}

// Distribution rows: label/bar/% for each non-zero bucket. Bar width = share of
// total items in this distribution (not a 0-100 score, so no tier coloring).
interface DistBucket {
	label: string;
	n: number;
}

function distLines(title: string, buckets: DistBucket[]): string[] {
	const present = buckets.filter((b) => b.n > 0);
	const total = present.reduce((s, b) => s + b.n, 0);
	if (!present.length || !total) return [];
	const labelW = Math.max(...present.map((b) => b.label.length));
	const rows: string[] = ["", `  ${pc.dim(title)}`];
	for (const b of present) {
		const pct = Math.round((b.n / total) * 100);
		const lit = Math.max(0, Math.min(20, Math.round((pct / 100) * 20)));
		const bar = `${pc.dim("▰".repeat(lit))}${pc.dim("▱".repeat(20 - lit))}`;
		rows.push(`    ${pc.dim(b.label.padEnd(labelW))}  ${bar}  ${pc.dim(`${pct}%`.padStart(4))}`);
	}
	return rows;
}

function rule(wide: number): string {
	return pc.dim(`  ${"─".repeat(Math.min(wide - 4, 52))}`);
}

// The behavioral read of the run: answer-quality scores plus the two attribution
// distributions. Reach context from run_signals when present.
function signalLines(result: JourneyRunResult, wide: number): string[] {
	const sig = result.run_signals;
	const rows: string[] = [];

	// Reach context (run_signals only).
	if (sig?.reached_anchor != null) {
		const reach = sig.reached_anchor
			? pc.green("✓ reached the site")
			: pc.red("✗ never reached the site");
		rows.push("", `  ${reach}`);
	}

	// The headline answer-quality metrics: score cards when the terminal is wide
	// enough, stacked bars otherwise.
	const metrics = answerMetrics(result);
	if (metrics.length) {
		const cards = metricCards(metrics, wide);
		if (cards) {
			rows.push(...cards);
		} else {
			rows.push("");
			for (const metric of metrics) rows.push(metricLine(metric));
		}
	}

	// Answer sources: how the answer's substance was composed.
	const basis = sig?.answer_basis;
	if (basis && basis.sections_total > 0) {
		rows.push(
			...distLines("answer sources", [
				{ label: "from this site", n: basis.from_site },
				{ label: "from external pages", n: basis.from_external },
				{ label: "from search results", n: basis.from_search },
				{ label: "from agent knowledge", n: basis.from_memory },
			]),
		);
	}

	// URL discovery: how fetched pages were found (matches run-recap.tsx kindOf logic).
	const steps = result.trajectory?.steps ?? [];
	const paths = steps.filter(
		(s) => s.type === "tool_call" && (s.action === "fetch" || s.action === "api_call"),
	);
	if (paths.length) {
		const kindOf = (s: (typeof paths)[number]): string => {
			const k = s.attribution?.kind;
			if (k === "previous_step" || k === "previous_artifact") return "previous_artifact";
			if (k === "web_search") return "web_search";
			if (
				k === "prior_knowledge" &&
				s.anchor_relation === "exact" &&
				(!s.url_path || s.url_path === "/")
			)
				return "task_input";
			return "prior_knowledge";
		};
		const counts: Record<string, number> = {};
		for (const s of paths) {
			const k = kindOf(s);
			counts[k] = (counts[k] ?? 0) + 1;
		}
		rows.push(
			...distLines("url discovery", [
				{ label: "given in the task", n: counts.task_input ?? 0 },
				{ label: "followed a link", n: counts.previous_artifact ?? 0 },
				{ label: "found via web search", n: counts.web_search ?? 0 },
				{ label: "guessed the URL", n: counts.prior_knowledge ?? 0 },
			]),
		);
	}

	return rows;
}

function renderOutcome(outcome: DeepJourneyOutcome, url: string): string[] {
	const wide = stdoutWidth(60, 120);
	const { detail } = outcome;
	const result = detail.result;
	const lines: string[] = ["", rule(wide), ""];

	// Verdict headline.
	lines.push(
		`  ${verdictLine(detail.verdict, detail.status)}  ${pc.dim("·")}  ${pc.dim(detail.domain ?? url)}`,
	);

	// One chip row: size and cost of the run at a glance.
	const chips: string[] = [];
	if (detail.step_count != null) chips.push(`${detail.step_count} steps`);
	const searches = result?.run_signals?.search_count ?? countSearches(result);
	if (searches) chips.push(`${searches} search${searches === 1 ? "" : "es"}`);
	if (result?.duration_ms != null) chips.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
	const tokens = totalTokens(result);
	if (tokens != null) chips.push(`${chipTokens(tokens)} tokens`);
	if (result?.cost_usd != null) chips.push(chipCost(result.cost_usd));
	if (chips.length) lines.push(`  ${pc.dim(chips.join("  ·  "))}`);
	for (const line of flagLines(detail.flags)) lines.push(`  ${line}`);

	// Behavioral signals: the answer-quality score cards and attribution
	// distributions, when the result carries them.
	if (result) lines.push(...signalLines(result, wide));

	// The generated read, wrapped to width; observations as bullets beneath it.
	if (result?.insight?.summary) {
		lines.push("");
		for (const row of flow(plain(result.insight.summary), wide - 4)) lines.push(`  ${row}`);
	}
	const observations = result?.insight?.key_observations ?? [];
	if (observations.length) {
		lines.push("", `  ${pc.bold("Observations")}`);
		for (const observation of observations) {
			const [first, ...rest] = flow(plain(observation), wide - 6);
			lines.push(`    ${pc.cyan("·")} ${first}`);
			for (const row of rest) lines.push(`      ${row}`);
		}
	}

	if (detail.status === "failed") {
		lines.push(
			"",
			pc.dim(
				outcome.engineError
					? `  Engine error: ${outcome.engineError} — re-running is free to try.`
					: "  The run ended in an engine error; re-running is free to try.",
			),
		);
	}

	lines.push("");
	return lines;
}

export async function deepJourneyCommand(input: DeepJourneyCommandInput): Promise<number> {
	// Usage mistakes print plain, API failures in red, both prefixed. `cause`
	// is the thrown error, whose served body (if any) is what --json prints.
	const fail = (error: CommandError, exit: number, cause?: unknown): number => {
		const prefixed = (message: string) => `ax ${input.via ?? "deep-journey"}: ${message}`;
		reportError(error, {
			json: input.json,
			display: (message) => (exit === EXIT.API ? pc.red(prefixed(message)) : prefixed(message)),
			served: cause instanceof DeepJourneyApiError ? cause.payload : undefined,
		});
		return exit;
	};
	// A caller reading JSON keeps reading JSON on the next call.
	const json = input.json ? ["--json"] : [];
	const target = input.url.trim();
	if (!target) {
		return fail(
			{
				code: "INVALID_TARGET",
				message: "a target URL or domain is required",
				next: { call: axCall(["journey", "--domain", placeholder("domain"), ...json]) },
			},
			EXIT.USAGE,
		);
	}

	const interactive = !input.json && process.stderr.isTTY;

	// Tier resolution, before any network call: the two intent arms are
	// mutually exclusive, and a free-text task without a key would only 401
	// server-side - fail fast with the fix instead of spending a request.
	const task = input.task?.trim() || undefined;
	const apiKey =
		input.apiKey || process.env.ORA_PARTNER_API_KEY || process.env.ORA_SCAN_API_KEY || undefined;
	// The run as a call, for the Next line. The key is never echoed: a key
	// passed as a flag comes back as a placeholder, one from the environment
	// needs no flag at all.
	// Written as `ax journey`, the name this run has now, whichever name was typed.
	const runWords = (intent: string | undefined, agentId: string | undefined): Word[] => [
		"journey",
		...(task ? [task] : []),
		"--domain",
		target,
		...(!task && intent ? ["--intent", intent] : []),
		...(agentId ? ["--agent", agentId] : []),
		...json,
		...(input.noStream ? ["--no-stream"] : []),
	];
	const keyWords: Word[] = input.apiKey ? ["--api-key", placeholder("key")] : [];
	const sameCall = (intent: string | undefined, agentId: string | undefined) =>
		axCall([...runWords(intent, agentId), ...keyWords]);
	const keyedCall = (intent: string | undefined, agentId: string | undefined) =>
		`ORA_PARTNER_API_KEY=<partner key> ${axCall(runWords(intent, agentId))}`;
	// A next action ora served is the Next line. Starting the run again is
	// this same ax call, which follows the run it starts; any other request
	// (the run's stream, the agent list) is written as curl. A docs page ora
	// links to (the partner key page on a 401) puts the keyed retry first.
	const base = apiBase();
	const served =
		(intent: string | undefined, agentId: string | undefined) =>
		(action: JourneyNextAction): NextStep =>
			servedNextStep(action, {
				base,
				axEquivalent: { method: "POST", url: JOURNEY_RUNS_PATH, call: sameCall(intent, agentId) },
				pageCall: keyedCall(intent, agentId),
			});
	if (task && input.intent !== undefined) {
		return fail(
			{
				code: "INVALID_FLAG",
				message:
					input.via === "journey"
						? "a goal of your own and --intent cannot be combined: --intent picks one of ora's curated tasks"
						: "--task and --intent are mutually exclusive — a free-text task replaces the curated intent",
				next: { call: sameCall(undefined, input.agent), why: "the task alone" },
			},
			EXIT.USAGE,
		);
	}
	if (task && !apiKey) {
		return fail(
			{
				code: "NEEDS_KEY",
				message:
					input.via === "journey"
						? "a goal of your own on ora's public journeys needs an ora partner API key (set ORA_PARTNER_API_KEY or pass --api-key). To use your account on Ora's front, sign in with ax login and use ax run."
						: "--task needs an ora partner API key — set ORA_PARTNER_API_KEY or pass --api-key (keys are issued by ora on request)",
				next: {
					call: keyedCall(undefined, input.agent),
					why: "or drop --task to run a curated task without a key",
				},
			},
			EXIT.USAGE,
		);
	}

	// Resolve the intent and agent against the live rosters (both static,
	// cached routes) so a typo fails with the menu instead of a bare 400. A
	// free-text task skips the intent roster entirely - the server takes the
	// text as-is (anchored to the target) instead of a template id.
	let intentId = input.intent;
	let agent: JourneyAgentOption;
	// The goal drawn at the graph's root: the free-text task verbatim, or the
	// curated intent's own phrasing (template › hint › label), never a bare id.
	let intentText = task ?? "journey";
	try {
		const [intents, agents] = await Promise.all([
			task ? undefined : fetchJourneyIntents(),
			fetchJourneyAgents(),
		]);
		if (intents) {
			if (intentId === undefined) {
				intentId = intents.defaultId;
			} else if (!intents.intents.some((option) => option.id === intentId)) {
				return fail(
					{
						code: "UNKNOWN_INTENT",
						message: `unknown intent "${intentId}". Available intents:\n${intents.intents
							.map((option) => `  ${option.id.padEnd(12)} ${option.hint}`)
							.join("\n")}`,
						next: {
							call: sameCall(intents.defaultId, input.agent),
							why: "or any intent id listed above",
						},
					},
					EXIT.USAGE,
				);
			}
			const chosen = intents.intents.find((option) => option.id === intentId);
			// The curated templates carry a literal `{domain}` token the server fills
			// in when it runs; substitute it here so the graph's root goal reads as a
			// real sentence ("… Find pricing for stripe.com.") instead of the raw
			// placeholder.
			intentText = (
				chosen?.template ||
				chosen?.hint ||
				chosen?.label ||
				intentId ||
				"journey"
			).replace(/\{domain\}/g, target);
		}
		// The selectable set: the live roster plus our haiku default (prepended so
		// it is both the default and resolvable via --agent). A roster that already
		// carries a haiku Claude Code agent wins - we never shadow it.
		const rosterHasHaiku = agents.agents.some(
			(option) => option.harness === "claude-agent-sdk" && /haiku/i.test(option.model),
		);
		const roster = rosterHasHaiku ? agents.agents : [DEFAULT_HAIKU_AGENT, ...agents.agents];
		// Default (no --agent): prefer Claude Code on Haiku over the roster's Sonnet.
		const preferredDefault =
			roster.find((option) => option.harness === "claude-agent-sdk" && /haiku/i.test(option.model))
				?.id ?? agents.defaultId;
		const wantedAgent = input.agent ?? preferredDefault;
		const found = roster.find((option) => option.id === wantedAgent);
		if (!found) {
			return fail(
				{
					code: "UNKNOWN_AGENT",
					message: `unknown agent "${wantedAgent}". Available agents:\n${roster
						.map((option) => `  ${option.id.padEnd(12)} ${agentLine(option)}`)
						.join("\n")}`,
					next: {
						call: sameCall(intentId, preferredDefault),
						why: "or any agent id listed above",
					},
				},
				EXIT.USAGE,
			);
		}
		agent = found;
	} catch (error) {
		return fail(
			{
				code: "API_ERROR",
				message: error instanceof Error ? error.message : String(error),
				next: failureNext(
					error,
					sameCall(intentId, input.agent),
					keyedCall(intentId, input.agent),
					served(intentId, input.agent),
				),
			},
			EXIT.API,
			error,
		);
	}

	if (!input.json) {
		console.error(pc.dim(apiKey ? KEYED_CAPS_LINE : CAPS_LINE));
	}

	// The live attribution graph draws itself from the streamed trajectory, so
	// it only lights up on a TTY without --no-stream. With --no-stream (the run
	// is still streamed; only the step count reaches the spinner) or a bare
	// pipe, we fall back to the one-line spinner and let the terminal graph
	// print once at the end.
	const live = interactive && !input.noStream;
	const panel = new LivePanel();
	let steps: JourneyStep[] = [];
	let headline = `waking ${agent.label}`;
	const repaint = () => panel.draw(graphLines(steps, intentText, false), headline);

	if (live) {
		console.log();
		console.log(
			`  ${pc.cyan("▶")} ${pc.bold(target)}  ${pc.dim("·")}  ${pc.dim(agentLine(agent))}  ${pc.dim("·")}  ${pc.dim(task ? "custom task" : (intentId ?? "default"))}`,
		);
		console.log();
		panel.open();
		repaint();
	} else if (interactive) {
		spinner.start(`Sending ${agentLine(agent)} to ${target} (${task ? `"${task}"` : intentId})`);
	}

	const progress = (line: string) => {
		if (live) {
			headline = line;
			repaint();
		} else if (interactive) {
			spinner.update(line);
		}
	};

	let outcome: DeepJourneyOutcome;
	try {
		outcome = await performDeepJourney(target, {
			intentId: task ? undefined : intentId,
			task,
			apiKey,
			harness: agent.harness,
			model: agent.model,
			noStream: input.noStream,
			progress: interactive ? progress : undefined,
			onTrajectory: live
				? (raw) => {
						steps = raw.map(toGraphStep);
						repaint();
					}
				: undefined,
		});
	} catch (error) {
		if (live) panel.close();
		else if (interactive) spinner.stop();
		return fail(
			{
				code: (error instanceof DeepJourneyApiError && error.code) || "API_ERROR",
				message: error instanceof Error ? error.message : String(error),
				next: failureNext(
					error,
					sameCall(intentId, agent.id),
					keyedCall(intentId, agent.id),
					served(intentId, agent.id),
				),
			},
			EXIT.API,
			error,
		);
	}
	if (live) panel.close();
	else if (interactive) spinner.stop();

	const failed = outcome.detail.status === "failed";
	const servedNext = servedNextAction(outcome.detail);
	const next: NextStep = servedNext
		? served(intentId, agent.id)(servedNext)
		: failed
			? {
					call: sameCall(intentId, agent.id),
					why: "the run ended in an engine error; re-running is free to try",
				}
			: {
					call: axCall(["audit", target, ...json]),
					why: "the readiness audit: which checks explain what the agent hit",
				};

	if (input.json) {
		console.log(JSON.stringify(outcome.detail, null, 2));
		for (const line of flagLines(outcome.detail.flags)) console.error(line);
		printNext(next, { stderr: true });
		return failed ? EXIT.RUN_FAILED : EXIT.OK;
	}

	if (outcome.cached) {
		console.error(
			pc.yellow(
				`This target hit its 24h cap — showing the most recent stored run${
					outcome.retryAfterMs ? ` (fresh run in ${formatWait(outcome.retryAfterMs)})` : ""
				}.`,
			),
		);
	} else if (outcome.allowance.remaining !== undefined && outcome.allowance.limit !== undefined) {
		console.error(
			pc.dim(
				`allowance: ${outcome.allowance.remaining} of ${outcome.allowance.limit} target runs left in the 24h window`,
			),
		);
	}

	// The permanent copy: redraw the graph from the terminal detail's trajectory
	// (the authoritative, complete tree - which can carry more steps than the
	// last stream frame did) so the attribution picture survives past the live
	// region and also shows up on a bare pipe or under --no-stream.
	const finalSteps = (outcome.detail.result?.trajectory?.steps ?? []).map(toGraphStep);
	if (finalSteps.length) {
		console.log();
		for (const line of graphLines(finalSteps, intentText, true)) console.log(line);
	}

	for (const line of renderOutcome(outcome, target)) console.log(line);
	printNext(next, { stderr: false });
	return failed ? EXIT.RUN_FAILED : EXIT.OK;
}
