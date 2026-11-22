import { type PlatformFeature, scopeList } from "./platform-features";

// The ways a platform credential fails before or while it is used, each the error that says so.
// commands/credential-failure.ts reads them the same way for every command.

/** No credential for this platform: neither ORA_API_KEY nor a sign-in for it. */
export class NotSignedInError extends Error {
	constructor(input: {
		/** The platform ax was about to call. */
		base: string;
		/** What the call needs a key to carry, when it needs anything. */
		feature?: PlatformFeature;
		/** The platform the sign-in stored here is for, when it is another one. */
		signedInFor?: string;
	}) {
		const key = input.feature
			? `a platform key (ora_sk_...) with the ${scopeList(input.feature)} scopes`
			: "a platform key (ora_sk_...)";
		const elsewhere = input.signedInFor
			? ` Your ax sign-in is for ${input.signedInFor}, not ${input.base}.`
			: "";
		super(
			`Not signed in to ora's platform. Run ax login to sign in through your browser, or set ORA_API_KEY to ${key} in your environment or a local .env file (see .env.example).${elsewhere}`,
		);
		this.name = "NotSignedInError";
	}
}

/**
 * The sign-in no longer works: ora refused it (disconnected, signed out everywhere, removed from
 * the organization), or it was signed out on this machine. `ax login` is the way on.
 */
export class SignInEndedError extends Error {
	constructor(message: string, options: { cause?: unknown } = {}) {
		super(message, options);
		this.name = "SignInEndedError";
	}
}

/** ora rejected a platform key: fixing ORA_API_KEY is the way on, as its message says. */
export class KeyRejectedError extends Error {
	constructor(message: string, options: { cause?: unknown } = {}) {
		super(message, options);
		this.name = "KeyRejectedError";
	}
}
