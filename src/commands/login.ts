import pc from "picocolors";
import {
	oraPlatformOrigin,
	PLATFORM_BASE,
	platformBase,
	platformDestinationProblem,
} from "../api/platform-origins";
import { openBrowser } from "../auth/browser";
import { endSignIn } from "../auth/end-sign-in";
import { fetchIdentity, identityLines } from "../auth/identity";
import {
	type DeviceAuthorization,
	discover,
	OAuthError,
	pollDeviceToken,
	type ServerMetadata,
	startDeviceAuthorization,
	type TokenSet,
} from "../auth/oauth";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import type { StoredSignIn } from "../auth/session-store";
import { SIGN_IN_SCOPE, type SignInTarget, signInTarget } from "../auth/sign-in-target";
import { type CommandError, reportError } from "../report/json-error";
import { EXIT } from "./exit-codes";

// `ax login`: a browser sign-in for ora's platform, the same as the ora CLI's (the device flow,
// RFC 8628). ax prints a link and a code, opens your browser when it can, and waits while you
// sign in (or up), confirm the code and approve. The sign-in is stored (auth/session-store.ts),
// and a journey with a goal and `audit --tunnel ora` then use it. Exit codes: 0 signed in,
// 2 a platform address ax will not sign in to, 3 the sign-in did not complete.

export interface LoginInput {
	json: boolean;
	noBrowser: boolean;
}

export interface LoginDeps {
	fetchFn: typeof fetch;
	/** The chain ax signs platform calls with, and the stored sign-in in it (written here). */
	credentials: PlatformCredentials;
	openBrowser: (url: string) => boolean;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	/** True when a person is at the terminal (a browser is opened only then). */
	interactive: boolean;
}

export function loginDeps(): LoginDeps {
	return {
		fetchFn: fetch,
		credentials: platformCredentials(),
		openBrowser,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: Date.now,
		interactive: Boolean(process.stdout.isTTY),
	};
}

/** Transient failures in a row the poll rides out (a dropped connection) before giving up. */
const MAX_POLL_FAILURES = 5;

const LOGIN_NEXT = { call: "ax login", why: "start a new sign-in" };
const KEY_NEXT = {
	call: "ORA_API_KEY=<platform key> ax journey ...",
	why: "a platform key works without a browser",
};

function fail(error: CommandError, json: boolean, exit: number): number {
	reportError(error, { json, display: (message) => pc.red(message) });
	return exit;
}

export async function loginCommand(
	input: LoginInput,
	deps: LoginDeps = loginDeps(),
): Promise<number> {
	const { json } = input;
	const base = platformBase();
	const store = deps.credentials.signIns.store;
	// The sign-in's tokens will go to this platform, so it is held to the key's rule.
	const problem = platformDestinationProblem(base, "a sign-in");
	if (problem) {
		return fail(
			{ code: "KEY_DESTINATION_REFUSED", message: problem, next: LOGIN_NEXT },
			json,
			EXIT.USAGE,
		);
	}
	// Another of ora's own addresses serves the same API, but a sign-in is issued for one only.
	const origin = oraPlatformOrigin(base);
	if (origin && !origin.canonical) {
		const message = `ora's sign-in is for ${PLATFORM_BASE}, the same API as ${origin.origin}. Unset ORA_PLATFORM_URL (or set it to ${PLATFORM_BASE}) and run ax login again.`;
		const next = {
			call: `ORA_PLATFORM_URL=${PLATFORM_BASE} ax login`,
			why: "sign in to ora's API",
		};
		return fail({ code: "SIGN_IN_UNAVAILABLE", message, next }, json, EXIT.USAGE);
	}
	const target = signInTarget(base);
	if (!target) {
		const message = `ax signs in at account.<domain> for a platform at api.<domain>, and ${base} is not one. Use ORA_API_KEY for it.`;
		return fail({ code: "SIGN_IN_UNAVAILABLE", message, next: KEY_NEXT }, json, EXIT.USAGE);
	}

	let meta: ServerMetadata;
	let device: DeviceAuthorization;
	try {
		meta = await discover(target.issuer, deps.fetchFn);
		device = await startDeviceAuthorization(meta, target, SIGN_IN_SCOPE, deps.fetchFn);
	} catch (cause) {
		return fail(startFailure(cause, target), json, EXIT.API);
	}

	showCode(device, deps, input);
	const outcome = await waitForApproval(meta, target, device, deps);
	if ("error" in outcome) return fail(outcome.error, json, EXIT.API);
	const { tokens } = outcome;
	if (!tokens.refreshToken) {
		const message =
			"ora signed you in without a refresh token, so the sign-in would end within minutes. Use ORA_API_KEY.";
		return fail({ code: "SIGN_IN_INCOMPLETE", message, next: KEY_NEXT }, json, EXIT.API);
	}

	const session: StoredSignIn = {
		version: 1,
		issuer: meta.issuer,
		clientId: target.clientId,
		resource: target.resource,
		tokenEndpoint: meta.tokenEndpoint,
		revocationEndpoint: meta.revocationEndpoint,
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: deps.now() + tokens.expiresIn * 1000,
		scope: tokens.scope,
	};
	const previous = store.read();
	store.write(session);
	// The sign-in this one replaces on this machine is ended on the server too, best effort.
	if (previous && previous.refreshToken !== session.refreshToken) {
		await endSignIn(previous, deps.fetchFn);
	}

	// Who signed in, asked of the platform with the new access token (it is minutes old).
	const identity = await fetchIdentity(base, tokens.accessToken, deps.fetchFn).catch(() => null);
	const credential = deps.credentials.signIns.find(base);
	if (json) {
		process.stdout.write(
			`${JSON.stringify({ signedIn: true, platform: base, identity }, null, 2)}\n`,
		);
	} else {
		console.log(pc.green("✓ Signed in to ora."));
		if (identity && credential) {
			console.log(identityLines(identity, credential.label, base).join("\n"));
		}
	}
	// The chain decides which credential ax signs with; say so when it is not this sign-in.
	const ahead = deps.credentials.chain.ahead(base, deps.credentials.signIns);
	if (ahead) {
		console.error(
			pc.yellow(
				`${ahead.label} is set here, and ax uses it before your sign-in. Unset it to use the sign-in.`,
			),
		);
	}
	return EXIT.OK;
}

/** What a sign-in that could not start tells you: most often an ora that does not offer it yet. */
function startFailure(cause: unknown, target: SignInTarget): CommandError {
	if (cause instanceof OAuthError && cause.code === "invalid_client") {
		return {
			code: "SIGN_IN_UNAVAILABLE",
			message: `${target.issuer} does not know ax as a sign-in client yet. Use ORA_API_KEY until it does.`,
			next: KEY_NEXT,
		};
	}
	if (cause instanceof OAuthError && cause.code === "not_offered") {
		return {
			code: "SIGN_IN_UNAVAILABLE",
			message: `${cause.message}. Use ORA_API_KEY until it does.`,
			next: KEY_NEXT,
		};
	}
	const message = cause instanceof Error ? cause.message : String(cause);
	return {
		code: "SIGN_IN_FAILED",
		message: `The sign-in could not start: ${message}`,
		next: LOGIN_NEXT,
	};
}

/** The link and the code, on stderr (stdout is the result, and the one JSON document under --json). */
function showCode(device: DeviceAuthorization, deps: LoginDeps, input: LoginInput): void {
	const minutes = Math.max(1, Math.round(device.expiresIn / 60));
	const lines = [
		"To sign in, open this link and confirm the code:",
		"",
		`    ${pc.cyan(device.verificationUri)}`,
		"",
		`    Code: ${pc.bold(device.userCode)}   ${pc.dim(`(valid for ${minutes} minutes)`)}`,
		"",
		pc.dim("Approve only a sign-in you started yourself."),
	];
	console.error(lines.join("\n"));
	const opened = !input.noBrowser && deps.interactive && deps.openBrowser(device.verificationUri);
	console.error(
		opened ? "Opened your browser. Waiting for you to approve…" : "Waiting for you to approve…",
	);
}

type Approval = { tokens: TokenSet } | { error: CommandError };

/** RFC 8628 §3.5: poll at the server's pace until the code is approved, refused or expired. */
async function waitForApproval(
	meta: ServerMetadata,
	target: SignInTarget,
	device: DeviceAuthorization,
	deps: LoginDeps,
): Promise<Approval> {
	const deadline = deps.now() + device.expiresIn * 1000;
	let interval = device.interval;
	let failures = 0;
	while (deps.now() < deadline) {
		await deps.sleep(interval * 1000);
		try {
			const poll = await pollDeviceToken(meta, target, device.deviceCode, deps.fetchFn);
			failures = 0;
			if (poll.kind === "tokens") return { tokens: poll.tokens };
			if (poll.kind === "slow_down") interval += 5;
		} catch (cause) {
			if (cause instanceof OAuthError) return { error: refusedApproval(cause) };
			failures += 1;
			if (failures >= MAX_POLL_FAILURES) {
				const message = `ax lost touch with ${meta.issuer}: ${cause instanceof Error ? cause.message : String(cause)}`;
				return { error: { code: "SIGN_IN_FAILED", message, next: LOGIN_NEXT } };
			}
		}
	}
	return {
		error: {
			code: "SIGN_IN_EXPIRED",
			message: "The code expired before it was approved.",
			next: LOGIN_NEXT,
		},
	};
}

function refusedApproval(cause: OAuthError): CommandError {
	if (cause.code === "access_denied") {
		return {
			code: "SIGN_IN_CANCELLED",
			message: "The sign-in was cancelled in the browser.",
			next: LOGIN_NEXT,
		};
	}
	if (cause.code === "expired_token") {
		return {
			code: "SIGN_IN_EXPIRED",
			message: "The code expired before it was approved.",
			next: LOGIN_NEXT,
		};
	}
	return {
		code: "SIGN_IN_FAILED",
		message: `The sign-in did not complete: ${cause.message}`,
		next: LOGIN_NEXT,
	};
}
