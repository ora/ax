// Plumbing shared by both API clients. Note that the two ora streams do NOT
// share an SSE parser: the scan stream is data-only JSON with a `type` field,
// while the run stream uses named `event:` blocks with `: ping` heartbeats.
// Each client owns its own decoder; only the timeout/error plumbing lives here.

/**
 * Idle watchdog for a long-lived stream: aborts the fetch when `poke()` hasn't
 * been called for `ms`. Unlike a fixed deadline, a stream that keeps emitting
 * can run indefinitely — which is what a slow-but-healthy scan or agent needs.
 */
export function watchdog(ms: number): {
	signal: AbortSignal;
	poke: () => void;
	disarm: () => void;
	tripped: () => boolean;
} {
	const controller = new AbortController();
	let fired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poke = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			fired = true;
			controller.abort();
		}, ms);
	};
	poke();
	return {
		signal: controller.signal,
		poke,
		disarm: () => clearTimeout(timer),
		tripped: () => fired,
	};
}

/**
 * Best-effort reading of an error response body: the human message, the
 * server's machine-readable `code` where it gave one, and the parsed body
 * itself. A caller that only branches on prose loses the code, and ora uses it
 * to say things that are not failures (see MCP_AUTH_REQUIRED in ./audit).
 * The body is read through a clone so the caller can still consume the
 * original.
 */
export async function errorBody(
	res: Response,
): Promise<{ message: string; code: string | null; payload: unknown }> {
	type ErrorBody = { message?: string; error?: string; code?: string };
	let payload: ErrorBody | null = null;
	try {
		payload = (await res.clone().json()) as ErrorBody;
	} catch {
		// Not JSON, or the body is already spent - fall back to the status line.
	}
	// Only the clone was read, so the original is still holding the socket:
	// every caller throws on this path, so release it rather than wait for GC.
	res.body?.cancel().catch(() => {});
	return {
		message: payload?.message || payload?.error || `HTTP ${res.status}`,
		code: payload?.code ?? null,
		payload,
	};
}

/**
 * The key-wide 429 a partner key gets once it has used its monthly usage
 * limit (contract 1.37.0): `error: "usage_limit_reached"` with `kind`,
 * `period`, `used`, `limit` and `resets_at`. Its Retry-After counts to the
 * next 1st of the month, so it must not be read as the per-minute or daily
 * limits the other 429s describe. Returns the message to show, or null for
 * any other 429. Reads a clone, so the caller can still consume the body.
 */
export async function usageLimitMessage(res: Response): Promise<string | null> {
	type Denial = {
		error?: string;
		kind?: string;
		period?: string;
		used?: number;
		limit?: number;
		resets_at?: string;
	};
	let body: Denial | null = null;
	try {
		body = (await res.clone().json()) as Denial;
	} catch {
		// Not JSON: an ordinary rate limit, which carries no such body.
		return null;
	}
	if (body?.error !== "usage_limit_reached") return null;
	const used =
		body.used !== undefined && body.limit !== undefined ? ` (${body.used} of ${body.limit})` : "";
	const resets = body.resets_at ? ` It resets at ${body.resets_at}.` : "";
	const scope = body.kind ? `${body.kind} limit` : "usage limit";
	const period = body.period ? ` for the ${body.period}` : "";
	return `this API key has used its ${scope}${period}${used}.${resets} GET /api/usage shows the numbers; ask ora to raise the limit.`;
}

/** Best-effort human message from an error response body. */
export async function errorBodyText(res: Response): Promise<string> {
	return (await errorBody(res)).message;
}

export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
