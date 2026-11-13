import { type NextStep, printNext } from "./next-line";

// Under --json, stdout carries one JSON document and nothing else: ora's
// payload when the command produced one, or this envelope when it could not.
// Every line written for a person (the error itself, the Next line, progress,
// warnings) goes to stderr, in both modes.

export interface CommandError {
	/** ora's code when it named one, otherwise the CLI's own (e.g. INVALID_TARGET). */
	code: string;
	/** What went wrong, as one human message. */
	message: string;
	next: NextStep;
}

export interface JsonErrorEnvelope {
	error: { code: string; message: string; next: string };
}

export function jsonErrorEnvelope(error: CommandError): JsonErrorEnvelope {
	return { error: { code: error.code, message: error.message, next: error.next.call } };
}

/**
 * Report a failed command: the message (or `display`, its painted or prefixed
 * form) and the Next line on stderr, and under --json the envelope on stdout.
 */
export function reportError(
	error: CommandError,
	options: { json: boolean; display?: string },
): void {
	console.error(options.display ?? error.message);
	printNext(error.next, { stderr: true });
	if (options.json) {
		process.stdout.write(`${JSON.stringify(jsonErrorEnvelope(error), null, 2)}\n`);
	}
}
