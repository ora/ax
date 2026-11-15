import pc from "picocolors";
import { KeyDestinationError } from "../api/key-destination";
import {
	type JourneyInsight,
	type JourneyRun,
	type JourneyStep,
	launchJourney,
	PlatformApiError,
	type RunSpend,
	type RunSummary,
} from "../api/platform";
import { KEY_DESTINATION_WHY } from "../journey-set/render-preview";
import { type CommandError, reportError } from "../report/json-error";
import { axCall, type NextStep, placeholder, printNext } from "../report/next-line";
import { flow, squeeze, stdoutWidth } from "../ui/ansi";
import {
	buildJourneyTree,
	drawJourneyTree,
	isSearchStep,
	journeySummary,
	splitUrl,
} from "../ui/graph";
import { LivePanel } from "../ui/panel";

export interface JourneyCommandInput {
	intent: string;
	domain?: string;
	harness: string;
	model?: string;
	json: boolean;
}

const wide = () => stdoutWidth(60, 120);

// Present-tense caption for whatever the agent is doing right now.
function activityLabel(step: JourneyStep): string {
	if (step.type === "tool_call") {
		const detail = step.input_display ?? step.summary ?? "";
		if (isSearchStep(step)) return detail ? `searching ${squeeze(detail, 40)}` : "searching…";
		const { host } = splitUrl(detail);
		return host ? `fetching ${host}` : "fetching…";
	}
	if (step.type === "text" && step.kind === "reasoning") return "deciding next step…";
	if (step.type === "text") return "writing the answer…";
	return "working…";
}

const chipTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function chipCost(usd: number): string {
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

function outcomeLines(summary: RunSummary, spend?: RunSpend): string[] {
	const won = summary.outcome === "success";
	const chips: string[] = [];
	if (summary.num_turns != null) chips.push(`${summary.num_turns} turns`);
	if (summary.duration_ms != null) chips.push(`${(summary.duration_ms / 1000).toFixed(1)}s`);
	if (spend?.totalTokens != null) chips.push(`${chipTokens(spend.totalTokens)} tokens`);
	if (spend?.costUsd != null) chips.push(chipCost(spend.costUsd));

	return [
		"",
		`  ${pc.dim("─".repeat(Math.min(wide() - 4, 52)))}`,
		`  ${won ? pc.green("✓") : pc.red("✗")} ${pc.bold(won ? "completed" : summary.outcome)}${
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

function journeyRunJson(run: JourneyRun): string {
	const insight = run.insight ?? {};
	return JSON.stringify(
		{
			runId: run.runId,
			intent: run.intent,
			domain: run.domain,
			harness: run.harness,
			model: run.result?.effective_model ?? run.result?.model,
			outcome: run.result?.outcome,
			durationMs: run.result?.duration_ms,
			numTurns: run.result?.num_turns,
			totalTokens: run.usage?.totalTokens,
			inputTokens: run.usage?.inputTokens,
			outputTokens: run.usage?.outputTokens,
			costUsd: run.usage?.costUsd,
			visibilityScore: insight.visibility_score,
			intentSatisfied: insight.intent_satisfied,
			taskSatisfied: insight.task_satisfied,
			summary: insight.summary,
			keyObservations: insight.key_observations,
			frictionPoints: insight.friction_points,
			recommendations: insight.recommendations,
			journeyLayers: insight.journey_layers,
			intentCategory: insight.intent_category,
			steps: run.trajectory,
		},
		null,
		2,
	);
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
 * A failed launch. `launchJourney` reads the key from ORA_API_KEY, so an unset
 * variable is the missing-key failure; anything else is retried as the same call.
 */
function launchFailure(input: JourneyCommandInput, cause: unknown): CommandError {
	const words = [
		"journey",
		input.intent,
		...(input.domain ? ["--domain", input.domain] : []),
		"--harness",
		input.harness,
		...(input.model ? ["--model", input.model] : []),
		...jsonWords(input),
	];
	const message = cause instanceof Error ? cause.message : String(cause);
	if (!process.env.ORA_API_KEY) {
		return {
			code: "MISSING_API_KEY",
			message,
			next: {
				call: `ORA_API_KEY=<Front API key> ${axCall(words)}`,
				why: "a goal of your own runs on your Front account and needs a Front API key (see the README's Get a key); with no goal, ax journey --domain <site> runs one of ora's curated tasks free",
			},
		};
	}
	if (cause instanceof KeyDestinationError) {
		return {
			code: "KEY_DESTINATION_REFUSED",
			message,
			next: { call: axCall(words), why: KEY_DESTINATION_WHY },
		};
	}
	return {
		code: "PLATFORM_ERROR",
		message,
		next: {
			call: axCall(words),
			why: "retry; if it fails the same way, check ORA_API_KEY and ORA_PLATFORM_URL",
		},
	};
}

// Exit codes: 0 run outcome "success" · 1 finished otherwise · 2 error.
export async function journeyCommand(input: JourneyCommandInput): Promise<number> {
	const request = {
		intent: input.intent,
		domain: input.domain,
		harness: input.harness,
		model: input.model,
	};
	const fail = (cause: unknown): number => {
		const error = launchFailure(input, cause);
		reportError(error, {
			json: input.json,
			display: (message) => `Journey failed: ${message}`,
			served: cause instanceof PlatformApiError ? cause.payload : undefined,
		});
		return 2;
	};

	if (input.json) {
		try {
			const run = await launchJourney(request);
			process.stdout.write(`${journeyRunJson(run)}\n`);
			printNext(resultNext(input), { stderr: true });
			return run.result?.outcome === "success" ? 0 : 1;
		} catch (cause) {
			return fail(cause);
		}
	}

	const panel = new LivePanel();
	let steps: JourneyStep[] = [];
	let settled = false;

	const view = (): string[] => [
		`  ${journeySummary(steps)}`,
		"",
		...drawJourneyTree(buildJourneyTree(steps, input.intent, settled)).map((row) => `  ${row}`),
	];

	console.log();
	console.log(
		`  ${pc.cyan("▶")} ${input.domain ? pc.bold(input.domain) : pc.dim("(no domain)")}  ${pc.dim("·")}  ${pc.dim(input.harness)}`,
	);
	console.log();
	panel.open();
	panel.draw(view(), "waking the agent");

	try {
		const run = await launchJourney(request, {
			snapshot: (latest) => {
				steps = latest;
				const tail = latest[latest.length - 1];
				panel.draw(view(), tail ? activityLabel(tail) : "working");
			},
			finished: () => {
				settled = true;
				panel.draw(view(), "scoring the journey");
			},
		});

		// Swap the live region for a permanent copy, then the finale under it.
		panel.close();
		settled = true;
		if (run.trajectory.length) steps = run.trajectory;
		for (const row of view()) console.log(row);
		if (run.result) for (const row of outcomeLines(run.result, run.usage)) console.log(row);
		if (run.insight) {
			for (const row of insightLines(run.insight)) console.log(row);
		} else if (run.result) {
			console.log(pc.dim("  (insight not available for this run)"));
			console.log();
		}
		printNext(resultNext(input), { stderr: false });
		return run.result?.outcome === "success" ? 0 : 1;
	} catch (cause) {
		panel.close();
		return fail(cause);
	}
}
