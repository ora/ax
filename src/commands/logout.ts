import pc from "picocolors";
import { revokeToken } from "../auth/oauth";
import { SessionStore } from "../auth/session-store";
import { EXIT } from "./audit";

// `ax logout`: ends the sign-in `ax login` stored, on ora's sign-in server (RFC 7009) and on
// this machine. A platform key in ORA_API_KEY is the environment's, and is left alone.

export interface LogoutDeps {
	fetchFn: typeof fetch;
	store: SessionStore;
}

export async function logoutCommand(
	input: { json: boolean },
	deps: LogoutDeps = { fetchFn: fetch, store: new SessionStore() },
): Promise<number> {
	const session = deps.store.read();
	if (!session) {
		if (input.json)
			process.stdout.write(`${JSON.stringify({ signedOut: false, reason: "not signed in" })}\n`);
		else console.log("Not signed in to ax on this machine.");
		return EXIT.OK;
	}
	const ended = session.revocationEndpoint
		? await revokeToken(
				session.revocationEndpoint,
				session.clientId,
				session.refreshToken,
				deps.fetchFn,
			)
		: false;
	deps.store.clear();
	if (input.json) {
		process.stdout.write(
			`${JSON.stringify({ signedOut: true, platform: session.resource, endedOnServer: ended })}\n`,
		);
	} else {
		console.log(`Signed out of ${session.resource}.`);
		if (!ended) {
			console.error(
				pc.yellow(
					"ora could not be reached to end the sign-in there: disconnect it in ora, Settings, Connected apps.",
				),
			);
		}
	}
	if (process.env.ORA_API_KEY)
		console.error(pc.dim("ORA_API_KEY is still set here, and ax keeps using it."));
	return EXIT.OK;
}
