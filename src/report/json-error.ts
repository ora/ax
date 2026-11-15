import { plainLines } from "../ui/ansi";
import { type NextStep, printNext } from "./next-line";

// Under --json, stdout carries one JSON document and nothing else. When ora
// (or the platform) answered with an error body, that body is the document,
// unchanged: it is the contract, the same as a result payload (invariant 4).
// Only a failure with no server body to show (a usage mistake caught here, a
// network failure, a timeout, a response that did not parse) gets this
// envelope instead. Every line written for a person (the error itself, the
// Next line, progress, warnings) goes to stderr, in both modes.

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
 * form) and the Next line on stderr. Under --json, stdout gets `served`, the
 * error body the server answered with, when there is one (a body that parsed
 * to null carries nothing to pass through), and the envelope otherwise.
 *
 * The message can quote a server, so stderr gets it with the terminal control
 * bytes dropped, and `display` paints that cleaned text rather than the raw one.
 */
export function reportError(
	error: CommandError,
	options: { json: boolean; display?: (message: string) => string; served?: unknown },
): void {
	const message = plainLines(error.message);
	console.error(options.display ? options.display(message) : message);
	printNext(error.next, { stderr: true });
	if (!options.json) return;
	const document =
		options.served === undefined || options.served === null
			? jsonErrorEnvelope(error)
			: options.served;
	process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}
