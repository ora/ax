import { hostOf, networkFailure } from "../api/network-failure";

// How ax talks to ora's sign-in server: one request, its JSON answer, and the error for an answer
// that is not a success. oauth.ts builds the OAuth calls on top of it.

/**
 * Every request's deadline. The sign-in lock's stale window is derived from it
 * (session-store.ts), so a hung refresh can never have its lock broken while it is in flight.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The sign-in server refused, or did not answer as one. `code` is OAuth's own when it sent one. */
export class OAuthError extends Error {
	readonly code: string;
	readonly status: number;
	/**
	 * The server did not answer as an OAuth server does (no answer at all, a 5xx or 429, a page with
	 * no OAuth `error`): the same request may work in a moment. An OAuth error is never transient.
	 */
	readonly transient: boolean;

	constructor(
		code: string,
		message: string,
		status: number,
		options: { transient?: boolean; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "OAuthError";
		this.code = code;
		this.status = status;
		this.transient = options.transient ?? false;
	}
}

export type Fetch = typeof fetch;
export type Json = Record<string, unknown>;

/** What the sign-in server answered, and where it was asked. */
export interface Answer {
	status: number;
	body: Json;
	url: string;
}

export const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

/** An answer that says nothing about the request itself: the server is busy, down or limiting. */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

const inContext = (context: string | undefined, message: string): string =>
	context ? `${context}: ${message}` : message;

async function readJson(res: Response): Promise<Json> {
	const text = await res.text();
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" ? (value as Json) : {};
	} catch {
		return {};
	}
}

/**
 * One request to the sign-in server, and its JSON answer. A redirect is refused, never followed:
 * fetch re-sends a POST body to wherever a 307 or 308 points, and the body holds a device code or
 * a refresh token, which go to the address the server named and nowhere else. No answer at all
 * (a refused connection, the deadline) is a transient OAuthError that names the host. `context`,
 * when given, opens every message (`the sign-in could not be renewed: ...`).
 */
export async function send(
	url: string,
	init: RequestInit,
	fetchFn: Fetch,
	context?: string,
): Promise<Answer> {
	let res: Response;
	let body: Json;
	try {
		res = await fetchFn(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		body = await readJson(res);
	} catch (cause) {
		const message = inContext(context, networkFailure(url, cause, REQUEST_TIMEOUT_MS));
		throw new OAuthError("unreachable", message, 0, { transient: true, cause });
	}
	if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
		const message = `${hostOf(url)} answered with a redirect (HTTP ${res.status}), and ax does not follow one with a sign-in`;
		throw new OAuthError("redirected", inContext(context, message), res.status);
	}
	return { status: res.status, body, url };
}

/** A form POST (every OAuth call but discovery), through {@link send}. */
export function postForm(
	url: string,
	form: Record<string, string>,
	fetchFn: Fetch,
	context?: string,
): Promise<Answer> {
	const init: RequestInit = {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams(form).toString(),
	};
	return send(url, init, fetchFn, context);
}

/**
 * The error for an answer that is not a success. An OAuth error (`error` in the body) is the
 * server's word on the request and ends it; anything else (a 5xx or 429, a proxy's page) is
 * transient: the same request may work in a moment. A transient answer is never read as an OAuth
 * error, whatever its body says, so its code is always `unavailable`: a 503 whose body names
 * `invalid_grant` must not end a sign-in.
 */
export function refusal(answer: Answer, context?: string): OAuthError {
	const { status, body, url } = answer;
	const code = str(body.error);
	if (code && !isTransientStatus(status)) {
		const message = str(body.error_description) ?? `${code} (HTTP ${status})`;
		return new OAuthError(code, inContext(context, message), status);
	}
	const message = inContext(context, `${hostOf(url)} answered HTTP ${status}`);
	return new OAuthError("unavailable", message, status, { transient: true });
}
