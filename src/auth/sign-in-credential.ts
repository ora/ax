import { PlatformApiError } from "../api/platform-error";
import type { PlatformCredential, RefusalWords } from "./credential";
import { endSignIn } from "./end-sign-in";
import { SignInEndedError } from "./errors";
import { fetchIdentity, type Identity } from "./identity";
import { OAuthError, refreshTokens } from "./oauth";
import type { SignInStore, StoredSignIn } from "./session-store";

// The browser sign-in `ax login` stored, as a platform credential. Its access token is sent as it
// is (the platform converts it on every request, so ending the sign-in stops the next one),
// renewed a minute before it expires, and renewed under the sign-in's lock: another ax may have
// renewed it first, and its renewal is then the one to use.

/** Renew this long before the access token expires, so it cannot lapse between "checked" and "used". */
const RENEW_BEFORE_MS = 60_000;

const ENDED =
	"Your ax sign-in no longer works (it was disconnected, or your access changed). Run ax login.";

const SIGNED_OUT_HERE = "You signed out of ax on this machine. Run ax login.";

const SIGN_IN_REFUSAL: RefusalWords = {
	unauthorized: "your sign-in no longer works. Run ax login.",
	forbidden: (scopes) =>
		`your sign-in lacks the ${scopes} scopes, which a viewer cannot grant. Ask for a developer role, or use a platform key.`,
};

export class SignInCredential implements PlatformCredential {
	readonly kind = "sign_in";
	readonly label = "ax login (browser sign-in)";
	readonly refusal = SIGN_IN_REFUSAL;

	constructor(
		/** The platform this credential calls, which the stored sign-in is for. */
		private readonly base: string,
		private readonly store: SignInStore,
		private session: StoredSignIn,
		private readonly fetchFn?: typeof fetch,
		private readonly now: () => number = Date.now,
	) {}

	async bearer(): Promise<string> {
		if (this.session.expiresAt - this.now() > RENEW_BEFORE_MS) return this.session.accessToken;
		return this.renew();
	}

	async renew(): Promise<string> {
		const spent = this.session.refreshToken;
		// A renewal no file ended up holding (see below), ended on ora once the lock is given back.
		let orphan: StoredSignIn | undefined;
		try {
			return await this.renewLocked(spent, (renewal) => {
				orphan = renewal;
			});
		} finally {
			if (orphan) await endSignIn(orphan, this.fetchFn);
		}
	}

	private renewLocked(spent: string, orphaned: (renewal: StoredSignIn) => void): Promise<string> {
		return this.store.withLock(async () => {
			const stored = this.store.read();
			if (!stored || stored.resource !== this.session.resource) {
				throw new SignInEndedError(SIGNED_OUT_HERE);
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
				// only fail the same way on every command. It is removed only while it is still the one
				// refused: a sign-in stored since (`ax login`) is another, and stays.
				if (err instanceof OAuthError && err.code === "invalid_grant") {
					if (this.store.read()?.refreshToken === stored.refreshToken) this.store.clear();
					throw new SignInEndedError(ENDED, { cause: err });
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
			// Stored only while the file still holds the sign-in renewed. Under the lock nothing else
			// changes it, but a holder that outlived the stale window (a machine that slept mid-request)
			// had its lock broken: a sign-in removed meanwhile (`ax logout`) stays removed, and one
			// stored since (`ax login`) is the one to use. The renewal is then ended on ora, so no
			// live sign-in is left that no file holds.
			const current = this.store.read();
			if (current?.refreshToken !== stored.refreshToken) {
				orphaned(next);
				if (!current || current.resource !== this.session.resource) {
					throw new SignInEndedError(SIGNED_OUT_HERE);
				}
				this.session = current;
				return current.accessToken;
			}
			this.store.write(next);
			this.session = next;
			return next.accessToken;
		});
	}

	/** Asked with the access token, and once more with a renewed one if ora refuses it (401). */
	async readIdentity(): Promise<Identity> {
		try {
			return await fetchIdentity(this.base, await this.bearer(), this.fetchFn);
		} catch (cause) {
			if (!isUnauthorized(cause)) throw cause;
		}
		try {
			return await fetchIdentity(this.base, await this.renew(), this.fetchFn);
		} catch (cause) {
			if (isUnauthorized(cause)) throw this.rejected("ora refused it (401)", cause);
			throw cause;
		}
	}

	rejected(context: string, cause?: unknown): Error {
		return new SignInEndedError(`${context}: ${this.refusal.unauthorized}`, { cause });
	}
}

function isUnauthorized(cause: unknown): boolean {
	return cause instanceof PlatformApiError && cause.status === 401;
}
