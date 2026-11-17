import { OAuthError, refreshTokens } from "./oauth";
import type { SessionStore, StoredSignIn } from "./session-store";
import { platformResource } from "./sign-in-target";

// What ax sends ora's platform API as `Authorization: Bearer ...`, whichever way you gave it:
// a platform key (ORA_API_KEY), traded for a short-lived token as ax always has, or the browser
// sign-in `ax login` stored, whose access token the API takes directly. The commands that call
// the platform (a journey with a goal, `audit --tunnel ora`) ask a credential for a bearer and
// never which kind it is.

export interface PlatformCredential {
	readonly kind: "api_key" | "sign_in";
	/** The bearer for the next call. */
	bearer(): Promise<string>;
	/** A new bearer after the API answered 401: a key traded again, a sign-in renewed. */
	renew(): Promise<string>;
}

/** No credential at all for this platform: neither ORA_API_KEY nor a sign-in for it. */
export class NotSignedInError extends Error {
	/** The platform a sign-in stored here is for, when there is one for another platform. */
	readonly signedInFor?: string;

	constructor(message: string, signedInFor?: string) {
		super(message);
		this.name = "NotSignedInError";
		this.signedInFor = signedInFor;
	}
}

/** The stored sign-in no longer works (disconnected, signed out everywhere, removed); it was removed here. */
export class SignInEndedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SignInEndedError";
	}
}

/** Renew this long before the access token expires, so it cannot lapse between "checked" and "used". */
const RENEW_BEFORE_MS = 60_000;

const ENDED =
	"Your ax sign-in no longer works (it was disconnected, or your access changed). Run ax login.";

/** The sign-in `ax login` stored, if it is for this platform: its tokens go to no other host. */
export function signInFor(base: string, store: SessionStore): StoredSignIn | null {
	const session = store.read();
	return session && session.resource === platformResource(base) ? session : null;
}

/**
 * A browser sign-in. Its access token is sent as it is (the platform converts it on every
 * request, so ending the sign-in stops the next one), renewed a minute before it expires, and
 * renewed under the sign-in's lock: another ax may have renewed it first, and its renewal is
 * then the one to use.
 */
export class SignInCredential implements PlatformCredential {
	readonly kind = "sign_in";

	constructor(
		private readonly store: SessionStore,
		private session: StoredSignIn,
		private readonly fetchFn: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	async bearer(): Promise<string> {
		if (this.session.expiresAt - this.now() > RENEW_BEFORE_MS) return this.session.accessToken;
		return this.renew();
	}

	renew(): Promise<string> {
		const spent = this.session.refreshToken;
		return this.store.withLock(async () => {
			const stored = this.store.read();
			if (!stored || stored.resource !== this.session.resource) {
				throw new SignInEndedError("You signed out of ax on this machine. Run ax login.");
			}
			if (stored.refreshToken !== spent && stored.expiresAt - this.now() > RENEW_BEFORE_MS) {
				this.session = stored;
				return stored.accessToken;
			}
			let tokens: Awaited<ReturnType<typeof refreshTokens>>;
			try {
				tokens = await refreshTokens(
					stored.tokenEndpoint,
					stored,
					stored.refreshToken,
					this.fetchFn,
				);
			} catch (err) {
				// The server refuses the refresh token itself: the sign-in is over, and keeping it would
				// only fail the same way on every command.
				if (err instanceof OAuthError && err.code === "invalid_grant") {
					this.store.clear();
					throw new SignInEndedError(ENDED);
				}
				throw err;
			}
			const next: StoredSignIn = {
				...stored,
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken ?? stored.refreshToken,
				expiresAt: this.now() + tokens.expiresIn * 1000,
				scope: tokens.scope || stored.scope,
			};
			this.store.write(next);
			this.session = next;
			return next.accessToken;
		});
	}
}
