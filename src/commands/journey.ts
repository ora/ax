import pc from "picocolors";
import { platformBase } from "../api/platform-origins";
import { createSetsClient, type SetDocument } from "../api/sets";
import type { JourneyInsight, StandaloneEvidence } from "../api/standalone";
import { SETS_FEATURE } from "../auth/platform-features";
import { type PlatformCredentials, platformCredentials } from "../auth/resolve-credential";
import { followSet } from "../journey-set/follow-set";
import { onInterrupt } from "../journey-set/interrupt";
import { JourneyProgress } from "../journey-set/journey-progress";
import { LineProgress } from "../journey-set/set-progress";
import { servedBody } from "../report/error-chain";
import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { flow, plain, stdoutWidth } from "../ui/ansi";
import { buildJourneyTree, drawJourneyTree, journeySummary } from "../ui/graph";
import { credentialFailure } from "./credential-failure";
import { DEFAULT_WAIT_MINUTES, INTERRUPTED } from "./journey-set";

export interface JourneyCommandInput {
	intent: string;
	domain?: string;
	harness: string;
	model?: string;
	json: boolean;
}

const wide = () => stdoutWidth(60, 120);

const chipTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function chipCost(usd: number): string {
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

function outcomeLines(run: NonNullable<StandaloneEvidence["run"]>): string[] {
	const won = run.outcome === "success";
	const chips: string[] = [];
	if (run.numTurns != null) chips.push(`${run.numTurns} turns`);
	if (run.durationMs != null) chips.push(`${(run.durationMs / 1000).toFixed(1)}s`);
	if (run.totalTokens != null) chips.push(`${chipTokens(run.totalTokens)} tokens`);
	if (run.costUsd != null) chips.push(chipCost(run.costUsd));

	return [
		"",
		`  ${pc.dim("─".repeat(Math.min(wide() - 4, 52)))}`,
		`  ${won ? pc.green("✓") : pc.red("✗")} ${pc.bold(won ? "completed" : (run.outcome ?? "no outcome recorded"))}${
			chips.length ? `  ${pc.dim(chips.join(" · "))}` : ""
		}`,
	];
}

function gauge(score: number, cells = 22): string {
	const bound = Math.min(100, Math.max(0, score));
	const lit = Math.round((bound / 100) * cells);
	const paint = bound >= 70 ? pc.green : bound >= 50 ? pc.yellow : pc.red;
	return paint("█".repeat(lit)) + pc.dim("░".repeat(cells - lit));
}

function priorityDot(priority?: string): string {
	if (priority === "high") return pc.red("● high  ");
	if (priority === "medium") return pc.yellow("● medium");
	if (priority === "low") return pc.dim("● low   ");
	return pc.dim("●       ");
}

function insightLines(insight: JourneyInsight): string[] {
	const rows: string[] = [""];

	if (insight.visibility_score != null) {
		const score = insight.visibility_score;
		const paint = score >= 70 ? pc.green : score >= 50 ? pc.yellow : pc.red;
		const verdict = insight.intent_satisfied
			? pc.green("✓ intent satisfied")
			: pc.yellow("✗ intent not satisfied");
		rows.push(
			`  ${pc.bold("Visibility")}  ${gauge(score)} ${paint(pc.bold(`${score}/100`))}   ${verdict}`,
		);
	}
	if (insight.summary) {
		rows.push("");
		for (const line of flow(insight.summary, wide() - 4)) rows.push(`  ${pc.dim(line)}`);
	}
	if (insight.friction_points?.length) {
		rows.push("", `  ${pc.bold("Friction")}`);
		for (const point of insight.friction_points) {
			const [first, ...rest] = flow(point, wide() - 6);
			rows.push(`    ${pc.yellow("·")} ${first}`);
			for (const line of rest) rows.push(`      ${line}`);
		}
	}
	if (insight.recommendations?.length) {
		rows.push("", `  ${pc.bold("Recommendations")}`);
		for (const rec of insight.recommendations) {
			rows.push(`    ${priorityDot(rec.priority)}  ${pc.bold(rec.title)}`);
			for (const line of flow(rec.detail, wide() - 8)) rows.push(`      ${pc.dim(line)}`);
		}
	}
	rows.push("");
	return rows;
}

/** Preserve the standalone command’s script fields, and add the Studio evaluation and its judge’s grades. */
function journeyRunJson(
	input: JourneyCommandInput,
	set: SetDocument,
	evidence: StandaloneEvidence,
) {
	const { run, insight } = evidence;
	return {
		setId: set.setId,
		reportUrl: set.links?.set,
		runId: evidence.runId ?? undefined,
		intent: input.intent,
		domain: input.domain,
		harness: run?.harness ?? input.harness,
		model: run?.model,
		outcome: run?.outcome ?? undefined,
		durationMs: run?.durationMs ?? undefined,
		numTurns: run?.numTurns ?? undefined,
		totalTokens: run?.totalTokens ?? undefined,
		inputTokens: run?.inputTokens ?? undefined,
		outputTokens: run?.outputTokens ?? undefined,
		costUsd: run?.costUsd ?? undefined,
		visibilityScore: insight?.visibility_score,
		intentSatisfied: insight?.intent_satisfied ?? run?.intentSatisfied ?? undefined,
		taskSatisfied: insight?.task_satisfied,
		summary: insight?.summary ?? run?.insightSummary ?? undefined,
		keyObservations: insight?.key_observations,
		frictionPoints: insight?.friction_points,
		recommendations: insight?.recommendations,
		journeyLayers: insight?.journey_layers,
		intentCategory: insight?.intent_category,
		steps: evidence.trajectory?.steps ?? [],
		qualityScore: run?.qualityScore ?? undefined,
		rubricResults: run?.rubricResults ?? undefined,
		judgeModel: run?.judgeModel ?? undefined,
		gradedAt: run?.gradedAt ?? undefined,
	};
}

function printRun(input: JourneyCommandInput, set: SetDocument, evidence: StandaloneEvidence) {
	const result = journeyRunJson(input, set, evidence);
	if (input.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	console.log(`  ${journeySummary(result.steps)}`);
	for (const row of drawJourneyTree(buildJourneyTree(result.steps, input.intent, true)))
		console.log(`  ${row}`);
	if (evidence.run) for (const row of outcomeLines(evidence.run)) console.log(row);
	if (evidence.insight) for (const row of insightLines(evidence.insight)) console.log(row);
	if (result.qualityScore !== undefined)
		console.log(`  ${pc.bold("Grade")}  ${result.qualityScore}/100`);
	for (const mark of result.rubricResults ?? []) {
		console.log(
			`    ${mark.passed ? pc.green("✓") : pc.red("✗")} ${plain(mark.criterion)}${mark.note ? ` — ${plain(mark.note)}` : ""}`,
		);
	}
	if (set.error) console.log(`  ${plain(set.error)}`);
	if (result.reportUrl) console.log(`  Report: ${plain(result.reportUrl)}`);
}
/** A caller reading JSON keeps reading JSON on the next call. */
const jsonWords = (input: JourneyCommandInput) => (input.json ? ["--json"] : []);

/** After a run: audit the site it targeted, or name one when the run had none. */
function resultNext(input: JourneyCommandInput): NextStep {
	if (input.domain) {
		return {
			call: axCall(["audit", input.domain, ...jsonWords(input)]),
			why: "the readiness audit: which checks explain what the agent hit",
		};
	}
	return {
		call: axCall(["journey", input.intent, "--domain", placeholder("domain"), ...jsonWords(input)]),
		why: "name the site so the run can be traced back to it",
	};
}

/**
 * A failed launch: a credential's failure reads as it does for every command (no credential is
 * MISSING_API_KEY, which scripts read; a sign-in that ended says ax login); anything else is
 * retried as the same call.
 */
function launchFailure(input: JourneyCommandInput, cause: unknown): CommandError {
	const retry = axCall([
		"journey",
		input.intent,
		...(input.domain ? ["--domain", input.domain] : []),
		"--harness",
		input.harness,
		...(input.model ? ["--model", input.model] : []),
		...jsonWords(input),
	]);
	const otherwise = "with no goal, ax journey --domain <site> runs one of ora's curated tasks free";
	return (
		credentialFailure(cause, { retry, otherwise }) ?? {
			code: "PLATFORM_ERROR",
			message: cause instanceof Error ? cause.message : String(cause),
			next: {
				call: retry,
				why: "retry; if it fails the same way, check your sign-in (ax whoami) or ORA_API_KEY, and ORA_PLATFORM_URL",
			},
		}
	);
}

/** One typed goal creates one Studio evaluation. The same AX credential reads its status and child-run evidence. */
export async function journeyCommand(
	input: JourneyCommandInput,
	deps: { credentials: PlatformCredentials } = { credentials: platformCredentials() },
): Promise<number> {
	let created: SetDocument | undefined;
	const interrupt = onInterrupt();
	try {
		const base = platformBase();
		const credential = deps.credentials.chain.resolve(base, SETS_FEATURE);
		const client = createSetsClient({ base, credential, signal: interrupt.signal });
		created = await client.createRun({
			goal: input.intent,
			...(input.domain !== undefined ? { site: input.domain } : {}),
			agent: input.model ? `${input.harness}/${input.model}` : input.harness,
		});
		console.error(`Evaluation ${created.setId} started.`);
		const { set, end } = await followSet(client, created, {
			interrupt: interrupt.signal,
			waitMinutes: DEFAULT_WAIT_MINUTES,
			watch: true,
			progress:
				!input.json && process.stdout.isTTY
					? new JourneyProgress(client, input.intent)
					: new LineProgress(),
		});
		if (end === "detached" || end === "wait_limit") {
			if (input.json) process.stdout.write(`${JSON.stringify(set, null, 2)}\n`);
			printNext(
				{ call: axCall(["journey", "view", set.setId, ...jsonWords(input)]) },
				{ stderr: input.json },
			);
			return end === "detached" ? INTERRUPTED : 2;
		}
		const evidence = await client.getRun(set.setId);
		printRun(input, set, evidence);
		printNext(resultNext(input), { stderr: input.json });
		return evidence.run?.outcome === "success" ? 0 : 1;
	} catch (cause) {
		if (interrupt.signal.aborted) return INTERRUPTED;
		const error = launchFailure(input, cause);
		if (created)
			error.next = {
				call: axCall(["journey", "view", created.setId, ...jsonWords(input)]),
				why: "open the evaluation already started",
			};
		reportError(error, {
			json: input.json,
			display: (message) => `Journey failed: ${message}`,
			served: servedBody(cause),
		});
		return 2;
	} finally {
		interrupt.stop();
	}
}
