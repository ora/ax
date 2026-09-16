import { pause, watchdog } from "./shared";

// Client for ora's authenticated platform API — the machinery behind `journey`.
// One journey == one run: an agent harness pursuing an intent against a domain.
// (The separate POST /studio/v1/journeys endpoint is a server-side multi-agent
// fan-out needing the journeys:write scope; a runs:read + runs:write key is all
// this client requires, so it stays away from that endpoint on purpose.)

const PLATFORM_BASE = "https://api.agentfront.sh";

/** The platform API base: explicit override, else $ORA_PLATFORM_URL, else prod. */
export function platformBase(override?: string): string {
	return (override ?? process.env.ORA_PLATFORM_URL ?? PLATFORM_BASE).replace(/\/+$/, "");
}
const RUN_IDLE_MS = 120_000; // agents legitimately go quiet between turns

// --- Wire shapes ---

export interface RunSummary {
	run_id: string;
	domain?: string;
	intent?: string;
	harness?: string;
	model?: string;
	effective_model?: string;
	outcome: string;
	num_turns?: number;
	duration_ms?: number;
	started_at?: string;
	finished_at?: string;
	last_seq?: number;
}

export interface InsightRecommendation {
	title: string;
	detail: string;
	priority?: string;
}

export interface JourneyInsight {
	summary?: string;
	outcome?: string;
	visibility_score?: number;
	intent_satisfied?: boolean;
	task_satisfied?: string;
	key_observations?: string[];
	friction_points?: string[];
	recommendations?: InsightRecommendation[];
	intent_category?: string;
	journey_layers?: string[];
	/** Usage of the analyzer that produced the insight — not the run itself. */
	usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * One entry of a `trajectory` snapshot. Richer than the raw `step` events: a
 * tool call arrives merged with its result (status, duration, structured
 * output) plus ora's attribution of where the agent got the target from.
 */
export interface JourneyStep {
	id: number;
	turn: number;
	type: string; // "text" | "tool_call" | "tool_result" | …
	kind?: string; // for text steps: "reasoning" | "text" | "output"
	text?: string;
	thinking?: string;
	tool?: string;
	action?: string;
	input?: Record<string, unknown>;
	input_display?: string;
	summary?: string;
	label?: string;
	status?: number;
	duration_ms?: number;
	is_error?: boolean;
	output_structured?: { body?: string; links?: Array<{ title?: string; url?: string }> };
	elapsed_ms?: number;
	attribution?: {
		kind?: string; // "web_search" | "prior_knowledge" | "previous_artifact" | …
		method?: string;
		confidence?: string;
		/** For link-follows: the exact step this URL was discovered on. */
		referrer?: { step_id?: number; turn?: number; artifact_kind?: string; url_path?: string };
	};
}

/** A raw `step` event payload (loosely typed; the CLI never renders from these). */
export interface RawRunStep {
	type: string;
	turn?: number;
	tool?: string;
	[extra: string]: unknown;
}

/** Run-level token/cost totals, read from the runs list after completion. */
export interface RunSpend {
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	costUsd?: number;
}

export interface JourneyHooks {
	/** Fired exactly once when the run exists (the stream's own `run` event is ignored). */
	opened?: (runId: string) => void;
	/**
	 * A full-trajectory snapshot arrived. These flow every few seconds while
	 * the agent works and are the ONLY live signal — drive all UI from here.
	 */
	snapshot?: (steps: JourneyStep[]) => void;
	/**
	 * A raw `step` event arrived. ⚠ The server flushes these in one burst at
	 * the very end of the run; rendering from them means a blank screen until
	 * the agent finishes.
	 */
	step?: (step: RawRunStep, seq: number) => void;
	finished?: (summary: RunSummary) => void;
	scored?: (insight: JourneyInsight) => void;
}

export interface RunRequest {
	intent: string;
	domain?: string;
	harness?: string;
	model?: string;
	/** "harness" = tool-using agent (default); "direct" = single LLM answer. */
	executionKind?: "harness" | "direct";
	baseUrl?: string;
	apiKey?: string;
	idleMs?: number;
}

export interface JourneyRun {
	runId: string;
	intent: string;
	domain?: string;
	harness?: string;
	result?: RunSummary;
	insight?: JourneyInsight;
	usage?: RunSpend;
	steps: RawRunStep[];
	/** The last trajectory snapshot seen — the definitive step list. */
	trajectory: JourneyStep[];
}

// --- Auth ---
// The ora_sk_ secret goes in the authorization HEADER (never the body) and is
// exchanged for a ~15-minute bearer token used on every later call.

export async function exchangeKey(base: string, secret: string): Promise<string> {
	const res = await fetch(`${base}/auth/token`, {
		method: "POST",
		headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
		body: "{}",
	});
	if (res.status === 401) throw new Error("ora rejected the API key (401). Check ORA_API_KEY.");
	const payload = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
	if (!res.ok || !payload.token) {
		throw new Error(`ora auth failed (${res.status})${payload.error ? `: ${payload.error}` : ""}`);
	}
	return payload.token;
}

// --- Run creation ---

interface CreatedRun {
	runId: string;
	status: string;
	streamUrl?: string;
	answer?: string;
}

async function createRun(base: string, bearer: string, request: RunRequest): Promise<CreatedRun> {
	const body: Record<string, unknown> = { intent: request.intent };
	if (request.domain) body.domain = request.domain;
	if (request.harness) body.harness = request.harness;
	if (request.model) body.model = request.model;
	if (request.executionKind) body.execution_kind = request.executionKind;

	const res = await fetch(`${base}/experiment/v1/runs`, {
		method: "POST",
		headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (res.status === 429) throw new Error("ora rate limit hit (429). Wait a moment and retry.");

	const text = await res.text();
	let created: CreatedRun & { error?: string; message?: string };
	try {
		created = JSON.parse(text);
	} catch {
		throw new Error(`ora returned a non-JSON response (${res.status})`);
	}
	if (!res.ok || !created.runId) {
		throw new Error(`ora run failed (${res.status}): ${created.message ?? created.error ?? text}`);
	}
	return created;
}

// --- The run stream ---
// Named SSE (`event: X` + `data: {json}` + `: ping` heartbeats) — a different
// framing from the scan stream, so it gets its own decoder. Expected order:
// run → trajectory×N → step×N (end burst) → result → insight. The insight is
// delivered in-stream a few seconds after the result; no polling needed.

export function decodeEventBlock(block: string): { event: string; data: string } | null {
	let event = "message";
	const payload: string[] = [];
	for (const row of block.split("\n")) {
		if (row.startsWith(":")) continue; // heartbeat comment
		if (row.startsWith("event:")) event = row.slice(6).trim();
		else if (row.startsWith("data:")) payload.push(row.slice(5).replace(/^ /, ""));
	}
	return payload.length ? { event, data: payload.join("\n") } : null;
}

interface StreamedRun {
	summary?: RunSummary;
	insight?: JourneyInsight;
	steps: RawRunStep[];
	trajectory: JourneyStep[];
}

async function followRunStream(
	base: string,
	bearer: string,
	streamPath: string,
	hooks: JourneyHooks,
	idleMs: number,
): Promise<StreamedRun> {
	const target = streamPath.startsWith("http") ? streamPath : `${base}${streamPath}`;
	const dog = watchdog(idleMs);

	const res = await fetch(target, {
		headers: { authorization: `Bearer ${bearer}`, accept: "text/event-stream" },
		signal: dog.signal,
	});
	if (!res.ok || !res.body) {
		dog.disarm();
		throw new Error(`ora run stream failed (${res.status})`);
	}

	const utf8 = new TextDecoder();
	const collected: StreamedRun = { steps: [], trajectory: [] };
	let pending = "";

	try {
		streaming: for await (const chunk of res.body) {
			dog.poke();
			pending = `${pending}${utf8.decode(chunk as Uint8Array, { stream: true })}`.replace(
				/\r\n?/g,
				"\n",
			);
			let cut = pending.indexOf("\n\n");
			while (cut !== -1) {
				const decoded = decodeEventBlock(pending.slice(0, cut));
				pending = pending.slice(cut + 2);
				cut = pending.indexOf("\n\n");
				if (!decoded) continue;
				let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(decoded.data);
				} catch {
					continue;
				}
				absorb(collected, decoded.event, payload, hooks);
				if (collected.summary && collected.insight) break streaming;
			}
		}
	} catch (cause) {
		if (dog.tripped()) throw new Error(`ora run stream timed out after ${idleMs}ms of silence`);
		throw cause;
	} finally {
		dog.disarm();
		res.body.cancel().catch(() => {});
	}

	return collected;
}

function absorb(
	into: StreamedRun,
	event: string,
	payload: Record<string, unknown>,
	hooks: JourneyHooks,
): void {
	switch (event) {
		case "trajectory": {
			const snapshot = payload.steps;
			if (Array.isArray(snapshot)) {
				into.trajectory = snapshot as JourneyStep[];
				hooks.snapshot?.(into.trajectory);
			}
			return;
		}
		case "step": {
			const step = payload.step as RawRunStep | undefined;
			if (step) {
				into.steps.push(step);
				hooks.step?.(step, Number(payload.seq ?? into.steps.length));
			}
			return;
		}
		case "result": {
			const summary = payload.result as RunSummary | undefined;
			if (summary) {
				into.summary = summary;
				hooks.finished?.(summary);
			}
			return;
		}
		case "insight": {
			const insight = payload.insight as JourneyInsight | undefined;
			if (insight) {
				into.insight = insight;
				hooks.scored?.(insight);
			}
			return;
		}
		default:
			// `run` merely repeats the id we already hold; ping comments never get here.
			return;
	}
}

// --- Spend lookup ---
// Tokens and cost never ride the stream; they land on the runs list, and the
// pricing itself is written asynchronously — hence the single delayed retry.

interface SpendRow {
	id: string;
	total_tokens?: number | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_tokens?: number | null;
	cache_creation_tokens?: number | null;
	cost_usd?: number | null;
}

async function readRunSpend(
	base: string,
	bearer: string,
	runId: string,
): Promise<RunSpend | undefined> {
	for (let attempt = 0; ; attempt++) {
		let row: SpendRow | undefined;
		try {
			const res = await fetch(`${base}/experiment/v1/runs?pageSize=50`, {
				headers: { authorization: `Bearer ${bearer}` },
			});
			if (!res.ok) return undefined;
			const page = (await res.json()) as { results?: SpendRow[] };
			row = page.results?.find((entry) => entry.id === runId);
		} catch {
			return undefined;
		}
		if (!row) return undefined;
		if (row.total_tokens != null || row.cost_usd != null) {
			return {
				totalTokens: row.total_tokens ?? undefined,
				inputTokens: row.input_tokens ?? undefined,
				outputTokens: row.output_tokens ?? undefined,
				cacheReadTokens: row.cache_read_tokens ?? undefined,
				cacheCreationTokens: row.cache_creation_tokens ?? undefined,
				costUsd: row.cost_usd ?? undefined,
			};
		}
		if (attempt > 0) return undefined;
		await pause(1200);
	}
}

// --- Orchestration: key → token → create → stream → spend ---

export async function launchJourney(
	request: RunRequest,
	hooks: JourneyHooks = {},
): Promise<JourneyRun> {
	const base = (request.baseUrl ?? process.env.ORA_PLATFORM_URL ?? PLATFORM_BASE).replace(
		/\/+$/,
		"",
	);
	const secret = request.apiKey ?? process.env.ORA_API_KEY;
	if (!secret) {
		throw new Error(
			"Missing ORA_API_KEY. Set it in your environment or a local .env file (see .env.example).",
		);
	}

	const bearer = await exchangeKey(base, secret);
	const created = await createRun(base, bearer, request);

	const outline = {
		runId: created.runId,
		intent: request.intent,
		domain: request.domain,
		harness: request.harness,
	};

	// Rare synchronous completion: no stream to follow, return the bare record.
	if (created.status === "succeeded" && !created.streamUrl) {
		return { ...outline, steps: [], trajectory: [] };
	}

	hooks.opened?.(created.runId);
	const streamed = await followRunStream(
		base,
		bearer,
		created.streamUrl ?? `/experiment/v1/runs/${created.runId}/stream`,
		hooks,
		request.idleMs ?? RUN_IDLE_MS,
	);
	const spend = streamed.summary ? await readRunSpend(base, bearer, created.runId) : undefined;

	return {
		...outline,
		result: streamed.summary,
		insight: streamed.insight,
		usage: spend,
		steps: streamed.steps,
		trajectory: streamed.trajectory,
	};
}
