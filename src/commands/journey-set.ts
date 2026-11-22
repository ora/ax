import { createInterface } from "node:readline";
import { PlatformApiError, platformKeyProblem } from "../api/platform";
import { createSetsClient, type SetDocument, type SetsClient } from "../api/sets";
import { type SetFlags, setRequestOf, wholeNumber } from "../journey-set/args";
import { previewProblem, renderList, renderPreview, renderReport } from "../journey-set/render";
import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { EXIT } from "./audit";

// A set of journeys: `ax journey "<goal>" ["<goal>" ...] --domain <site>` with any set flag, and
// `ax journey view | list | cancel`. The platform plans, runs, grades and counts a set; ax asks,
// waits and prints. Lines for a person (the preview, the question, progress, the Next line under
// --json) go to stderr; stdout carries the report, or under --json the platform's answer as served.

/** Ctrl-C, as `ax audit` exits on it. */
export const INTERRUPTED = 130;
/** How long a set is followed when --wait names nothing. */
export const DEFAULT_WAIT_MINUTES = 60;
const POLL_MS = 5_000;

/** Tests only; there is no flag for any of these. */
interface Seams {
	client?: SetsClient;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Aborted on Ctrl-C. Tests abort it themselves. */
	interrupt?: AbortSignal;
}

export interface SetRunInput extends Seams {
	goals: readonly string[];
	flags: SetFlags;
	yes: boolean;
	wait?: string;
	json: boolean;
	/** Asks on the terminal; null when there is no terminal or Ctrl-C answers. Tests answer for the person. */
	ask?: (question: string) => Promise<string | null>;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

/** A signal that aborts on the first Ctrl-C, and the call that stops listening. */
function onInterrupt(): { signal: AbortSignal; stop: () => void } {
	const controller = new AbortController();
	const handler = () => controller.abort();
	process.once("SIGINT", handler);
	return { signal: controller.signal, stop: () => process.removeListener("SIGINT", handler) };
}

async function askOnTerminal(question: string): Promise<string | null> {
	if (!process.stdin.isTTY) return null;
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await new Promise<string | null>((resolve) => {
			rl.once("SIGINT", () => resolve(null));
			rl.question(question, resolve);
		});
	} finally {
		rl.close();
	}
}

const viewStep = (id: string, json: boolean): NextStep => ({
	call: axCall(["journey", "view", id, ...(json ? ["--json"] : [])]),
});
const KEY_STEP: NextStep = {
	call: `ORA_API_KEY=<platform key> ${axCall(["journey", "list"])}`,
	why: "a platform key with the ax.sets scopes",
};

function fail(error: CommandError, exit: number, json: boolean, served?: unknown): number {
	reportError(error, { json, served });
	return exit;
}

/** The platform's refusals that are the caller's to fix (exit 2); anything else is the platform failing (exit 3). */
const USAGE_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 409, 422]);

/** A failed call as an exit code, with the platform's own body under --json. */
function failedCall(error: unknown, json: boolean, next: NextStep): number {
	if (error instanceof PlatformApiError) {
		const body = (error.payload ?? {}) as { code?: unknown };
		const code = typeof body.code === "string" ? body.code : `HTTP_${error.status}`;
		const exit = USAGE_STATUSES.has(error.status) ? EXIT.USAGE : EXIT.API;
		return fail(
			{ code, message: error.message, next: error.status === 401 ? KEY_STEP : next },
			exit,
			json,
			error.payload,
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return fail(
		{ code: "API_ERROR", message: `ora could not be reached: ${message}`, next },
		EXIT.API,
		json,
	);
}

/** The key checks every set command makes before any call. A usage problem, never an API one. */
function keyProblem(json: boolean): number | null {
	if (!process.env.ORA_API_KEY) {
		return fail(
			{
				code: "MISSING_KEY",
				message: "A set of journeys runs on your ora account: set ORA_API_KEY to a platform key.",
				next: KEY_STEP,
			},
			EXIT.USAGE,
			json,
		);
	}
	const problem = platformKeyProblem();
	return problem
		? fail({ code: "KEY_DESTINATION", message: problem, next: KEY_STEP }, EXIT.USAGE, json)
		: null;
}

function waitMinutesOf(wait: string | undefined): number | null {
	if (wait === undefined) return DEFAULT_WAIT_MINUTES;
	return wholeNumber(wait) ?? null;
}

export type FollowEnd = "complete" | "stopped" | "failed" | "wait_limit" | "detached";

/**
 * Read the set until it is over, the wait runs out or Ctrl-C detaches. The runs go on at the
 * platform either way: following only watches. One line on stderr each time the state changes.
 */
export async function followSet(
	client: SetsClient,
	first: SetDocument,
	options: { waitMinutes: number; interrupt: AbortSignal } & Pick<Seams, "now" | "sleep">,
): Promise<{ set: SetDocument; end: FollowEnd }> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? abortableSleep;
	const deadline = now() + options.waitMinutes * 60_000;
	let set = first;
	let said = "";
	for (;;) {
		if (set.state === "complete" || set.state === "stopped" || set.state === "failed")
			return { set, end: set.state };
		const line = `${set.state}: ${set.runs.started} of ${set.runs.planned} runs started`;
		if (line !== said) console.error(`  ${line}`);
		said = line;
		if (options.interrupt.aborted) return { set, end: "detached" };
		if (now() >= deadline) return { set, end: "wait_limit" };
		await sleep(POLL_MS, options.interrupt);
		if (options.interrupt.aborted) return { set, end: "detached" };
		set = await client.get(set.setId);
	}
}

const END_LINE: Readonly<Record<FollowEnd, string | null>> = {
	complete: null,
	stopped: null,
	failed: null,
	wait_limit: "The wait ran out before the set finished. Its runs go on; look again later.",
	detached: "Stopped watching. The set's runs go on.",
};

/** Print the set as it stands, and the Next line: the platform's own, or `view` when ax stopped watching. */
function report(set: SetDocument, end: FollowEnd, json: boolean): number {
	const why = END_LINE[end];
	if (why) console.error(why);
	if (json) process.stdout.write(`${JSON.stringify(set, null, 2)}\n`);
	else console.log(renderReport(set));
	const next: NextStep =
		set.complete || end === "stopped" || end === "failed"
			? { call: set.next.line }
			: viewStep(set.setId, json);
	printNext(next, { stderr: json });
	return end === "detached" ? INTERRUPTED : EXIT.OK;
}

export async function journeySetRun(input: SetRunInput): Promise<number> {
	const { json } = input;
	const usage: NextStep = {
		call: axCall(["journey", placeholder("goal"), "--domain", placeholder("site"), "--levels"]),
		why: "a set of journeys",
	};
	const built = setRequestOf(input.goals, input.flags);
	if ("problem" in built)
		return fail({ code: "INVALID_SET", message: built.problem, next: usage }, EXIT.USAGE, json);
	const waitMinutes = waitMinutesOf(input.wait);
	if (waitMinutes === null)
		return fail(
			{
				code: "INVALID_FLAG",
				message: `--wait takes a whole number of minutes, 1 or more, not "${input.wait}"`,
				next: usage,
			},
			EXIT.USAGE,
			json,
		);
	const keyExit = input.client ? null : keyProblem(json);
	if (keyExit !== null) return keyExit;
	const client = input.client ?? createSetsClient();

	let created: SetDocument;
	try {
		const preview = await client.preview(built.request);
		console.error(renderPreview(preview));
		const problem = previewProblem(preview);
		if (problem)
			return fail(
				{ code: "SET_REFUSED", message: `${problem} Nothing was launched.`, next: usage },
				EXIT.USAGE,
				json,
				preview,
			);
		if (!input.yes) {
			const answer = await (input.ask ?? askOnTerminal)(
				`Launch ${preview.runs.total} runs? [y/N] `,
			);
			if (answer === null) {
				return fail(
					{
						code: "CONFIRMATION_NEEDED",
						message:
							"There is no terminal to ask on, and --yes was not given. Nothing was launched.",
						next: { call: `${axCall(["journey", "..."])} --yes`, why: "launch without asking" },
					},
					EXIT.USAGE,
					json,
				);
			}
			if (!/^y(es)?$/i.test(answer.trim())) {
				console.error("Nothing was launched.");
				return EXIT.OK;
			}
		}
		created = await client.create(built.request);
	} catch (error) {
		return failedCall(error, json, usage);
	}

	console.error(`Set ${created.setId} started.`);
	const interrupt = input.interrupt ? { signal: input.interrupt, stop: () => {} } : onInterrupt();
	try {
		const { set, end } = await followSet(client, created, {
			waitMinutes,
			interrupt: interrupt.signal,
			now: input.now,
			sleep: input.sleep,
		});
		return report(set, end, json);
	} catch (error) {
		// The set exists: whatever failed while watching it, the way back is to look again.
		return failedCall(error, json, viewStep(created.setId, json));
	} finally {
		interrupt.stop();
	}
}

export interface SetViewInput extends Seams {
	id: string | undefined;
	wait?: string;
	json: boolean;
}

export async function journeySetView(input: SetViewInput): Promise<number> {
	const { json } = input;
	const listStep: NextStep = { call: axCall(["journey", "list"]), why: "your sets and their ids" };
	if (!input.id)
		return fail(
			{ code: "INVALID_SET", message: "ax journey view needs a set id", next: listStep },
			EXIT.USAGE,
			json,
		);
	const waitMinutes = waitMinutesOf(input.wait);
	if (waitMinutes === null)
		return fail(
			{
				code: "INVALID_FLAG",
				message: `--wait takes a whole number of minutes, 1 or more, not "${input.wait}"`,
				next: viewStep(input.id, json),
			},
			EXIT.USAGE,
			json,
		);
	const keyExit = input.client ? null : keyProblem(json);
	if (keyExit !== null) return keyExit;
	const client = input.client ?? createSetsClient();
	const interrupt = input.interrupt ? { signal: input.interrupt, stop: () => {} } : onInterrupt();
	try {
		const first = await client.get(input.id);
		// Without --wait, view prints the set as it stands: its own state line says whether it is
		// still going, so no "the wait ran out" line belongs above it.
		if (input.wait === undefined) {
			const asItStands: FollowEnd =
				first.state === "stopped" || first.state === "failed" ? first.state : "complete";
			return report(first, asItStands, json);
		}
		// With --wait, view watches a set that is still going.
		const { set, end } = await followSet(client, first, {
			waitMinutes,
			interrupt: interrupt.signal,
			now: input.now,
			sleep: input.sleep,
		});
		return report(set, end, json);
	} catch (error) {
		return failedCall(error, json, listStep);
	} finally {
		interrupt.stop();
	}
}

export async function journeySetList(
	input: { json: boolean } & Pick<Seams, "client">,
): Promise<number> {
	const { json } = input;
	const keyExit = input.client ? null : keyProblem(json);
	if (keyExit !== null) return keyExit;
	try {
		const list = await (input.client ?? createSetsClient()).list();
		if (json) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
		else console.log(renderList(list));
		const first = list.sets[0];
		printNext(
			first
				? viewStep(first.setId, json)
				: {
						call: axCall([
							"journey",
							placeholder("goal"),
							"--domain",
							placeholder("site"),
							"--levels",
						]),
						why: "start a set",
					},
			{ stderr: json },
		);
		return EXIT.OK;
	} catch (error) {
		// A 401 gets the key line from failedCall; any other refusal says its own fix, so the way on is the list again.
		return failedCall(error, json, {
			call: axCall(["journey", "list", ...(json ? ["--json"] : [])]),
			why: "once that is fixed",
		});
	}
}

export async function journeySetCancel(
	input: { id: string | undefined; json: boolean } & Pick<Seams, "client">,
): Promise<number> {
	const { json } = input;
	const listStep: NextStep = { call: axCall(["journey", "list"]), why: "your sets and their ids" };
	if (!input.id)
		return fail(
			{ code: "INVALID_SET", message: "ax journey cancel needs a set id", next: listStep },
			EXIT.USAGE,
			json,
		);
	const keyExit = input.client ? null : keyProblem(json);
	if (keyExit !== null) return keyExit;
	try {
		const answer = await (input.client ?? createSetsClient()).cancel(input.id);
		if (json) process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
		else
			console.log(
				`Set ${input.id} was asked to stop. Runs that already finished keep their results.`,
			);
		printNext({ ...viewStep(input.id, json), why: "what finished" }, { stderr: json });
		return EXIT.OK;
	} catch (error) {
		return failedCall(error, json, listStep);
	}
}
