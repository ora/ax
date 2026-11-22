import { createInterface } from "node:readline";
import { PlatformApiError } from "../api/platform-error";
import { platformBase } from "../api/platform-origins";
import { createSetsClient, type SetDocument, type SetsClient } from "../api/sets";
import { KeyRejectedError } from "../auth/errors";
import { SETS_FEATURE } from "../auth/platform-features";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import { type SetFlags, setRequestOf, wholeNumber } from "../journey-set/args";
import { previewProblem, renderList, renderPreview, renderReport } from "../journey-set/render";
import { errorChain, servedBody } from "../report/error-chain";
import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { credentialFailure } from "./credential-failure";
import { EXIT } from "./exit-codes";

// A set of journeys: `ax journey "<goal>" ["<goal>" ...] --domain <site>` with any set flag, and
// `ax journey view | list | cancel`. The platform plans, runs, grades and counts a set; ax asks,
// waits and prints. It signs as every platform command does: ORA_API_KEY when set, else the
// sign-in `ax login` stored (auth/resolve-credential.ts). Lines for a person (the preview, the question, progress, the Next line under
// --json) go to stderr; stdout carries the report, or under --json the platform's answer as served.

/** Ctrl-C, as `ax audit` exits on it. */
export const INTERRUPTED = 130;
/** How long a set is followed when --wait names nothing. */
export const DEFAULT_WAIT_MINUTES = 60;
const POLL_MS = 5_000;

/** Tests only; there is no flag for any of these. */
interface Seams {
	client?: SetsClient;
	/** Which credential signs the calls: ax's own chain unless a caller (a test, the command) hands one in. */
	credentials?: PlatformCredentials;
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
	/** Show each change as the platform reports it (its live stream), not only the state line. */
	watch?: boolean;
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

export type FollowEnd = "complete" | "stopped" | "failed" | "wait_limit" | "detached";

/**
 * Read the set until it is over, the wait runs out or Ctrl-C detaches. The runs go on at the
 * platform either way: following only watches. One line on stderr each time the state changes.
 */
export async function followSet(
	client: SetsClient,
	first: SetDocument,
	options: { waitMinutes: number; interrupt: AbortSignal; watch?: boolean } & Pick<
		Seams,
		"now" | "sleep"
	>,
): Promise<{ set: SetDocument; end: FollowEnd }> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? abortableSleep;
	const deadline = now() + options.waitMinutes * 60_000;
	let set = first;
	let said = "";
	if (options.watch) {
		const live = await watchSet(client, first, { deadline, now, interrupt: options.interrupt });
		if (live.end !== null) return { set: live.set, end: live.end };
		// The live stream could not be opened, or ended before the set was over: read it instead.
		console.error("  Live updates are not available right now; checking every few seconds.");
		set = live.set;
	}
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

/** What moved between two documents of one set, as lines: its state, then each cell whose counts changed. */
export function progressLines(before: SetDocument | null, after: SetDocument): string[] {
	const lines: string[] = [];
	const stateLine = (set: SetDocument) =>
		`${set.state}: ${set.runs.started} of ${set.runs.planned} runs started`;
	if (before === null || stateLine(before) !== stateLine(after)) lines.push(stateLine(after));
	const labelOf = (key: string) => after.levels.find((level) => level.key === key)?.label ?? key;
	const keyOf = (cell: SetDocument["cells"][number]) => `${cell.goal}|${cell.level}|${cell.agent}`;
	const earlier = new Map((before?.cells ?? []).map((cell) => [keyOf(cell), cell]));
	for (const cell of after.cells) {
		const was = earlier.get(keyOf(cell));
		const moved =
			was === undefined
				? cell.graded > 0 || cell.inFlight > 0
				: was.graded !== cell.graded ||
					was.passed !== cell.passed ||
					was.inFlight !== cell.inFlight;
		if (!moved) continue;
		const goal = after.goals.length > 1 ? `goal ${cell.goal} · ` : "";
		const going = cell.inFlight > 0 ? `, ${cell.inFlight} still running` : "";
		lines.push(
			`${goal}${labelOf(cell.level)} · ${cell.agent}: ${cell.passed ?? 0} of ${cell.graded} graded${going}`,
		);
	}
	return lines;
}

/**
 * Follow the set over the platform's live stream, printing what moves as it moves. `end` is null
 * when the stream could not say how the set ended (it would not open, or closed early): the caller
 * then reads the set instead. The wait limit and Ctrl-C close the stream; the runs go on.
 */
async function watchSet(
	client: SetsClient,
	first: SetDocument,
	options: { deadline: number; now: () => number; interrupt: AbortSignal },
): Promise<{ set: SetDocument; end: FollowEnd | null }> {
	const over = (set: SetDocument): FollowEnd | null =>
		set.state === "complete" || set.state === "stopped" || set.state === "failed"
			? set.state
			: null;
	if (over(first)) return { set: first, end: over(first) };
	const stop = new AbortController();
	let outOfTime = false;
	const timer = setTimeout(
		() => {
			outOfTime = true;
			stop.abort();
		},
		Math.max(0, options.deadline - options.now()),
	);
	const onInterrupt = () => stop.abort();
	options.interrupt.addEventListener("abort", onInterrupt, { once: true });
	let latest = first;
	let printed: SetDocument | null = null;
	try {
		await client.follow(
			first.setId,
			(set) => {
				for (const line of progressLines(printed, set)) console.error(`  ${line}`);
				printed = set;
				latest = set;
			},
			stop.signal,
		);
	} catch (error) {
		// A stream we closed ourselves is not a failure; any other one falls back to reading.
		if (!stop.signal.aborted && !(error instanceof Error)) throw error;
	} finally {
		clearTimeout(timer);
		options.interrupt.removeEventListener("abort", onInterrupt);
	}
	if (options.interrupt.aborted) return { set: latest, end: "detached" };
	if (outOfTime) return { set: latest, end: "wait_limit" };
	return { set: latest, end: over(latest) };
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
	let client: SetsClient;
	let created: SetDocument;
	try {
		client = clientOf(input);
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
			watch: input.watch,
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
	/** Follow the set live until it is over (or the wait runs out), printing what moves. */
	watch?: boolean;
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
		const { set, end } = await followSet(client, first, {
			waitMinutes,
			interrupt: interrupt.signal,
			watch: input.watch,
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
		// A credential's failure gets its own line from failedCall; any other refusal says its own fix, so the way on is the list again.
		return failedCall(error, json, {
			call: axCall(["journey", "list", ...(json ? ["--json"] : [])]),
			why: "once that is fixed",
		});
	}
}

export async function journeySetCancel(
	input: { id: string | undefined; json: boolean } & Pick<Seams, "client" | "credentials">,
): Promise<number> {
	const { json } = input;
	const listStep: NextStep = { call: axCall(["journey", "list"]), why: "your sets and their ids" };
	if (!input.id)
		return fail(
			{ code: "INVALID_SET", message: "ax journey cancel needs a set id", next: listStep },
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
