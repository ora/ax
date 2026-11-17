import { revokeToken } from "./oauth";
import type { StoredSignIn } from "./session-store";

/**
 * Ends a stored sign-in on ora's sign-in server (RFC 7009), best effort: true when ora took it,
 * false when it names no revocation address or could not be reached. Never throws. `ax logout`
 * calls it, and so does `ax login` for the sign-in a new one replaces on this machine.
 */
export function endSignIn(session: StoredSignIn, fetchFn: typeof fetch = fetch): Promise<boolean> {
	if (!session.revocationEndpoint) return Promise.resolve(false);
	return revokeToken(session.revocationEndpoint, session.clientId, session.refreshToken, fetchFn);
}
