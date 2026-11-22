import pc from "picocolors";
import { platformBase } from "../api/platform-origins";
import { endSignIn } from "../auth/end-sign-in";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import type { SignInStore, StoredSignIn } from "../auth/session-store";
import { reportError } from "../report/json-error";
import { EXIT } from "./exit-codes";

// `ax logout`: ends the sign-in `ax login` stored, on this machine and on ora's sign-in server
// (RFC 7009). The file goes first, under the sign-in's lock: a renewal another ax is making
// finishes before it, so the tokens ended on the server are the latest, and a revocation that
// hangs or is interrupted leaves nothing on disk. A file this ax cannot read (a newer ax wrote
// it, or it was cut short) is removed too. A platform key in ORA_API_KEY is the environment's,
// and is left alone.

export interface LogoutDeps {
	fetchFn: typeof fetch;
	/** The chain ax signs platform calls with, and the stored sign-in in it (removed here). */
	credentials: PlatformCredentials;
}

/** What `ax logout` found on this machine, and removed. */
type Found =
	| { kind: "nothing" }
	| { kind: "unreadable" }
	| { kind: "sign-in"; session: StoredSignIn };

const CONNECTED_APPS = "disconnect it in ora, Settings, Connected apps";

export async function logoutCommand(
	input: { json: boolean },
	deps: LogoutDeps = { fetchFn: fetch, credentials: platformCredentials() },
): Promise<number> {
	let found: Found;
	try {
		found = await takeOut(deps.credentials.signIns.store);
	} catch (cause) {
		const message = `ax could not remove the stored sign-in: ${cause instanceof Error ? cause.message : String(cause)}`;
		reportError(
			{ code: "SIGN_OUT_FAILED", message, next: { call: "ax logout", why: "try again" } },
			{ json: input.json, display: (line) => pc.red(line) },
		);
		return EXIT.API;
	}
	if (found.kind === "nothing") {
		if (input.json)
			process.stdout.write(`${JSON.stringify({ signedOut: false, reason: "not signed in" })}\n`);
		else console.log("Not signed in to ax on this machine.");
		return EXIT.OK;
	}
	if (found.kind === "unreadable") {
		if (input.json) {
			process.stdout.write(
				`${JSON.stringify({ signedOut: true, endedOnServer: false, unreadable: true })}\n`,
			);
		} else {
			console.log("Removed the stored sign-in, which this version of ax could not read.");
			console.error(pc.yellow(`If it was still in use, ${CONNECTED_APPS}.`));
		}
		return EXIT.OK;
	}
	const { session } = found;
	const ended = await endSignIn(session, deps.fetchFn);
	if (input.json) {
		process.stdout.write(
			`${JSON.stringify({ signedOut: true, platform: session.resource, endedOnServer: ended })}\n`,
		);
	} else {
		console.log(`Signed out of ${session.resource}.`);
		if (!ended) {
			console.error(
				pc.yellow(`ora could not be reached to end the sign-in there: ${CONNECTED_APPS}.`),
			);
		}
	}
	// The chain decides what ax signs with from now on; say so when something still does.
	const still = deps.credentials.chain.find(platformBase());
	if (still) console.error(pc.dim(`${still.label} is still set here, and ax keeps using it.`));
	return EXIT.OK;
}

/**
 * Reads and removes the stored sign-in in one step under its lock. With no file there, no lock
 * is taken: taking one would create ax's folder only to say there was nothing in it.
 */
async function takeOut(store: SignInStore): Promise<Found> {
	if (!store.present()) return { kind: "nothing" };
	return store.withLock(async (): Promise<Found> => {
		if (!store.present()) return { kind: "nothing" };
		const session = store.read();
		store.clear();
		return session ? { kind: "sign-in", session } : { kind: "unreadable" };
	});
}
