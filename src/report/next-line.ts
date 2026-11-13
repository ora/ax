import { plain } from "../ui/ansi";

// The one renderer for the line that ends every ax result and error: the next
// call to make, written out with its arguments so an agent can run it as-is.
// A value the CLI cannot know (the user's domain, a key) is a <placeholder>;
// a secret the user passed is never echoed, only its placeholder.

export interface NextStep {
	/** The call, e.g. `ax deep-journey stripe.com --intent pricing`. */
	call: string;
	/** Why, in one line; printed as a shell comment after the call. */
	why?: string;
}

/** A word the user fills in, shown as `<name>` and never shell-quoted. */
export interface Placeholder {
	placeholder: string;
}

export type Word = string | Placeholder;

export function placeholder(name: string): Placeholder {
	return { placeholder: name };
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One shell word: bare when it needs no quoting, single quoted otherwise. */
export function shellWord(value: string): string {
	if (SHELL_SAFE.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** An `ax` invocation, each real argument quoted the way a shell needs it. */
export function axCall(words: readonly Word[]): string {
	const rendered = words.map((word) =>
		typeof word === "string" ? shellWord(word) : `<${word.placeholder}>`,
	);
	return ["ax", ...rendered].join(" ");
}

/** `Next: <call>`, plus `  # <why>` when there is one. Control characters are blanked. */
export function nextLine(step: NextStep): string {
	const line = step.why ? `Next: ${step.call}  # ${step.why}` : `Next: ${step.call}`;
	return plain(line);
}

/**
 * Print the Next line: on stdout after a report rendered for a person, on
 * stderr whenever stdout carries a payload (`--json`, raw skill bytes) that
 * must stay clean.
 */
export function printNext(step: NextStep, options: { stderr: boolean }): void {
	if (options.stderr) console.error(nextLine(step));
	else console.log(nextLine(step));
}
