import {
	type DeviceAuthorization,
	OAuthError,
	pollDeviceToken,
	type ServerMetadata,
	type TokenSet,
} from "../auth/oauth";
import type { SignInTarget } from "../auth/sign-in-target";
import type { CommandError } from "../report/json-error";

// The wait in `ax login` between showing the code and the person approving it: RFC 8628 §3.5's
// polling, at the server's pace, riding out a sign-in server that stops answering for a while.

/** Transient failures in a row the poll rides out (no answer, a 5xx, a 429) before giving up. */
export const MAX_POLL_FAILURES = 5;

/** The longest wait between two polls while backing off, unless the server's interval is longer. */
export const MAX_BACKOFF_SECONDS = 60;

export const LOGIN_NEXT = { call: "ax login", why: "start a new sign-in" };

export interface ApprovalDeps {
	fetchFn: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

export type Approval = { tokens: TokenSet } | { error: CommandError };

const EXPIRED: CommandError = {
	code: "SIGN_IN_EXPIRED",
	message: "The code expired before it was approved.",
	next: LOGIN_NEXT,
};

/**
 * Seconds to wait before the next poll: the server's interval (raised for good by each
 * slow_down), doubled for each transient failure in a row (RFC 8628 §3.5: a client backs off
 * before it retries), and at most a minute unless the interval itself is longer.
 */
export function nextWait(interval: number, failures: number): number {
	if (failures === 0) return interval;
	return Math.max(interval, Math.min(interval * 2 ** failures, MAX_BACKOFF_SECONDS));
}

/** Polls until the code is approved, refused or expired. Never throws. */
export async function waitForApproval(
	meta: ServerMetadata,
	target: SignInTarget,
	device: DeviceAuthorization,
	deps: ApprovalDeps,
): Promise<Approval> {
	const deadline = deps.now() + device.expiresIn * 1000;
	let interval = device.interval;
	let failures = 0;
	while (deps.now() < deadline) {
		await deps.sleep(Math.min(nextWait(interval, failures) * 1000, deadline - deps.now()));
		try {
			const poll = await pollDeviceToken(meta, target, device.deviceCode, deps.fetchFn);
			failures = 0;
			if (poll.kind === "tokens") return { tokens: poll.tokens };
			if (poll.kind === "slow_down") interval += 5;
		} catch (cause) {
			// An OAuth error is the server's answer to the code. Anything else (no answer, a 5xx, a
			// rate limit) can pass while the person is still approving, so it is waited out.
			if (cause instanceof OAuthError && !cause.transient) return { error: refused(cause) };
			failures += 1;
			if (failures >= MAX_POLL_FAILURES) return { error: lostTouch(cause) };
		}
	}
	return { error: EXPIRED };
}

function refused(cause: OAuthError): CommandError {
	if (cause.code === "access_denied") {
		return {
			code: "SIGN_IN_CANCELLED",
			message: "The sign-in was cancelled in the browser.",
			next: LOGIN_NEXT,
		};
	}
	if (cause.code === "expired_token") return EXPIRED;
	return {
		code: "SIGN_IN_FAILED",
		message: `The sign-in did not complete: ${cause.message}`,
		next: LOGIN_NEXT,
	};
}

function lostTouch(cause: unknown): CommandError {
	const why = cause instanceof Error ? cause.message : String(cause);
	return {
		code: "SIGN_IN_FAILED",
		message: `The sign-in did not complete: ${why}, ${MAX_POLL_FAILURES} times in a row.`,
		next: LOGIN_NEXT,
	};
}
