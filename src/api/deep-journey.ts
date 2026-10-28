import type {
	JourneyRun,
	JourneyRunDetail,
	JourneyRunResult,
	JourneyTrajectoryStep,
} from "../contract";
import { warnOnNewerContract } from "../contract";
import { decodeEventBlock } from "./platform";
import { errorBodyText, pause, usageLimitMessage, watchdog } from "./shared";

// Client for ora's public deep-journey API (/api/journey/*): a real AI agent
// attempts a curated task against a domain while ora records the trajectory.
// Anonymous by default (same posture as audit.ts) - the public surface is
// rate-limited per target and per caller. A partner API key (optional)
// unlocks the keyed tier: free-text tasks and a per-key allowance instead of
// the per-IP one.
//
// Thin client: every field (verdict, step_count, insight, trajectory) comes
// from the versioned journey contract as-is; nothing here re-derives judgement.
// The stream is NAMED SSE (event: run_id / trajectory / processing / result /
// error), the same framing the platform client decodes - decodeEventBlock is
// shared from there.

const PUBLIC_BASE = "https://ora.ai";
// A live engine run can take several minutes end to end, but frames arrive at
// least every few seconds while it works; this bounds SILENCE, not the run.
const STREAM_IDLE_MS = 120_000;
const POLL_EVERY_MS = 5_000;
const POLL_LIMIT = 180;
// One budget for following a run, streaming and polling together, matching
// the server's run ceiling: a run nobody streams cannot finish, so time spent
// polling after the stream failed is mostly spent waiting for nothing.
const FOLLOW_BUDGET_MS = 15 * 60_000;
// Longest Retry-After a 429 on the stream is waited out before a reopen.
const MAX_RETRY_AFTER_MS = 60_000;
// ora saves a run's terminal status only from inside the stream route, so a
// run nobody streams to the end stays "running" forever. A dropped stream is
// reopened rather than abandoned: reopening resumes the same run server-side
// and never re-executes the agent.
const STREAM_REOPENS = 5;
const STREAM_REOPEN_PAUSE_MS = 2_000;

/** Any failure to obtain a run from ora: network, HTTP, rate limit, stream error. */
export class DeepJourneyApiError extends Error {}

/** The stream answered with an HTTP error rather than an event stream. */
class JourneyStreamHttpError extends DeepJourneyApiError {
	constructor(
		message: string,
		readonly status: number,
		readonly retryAfterMs: number | undefined,
	) {
		super(message);
	}
}

export interface JourneyIntentOption {
	id: string;
	label: string;
	hint: string;
	template: string;
}

export interface JourneyAgentOption {
	id: string;
	label: string;
	variant: string;
	harness: string;
	model: string;
	blurb?: string;
}

/** The per-target allowance the POST response advertises via X-RateLimit-*. */
export interface RunAllowance {
	limit?: number;
	remaining?: number;
	/** Unix ms when the next per-target slot frees; absent when unknown. */
	resetAtMs?: number;
}

export interface DeepJourneyOptions {
	/** Curated intent id; the server default when omitted. */
	intentId?: string;
	/**
	 * Free-text task (the keyed custom arm, 4-300 chars server-side). Needs a
	 * partner API key; mutually exclusive with `intentId` (the command layer
	 * enforces the exclusivity, this client just sends whichever arm is set).
	 */
	task?: string;
	/**
	 * ora-issued partner API key, sent as `Authorization: Bearer`. Unlocks
	 * free-text tasks and moves the caller to the 1000/24h per-key allowance
	 * (no per-target cap, no burst guard). Falls back to $ORA_PARTNER_API_KEY,
	 * then $ORA_SCAN_API_KEY (the shared partner registry serves both
	 * surfaces). Safe to send a wrong key with a curated intent - the server
	 * silently degrades to the keyless tier.
	 */
	apiKey?: string;
	harness: string;
	model: string;
	/** Receives one-line progress updates while the run streams/polls. */
	progress?: (line: string) => void;
	/**
	 * Receives the cumulative trajectory on every `trajectory` frame - the raw
	 * material the caller redraws the live attribution graph from. Streaming
	 * only; polling has no per-step frames to hand back.
	 */
	onTrajectory?: (steps: JourneyTrajectoryStep[]) => void;
	/** Base URL override; otherwise $ORA_API_URL, otherwise https://ora.ai. */
	baseUrl?: string;
	/** Abort when the stream is silent for this long (default 120s). */
	idleMs?: number;
	/**
	 * No live view: `onTrajectory` is never called. The run is still followed
	 * over the stream, because the stream is what saves the finished run.
	 */
	noStream?: boolean;
	/** Pause between stream reopens after a drop (default 2s). */
	reopenPauseMs?: number;
	/** Total time to follow a running run, streaming plus polling (default 15min). */
	followBudgetMs?: number;
	/** Detail polling, the last resort once every stream reopen has failed. */
	pollEveryMs?: number;
	pollLimit?: number;
}

export interface DeepJourneyOutcome {
	/** The projected run record from the trigger (or the cached latest run). */
	record: JourneyRun;
	/** True when the per-target cap answered with the stored latest run. */
	cached: boolean;
	/** Milliseconds until a per-target slot frees, on a cached answer. */
	retryAfterMs?: number;
	allowance: RunAllowance;
	/** Terminal detail: status, verdict, step_count, and result once succeeded. */
	detail: JourneyRunDetail;
	/** The stream's terminal error message, when the run failed mid-stream. */
	engineError?: string;
}

function apiBase(baseUrl?: string): string {
	return (baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE).replace(/\/+$/, "");
}

async function getJson<T>(url: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new DeepJourneyApiError(`ora request failed: ${detail}`);
	}
	if (!res.ok) throw new DeepJourneyApiError(`ora request failed: ${await errorBodyText(res)}`);
	return (await res.json()) as T;
}

/** The curated intents a public run can execute. */
export function fetchJourneyIntents(
	baseUrl?: string,
): Promise<{ intents: JourneyIntentOption[]; defaultId: string }> {
	return getJson(`${apiBase(baseUrl)}/api/journey/intents`);
}

/** The agents an anonymous run request accepts. */
export function fetchJourneyAgents(
	baseUrl?: string,
): Promise<{ agents: JourneyAgentOption[]; defaultId: string }> {
	return getJson(`${apiBase(baseUrl)}/api/journey/agents`);
}

function allowanceFrom(res: Response): RunAllowance {
	const num = (name: string): number | undefined => {
		const raw = res.headers.get(name);
		if (raw === null) return undefined;
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	};
	const resetSeconds = num("x-ratelimit-reset");
	return {
		limit: num("x-ratelimit-limit"),
		remaining: num("x-ratelimit-remaining"),
		resetAtMs: resetSeconds !== undefined ? resetSeconds * 1000 : undefined,
	};
}

interface TriggeredRun {
	record: JourneyRun & { rate_limited?: boolean; retry_after_ms?: number };
	cached: boolean;
	allowance: RunAllowance;
}

async function triggerRun(
	base: string,
	target: string,
	options: DeepJourneyOptions,
): Promise<TriggeredRun> {
	// The custom arm ({custom, domain}) and the curated arm ({intent_id?,
	// domain}) are mutually exclusive server-side (strict union); whichever the
	// caller set is the one sent.
	const body: Record<string, unknown> = {
		intent: options.task
			? { custom: options.task, domain: target }
			: {
					...(options.intentId ? { intent_id: options.intentId } : {}),
					domain: target,
				},
		harness: options.harness,
		model: options.model,
	};

	let res: Response;
	try {
		res = await fetch(`${base}/api/journey/runs`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new DeepJourneyApiError(`ora journey request failed: ${detail}`);
	}

	if (res.status === 401) {
		// The capability 401: free text needs a recognized partner key. (A
		// curated body never 401s - a bad key silently degrades to keyless.)
		throw new DeepJourneyApiError(
			"free-text tasks need an ora partner API key — set ORA_PARTNER_API_KEY or pass --api-key (keys are issued by ora on request)",
		);
	}
	if (res.status === 429) {
		const usage = await usageLimitMessage(res);
		if (usage) throw new DeepJourneyApiError(`ora usage limit reached: ${usage}`);
		const wait = res.headers.get("retry-after");
		const caps = options.apiKey
			? "keyed allowance: 1000 runs per 24h per key"
			: "burst: 20/min/IP; daily: 20 runs per 24h per IP — an ora partner API key raises this to 1000/24h per key: set ORA_PARTNER_API_KEY or pass --api-key";
		throw new DeepJourneyApiError(
			`ora journey caller limit exceeded${wait ? ` — retry after ${formatWait(Number(wait) * 1000)}` : ""} (${caps})`,
		);
	}
	if (res.status === 503) {
		throw new DeepJourneyApiError("ora's run engine is unavailable right now — try again shortly");
	}
	if (!res.ok) {
		throw new DeepJourneyApiError(`ora journey request failed: ${await errorBodyText(res)}`);
	}

	const record = (await res.json()) as TriggeredRun["record"];
	warnOnNewerContract(record.contractVersion);
	return { record, cached: record.rate_limited === true, allowance: allowanceFrom(res) };
}

export function formatWait(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "soon";
	const hours = ms / 3_600_000;
	if (hours >= 1) return `${Math.ceil(hours)}h`;
	const minutes = ms / 60_000;
	if (minutes >= 1) return `${Math.ceil(minutes)}m`;
	return `${Math.ceil(ms / 1000)}s`;
}

// --- Live stream ---

// Present-tense caption for the newest step in a trajectory frame.
function activityLabel(step: JourneyTrajectoryStep | undefined): string {
	if (!step) return "starting…";
	if (step.type === "text") return "thinking…";
	if (step.action === "search") {
		return step.search_query ? `searching “${clip(step.search_query, 40)}”` : "searching…";
	}
	const where = step.label ?? `${step.url_host ?? ""}${step.url_path ?? ""}`;
	const doing = step.completed === false ? "fetching" : "fetched";
	return where ? `${doing} ${clip(where, 48)}` : `${doing}…`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface StreamedJourney {
	result?: JourneyRunResult;
	errorMessage?: string;
}

async function followJourneyStream(
	base: string,
	streamPath: string,
	options: DeepJourneyOptions,
): Promise<StreamedJourney> {
	const target = streamPath.startsWith("http") ? streamPath : `${base}${streamPath}`;
	const idleMs = options.idleMs ?? STREAM_IDLE_MS;
	const dog = watchdog(idleMs);
	const timeoutError = () =>
		new DeepJourneyApiError(
			`ora journey stream timed out — no frames for ${Math.round(idleMs / 1000)}s`,
		);

	let res: Response;
	try {
		res = await fetch(target, {
			headers: {
				accept: "text/event-stream",
				// A recognized key lifts the stream's per-IP limit on a run that
				// already exists, which reopening after a drop relies on.
				...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
			},
			signal: dog.signal,
		});
	} catch (cause) {
		dog.disarm();
		if (dog.tripped()) throw timeoutError();
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new DeepJourneyApiError(`ora journey stream failed: ${detail}`);
	}
	if (!res.ok || !res.body) {
		dog.disarm();
		const retryAfterS = Number(res.headers.get("retry-after"));
		throw new JourneyStreamHttpError(
			`ora journey stream failed (${res.status}): ${await errorBodyText(res)}`,
			res.status,
			Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : undefined,
		);
	}

	const utf8 = new TextDecoder();
	const collected: StreamedJourney = {};
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
				if (decoded.event === "trajectory") {
					const steps = (payload.steps ?? []) as JourneyTrajectoryStep[];
					const active = steps.filter((s) => s.type === "tool_call").at(-1);
					options.progress?.(`step ${steps.length} · ${activityLabel(active ?? steps.at(-1))}`);
					options.onTrajectory?.(steps);
				} else if (decoded.event === "processing") {
					options.progress?.(
						typeof payload.message === "string" ? payload.message : "generating insights…",
					);
				} else if (decoded.event === "result") {
					collected.result = payload as unknown as JourneyRunResult;
					break streaming;
				} else if (decoded.event === "error") {
					collected.errorMessage =
						typeof payload.message === "string" ? payload.message : "unknown engine error";
					break streaming;
				}
			}
		}
	} catch (cause) {
		if (dog.tripped()) throw timeoutError();
		if (cause instanceof DeepJourneyApiError) throw cause;
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new DeepJourneyApiError(`ora journey stream error: ${detail}`);
	} finally {
		dog.disarm();
		res.body.cancel().catch(() => {});
	}

	return collected;
}

/**
 * Follow the stream to its terminal frame, reopening it when it drops or
 * closes early. Returns the stream's error message for a failed run, or
 * `undefined` once a result arrived. Throws when every reopen failed.
 */
async function streamToEnd(
	base: string,
	streamPath: string,
	options: DeepJourneyOptions,
	deadline: number,
): Promise<string | undefined> {
	const pauseMs = options.reopenPauseMs ?? STREAM_REOPEN_PAUSE_MS;
	let lastFailure: unknown;
	let waitMs = 0;
	for (let attempt = 0; attempt <= STREAM_REOPENS && Date.now() < deadline; attempt++) {
		if (attempt > 0) {
			options.progress?.("stream dropped — reopening");
			await pause(waitMs);
		}
		waitMs = pauseMs;
		try {
			const streamed = await followJourneyStream(base, streamPath, options);
			if (streamed.result || streamed.errorMessage) return streamed.errorMessage;
			lastFailure = new DeepJourneyApiError("ora journey stream closed before the run ended");
		} catch (cause) {
			lastFailure = cause;
			if (cause instanceof JourneyStreamHttpError) {
				// Only a rate limit is worth reopening for, after its window; a
				// 404 or an auth refusal answers the same way every time.
				if (cause.status !== 429) throw cause;
				waitMs = Math.min(cause.retryAfterMs ?? pauseMs, MAX_RETRY_AFTER_MS);
			}
		}
	}
	throw lastFailure ?? new DeepJourneyApiError("ora journey stream was never opened");
}

/** Non-streaming run detail (verdict, step_count, result once succeeded). */
export function fetchRunDetail(base: string, runId: string): Promise<JourneyRunDetail> {
	return getJson<JourneyRunDetail>(`${base}/api/journey/runs/${encodeURIComponent(runId)}`);
}

async function awaitByPolling(
	base: string,
	runId: string,
	options: DeepJourneyOptions,
	deadline: number,
): Promise<JourneyRunDetail> {
	const every = options.pollEveryMs ?? POLL_EVERY_MS;
	const limit = options.pollLimit ?? POLL_LIMIT;
	let latest = await fetchRunDetail(base, runId);
	for (
		let round = 0;
		round < limit && latest.status === "running" && Date.now() < deadline;
		round++
	) {
		options.progress?.("agent working… (polling)");
		await pause(every);
		try {
			latest = await fetchRunDetail(base, runId);
		} catch {
			// transient hiccup — keep polling until the round budget is spent
		}
	}
	return latest;
}

/**
 * Run a deep journey against `target` and resolve with the terminal detail.
 * Follows a running run's stream to its terminal frame (progress lines via
 * `options.progress`); `noStream` only withholds `onTrajectory`. A per-target-capped trigger is
 * NOT an error: ora answers with the most recent stored run for that target,
 * and the outcome carries `cached: true` plus `retryAfterMs`.
 */
export async function performDeepJourney(
	target: string,
	options: DeepJourneyOptions,
): Promise<DeepJourneyOutcome> {
	const base = apiBase(options.baseUrl);
	// `||` not `??`: an empty --api-key should fall through to the env chain.
	options = {
		...options,
		apiKey:
			options.apiKey ||
			process.env.ORA_PARTNER_API_KEY ||
			process.env.ORA_SCAN_API_KEY ||
			undefined,
	};

	const triggered = await triggerRun(base, target, options);
	const { record } = triggered;

	if (triggered.cached) {
		options.progress?.("target at its 24h cap — fetching the most recent stored run");
	}

	// A cached record can still be "running" (the latest run is mid-flight);
	// the stream attaches to it the same way it does to a fresh run. Every
	// running record is streamed, --no-stream included: only the stream route
	// saves the terminal status, so polling alone would watch "running" until
	// the poll budget ran out.
	let engineError: string | undefined;
	let streamFailure: string | undefined;
	if (record.status === "running") {
		const deadline = Date.now() + (options.followBudgetMs ?? FOLLOW_BUDGET_MS);
		const streamOptions = options.noStream ? { ...options, onTrajectory: undefined } : options;
		try {
			// A terminal `error` frame means the run failed - NOT a client failure.
			// Fall through to the detail so a failed run resolves through status
			// "failed" -> the caller's run-failed path, like any other failure.
			engineError = await streamToEnd(base, record.stream_url, streamOptions, deadline);
		} catch (cause) {
			if (cause instanceof JourneyStreamHttpError && cause.status !== 429) throw cause;
			// Every reopen failed (the network, a proxy that strips SSE, a rate
			// limit that outlasted the reopens). The run may still finish if
			// anything else streams it, so poll the detail for what is left of
			// the budget; the still-running guard below reports it otherwise.
			streamFailure = cause instanceof Error ? cause.message : String(cause);
			options.progress?.(`stream unavailable (${streamFailure}) — polling`);
			await awaitByPolling(base, record.id, options, deadline);
		}
	}

	// The detail is the terminal source of truth: verdict + step_count +
	// (once succeeded) the full result. One extra GET, always fresh.
	const detail = await awaitDetailSettled(base, record.id, options);
	// A run can outlive the stream (the serving function's 800s ceiling, or any
	// clean connection close before the terminal frame) and the poll budget. A
	// still-running detail has no verdict to render - never return it as terminal.
	if (detail.status === "running") {
		// With an engine error in hand the run IS over; only the row lagged.
		if (engineError) {
			throw new DeepJourneyApiError(`ora journey run failed: ${engineError}`);
		}
		throw new DeepJourneyApiError(
			`run ${record.id} is still executing — ${
				streamFailure
					? `the stream could not be followed (${streamFailure}) and polling ran out of time`
					: "the stream ended"
			} before a terminal result. Check ${base}/api/journey/runs/${record.id} shortly`,
		);
	}
	warnOnNewerContract(detail.contractVersion);
	return {
		record,
		cached: triggered.cached,
		retryAfterMs: triggered.record.retry_after_ms,
		allowance: triggered.allowance,
		detail,
		engineError,
	};
}

// The stream's terminal frame and the row persist race by a beat; a couple of
// short retries lets the detail settle without a user-visible pause.
async function awaitDetailSettled(
	base: string,
	runId: string,
	options: DeepJourneyOptions,
): Promise<JourneyRunDetail> {
	let detail = await fetchRunDetail(base, runId);
	for (let round = 0; round < 3 && detail.status === "running"; round++) {
		options.progress?.("finalizing…");
		await pause(1_500);
		detail = await fetchRunDetail(base, runId);
	}
	return detail;
}
