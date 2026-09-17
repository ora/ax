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

/** Best-effort human message from an error response body. */
export async function errorBodyText(res: Response): Promise<string> {
	return (await errorBody(res)).message;
}

export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
