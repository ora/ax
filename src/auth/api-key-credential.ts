import { fetchText } from "../api/network-failure";
import { jsonOrNull, PlatformApiError } from "../api/platform-error";
import { assertPlatformDestination } from "../api/platform-origins";
import type { PlatformCredential, RefusalWords } from "./credential";
import { KeyRejectedError } from "./errors";
import { fetchIdentity, type Identity } from "./identity";

// A platform key (ORA_API_KEY, `ora_sk_...`). It goes in the Authorization HEADER (never a body
// or a URL), only to a platform address the key's destination rule allows, and is traded at
// POST /auth/token for a ~15-minute bearer that every other call uses.

const KEY_EXCHANGE_TIMEOUT_MS = 30_000;

const KEY_REFUSAL: RefusalWords = {
	unauthorized: "the platform key was rejected. Check ORA_API_KEY.",
	forbidden: (scopes) =>
		`the platform key lacks the ${scopes} scopes. Issue one with them and retry.`,
};

/** ora no longer accepts the key: the words say to check ORA_API_KEY. */
function rejectedKey(context: string, cause?: unknown): KeyRejectedError {
	return new KeyRejectedError(`${context}: ${KEY_REFUSAL.unauthorized}`, { cause });
}

/** A platform key, traded once per command for a ~15-minute token, and again after a 401. */
export class ApiKeyCredential implements PlatformCredential {
	readonly kind = "api_key";
	readonly label = "ORA_API_KEY (a platform key)";
	readonly refusal = KEY_REFUSAL;
	private token: Promise<string> | undefined;

	constructor(
		private readonly base: string,
		private readonly secret: string,
		private readonly fetchFn?: typeof fetch,
	) {}

	bearer(): Promise<string> {
		this.token ??= exchangeKey(this.base, this.secret, this.fetchFn);
		return this.token;
	}

	renew(): Promise<string> {
		this.token = exchangeKey(this.base, this.secret, this.fetchFn);
		return this.token;
	}

	/** The key itself is the bearer here, held to the same destination rule as the trade. */
	async readIdentity(): Promise<Identity> {
		assertPlatformDestination(this.base);
		try {
			return await fetchIdentity(this.base, this.secret, this.fetchFn);
		} catch (cause) {
			if (cause instanceof PlatformApiError && cause.status === 401) {
				throw rejectedKey("ora refused the key (401)", cause);
			}
			throw cause;
		}
	}

	rejected(context: string, cause?: unknown): Error {
		return rejectedKey(context, cause);
	}
}

/** Trades the key for a short-lived bearer (POST /auth/token), sending it nowhere it may not go. */
export async function exchangeKey(
	base: string,
	secret: string,
	fetchFn: typeof fetch = fetch,
): Promise<string> {
	assertPlatformDestination(base);
	const { res, text } = await fetchText(
		`${base}/auth/token`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
			body: "{}",
		},
		KEY_EXCHANGE_TIMEOUT_MS,
		fetchFn,
	);
	const body = jsonOrNull(text);
	if (res.status === 401) {
		const context = "ora refused the key (401)";
		throw rejectedKey(context, new PlatformApiError(context, { status: 401, payload: body }));
	}
	const payload = (body ?? {}) as { token?: string; error?: string };
	const failed = `ora auth failed (${res.status})${payload.error ? `: ${payload.error}` : ""}`;
	if (!res.ok) throw new PlatformApiError(failed, { status: res.status, payload: body });
	if (!payload.token) throw new Error(failed);
	return payload.token;
}
