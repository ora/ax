import { createInterface } from "node:readline";
import { PlatformApiError } from "../api/platform-error";
import { platformBase } from "../api/platform-origins";
import { createSetsClient, type SetDocument, type SetsClient } from "../api/sets";
import { KeyRejectedError } from "../auth/errors";
import { SETS_FEATURE } from "../auth/platform-features";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import { type SetFlags, setRequestOf, wholeNumber } from "../journey-set/args";
import { type EndViewOptions, endNextWhy, endViewLines } from "../journey-set/end-view";
import { type FollowEnd, followSet } from "../journey-set/follow-set";
import { onInterrupt } from "../journey-set/interrupt";
import { progressFor } from "../journey-set/live-watch";
import { previewProblem, renderList, renderPreview, renderReport } from "../journey-set/render";
import type { SetProgress } from "../journey-set/set-progress";
import { isRunLimitError, studioUsageStep } from "../journey-set/usage";
import { errorChain, servedBody } from "../report/error-chain";
import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { credentialFailure } from "./credential-failure";
import { EXIT } from "./exit-codes";

// A set of journeys: `ax run set create "<goal>" ["<goal>" ...] --domain <site>` and
// `ax run set view | list | cancel`. The platform plans, runs, grades and counts a set; ax asks,
// waits and prints. It signs as every platform command does: ORA_API_KEY when set, else the
// sign-in `ax login` stored (auth/resolve-credential.ts). Lines for a person (the preview, the question, progress, the Next line under
// --json) go to stderr; stdout carries the report, or under --json the platform's answer as served.

/** Ctrl-C, as `ax audit` exits on it. */
export const INTERRUPTED = 130;
/** How long a set is followed when --wait names nothing. */
export const DEFAULT_WAIT_MINUTES = 60;

/** Tests only; there is no flag for any of these. */
interface Seams {
	client?: SetsClient;
	/** Which credential signs the calls: ax's own chain unless a caller (a test, the command) hands one in. */
	credentials?: PlatformCredentials;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Aborted on Ctrl-C. Tests abort it themselves. */
	interrupt?: AbortSignal;
	/** Where --watch shows the set: the live view on a terminal, the lines elsewhere (live-watch.ts). Tests hand one in. */
	progress?: () => SetProgress;
	/** stdout is the person's terminal (not a pipe or a file). Tests say which. */
	stdoutIsTerminal?: boolean;
	/** How the end of a watched set is drawn: the terminal's width, and whether in color. Tests say which. */
	endView?: EndViewOptions;
}

/** The end view's options: the ones handed in, else stdout's width and the person's color settings. */
const endViewOf = (input: Pick<Seams, "endView">): EndViewOptions =>
	input.endView ?? {
		width: Math.max(40, (process.stdout.columns ?? 100) - 1),
		color: !("NO_COLOR" in process.env) && process.env.TERM !== "dumb",
	};

/** The progress --watch uses: the one handed in, else the live view on a terminal and the lines everywhere else. */
const progressOf = (input: Pick<Seams, "progress">): SetProgress =>
	input.progress?.() ?? progressFor(process.stderr);

/**
 * Follow the set (with the progress --watch shows it on), and say whether its rows are already on the screen the
 * report goes to: the live view left them on the terminal, and stdout is that terminal.
 */
async function follow(
	input: Seams & { watch?: boolean },
	client: SetsClient,
	first: SetDocument,
	options: { waitMinutes: number; interrupt: AbortSignal },
): Promise<{ set: SetDocument; end: FollowEnd; cellsShown: boolean }> {
	const progress = input.watch ? progressOf(input) : undefined;
	const { set, end } = await followSet(client, first, {
		...options,
		watch: input.watch,
		...(progress ? { progress } : {}),
		now: input.now,
		sleep: input.sleep,
	});
	const terminal = input.stdoutIsTerminal ?? process.stdout.isTTY === true;
	return { set, end, cellsShown: terminal && progress?.leftOnScreen() === true };
}

export interface SetRunInput extends Seams {
	goals: readonly string[];
	flags: SetFlags;
	yes: boolean;
	wait?: string;
	/** Show each change as the platform reports it (its live stream), not only the state line. */
	watch?: boolean;
	json: boolean;
	/** Asks on the terminal; null when there is no terminal or Ctrl-C answers. Tests answer for the person. */
	ask?: (question: string) => Promise<string | null>;
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
	call: axCall(["run", "set", "view", id, ...(json ? ["--json"] : [])]),
});
function fail(error: CommandError, exit: number, json: boolean, served?: unknown): number {
	reportError(error, { json, served });
	return exit;
}

/** The platform's refusals that are the caller's to fix (exit 2); anything else is the platform failing (exit 3). */
const USAGE_STATUSES: ReadonlySet<number> = new Set([400, 402, 403, 404, 409, 422]);

/**
 * A failed call as an exit code, with the platform's own body under --json. A credential's failure
 * (none, a sign-in that ended, an address ax will not send one to) reads as it does for every
 * command; `next` is the call to make again once it is in order.
 */
function failedCall(error: unknown, json: boolean, next: NextStep): number {
	const credential = credentialFailure(error, { retry: next.call });
	if (credential) {
		return fail(
			credential,
			credential.refusedByOra ? EXIT.API : EXIT.USAGE,
			json,
			servedBody(error),
		);
	}
	if (error instanceof PlatformApiError) {
		const body = (error.payload ?? {}) as { code?: unknown };
		const code = typeof body.code === "string" ? body.code : `HTTP_${error.status}`;
		const exit = USAGE_STATUSES.has(error.status) ? EXIT.USAGE : EXIT.API;
		return fail({ code, message: error.message, next }, exit, json, error.payload);
	}
	const message = error instanceof Error ? error.message : String(error);
	// A platform key ora rejects: the key's own words say what to do, and it is the caller's to fix.
	if ([...errorChain(error)].some((each) => each instanceof KeyRejectedError)) {
		return fail({ code: "KEY_REJECTED", message, next }, EXIT.USAGE, json, servedBody(error));
	}
	return fail(
		{ code: "API_ERROR", message: `ora could not be reached: ${message}`, next },
		EXIT.API,
		json,
	);
}

/**
 * The client a command calls with: the one handed in, else one that signs with the first credential
 * the chain holds for this platform. None is a NotSignedInError, which failedCall words.
 */
function clientOf(input: Pick<Seams, "client" | "credentials">): SetsClient {
	if (input.client) return input.client;
	const base = platformBase();
	const credential = (input.credentials ?? platformCredentials()).chain.resolve(base, SETS_FEATURE);
	return createSetsClient({ base, credential });
}

function waitMinutesOf(wait: string | undefined): number | null {
	if (wait === undefined) return DEFAULT_WAIT_MINUTES;
	return wholeNumber(wait) ?? null;
}

export { progressLines } from "../journey-set/set-progress";

const END_LINE: Readonly<Record<FollowEnd, string | null>> = {
	complete: null,
	stopped: null,
	failed: null,
	wait_limit: "The wait ran out before the set finished. Its runs go on; look again later.",
	detached: "Stopped watching. The set's runs go on.",
};

/**
 * Print the set as it stands, and the Next line: the platform's own, or `view` when ax stopped watching.
 * `cellsShown`: the live view left the set's rows on the screen this prints to, so they are not printed again.
 */
function report(
	set: SetDocument,
	end: FollowEnd,
	json: boolean,
	cellsShown = false,
	endView?: EndViewOptions,
): number {
	const why = END_LINE[end];
	if (why) console.error(why);
	// Under the panel the live view left on screen, a set the platform read closely ends with the end view: it says
	// what the closing lines said, with more, so they are not printed again.
	const closing = !json && cellsShown && endView ? endViewLines(set, endView) : [];
	if (json) process.stdout.write(`${JSON.stringify(set, null, 2)}\n`);
	else if (closing.length > 0) console.log(closing.join("\n"));
	else console.log(renderReport(set, { cells: !cellsShown }));
	const aim = closing.length > 0 ? endNextWhy(set) : undefined;
	const next: NextStep =
		set.complete || end === "stopped" || end === "failed"
			? { call: set.next.line, ...(aim ? { why: aim } : {}) }
			: viewStep(set.setId, json);
	printNext(next, { stderr: json });
	return end === "detached" ? INTERRUPTED : EXIT.OK;
}

export async function journeySetRun(input: SetRunInput): Promise<number> {
	const { json } = input;
	const usage: NextStep = {
		call: axCall([
			"run",
			"set",
			"create",
			placeholder("goal"),
			"--domain",
			placeholder("site"),
			"--levels",
		]),
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
	let client: SetsClient;
	let created: SetDocument;
	try {
		client = clientOf(input);
		const preview = await client.preview(built.request);
		console.error(renderPreview(preview));
		const problem = previewProblem(preview);
		if (problem)
			return fail(
				{
					code: "SET_REFUSED",
					message: `${problem.message} Nothing was launched.`,
					next: problem.reason === "allowance" ? studioUsageStep() : usage,
				},
				EXIT.USAGE,
				json,
				preview,
			);
		if (!input.yes) {
			const answer = await (input.ask ?? askOnTerminal)(
				`Launch ${preview.runs.total} ${preview.runs.total === 1 ? "run" : "runs"}? [y/N] `,
			);
			if (answer === null) {
				return fail(
					{
						code: "CONFIRMATION_NEEDED",
						message:
							"There is no terminal to ask on, and --yes was not given. Nothing was launched.",
						next: {
							call: `${axCall(["run", "set", "create", "..."])} --yes`,
							why: "launch without asking",
						},
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
		return failedCall(error, json, isRunLimitError(error) ? studioUsageStep() : usage);
	}

	console.error(`Set ${created.setId} started.`);
	const interrupt = input.interrupt ? { signal: input.interrupt, stop: () => {} } : onInterrupt();
	try {
		const { set, end, cellsShown } = await follow(input, client, created, {
			waitMinutes,
			interrupt: interrupt.signal,
		});
		return report(set, end, json, cellsShown, endViewOf(input));
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
	/** Follow the set live until it is over (or the wait runs out), printing what moves. */
	watch?: boolean;
	json: boolean;
}

export async function journeySetView(input: SetViewInput): Promise<number> {
	const { json } = input;
	const listStep: NextStep = {
		call: axCall(["run", "set", "list"]),
		why: "your sets and their ids",
	};
	if (!input.id)
		return fail(
			{ code: "INVALID_SET", message: "ax run set view needs a set id", next: listStep },
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
	const interrupt = input.interrupt ? { signal: input.interrupt, stop: () => {} } : onInterrupt();
	try {
		const client = clientOf(input);
		const first = await client.get(input.id);
		// Without --wait or --watch, view prints the set as it stands: its own state line says whether
		// it is still going, so no "the wait ran out" line belongs above it.
		if (input.wait === undefined && !input.watch) {
			const asItStands: FollowEnd =
				first.state === "stopped" || first.state === "failed" ? first.state : "complete";
			return report(first, asItStands, json);
		}
		// With --wait or --watch, view follows a set that is still going.
		const { set, end, cellsShown } = await follow(input, client, first, {
			waitMinutes,
			interrupt: interrupt.signal,
		});
		return report(set, end, json, cellsShown, endViewOf(input));
	} catch (error) {
		return failedCall(error, json, listStep);
	} finally {
		interrupt.stop();
	}
}

export async function journeySetList(
	input: { json: boolean } & Pick<Seams, "client" | "credentials">,
): Promise<number> {
	const { json } = input;
	try {
		const list = await clientOf(input).list();
		if (json) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
		else console.log(renderList(list));
		const first = list.sets[0];
		printNext(
			first
				? viewStep(first.setId, json)
				: {
						call: axCall([
							"run",
							"set",
							"create",
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
		// A credential's failure gets its own line from failedCall; any other refusal says its own fix, so the way on is the list again.
		return failedCall(error, json, {
			call: axCall(["run", "set", "list", ...(json ? ["--json"] : [])]),
			why: "once that is fixed",
		});
	}
}

export async function journeySetCancel(
	input: { id: string | undefined; json: boolean } & Pick<Seams, "client" | "credentials">,
): Promise<number> {
	const { json } = input;
	const listStep: NextStep = {
		call: axCall(["run", "set", "list"]),
		why: "your sets and their ids",
	};
	if (!input.id)
		return fail(
			{ code: "INVALID_SET", message: "ax run set cancel needs a set id", next: listStep },
			EXIT.USAGE,
			json,
		);
	try {
		const answer = await clientOf(input).cancel(input.id);
		if (json) process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
		else
			console.log(
				`Set ${input.id} was asked to stop. Runs that already finished keep their results.`,
			);
		printNext({ ...viewStep(input.id, json), why: "what finished" }, { stderr: json });
		return EXIT.OK;
	} catch (error) {
		// The set has no run still going: ora says how it ended. Nothing failed, so this is the answer.
		if (alreadyOver(error)) {
			if (json) process.stdout.write(`${JSON.stringify(error.payload, null, 2)}\n`);
			else console.log(error.message);
			printNext({ ...viewStep(input.id, json), why: "its report" }, { stderr: json });
			return EXIT.OK;
		}
		return failedCall(error, json, listStep);
	}
}

/** ora refused to stop a set because none of its runs is still going (HTTP 409, `SET_ALREADY_OVER`). */
function alreadyOver(error: unknown): error is PlatformApiError {
	if (!(error instanceof PlatformApiError) || error.status !== 409) return false;
	return (error.payload as { code?: unknown } | null | undefined)?.code === "SET_ALREADY_OVER";
}
