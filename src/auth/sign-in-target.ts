// Where `ax login` signs in, and what it asks for. ax is one of ora's own CLIs: a first-party
// client of ora's sign-in server, with its own name ("ax" on the approval page and in Connected
// apps) and its own ceiling, the scopes below. The server offers ax those and nothing else.

/** ax's client id on ora's sign-in server: a public client, no secret (it runs on your machine). */
export const AX_CLIENT_ID = "ax-cli";

/**
 * Everything ax's commands use, and so all a sign-in asks for: a journey is a run (create it,
 * follow its stream, read its totals); `--tunnel ora` is a tunnel (create it, hold its
 * connection, delete it).
 */
export const AX_SCOPES = [
	"runs:read",
	"runs:write",
	"tunnels:read",
	"tunnels:write",
	"tunnels:connect",
] as const;

/** `openid` names who signed in; `offline_access` brings the refresh token a sign-in lasts by. */
export const SIGN_IN_SCOPE = ["openid", "offline_access", ...AX_SCOPES].join(" ");

export interface SignInTarget {
	/** ora's sign-in server, `https://account.<domain>`: its issuer. */
	issuer: string;
	/** The platform API's origin: every access token's audience (RFC 8707). */
	resource: string;
	clientId: string;
}

/** `https://API.ora.ai/` -> `https://api.ora.ai`: the origin, as a token names its audience. */
export function platformResource(base: string): string {
	const url = new URL(base);
	return `${url.protocol}//${url.host.toLowerCase()}`;
}

/**
 * The sign-in server for a platform address: `api.<domain>` -> `account.<domain>`, scheme and
 * port kept (`https://api.ora.ai` -> `https://account.ora.ai`; a dev cluster's
 * `http://api.ora.localhost:8081` -> `http://account.ora.localhost:8081`). Null when the host is
 * not `api.<...>`: ax does not guess anywhere else to send a person to sign in.
 */
export function signInTarget(base: string): SignInTarget | null {
	const url = new URL(base);
	if (!/^api\./i.test(url.hostname)) return null;
	const host = url.host.toLowerCase().replace(/^api\./, "account.");
	return {
		issuer: `${url.protocol}//${host}`,
		resource: platformResource(base),
		clientId: AX_CLIENT_ID,
	};
}
