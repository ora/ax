import pc from "picocolors";
import { PlatformApiError, platformBase, resolvePlatformCredential } from "../api/platform";
import { NotSignedInError, type PlatformCredential, SignInEndedError } from "../auth/credential";
import { type Identity, identityLines, readIdentity, tokenClaims } from "../auth/identity";
import { SessionStore } from "../auth/session-store";
import { type CommandError, reportError } from "../report/json-error";
import { EXIT } from "./audit";

// `ax whoami`: who ax calls ora's platform as, asked of the platform now: a sign-in through
// GET /auth/identity (it renews first when it needs to), a platform key by trading it, as every
// command does. Exit codes: 0, 2 no credential, 3 the platform refused it or could not answer.

export interface WhoamiDeps {
	fetchFn: typeof fetch;
	store: SessionStore;
}

const HOW: Record<PlatformCredential["kind"], string> = {
	sign_in: "ax login (browser sign-in)",
	api_key: "ORA_API_KEY (a platform key)",
};

export async function whoamiCommand(
	input: { json: boolean },
	deps: WhoamiDeps = { fetchFn: fetch, store: new SessionStore() },
): Promise<number> {
	const base = platformBase();
	let credential: PlatformCredential;
	try {
		credential = resolvePlatformCredential({ base, store: deps.store, fetchFn: deps.fetchFn });
	} catch (cause) {
		if (!(cause instanceof NotSignedInError)) throw cause;
		return fail(
			{ code: "MISSING_API_KEY", message: cause.message, next: LOGIN_NEXT },
			input,
			EXIT.USAGE,
		);
	}
	let identity: Identity;
	try {
		identity = await identityOf(credential, base, deps.fetchFn);
	} catch (cause) {
		return fail(refused(cause, credential), input, EXIT.API, cause);
	}
	if (input.json) {
		process.stdout.write(
			`${JSON.stringify({ credential: credential.kind, platform: base, identity }, null, 2)}\n`,
		);
	} else {
		console.log(identityLines(identity, HOW[credential.kind], base).join("\n"));
	}
	return EXIT.OK;
}

const LOGIN_NEXT = { call: "ax login", why: "sign in through your browser, or set ORA_API_KEY" };

/** A sign-in asked of the platform (renewed once if it answers 401); a key by the token it trades for. */
async function identityOf(
	credential: PlatformCredential,
	base: string,
	fetchFn: typeof fetch,
): Promise<Identity> {
	if (credential.kind === "api_key") return tokenClaims(await credential.bearer());
	try {
		return await readIdentity(base, await credential.bearer(), fetchFn);
	} catch (cause) {
		if (!(cause instanceof PlatformApiError) || cause.status !== 401) throw cause;
		return readIdentity(base, await credential.renew(), fetchFn);
	}
}

function refused(cause: unknown, credential: PlatformCredential): CommandError {
	const message = cause instanceof Error ? cause.message : String(cause);
	if (cause instanceof SignInEndedError)
		return { code: "SIGN_IN_ENDED", message, next: LOGIN_NEXT };
	if (cause instanceof PlatformApiError && cause.status === 401) {
		return credential.kind === "sign_in"
			? {
					code: "SIGN_IN_ENDED",
					message: "ora no longer accepts your sign-in (401). Run ax login.",
					next: LOGIN_NEXT,
				}
			: {
					code: "PLATFORM_ERROR",
					message,
					next: { call: "ax whoami", why: "check ORA_API_KEY, then retry" },
				};
	}
	return { code: "PLATFORM_ERROR", message, next: { call: "ax whoami", why: "retry" } };
}

function fail(
	error: CommandError,
	input: { json: boolean },
	exit: number,
	cause?: unknown,
): number {
	reportError(error, {
		json: input.json,
		display: (message) => pc.red(message),
		served: cause instanceof PlatformApiError ? cause.payload : undefined,
	});
	return exit;
}
