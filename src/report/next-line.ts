import type { JourneyNextAction } from "../contract";
import { plain } from "../ui/ansi";

// The one renderer for the line that ends every ax result and error: the next
// call to make, written out with its arguments so an agent can run it as-is.
// A value the CLI cannot know (the user's domain, a key) is a <placeholder>;
// a secret the user passed is never echoed, only its placeholder. When ora
// served a `next_action`, that request is the next call (servedNextStep);
// the CLI's own suggestion is only for payloads that carry none.

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

export interface ServedCallOptions {
	/** The origin a relative API path in the action resolves against. */
	base: string;
	/**
	 * The ax call that sends `method url` itself. A request ax makes is
	 * written as that ax call, which also follows what it starts; any other
	 * request is written as curl.
	 */
	axEquivalent?: { method: string; url: string; call: string };
}

function curlCall(action: JourneyNextAction, base: string): string {
	const url = /^https?:\/\//.test(action.url) ? action.url : `${base}${action.url}`;
	if (action.method === "GET") return `curl -s ${shellWord(url)}`;
	const body = action.body
		? ` -H ${shellWord("content-type: application/json")} -d ${shellWord(JSON.stringify(action.body))}`
		: "";
	return `curl -s -X ${shellWord(action.method)} ${shellWord(url)}${body}`;
}

/**
 * The Next step for a next action ora served (a `next_action` on a journey
 * payload): its request as a call, its wait as a `sleep` in front, and ora's
 * reason, verbatim, as the why.
 */
export function servedNextStep(action: JourneyNextAction, options: ServedCallOptions): NextStep {
	const same = options.axEquivalent;
	const call =
		same && action.method === same.method && action.url === same.url
			? same.call
			: curlCall(action, options.base);
	const seconds = action.wait_seconds;
	const wait = Number.isInteger(seconds) && (seconds ?? 0) > 0 ? `sleep ${seconds} && ` : "";
	return { call: `${wait}${call}`, why: action.reason };
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
