import pc from "picocolors";
import { platformBase } from "../api/platform-origins";
import type { PlatformCredential } from "../auth/credential";
import { type Identity, identityLines } from "../auth/identity";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import { servedBody } from "../report/error-chain";
import { type CommandError, reportError } from "../report/json-error";
import { credentialFailure } from "./credential-failure";
import { EXIT } from "./exit-codes";

// `ax whoami`: who ax calls ora's platform as, asked of the platform now (GET /auth/identity, for
// a sign-in and a key alike; a sign-in renews first when it needs to). Exit codes: 0; 2 no
// credential, or an address ax will not send one to; 3 the platform refused it or did not answer.

export interface WhoamiDeps {
	/** Which credential ax would call the platform with. */
	credentials: PlatformCredentials;
}

const RETRY = "ax whoami";

export async function whoamiCommand(
	input: { json: boolean },
	deps: WhoamiDeps = { credentials: platformCredentials() },
): Promise<number> {
	const base = platformBase();
	let credential: PlatformCredential;
	let identity: Identity;
	try {
		credential = deps.credentials.chain.resolve(base);
		identity = await credential.readIdentity();
	} catch (cause) {
		const failure = credentialFailure(cause, { retry: RETRY });
		const message = cause instanceof Error ? cause.message : String(cause);
		const error: CommandError = failure ?? {
			code: "PLATFORM_ERROR",
			message,
			next: { call: RETRY, why: "retry" },
		};
		return fail(error, input, failure && !failure.refusedByOra ? EXIT.USAGE : EXIT.API, cause);
	}
	if (input.json) {
		process.stdout.write(
			`${JSON.stringify({ credential: credential.kind, platform: base, identity }, null, 2)}\n`,
		);
	} else {
		console.log(identityLines(identity, credential.label, base).join("\n"));
	}
	return EXIT.OK;
}

function fail(error: CommandError, input: { json: boolean }, exit: number, cause: unknown): number {
	reportError(error, {
		json: input.json,
		display: (message) => pc.red(message),
		served: servedBody(cause),
	});
	return exit;
}
