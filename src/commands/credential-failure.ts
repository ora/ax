import { KEY_DESTINATION_WHY, KeyDestinationError } from "../api/key-destination";
import { NotSignedInError, SignInEndedError } from "../auth/errors";
import { errorChain } from "../report/error-chain";
import type { CommandError } from "../report/json-error";

// The one reading of a credential's failure, for every command: no credential, a sign-in ora no
// longer accepts, or an address ax will not send one to. It looks through wrappers (`cause`), so
// the same failure reads the same whether it surfaced while a tunnel opened, mid-audit, in a
// journey or in whoami. Anything else is the command's own to word.

export interface CredentialFailure extends CommandError {
	/** ora refused the credential, rather than ax having none to send or refusing to send it. */
	readonly refusedByOra: boolean;
}

export interface CredentialFailureHints {
	/** The same call again, to run once the credential is in order. */
	readonly retry: string;
	/** What works without a platform credential, when something does. */
	readonly otherwise?: string;
}

/** How one kind of credential failure reads (Strategy), keyed by the error that says so. */
interface Reading {
	matches(error: Error): boolean;
	read(error: Error, hints: CredentialFailureHints): CredentialFailure;
}

const READINGS: readonly Reading[] = [
	{
		matches: (error) => error instanceof NotSignedInError,
		read: (error, { retry, otherwise }) => ({
			// The code scripts read since before sign-ins existed: kept.
			code: "MISSING_API_KEY",
			message: error.message,
			refusedByOra: false,
			next: {
				call: "ax login",
				why: `sign in through your browser, then run ${retry} again; or set ORA_API_KEY to a platform key${otherwise ? `; ${otherwise}` : ""}`,
			},
		}),
	},
	{
		matches: (error) => error instanceof SignInEndedError,
		read: (error, { retry }) => ({
			code: "SIGN_IN_ENDED",
			message: error.message,
			refusedByOra: true,
			next: { call: "ax login", why: `sign in again, then run ${retry}` },
		}),
	},
	{
		matches: (error) => error instanceof KeyDestinationError,
		read: (error, { retry }) => ({
			code: "KEY_DESTINATION_REFUSED",
			message: error.message,
			refusedByOra: false,
			next: { call: retry, why: KEY_DESTINATION_WHY },
		}),
	},
];

/** The failure `cause` is, if it is a credential's: read from the first error in its chain that says so. */
export function credentialFailure(
	cause: unknown,
	hints: CredentialFailureHints,
): CredentialFailure | undefined {
	for (const error of errorChain(cause)) {
		const reading = READINGS.find((each) => each.matches(error));
		if (reading) return reading.read(error, hints);
	}
	return undefined;
}
