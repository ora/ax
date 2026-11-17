// An error and the errors it wraps (`cause`), outermost first. A wrapper adds context and keeps
// the original as its cause, so what a failure IS is read through every wrapper, wherever it
// surfaced.

export function* errorChain(error: unknown): Generator<Error> {
	const seen = new Set<unknown>();
	let current = error;
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		yield current;
		current = current.cause;
	}
}

/**
 * The error body a server answered with, when an error in the chain carries one (a `payload`, as
 * PlatformApiError, TunnelError and AuditApiError do): what `--json` prints instead of the
 * envelope. Undefined when none does.
 */
export function servedBody(error: unknown): unknown {
	for (const each of errorChain(error)) {
		const payload: unknown = "payload" in each ? each.payload : undefined;
		if (payload !== undefined && payload !== null) return payload;
	}
	return undefined;
}
