// The error every client of ora's platform API raises when the platform answered with an HTTP
// error, in a module of its own: the run client (./platform) and the credentials (../auth) both
// raise it, and neither imports the other for it.

/**
 * The platform answered with an HTTP error. `payload` is the error body
 * exactly as served when it was JSON (what `--json` prints), null otherwise.
 */
export class PlatformApiError extends Error {
	readonly status: number;
	readonly payload: unknown;

	constructor(message: string, options: { status: number; payload?: unknown; cause?: unknown }) {
		super(message, { cause: options.cause });
		this.name = "PlatformApiError";
		this.status = options.status;
		this.payload = options.payload;
	}
}

/** A response body parsed as JSON, or null when it is not JSON. */
export function jsonOrNull(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		if (err instanceof SyntaxError) return null;
		throw err;
	}
}
