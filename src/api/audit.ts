import type { AuditScanResult, AuditScoreResult } from "../contract";
import { warnOnNewerContract } from "../contract";
import { errorBody, pause, watchdog } from "./shared";

// Client for ora's public agent-readiness audit. Uses the SSE endpoint
// (GET /api/scan/stream?format=audit) rather than POST /api/scan: the
// synchronous variant has a ~30s hard cap and reliably times out on large or
// uncached sites, whereas the stream just keeps emitting while the scan works.
//
// Thin client by design: every payload field (grade, tiers, topFixes ranking,
// estScoreGain) comes from the versioned audit contract as-is. Nothing here
// re-derives interpretation - see src/contract/ for the generated types.

const PUBLIC_BASE = "https://ora.ai";
const STREAM_IDLE_MS = 60_000;
const POLL_EVERY_MS = 2_000;
const POLL_LIMIT = 45; // ≈90s of patience for async deep analysis
const BAR_CELLS = 14;

/**
 * Any failure to obtain a result from ora: network, HTTP, rate limit, timeout.
 *
 * `code` is the server's machine-readable reason where it gave one, so a
 * caller can branch without matching on prose, and `payload` is the error
 * object exactly as ora served it (what `--json` prints - invariant 4). Both
 * are null/undefined for the failures ora has no code for.
 */
export class AuditApiError extends Error {
	readonly code: string | null;
	readonly payload: unknown;

	constructor(message: string, options: { code?: string | null; payload?: unknown } = {}) {
		super(message);
		this.name = "AuditApiError";
		this.code = options.code ?? null;
		this.payload = options.payload;
	}
}

/**
 * ora's answer for a target whose MCP handshake needs credentials (contract
 * 1.25.0): the scan is refused rather than scored, so there is no score to
 * gate on. Not a failure - the CLI reports it and exits 0.
 */
export const MCP_AUTH_REQUIRED = "MCP_AUTH_REQUIRED";

/** True when ora refused the scan because the MCP server wants credentials. */
export function isMcpAuthRequired(error: unknown): error is AuditApiError {
	return error instanceof AuditApiError && error.code === MCP_AUTH_REQUIRED;
}

/**
 * The raw audit payload: scan-shaped from the stream's terminal event,
 * score-shaped once deep-analysis polling has taken over.
 */
export type AuditResult = AuditScanResult | AuditScoreResult;

export interface AuditOutcome {
	/** The raw `?format=audit` contract payload, untouched. */
	result: AuditResult;
	/**
	 * ora's one-line agentic verdict. Rides the stream's `summary_ready` event,
	 * not the audit payload, so it is carried alongside rather than injected.
	 */
	verdict?: string;
}

export interface AuditOptions {
	/** Receives one-line progress updates while the scan streams and polls. */
	progress?: (line: string) => void;
	/** Base URL override; otherwise $ORA_API_URL, otherwise https://ora.ai. */
	baseUrl?: string;
	/** Abort when the stream is silent for this long (default 60s). */
	idleMs?: number;
	pollEveryMs?: number;
	pollLimit?: number;
	/** Freshness window in seconds (server clamps to [3600, 86400]). */
	maxAgeSeconds?: number;
	/** Bypass the freshness cache (spends the stricter 6/day force budget). */
	force?: boolean;
	/** Store the result as disposable (tunnel hosts are auto-classified). */
	ephemeral?: boolean;
	/**
	 * ora-issued scan API key (contract 1.10.0): exempts the caller from every
	 * scan-family rate limit. Falls back to $ORA_SCAN_API_KEY. Safe to send
	 * blind — the server degrades an unrecognized key to keyless, never a 401.
	 */
	apiKey?: string;
}

/** Bearer header for the scan API key, or nothing when the caller is keyless. */
function authHeaders(apiKey: string | undefined): Record<string, string> {
	return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Audit `target` and resolve with ora's raw audit payload. When the stream
 * ends with analysis still marked partial, keeps polling
 * GET /api/score/{domain}?format=audit until it settles (complete or stuck)
 * or the poll budget runs out.
 */
export async function performAudit(
	target: string,
	options: AuditOptions = {},
): Promise<AuditOutcome> {
	const base = (options.baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE).replace(/\/+$/, "");
	// Resolve the key once so the stream request and the deep-analysis poll
	// agree — the poll target is rate limited too, and a keyed scan whose polls
	// went keyless would throttle exactly the high-volume callers keys exist for.
	options = { ...options, apiKey: options.apiKey || process.env.ORA_SCAN_API_KEY || undefined };
	options.progress?.(`Auditing ${target} with ora`);

	const streamed = await consumeScanStream(base, target, options);
	warnOnNewerContract(streamed.result.contractVersion);

	let result: AuditResult = streamed.result;
	if (stillAnalyzing(result)) result = await awaitDeepAnalysis(base, result, options);
	return { result, verdict: streamed.verdict };
}

function streamUrl(base: string, target: string, options: AuditOptions): string {
	const params = new URLSearchParams({ domain: target, format: "audit" });
	if (options.force) params.set("force", "1");
	if (options.ephemeral) params.set("ephemeral", "1");
	if (options.maxAgeSeconds !== undefined)
		params.set("maxAgeSeconds", String(options.maxAgeSeconds));
	return `${base}/api/scan/stream?${params}`;
}

// The stream is data-only SSE: `data: {json}` blocks separated by blank lines,
// no `event:` names. Every payload carries a `type` discriminator. Two of them
// matter beyond progress: `scan_complete` (the audit payload nested under
// `result`) and `summary_ready` (the one-line agentic verdict, generated after
// scoring - stopping at scan_complete would silently drop it).
async function consumeScanStream(
	base: string,
	target: string,
	options: AuditOptions,
): Promise<AuditOutcome & { result: AuditScanResult }> {
	const idleMs = options.idleMs ?? STREAM_IDLE_MS;
	const dog = watchdog(idleMs);
	const timeoutError = () =>
		new AuditApiError(`ora audit timed out — no progress for ${Math.round(idleMs / 1000)}s`);

	let res: Response;
	try {
		res = await fetch(streamUrl(base, target, options), {
			headers: { accept: "text/event-stream", ...authHeaders(options.apiKey) },
			signal: dog.signal,
		});
	} catch (cause) {
		dog.disarm();
		if (dog.tripped()) throw timeoutError();
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new AuditApiError(`ora audit request failed: ${detail}`);
	}

	if (res.status === 429) {
		dog.disarm();
		const wait = res.headers.get("retry-after");
		throw new AuditApiError(
			`ora rate limit exceeded${wait ? ` — retry after ${wait}s` : ""} (burst: 10 scans/min/IP; daily: 30 scans + 6 force per 24h). An ora-issued scan API key lifts these limits: set ORA_SCAN_API_KEY or pass --api-key.`,
		);
	}
	if (!res.ok || !res.body) {
		dog.disarm();
		const body = await errorBody(res);
		throw new AuditApiError(`ora audit failed: ${body.message}`, {
			code: body.code,
			payload: body.payload,
		});
	}

	const narrate = progressNarrator();
	const utf8 = new TextDecoder();
	let pending = "";
	let result: AuditScanResult | undefined;
	let verdict: string | undefined;

	try {
		streaming: for await (const chunk of res.body) {
			dog.poke();
			pending = `${pending}${utf8.decode(chunk as Uint8Array, { stream: true })}`.replace(
				/\r\n?/g,
				"\n",
			);
			let cut = pending.indexOf("\n\n");
			while (cut !== -1) {
				const packet = joinDataLines(pending.slice(0, cut));
				pending = pending.slice(cut + 2);
				cut = pending.indexOf("\n\n");
				if (!packet) continue;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(packet);
				} catch {
					continue;
				}
				const line = narrate(event);
				if (line) options.progress?.(line);
				if (event.type === "error") {
					// The server closes right after this frame; without surfacing it
					// the caller would only see "ended before completing". The frame
					// carries the code (MCP_AUTH_REQUIRED is not a failure) and is
					// itself what --json prints, so both ride along.
					throw new AuditApiError(
						`ora audit failed: ${typeof event.message === "string" ? event.message : "scan error"}`,
						{ code: typeof event.code === "string" ? event.code : null, payload: event },
					);
				}
				if (event.type === "scan_complete" && event.result) {
					result = event.result as AuditScanResult;
				} else if (event.type === "summary_ready" && typeof event.agenticSummary === "string") {
					verdict = event.agenticSummary;
				}
				// Bail as soon as both pieces are in hand; otherwise drain to the end
				// (the server closes shortly after, with or without a summary).
				if (result && verdict) break streaming;
			}
		}
	} catch (cause) {
		if (dog.tripped()) throw timeoutError();
		if (cause instanceof AuditApiError) throw cause;
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new AuditApiError(`ora audit stream error: ${detail}`);
	} finally {
		dog.disarm();
		res.body.cancel().catch(() => {});
	}

	if (!result) throw new AuditApiError("ora audit stream ended before completing");
	return { result, verdict };
}

// Concatenate the data: lines of one SSE block, dropping one optional leading
// space per line (the scan stream never sends event: lines).
function joinDataLines(block: string): string {
	const collected: string[] = [];
	for (const row of block.split("\n")) {
		if (row.startsWith("data:")) collected.push(row.slice(5).replace(/^ /, ""));
	}
	return collected.join("\n");
}

// Turns raw stream events into spinner copy. The determinate bar is driven by
// `check_complete` events against the roster announced in `scan_init`;
// `check_start` is useless for progress because ora emits every start up
// front. Completions can also overshoot the roster, hence the clamp.
function progressNarrator(): (event: Record<string, unknown>) => string | undefined {
	let expected = 0;
	let finished = 0;
	let checkName = "";

	return (event) => {
		switch (event.type) {
			case "kind_detecting":
				return "Detecting URL kind…";
			case "kind_detected":
				return typeof event.kind === "string" ? `Detected ${event.kind}, scanning…` : undefined;
			case "scan_init":
				if (Array.isArray(event.checkRoster)) expected = event.checkRoster.length;
				return undefined;
			case "discovery_phase":
				return typeof event.label === "string" ? event.label : undefined;
			case "check_complete": {
				finished += 1;
				if (typeof event.checkName === "string") checkName = event.checkName;
				if (expected <= 0) return `Running checks… (${finished})`;
				const capped = Math.min(finished, expected);
				const cells = Math.min(BAR_CELLS, Math.max(0, Math.round((capped / expected) * BAR_CELLS)));
				const bar = `${"█".repeat(cells)}${"░".repeat(BAR_CELLS - cells)}`;
				return `${bar} ${capped}/${expected}${checkName ? ` · ${checkName}` : ""}`;
			}
			case "scan_complete":
				return "Finishing up…";
			default:
				return undefined;
		}
	};
}

function stillAnalyzing(result: AuditResult): boolean {
	if (result.analysisStatus === "complete" || result.analysisStatus === "stuck") return false;
	if (result.analysisStatus === "partial") return true;
	return (result.pendingChecks?.length ?? 0) > 0;
}

async function awaitDeepAnalysis(
	base: string,
	first: AuditResult,
	options: AuditOptions,
): Promise<AuditResult> {
	const scoreUrl = `${base}/api/score/${encodeURIComponent(first.domain)}?format=audit`;
	const every = options.pollEveryMs ?? POLL_EVERY_MS;
	const limit = options.pollLimit ?? POLL_LIMIT;
	let latest = first;

	for (let round = 0; round < limit && stillAnalyzing(latest); round++) {
		const left = latest.pendingChecks?.length ?? 0;
		options.progress?.(
			left ? `Analyzing… ${left} check${left === 1 ? "" : "s"} pending` : "Analyzing…",
		);
		await pause(every);
		try {
			const res = await fetch(scoreUrl, {
				headers: { accept: "application/json", ...authHeaders(options.apiKey) },
				signal: AbortSignal.timeout(15_000),
			});
			if (res.ok) latest = (await res.json()) as AuditScoreResult;
		} catch {
			// transient hiccup — keep polling until the round budget is spent
		}
	}
	return latest;
}
