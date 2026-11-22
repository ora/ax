import type { Identity } from "./identity";

// What ax sends ora's platform API as `Authorization: Bearer ...`, whichever way you gave it: a
// platform key (ORA_API_KEY), traded for a short-lived token as ax always has, or the browser
// sign-in `ax login` stored, whose access token the API takes directly. A command asks a
// credential for a bearer, for its name, for who it is and for how a refusal of it reads, and
// never which kind it is: what differs per kind lives on the credential itself
// (api-key-credential.ts, sign-in-credential.ts). Which one a command gets is decided once, by the
// chain in resolve-credential.ts.

/** Which kind of credential it is, for `--json` output only. */
export type CredentialKind = "api_key" | "sign_in";

/** What to tell a person whose credential ora refused, in words for that credential. */
export interface RefusalWords {
	/** ora no longer accepts it (a 401): what that means, and what to do. */
	readonly unauthorized: string;
	/** ora refused it a call that needs `scopes` (a 403): what that means, and what to do. */
	forbidden(scopes: string): string;
}

export interface PlatformCredential {
	/** Which kind it is, for `--json` output only: code asks the credential, never this. */
	readonly kind: CredentialKind;
	/** How a person set it up, e.g. `ax login (browser sign-in)`. */
	readonly label: string;
	readonly refusal: RefusalWords;
	/** The bearer for the next call. */
	bearer(): Promise<string>;
	/** A new bearer after the API answered 401: a key traded again, a sign-in renewed. */
	renew(): Promise<string>;
	/** Who it is, asked of the platform (GET /auth/identity, which hands out no token). */
	readIdentity(): Promise<Identity>;
	/**
	 * The error to raise when ora no longer accepts it (a 401 that survived a renewal, a tunnel
	 * closed for it): `context` says where, and the refusal words say what to do.
	 */
	rejected(context: string, cause?: unknown): Error;
}
