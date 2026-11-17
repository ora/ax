import pc from "picocolors";
import { platformBase } from "../api/platform-origins";
import { endSignIn } from "../auth/end-sign-in";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import { EXIT } from "./exit-codes";

// `ax logout`: ends the sign-in `ax login` stored, on ora's sign-in server (RFC 7009) and on
// this machine. A platform key in ORA_API_KEY is the environment's, and is left alone.

export interface LogoutDeps {
	fetchFn: typeof fetch;
	/** The chain ax signs platform calls with, and the stored sign-in in it (removed here). */
	credentials: PlatformCredentials;
}

export async function logoutCommand(
	input: { json: boolean },
	deps: LogoutDeps = { fetchFn: fetch, credentials: platformCredentials() },
): Promise<number> {
	const store = deps.credentials.signIns.store;
	const session = store.read();
	if (!session) {
		if (input.json)
			process.stdout.write(`${JSON.stringify({ signedOut: false, reason: "not signed in" })}\n`);
		else console.log("Not signed in to ax on this machine.");
		return EXIT.OK;
	}
	const ended = await endSignIn(session, deps.fetchFn);
	store.clear();
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
	// The chain decides what ax signs with from now on; say so when something still does.
	const still = deps.credentials.chain.find(platformBase());
	if (still) console.error(pc.dim(`${still.label} is still set here, and ax keeps using it.`));
	return EXIT.OK;
}
