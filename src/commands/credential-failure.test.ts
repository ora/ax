import { describe, expect, it } from "vitest";
import { KeyDestinationError } from "../api/key-destination";
import { PlatformApiError } from "../api/platform-error";
import { KeyRejectedError, NotSignedInError, SignInEndedError } from "../auth/errors";
import { TunnelError } from "../tunnel";
import { credentialFailure } from "./credential-failure";

// One reading of a credential's failure for every command. Each case changes one thing.

const HINTS = { retry: "ax audit localhost:3000 --tunnel ora" };

describe("credentialFailure", () => {
	it("no credential is MISSING_API_KEY: sign in, then the same call, or set a key", () => {
		const failure = credentialFailure(new NotSignedInError({ base: "https://api.ora.ai" }), HINTS);
		expect(failure).toMatchObject({
			code: "MISSING_API_KEY",
			refusedByOra: false,
			next: { call: "ax login" },
		});
		expect(failure?.next.why).toContain(`then run ${HINTS.retry} again`);
	});

	it("names what works without a credential, when the command has something", () => {
		const failure = credentialFailure(new NotSignedInError({ base: "https://api.ora.ai" }), {
			...HINTS,
			otherwise: "or bring your own tunnel with --tunnel-cmd",
		});
		expect(failure?.next.why).toMatch(/; or bring your own tunnel with --tunnel-cmd$/);
	});

	it("a sign-in ora no longer accepts is SIGN_IN_ENDED, refused by ora: sign in again", () => {
		const failure = credentialFailure(new SignInEndedError("it ended. Run ax login."), HINTS);
		expect(failure).toMatchObject({
			code: "SIGN_IN_ENDED",
			message: "it ended. Run ax login.",
			refusedByOra: true,
			next: { call: "ax login", why: `sign in again, then run ${HINTS.retry}` },
		});
	});

	it("an address ax will not send a credential to is KEY_DESTINATION_REFUSED: the same call", () => {
		const failure = credentialFailure(new KeyDestinationError("not there"), HINTS);
		expect(failure).toMatchObject({
			code: "KEY_DESTINATION_REFUSED",
			refusedByOra: false,
			next: { call: HINTS.retry },
		});
	});

	it("reads through a wrapper, with the wrapped failure's own words", () => {
		const ended = new SignInEndedError("it ended. Run ax login.");
		const wrapped = new TunnelError("could not open the tunnel", { cause: ended });
		expect(credentialFailure(wrapped, HINTS)).toMatchObject({
			code: "SIGN_IN_ENDED",
			message: ended.message,
		});
	});

	it("anything else is the command's own to word, a rejected key included", () => {
		for (const other of [
			new TunnelError("dropped"),
			new PlatformApiError("down", { status: 503 }),
			new KeyRejectedError("the platform key was rejected. Check ORA_API_KEY."),
			"not even an error",
		]) {
			expect(credentialFailure(other, HINTS)).toBeUndefined();
		}
	});
});
