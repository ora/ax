import { createInterface } from "node:readline";
import { PlatformApiError, platformKeyProblem } from "../api/platform";
import { createStudioClient, isStudioFailure, StudioApiError } from "../api/studio";
import { STUDIO_SCOPES, type StudioClient } from "../api/studio-types";
import { abortableSleep } from "../journey-set/follow";
import { type PreviewResult, previewSet, type Refusal } from "../journey-set/preview";
import { createRecord } from "../journey-set/record";
import {
	closeTerminalLine,
	confirmPrompt,
	GET_A_KEY,
	isProductNotGranted,
	KEY_DESTINATION_WHY,
	PRODUCT_NOT_GRANTED_MESSAGE,
	renderPreview,
	renderRefusal,
	renderRefusals,
} from "../journey-set/render-preview";
import {
	type FlowEnd,
	failureCode,
	followAndReport,
	launchAndReport,
	pickUpRecord,
	SET_USAGE_CALL,
} from "../journey-set/report-flow";
import {
	type CellPlan,
	parseSetSpec,
	parseWaitMinutes,
	planCells,
	type SetSpec,
} from "../journey-set/spec";
import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext, type Word } from "../report/next-line";
import { plain } from "../ui/ansi";
import { EXIT } from "./audit";

// A set of journeys from `ax journey` (src/commands/journey-cli.ts decides when the flags ask for
// one), and `ax journey view`. Run checks the spec and the key, reads the key's scopes, the agent
// catalog and the month's usage, prints the preview, asks, writes the record, then launches,
// follows and reports through src/journey-set/report-flow.ts; view picks a recorded set up and
// follows and reports it the same way. Lines for a person go to stderr; stdout carries only the
// report.

/** Ctrl-C, as `ax audit` exits on it. */
const INTERRUPTED = 130;

/** Tests only; there is no flag for any of these. */
interface Seams {
	setsDir?: string;
	/** Builds the Studio client; tests build one over a mocked fetch. */
	client?: () => StudioClient;
	/** Following's clock and sleep. */
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface JourneySetRunInput extends Seams {
	/** --domain; a set refuses to run without one. */
	site?: string;
	goals: readonly string[];
	agents?: string;
	/** --levels as typed; --brand, --docs and --exact turn levels on without it. */
	levels: boolean;
	brand?: string;
	docs?: string;
	exact?: string;
	repeat?: string;
	wait?: string;
	yes: boolean;
	json: boolean;
	/** Asks on the terminal; null when Ctrl-C answers. Tests answer for the person. */
	ask?: (question: string) => Promise<string | null>;
}

export interface JourneySetViewInput extends Seams {
	id: string;
	wait?: string;
	json: boolean;
}

const NOTHING_LAUNCHED = "Nothing was launched.";

function fail(error: CommandError, exit: number, json: boolean, served?: unknown): number {
	reportError(error, { json, served });
	return exit;
}

function messageOf(error: unknown): string {
	return plain(error instanceof Error ? error.message : String(error));
}

function exitOf(end: FlowEnd): number {
	if (end === "interrupted") return INTERRUPTED;
	return end === "failed" ? EXIT.API : EXIT.OK;
}

/** The Studio client and following's clock, real unless a test injected them. */
function seams(input: Seams) {
	const client = (input.client ?? (() => createStudioClient()))();
	return { client, now: input.now ?? Date.now, sleep: input.sleep ?? abortableSleep };
}

const keyStep = (call: string): NextStep => ({
	call: `ORA_API_KEY=<Front API key> ${call}`,
	why: "a Front API key with the scopes a set of journeys needs",
});

/** Exit 2 before any call when the key must not go to the platform URL; undefined when it may. */
function keyRefusal(call: string, json: boolean): number | undefined {
	const problem = platformKeyProblem();
	if (problem === undefined) return undefined;
	const next = { call, why: KEY_DESTINATION_WHY };
	return fail({ code: "KEY_DESTINATION_REFUSED", message: problem, next }, EXIT.USAGE, json);
}

/** The key exchange or a read failed on the platform: exit 3, with the key named on a 401. */
function platformFailure(error: unknown, call: string, json: boolean): number {
	const rejected = error instanceof PlatformApiError && error.status === 401;
	const served = error instanceof PlatformApiError ? error.payload : undefined;
	const next = rejected ? keyStep(call) : { call, why: "retry" };
	const failure = { code: failureCode(error), message: messageOf(error), next };
	return fail(failure, EXIT.API, json, served);
}

// --- run ---

interface Swap {
	site?: Word;
	repeat?: Word;
	agents?: Word;
	yes?: true;
}

/** The set as the person typed it, with one value swapped for a Next line. */
function runCall(input: JourneySetRunInput, swap: Swap = {}) {
	const flag = (name: string, value: Word | undefined) =>
		value === undefined ? [] : [name, value];
	return axCall([
		"journey",
		...input.goals,
		...flag("--domain", swap.site ?? input.site),
		...flag("--agents", swap.agents ?? input.agents),
		...(input.levels ? ["--levels"] : []),
		...flag("--brand", input.brand),
		...flag("--docs", input.docs),
		...flag("--exact", input.exact),
		...flag("--repeat", swap.repeat ?? input.repeat),
		...flag("--wait", input.wait),
		...(input.yes || swap.yes ? ["--yes"] : []),
		...jsonWords(input),
	]);
}

/** The set's goal, site and agent as one journey: no --repeat, and no set-only flags. */
function oneJourneyCall(input: JourneySetRunInput) {
	return axCall([
		"journey",
		...input.goals,
		...(input.site === undefined ? [] : ["--domain", input.site]),
		...(input.agents === undefined ? [] : ["--agents", input.agents]),
		...jsonWords(input),
	]);
}

function jsonWords(input: { json: boolean }): string[] {
	return input.json ? ["--json"] : [];
}

/** A 403 on the agents or usage read is about the key, so it exits 2; anything else exits 3. */
function readFailure(error: unknown, input: JourneySetRunInput): number {
	const next = keyStep(runCall(input));
	const served = error instanceof PlatformApiError ? error.payload : undefined;
	if (isProductNotGranted(error)) {
		const refusal = { code: "PRODUCT_NOT_GRANTED", message: PRODUCT_NOT_GRANTED_MESSAGE, next };
		return fail(refusal, EXIT.USAGE, input.json, served);
	}
	if (error instanceof StudioApiError && error.code === "INSUFFICIENT_SCOPE") {
		const missing = STUDIO_SCOPES.filter((scope) => error.missingScopes.includes(scope));
		const lines = missing.length
			? renderRefusal({ kind: "missing_scopes", missing })
			: [messageOf(error), GET_A_KEY];
		const refusal = { code: error.code, message: lines.join("\n"), next };
		return fail(refusal, EXIT.USAGE, input.json, served);
	}
	return platformFailure(error, runCall(input), input.json);
}

/** The scopes, then the catalog and usage unless a scope is missing; or the exit code reported. */
async function preview(
	studio: StudioClient,
	input: JourneySetRunInput,
	base: { spec: SetSpec; cells: CellPlan["cells"] },
): Promise<PreviewResult | number> {
	let scopes: string[];
	try {
		scopes = await studio.scopes();
	} catch (error) {
		if (!isStudioFailure(error)) throw error;
		return platformFailure(error, runCall(input), input.json);
	}
	const lacking = STUDIO_SCOPES.some((scope) => !scopes.includes(scope));
	if (lacking) return previewSet({ ...base, scopes });
	try {
		const agents = await studio.agents();
		return previewSet({ ...base, scopes, agents, usage: await studio.usage() });
	} catch (error) {
		if (!isStudioFailure(error)) throw error;
		return readFailure(error, input);
	}
}

/** The Next line for one refusal: the call with the value to change filled in or left to fill. */
function refusalNext(lead: Refusal, input: JourneySetRunInput): NextStep {
	switch (lead.kind) {
		case "missing_scopes":
			return keyStep(runCall(input));
		case "over_allowance": {
			if (!lead.fits) return { call: runCall(input), why: "after your plan's runs reset" };
			if (lead.oneJourney) {
				const why = "one run fits what your plan has left; without --repeat this is one journey";
				return { call: oneJourneyCall(input), why };
			}
			const repeat = String(lead.fits.repeat);
			const why = "the largest repeat that fits what your plan has left";
			return { call: runCall(input, { repeat }), why };
		}
		case "over_cap": {
			const repeat = placeholder("repeats");
			return { call: runCall(input, { repeat }), why: "fewer repeats, goals or agents" };
		}
		default: {
			const agents = placeholder("harness/model");
			return { call: runCall(input, { agents }), why: "an agent your plan offers" };
		}
	}
}

/** The typed answer; null on Ctrl-C. End of input answers like an empty line: the default, no. */
function askOnTerminal(question: string): Promise<string | null> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve) => {
		rl.once("SIGINT", () => {
			process.stderr.write("\n");
			resolve(null);
			rl.close();
		});
		rl.once("close", () => resolve(""));
		rl.question(question, (answer) => {
			resolve(answer);
			rl.close();
		});
	});
}

/** True to launch; otherwise the exit code of a refusal or a no, already reported. */
async function confirm(input: JourneySetRunInput, runs: number): Promise<true | number> {
	if (input.yes) return true;
	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		const next = { call: runCall(input, { yes: true }), why: "launches without asking" };
		const message = `There is no terminal to confirm the launch in. ${NOTHING_LAUNCHED}`;
		return fail({ code: "CONFIRM_NEEDS_TERMINAL", message, next }, EXIT.USAGE, input.json);
	}
	const answer = await (input.ask ?? askOnTerminal)(confirmPrompt(runs));
	if (answer !== null && /^y(es)?$/i.test(answer.trim())) return true;
	console.error(NOTHING_LAUNCHED);
	const why = "the same set, when you want to launch it";
	printNext({ call: runCall(input), why }, { stderr: true });
	return answer === null ? INTERRUPTED : EXIT.OK;
}

export async function journeySetRunCommand(input: JourneySetRunInput): Promise<number> {
	const { json } = input;
	const parsed = parseSetSpec(input);
	if (!parsed.ok) {
		const next =
			input.site === undefined
				? {
						call: runCall(input, { site: placeholder("site") }),
						why: "with the site the agents work on",
					}
				: { call: SET_USAGE_CALL, why: "with the value named above fixed" };
		return fail({ code: "INVALID_SPEC", message: parsed.error, next }, EXIT.USAGE, json);
	}
	if (!process.env.ORA_API_KEY) {
		const next = keyStep(runCall(input));
		return fail({ code: "MISSING_API_KEY", message: GET_A_KEY, next }, EXIT.USAGE, json);
	}
	const refused = keyRefusal(runCall(input), json);
	if (refused !== undefined) return refused;
	const { spec } = parsed;
	const { cells, skipped } = planCells(spec);
	const { client, now, sleep } = seams(input);
	const decided = await preview(client, input, { spec, cells });
	if (typeof decided === "number") return decided;
	if (!decided.ok) {
		const { refusals } = decided;
		const lead = refusals.find((r) => r.kind === "over_allowance" && r.fits) ?? refusals[0];
		const message = renderRefusals(refusals).join("\n");
		const refusal = { code: lead.kind.toUpperCase(), message, next: refusalNext(lead, input) };
		return fail(refusal, EXIT.USAGE, json);
	}
	for (const line of renderPreview({ spec, cells, skipped, preview: decided })) console.error(line);
	console.error("");
	const go = await confirm(input, decided.totals.runs);
	if (go !== true) return go;

	const agents = decided.agents.map(({ harness, model }) => ({ harness, model }));
	const record = createRecord({ spec, agents, cells }, input.setsDir);
	console.error(closeTerminalLine(record.id));
	const { waitMinutes } = spec;
	const flow = { client, record, agents, waitMinutes, json, now, sleep, dir: input.setsDir };
	return exitOf(await launchAndReport({ ...flow, runCall: runCall(input) }));
}

// --- view ---

export async function journeySetViewCommand(input: JourneySetViewInput): Promise<number> {
	const { id, json } = input;
	const record = pickUpRecord(id, json, input.setsDir);
	if (!record) return EXIT.USAGE;
	const wait = parseWaitMinutes(input.wait);
	if ("error" in wait) {
		const minutes = placeholder("minutes");
		const call = axCall(["journey", "view", id, "--wait", minutes, ...jsonWords(input)]);
		const next = { call, why: "a whole number of minutes" };
		return fail({ code: "INVALID_WAIT", message: wait.error, next }, EXIT.USAGE, json);
	}
	const waitWords = input.wait ? ["--wait", input.wait] : [];
	const call = axCall(["journey", "view", id, ...waitWords, ...jsonWords(input)]);
	if (!process.env.ORA_API_KEY) {
		const missing = { code: "MISSING_API_KEY", message: GET_A_KEY, next: keyStep(call) };
		return fail(missing, EXIT.USAGE, json);
	}
	const refused = keyRefusal(call, json);
	if (refused !== undefined) return refused;
	const { client, now, sleep } = seams(input);
	try {
		// The key exchange up front, so a rejected key fails here and not after three read rounds.
		await client.scopes();
	} catch (error) {
		if (!isStudioFailure(error)) throw error;
		return platformFailure(error, call, json);
	}
	const flow = { client, record, waitMinutes: wait.value, json, now, sleep };
	return exitOf(await followAndReport(flow));
}
