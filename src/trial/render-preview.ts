// The words of a trial before it launches: the preview, the refusals, the confirm prompt, the key
// copy, the lines a launch stops with, and the error after reads kept failing. Pure functions that return strings; the
// command prints (and colors) them. Every string the server supplied (agent names, a catalog
// reason, an error message) goes through `plain()` before it is put in a line.

import { StudioApiError, StudioConnectionError, StudioShapeError } from "../api/studio";
import { plain } from "../ui/ansi";
import type { FollowProgress } from "./follow";
import type { LaunchResult } from "./launch";
import type { PreviewResult, Refusal } from "./preview";
import type { PlannedCell, SkippedCell, TrialSpec } from "./spec";

/** Shared copy: the README and the journeys docs page reproduce this word for word. */
export const GET_A_KEY =
	"Trials run on your Front account. Sign up at app.ora.ai with a work email (personal addresses are not accepted), then create an API key in your account settings with these scopes: `journeys:write`, `journeys:read`, `runs:read`, `runs:write`, `intents:read`. Set it as `ORA_API_KEY`. The Free plan includes a monthly number of runs; the preview shows what is left before anything runs.";

/** The code of a 403 that says the key was made for another product. */
export const PRODUCT_NOT_GRANTED_CODE = "PRODUCT_NOT_GRANTED";

export const PRODUCT_NOT_GRANTED_MESSAGE = `This API key was made for another product, so it cannot run trials. Create a key in your Front account settings. ${GET_A_KEY}`;

/** True for the 403 that PRODUCT_NOT_GRANTED_MESSAGE answers. */
export function isProductNotGranted(error: unknown): boolean {
	return (
		error instanceof StudioApiError &&
		error.status === 403 &&
		error.code === PRODUCT_NOT_GRANTED_CODE
	);
}

/** `1 run`, `2 runs`. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `Dec 1`: en-US short month and day, read in UTC so the date is the same on every machine. */
function resetDate(resetsAt: string | null): string | null {
	if (resetsAt === null) return null;
	const date = new Date(resetsAt);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** ` (resets Dec 1)` or nothing, for the sentences that carry the reset date. */
function resetClause(resetsAt: string | null): string {
	const date = resetDate(resetsAt);
	return date === null ? "" : ` (resets ${date})`;
}

type GoPreview = Extract<PreviewResult, { ok: true }>;

export interface PreviewRender {
	spec: TrialSpec;
	cells: readonly PlannedCell[];
	skipped: readonly SkippedCell[];
	preview: GoPreview;
}

/** Levels per task, when every task runs the same number of them; null when they differ. */
function uniformLevels(cells: readonly PlannedCell[]): { tasks: number; levels: number } | null {
	const perTask = new Map<number, number>();
	for (const cell of cells) perTask.set(cell.task, (perTask.get(cell.task) ?? 0) + 1);
	const levels = new Set(perTask.values());
	if (levels.size !== 1) return null;
	return { tasks: perTask.size, levels: [...levels][0] };
}

function totalsSentence({ spec, cells, preview }: PreviewRender): string {
	const { runs } = preview.totals;
	const agents = count(preview.agents.length, "agent");
	const repeats = count(spec.repeat, "repeat");
	const shape = uniformLevels(cells);
	const grid = shape
		? `${count(shape.tasks, "task")} x ${count(shape.levels, "level")}`
		: `${count(cells.length, "task and level pair")}`;
	return `This trial uses ${count(runs, "run")} (${grid} x ${agents} x ${repeats}).`;
}

function allowanceSentence(allowance: GoPreview["allowance"]): string {
	if (allowance.kind === "unlimited") return "Your plan has no monthly run limit.";
	const left = `Your plan has ${count(allowance.remaining, "run")} left this month`;
	return `${left}${resetClause(allowance.resetsAt)}.`;
}

function trackedSentence(site: string, journeys: number): string {
	return `It adds ${plain(site)} to your Front account's tracked sites if it is not there yet (with a daily ora score scan, which does not count against your plan) and ${count(journeys, "journey")} to your journeys list.`;
}

/** The lines shown before the confirm prompt. The command prints the blank lines between groups. */
export function renderPreview(input: PreviewRender): string[] {
	const { spec, skipped, preview } = input;
	const lines = [totalsSentence(input)];
	if (preview.defaultedAgent) {
		const [agent] = preview.agents;
		lines.push(
			`Agent: ${plain(agent.harnessName)} with ${plain(agent.modelName)}, the first one your plan offers. Choose others with --agents.`,
		);
	}
	lines.push(`Brand in the prompts: ${plain(spec.brand)}. Change it with --brand.`);
	for (const skip of skipped) lines.push(plain(skip.note));
	lines.push(allowanceSentence(preview.allowance));
	lines.push(trackedSentence(spec.site, preview.totals.journeys));
	return lines;
}

/** Printed once the record exists, with its real id. */
export function closeTerminalLine(id: string): string {
	return `You can close the terminal; \`ax trial view ${id}\` picks it up.`;
}

/** The question asked before launching. Ends with a space so the answer types after it. */
export function confirmPrompt(runs: number): string {
	return `Launch ${count(runs, "run")}? [y/N] `;
}

function overAllowanceLines(refusal: Extract<Refusal, { kind: "over_allowance" }>): string[] {
	const { runs, remaining, resetsAt, fits } = refusal;
	const lines = [
		`This trial needs ${count(runs, "run")} and your plan has ${count(remaining, "run")} left this month${resetClause(resetsAt)}.`,
	];
	if (fits === null) {
		lines.push(
			"Not even one repeat fits in what is left. Cut tasks or agents, or wait for the reset.",
		);
		return lines;
	}
	const verb = fits.repeat === 1 ? "fits" : "fit";
	lines.push(
		`${count(fits.repeat, "repeat")} ${verb}: ${count(fits.runs, "run")}. Try --repeat ${fits.repeat}.`,
	);
	return lines;
}

/** One refusal in plain words, as one or more lines. */
export function renderRefusal(refusal: Refusal): string[] {
	switch (refusal.kind) {
		case "missing_scopes":
			return [`Your API key is missing these scopes: ${refusal.missing.join(", ")}.`, GET_A_KEY];
		case "unknown_agent":
			return [
				`No agent is named ${plain(refusal.requested)}. --agents takes harness or harness/model.`,
			];
		case "unavailable_agent": {
			const reason = refusal.reason ? plain(refusal.reason).trim().replace(/\.$/, "") : "";
			const why = reason ? `: ${reason}` : "";
			return [`The agent ${plain(refusal.requested)} is not available to your account${why}.`];
		}
		case "duplicate_agent":
			return [
				`${refusal.requested.map(plain).join(" and ")} name the same agent, ${plain(refusal.label)}. Name it once.`,
			];
		case "no_agent_offered":
			return ["No agent is available to your account right now. Check your plan at app.ora.ai."];
		case "over_cap":
			return [
				`This trial would use ${count(refusal.runs, "run")}, and a trial is capped at ${refusal.maxRuns}. Cut tasks, agents or repeats.`,
			];
		case "over_allowance":
			return overAllowanceLines(refusal);
	}
}

/** Every refusal, in the order the preview found them. */
export function renderRefusals(refusals: readonly Refusal[]): string[] {
	return refusals.flatMap(renderRefusal);
}

/** `2 queued, 1 running, 0 finished`, with the slot clause when a run waits for one. */
export function progressLine(progress: FollowProgress): string {
	const line = `${progress.queued} queued, ${progress.running} running, ${progress.finished} finished`;
	return progress.waitingForSlot ? `${line}; waiting for your plan's run slot` : line;
}

/** True when the create that failed may have landed on the platform anyway. */
function lastCreateMayHaveLanded(error: unknown): boolean {
	if (error instanceof StudioApiError) return error.gateway;
	return error instanceof StudioConnectionError || error instanceof StudioShapeError;
}

function errorText(error: unknown): string {
	return plain(error instanceof Error ? error.message : String(error));
}

function notLaunched(n: number): string {
	return `${count(n, "run")} ${n === 1 ? "was" : "were"} not launched.`;
}

const KEEPS_RUNNING = "Runs that started keep running.";

/**
 * Why launching stopped; empty for a launch that ran to the end. The command's Next lines name the
 * commands to run (`view`, `cancel`), so no message here repeats them. After a quota stop the
 * command goes on to follow what started.
 */
export function stopMessage(result: LaunchResult): string[] {
	switch (result.stoppedReason) {
		case undefined:
			return [];
		case "quota":
			return [
				`Your plan's run limit was reached, so launching stopped. ${notLaunched(result.notLaunched)}`,
				result.launchedRuns > 0
					? `Following the ${count(result.launchedRuns, "run")} that started.`
					: "No run started.",
			];
		case "platform_down": {
			const lines = [`The platform is likely down, so launching stopped. ${KEEPS_RUNNING}`];
			if (lastCreateMayHaveLanded(result.lastError)) {
				lines.push(
					"The last journey may have started its runs anyway; they will show in your account's journeys list.",
				);
			}
			return lines;
		}
		case "api_error":
			return [
				`The platform answered with an error, so launching stopped: ${errorText(result.lastError)}`,
				`${notLaunched(result.notLaunched)} ${KEEPS_RUNNING}`,
			];
		case "interrupted":
			return [`Launching stopped. ${notLaunched(result.notLaunched)} ${KEEPS_RUNNING}`];
	}
}

/**
 * After reads kept failing, the last error: the one thing the report's incomplete line cannot say.
 * The command prints it on stderr, before the report or, with no report, before the view line.
 */
export function readFailureMessage(lastError?: unknown): string[] {
	const lines = ["Reading from the platform kept failing."];
	if (lastError !== undefined) lines.push(`The last error: ${errorText(lastError)}`);
	return lines;
}
