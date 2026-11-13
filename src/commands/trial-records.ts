import { PlatformApiError } from "../api/platform";
import { createStudioClient, isStudioFailure, StudioApiError } from "../api/studio";
import type { CancelResult, StudioClient } from "../api/studio-types";
import { reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { listRecords } from "../trial/record";
import {
	GET_A_KEY,
	isProductNotGranted,
	PRODUCT_NOT_GRANTED_MESSAGE,
} from "../trial/render-preview";
import { failureCode, pickUpRecord } from "../trial/report-flow";
import { plain } from "../ui/ansi";
import { EXIT } from "./audit";

// `ax trial list` and `ax trial cancel`: the two commands that work from the local record in
// ~/.ax/trials/. `list` reads only that directory and asks no server. `cancel` sends every run id
// the record holds to Studio in one call and prints Studio's answer: counts for a person, the body
// untouched under --json (a single server payload, so invariant 4 applies).

export interface TrialListInput {
	json: boolean;
	/** Record directory; tests only, there is no flag for it. */
	trialsDir?: string;
}

export interface TrialCancelInput {
	id: string;
	json: boolean;
	/** Record directory; tests only, there is no flag for it. */
	trialsDir?: string;
	/** Builds the Studio client; tests inject one over a mocked fetch. */
	client?: () => Pick<StudioClient, "cancelRuns">;
}

const noun = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function jsonWords(json: boolean): string[] {
	return json ? ["--json"] : [];
}

/** After a result: stdout for a person's report, stderr when stdout carries the JSON document. */
function next(step: NextStep, json: boolean): void {
	printNext(step, { stderr: json });
}

// --- list ---

export function trialListCommand(input: TrialListInput): number {
	const { records, skipped } = listRecords(input.trialsDir);
	if (skipped.length > 0) {
		console.error(
			`Skipped ${noun(skipped.length, "file")} that ${skipped.length === 1 ? "is" : "are"} not a readable trial record: ${skipped.map(plain).join(", ")}`,
		);
	}
	if (input.json) process.stdout.write(`${JSON.stringify({ records, skipped }, null, 2)}\n`);

	if (records.length === 0) {
		if (!input.json) {
			console.log(
				skipped.length > 0
					? "No readable trials on this machine."
					: "No trials on this machine yet.",
			);
		}
		next(
			{
				call: axCall(["trial", "run", placeholder("site"), "--task", placeholder("task")]),
				why: "start a trial; it is recorded here",
			},
			input.json,
		);
		return EXIT.OK;
	}

	if (!input.json) {
		const site = Math.max(...records.map((r) => plain(r.site).length));
		for (const r of records) {
			const counts = `${noun(r.journeys, "journey")}, ${noun(r.runs, "run")}`;
			console.log(`${r.id}  ${plain(r.createdAt)}  ${plain(r.site).padEnd(site)}  ${counts}`);
		}
	}
	next(
		{ call: axCall(["trial", "view", records[0].id]), why: "read the newest trial's report" },
		input.json,
	);
	return EXIT.OK;
}

// --- cancel ---

function fail(
	code: string,
	message: string,
	step: NextStep,
	exit: number,
	options: { json: boolean; served?: unknown },
): number {
	reportError({ code, message, next: step }, options);
	return exit;
}

/** The scopes a 403 named, in one sentence. */
function missingScopesMessage(scopes: readonly string[]): string {
	const names = scopes.map((scope) => plain(scope)).join(", ");
	const lead = `Your API key is missing ${scopes.length === 1 ? "this scope" : "these scopes"}: ${names}.`;
	return `${lead}\n${GET_A_KEY}`;
}

function platformFailure(error: unknown, id: string, json: boolean): number {
	const retry: NextStep = {
		call: axCall(["trial", "cancel", id, ...jsonWords(json)]),
		why: "retry; runs that already stopped are reported, not canceled twice",
	};
	const keyStep = (why: string): NextStep => ({
		call: `ORA_API_KEY=<Front API key> ${retry.call}`,
		why,
	});
	const served = error instanceof PlatformApiError ? error.payload : undefined;
	if (isProductNotGranted(error)) {
		const step = keyStep("run it again with a key made in your Front account settings");
		return fail("PRODUCT_NOT_GRANTED", PRODUCT_NOT_GRANTED_MESSAGE, step, EXIT.USAGE, {
			json,
			served,
		});
	}
	if (error instanceof StudioApiError && error.status === 403 && error.missingScopes.length > 0) {
		return fail(
			error.code || "INSUFFICIENT_SCOPE",
			missingScopesMessage(error.missingScopes),
			keyStep("run it again with a key that has the scope"),
			EXIT.USAGE,
			{ json, served },
		);
	}
	const message = `Could not cancel the runs: ${plain(error instanceof Error ? error.message : String(error))}`;
	return fail(failureCode(error), message, retry, EXIT.API, { json, served });
}

function printCounts(id: string, result: CancelResult): void {
	const rows: Array<[string, number]> = [
		["canceled", result.canceled.length],
		["already finished", result.alreadyTerminal.length],
		["skipped", result.skipped.length],
	];
	console.log(`Asked to cancel ${noun(result.requested, "run")} for trial ${id}.`);
	for (const [label, n] of rows) console.log(`  ${label.padEnd(16)}  ${n}`);
}

export async function trialCancelCommand(input: TrialCancelInput): Promise<number> {
	const { id, json } = input;
	const loaded = pickUpRecord(id, json, input.trialsDir);
	if (!loaded) return EXIT.USAGE;

	const runIds = loaded.journeys.flatMap((journey) => journey.runIds);
	if (runIds.length === 0) {
		// Nothing started, so there is no server answer to pass through: --json gets an empty report.
		const none: CancelResult = { requested: 0, canceled: [], alreadyTerminal: [], skipped: [] };
		if (json) process.stdout.write(`${JSON.stringify(none, null, 2)}\n`);
		console[json ? "error" : "log"](`Trial ${id} started no runs, so there is nothing to cancel.`);
		return EXIT.OK;
	}

	if (!process.env.ORA_API_KEY) {
		return fail(
			"MISSING_API_KEY",
			GET_A_KEY,
			{
				call: `ORA_API_KEY=<Front API key> ${axCall(["trial", "cancel", id, ...jsonWords(json)])}`,
				why: "canceling runs needs your Front API key",
			},
			EXIT.USAGE,
			{ json },
		);
	}

	let result: CancelResult;
	try {
		const client = input.client ?? (() => createStudioClient());
		result = await client().cancelRuns(runIds);
	} catch (error) {
		// Only the platform's failures are reported here; a bug in ax propagates.
		if (!isStudioFailure(error)) throw error;
		return platformFailure(error, id, json);
	}

	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		printCounts(id, result);
	}
	next(
		{
			call: axCall(["trial", "view", id, ...jsonWords(json)]),
			why: "read the report for what finished",
		},
		json,
	);
	return EXIT.OK;
}
