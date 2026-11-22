// Words for a request that never got an answer. Node's fetch says only "fetch failed" and keeps
// what happened (an errno code such as ECONNREFUSED or ENOTFOUND, a certificate problem) in its
// `cause`, and a passed deadline reads "The operation was aborted due to timeout". A person needs
// the host, and that.

/** How deep the cause chain is searched for a code (fetch nests it one or two levels down). */
const MAX_DEPTH = 5;

/** The errno-style code Node attached somewhere in the error's cause chain, if any. */
function codeOf(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < MAX_DEPTH; depth += 1) {
		const code = (current as NodeJS.ErrnoException).code;
		if (typeof code === "string" && code !== "") return code;
		current = current.cause;
	}
	return undefined;
}

/** The host a URL names, or the text itself when it names none. */
export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Why a request to `url` got no answer, as a person reads it: `could not reach account.ora.ai
 * (ECONNREFUSED)`, or `account.ora.ai did not answer within 15 s` when its deadline passed.
 */
export function networkFailure(url: string, cause: unknown, deadlineMs: number): string {
	const host = hostOf(url);
	if (cause instanceof Error && cause.name === "TimeoutError") {
		return `${host} did not answer within ${Math.round(deadlineMs / 1000)} s`;
	}
	const detail = codeOf(cause) ?? (cause instanceof Error ? cause.message : String(cause));
	return `could not reach ${host} (${detail})`;
}

/** A request that got no answer, worded by {@link networkFailure}; the original is its `cause`. */
export class NetworkFailureError extends Error {
	constructor(url: string, cause: unknown, deadlineMs: number) {
		super(networkFailure(url, cause, deadlineMs), { cause });
		this.name = "NetworkFailureError";
	}
}

/**
 * `fetchFn(url, init)` and its body as text, within `deadlineMs`. A request that gets no answer,
 * or whose body never arrives, is a NetworkFailureError naming the host.
 */
export async function fetchText(
	url: string,
	init: RequestInit,
	deadlineMs: number,
	fetchFn: typeof fetch = fetch,
): Promise<{ res: Response; text: string }> {
	try {
		const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(deadlineMs) });
		return { res, text: await res.text() };
	} catch (cause) {
		throw new NetworkFailureError(url, cause, deadlineMs);
	}
}
