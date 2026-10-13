/**
 * The ingest hop: POST a locally-taken capture to ora, stream the scored audit
 * back.
 *
 * `POST /api/webmcp/audit/ingest` with `{ url, capture }`. The response is
 * data-only SSE - the same idiom as the scan stream, `data: {json}` blocks with
 * no `event:` names - and every frame is a `WebmcpAuditEvent`. Exactly one
 * terminal frame arrives: `done` carrying the audit, or `error`.
 *
 * Nothing is persisted server-side. A local audit is scored and returned and
 * then forgotten: it never reaches the leaderboard, the badge, or the corpus
 * the `webmcp` scanner check reads. Report copy must not imply otherwise.
 *
 * This module does no interpretation. Grade, findings, category scores and the
 * simulation all arrive decided (design decision #1); everything here is
 * transport, error mapping, and the local pre-flight that catches a capture the
 * server would reject anyway.
 */

import { errorBodyText, watchdog } from "../api/shared";
import { WEBMCP_SHIM_VERSION } from "./vendor/checks";
import type { PublicWebmcpAudit } from "./vendor/projection";
import type { WebmcpAuditEvent, WebmcpCaptureResult } from "./vendor/types";

const PUBLIC_BASE = "https://ora.ai";
/** Scoring runs two model hops and a simulation behind this stream; the idle
 * watchdog has to outlast the quiet stretch while they run. */
const STREAM_IDLE_MS = 120_000;

/**
 * An ingest that did not produce an audit.
 *
 * `code` is the server's machine-readable reason where it gave one, so the
 * command can branch without matching on prose. `SHIM_VERSION_MISMATCH` is the
 * one the CLI must not render as a generic API failure: it means this build's
 * capture measures something the server no longer scores, and the fix is to
 * upgrade the CLI, not to retry.
 */
export class WebmcpIngestError extends Error {
	readonly code: string | null;
	/** Milliseconds to wait, from a 429. */
	readonly retryAfterMs: number | null;

	constructor(
		message: string,
		options: { code?: string | null; retryAfterMs?: number | null } = {},
	) {
		super(message);
		this.name = "WebmcpIngestError";
		this.code = options.code ?? null;
		this.retryAfterMs = options.retryAfterMs ?? null;
	}
}

export interface IngestOptions {
	/** Base URL override; otherwise $ORA_API_URL, otherwise https://ora.ai. */
	baseUrl?: string;
	/** An ora API key exempts the caller from the anonymous rate limits. An
	 * unrecognised token degrades to keyless rather than 401, so passing one
	 * through is harmless. */
	apiKey?: string;
	/** Progress sink for the events that arrive before the terminal frame. */
	onEvent?: (event: WebmcpAuditEvent) => void;
	idleMs?: number;
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/** Caps the ingest endpoint enforces. Mirrored here so a developer sees the
 * problem before spending a round trip on it, never to decide anything the
 * server does not already decide the same way. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_TOOLS_PER_PAGE = 100;
const MAX_SERIALIZED_CHARS = 32_768;
const MAX_DESCRIPTION_CHARS = 4096;
const MAX_NAME_CHARS = 512;

/**
 * What the server would reject this capture for, or null.
 *
 * Two behaviours are deliberately mirrored from the server rather than
 * improved on:
 *
 *  - ONE malformed tool rejects the WHOLE capture. Dropping the tool instead
 *    would score the page as one that never registered it, which is a worse
 *    answer than refusing to score at all.
 *  - An oversized screenshot is NOT an error. The server drops it and reports
 *    `page-experience` as `unmeasured`; so does this, silently, because the
 *    audit is still worth running.
 */
export function preflightCapture(capture: WebmcpCaptureResult): string | null {
	if (capture.shimVersion !== WEBMCP_SHIM_VERSION) {
		return `this build captures with shim version ${capture.shimVersion}, which is not the version it was built against (${WEBMCP_SHIM_VERSION})`;
	}
	if (capture.pages.length > MAX_PAGES) {
		return `capture covers ${capture.pages.length} pages; the limit is ${MAX_PAGES}`;
	}
	for (const page of capture.pages) {
		if (page.tools.length > MAX_TOOLS_PER_PAGE) {
			return `${page.url} registered ${page.tools.length} tools; the limit is ${MAX_TOOLS_PER_PAGE} per page`;
		}
		for (const tool of page.tools) {
			if (tool.name.length > MAX_NAME_CHARS) {
				return `tool name on ${page.url} is ${tool.name.length} characters; the limit is ${MAX_NAME_CHARS}`;
			}
			if (tool.description.length > MAX_DESCRIPTION_CHARS) {
				return `description for "${tool.name}" is ${tool.description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}`;
			}
			for (const [label, value] of [
				["inputSchema", tool.inputSchema],
				["annotations", tool.annotations],
			] as const) {
				// Bounded by size, never by vocabulary: `$ref`, `$defs` and `oneOf`
				// all travel through untouched, because a schema the server can
				// read is the point and stripping keywords would change what it
				// scores.
				const serialized = safeStringify(value);
				if (serialized === null) {
					return `${label} for "${tool.name}" could not be serialized (a cycle, or a value JSON cannot carry)`;
				}
				if (serialized.length > MAX_SERIALIZED_CHARS) {
					return `${label} for "${tool.name}" serializes to ${serialized.length} characters; the limit is ${MAX_SERIALIZED_CHARS}`;
				}
			}
		}
	}
	return null;
}

/**
 * The capture as it will go on the wire, with a screenshot the server would
 * drop removed here instead.
 *
 * Dropping it locally is what lets the CLI say so: the server drops it in
 * silence and the only visible trace is `page-experience` coming back
 * `unmeasured`, which reads like a server problem rather than a capture that
 * was too big to send.
 */
export function prepareForIngest(capture: WebmcpCaptureResult): {
	capture: WebmcpCaptureResult;
	droppedScreenshot: boolean;
} {
	const screenshot = capture.screenshot;
	if (!screenshot) return { capture, droppedScreenshot: false };
	const tooBig = screenshot.data.length > 2 * 1024 * 1024;
	const wrongType = screenshot.mimeType !== "image/jpeg";
	if (!tooBig && !wrongType) return { capture, droppedScreenshot: false };
	return { capture: { ...capture, screenshot: null }, droppedScreenshot: true };
}

function safeStringify(value: unknown): string | null {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// The hop
// ---------------------------------------------------------------------------

/**
 * Send `capture` and resolve with the audit the server scored from it.
 *
 * Rejects with `WebmcpIngestError` on every failure path, including a stream
 * that ends without a terminal frame - a truncated stream is not a passing
 * audit, and treating it as one would report a grade nobody computed.
 */
export async function ingestCapture(
	url: string,
	capture: WebmcpCaptureResult,
	options: IngestOptions = {},
): Promise<PublicWebmcpAudit> {
	const base = (options.baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE).replace(/\/+$/, "");
	const idleMs = options.idleMs ?? STREAM_IDLE_MS;
	const dog = watchdog(idleMs);
	const timeoutError = () =>
		new WebmcpIngestError(`ora scoring timed out — no progress for ${Math.round(idleMs / 1000)}s`);

	const body = JSON.stringify({ url, capture });
	// Checked before sending: a 4 MB POST that comes back 413 costs the upload,
	// and the byte length is the same number the server measures.
	if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
		dog.disarm();
		throw new WebmcpIngestError(
			`this capture serializes to ${Math.round(Buffer.byteLength(body, "utf8") / 1024)} KB; the ingest limit is ${MAX_BODY_BYTES / 1024 / 1024} MB`,
			{ code: "BODY_TOO_LARGE" },
		);
	}

	let res: Response;
	try {
		res = await fetch(`${base}/api/webmcp/audit/ingest`, {
			method: "POST",
			headers: {
				accept: "text/event-stream",
				"content-type": "application/json",
				...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
			},
			body,
			signal: dog.signal,
		});
	} catch (cause) {
		dog.disarm();
		if (dog.tripped()) throw timeoutError();
		throw new WebmcpIngestError(
			`ora ingest request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}

	if (!res.ok || !res.body) {
		dog.disarm();
		throw await httpError(res);
	}

	return consumeIngestStream(res, dog, options, timeoutError);
}

/** Turn a non-2xx response into the error the command branches on. */
async function httpError(res: Response): Promise<WebmcpIngestError> {
	const payload = (await res
		.clone()
		.json()
		.catch(() => null)) as { error?: string; code?: string; retry_after_ms?: number } | null;
	const code = payload?.code ?? null;

	if (res.status === 429) {
		const headerSeconds = Number(res.headers.get("retry-after"));
		const retryAfterMs =
			payload?.retry_after_ms ??
			(Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds * 1000 : null);
		const wait = retryAfterMs ? ` — retry in ${Math.ceil(retryAfterMs / 1000)}s` : "";
		return new WebmcpIngestError(
			`ora rate limit exceeded${wait} (10/min and 20 per 24h per IP). An ora partner or scan API key lifts the daily limit: set ORA_PARTNER_API_KEY or pass --api-key.`,
			{ code: code ?? "RATE_LIMITED", retryAfterMs },
		);
	}

	if (code === "SHIM_VERSION_MISMATCH") {
		return new WebmcpIngestError(
			`This ax build captures with a shim ora no longer scores, so the audit was refused.\nUpgrade with \`npm i -g ax@latest\` (or \`npx ax@latest webmcp-audit …\`) and run it again.\n\nora said: ${payload?.error ?? "shim version mismatch"}`,
			{ code },
		);
	}

	if (res.status === 503) {
		return new WebmcpIngestError(
			`ora cannot score right now: ${sentence(payload?.error ?? "scoring is unavailable")} Nothing was spent against your rate limit; try again shortly.`,
			{ code: code ?? "SCORING_UNAVAILABLE" },
		);
	}

	return new WebmcpIngestError(
		`ora ingest failed: ${payload?.error ?? (await errorBodyText(res))}`,
		{ code },
	);
}

async function consumeIngestStream(
	res: Response,
	dog: ReturnType<typeof watchdog>,
	options: IngestOptions,
	timeoutError: () => WebmcpIngestError,
): Promise<PublicWebmcpAudit> {
	const utf8 = new TextDecoder();
	let pending = "";
	let audit: PublicWebmcpAudit | undefined;

	try {
		streaming: for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
			dog.poke();
			pending = `${pending}${utf8.decode(chunk, { stream: true })}`.replace(/\r\n?/g, "\n");
			let cut = pending.indexOf("\n\n");
			while (cut !== -1) {
				const packet = joinDataLines(pending.slice(0, cut));
				pending = pending.slice(cut + 2);
				cut = pending.indexOf("\n\n");
				if (!packet) continue;

				let event: WebmcpAuditEvent;
				try {
					event = JSON.parse(packet) as WebmcpAuditEvent;
				} catch {
					// A frame we cannot parse is a frame we cannot act on. The
					// terminal frame is what decides this call's outcome, so a
					// mangled progress line is not worth failing over.
					continue;
				}
				options.onEvent?.(event);

				if (event.type === "error") {
					// The server closes right after this frame; without surfacing it
					// the caller would only see "ended before completing".
					throw new WebmcpIngestError(`ora audit failed: ${event.message}`, {
						code: event.status,
					});
				}
				if (event.type === "done") {
					// The union types this as the stored record; the endpoint sends the
					// projection, which is a superset (contractVersion, availability, a
					// non-null evidenceCoverage). Narrowing here is what lets the report
					// read availability without re-deriving it.
					audit = event.audit as unknown as PublicWebmcpAudit;
					break streaming;
				}
			}
		}
	} catch (cause) {
		if (dog.tripped()) throw timeoutError();
		throw cause instanceof WebmcpIngestError
			? cause
			: new WebmcpIngestError(
					`ora ingest stream failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
	} finally {
		dog.disarm();
	}

	if (!audit) {
		throw new WebmcpIngestError("ora ingest stream ended before the audit completed");
	}
	return audit;
}

/** One sentence, ending in exactly one full stop. The server's `error` strings
 * sometimes end in one and sometimes do not, and both spellings get appended to
 * below. */
function sentence(text: string): string {
	const trimmed = text.trim();
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Data-only SSE: collect the `data:` lines of one block. */
function joinDataLines(block: string): string {
	const collected: string[] = [];
	for (const row of block.split("\n")) {
		if (row.startsWith("data:")) collected.push(row.slice(5).replace(/^ /, ""));
	}
	return collected.join("\n");
}
