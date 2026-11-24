import pc from "picocolors";
import { type JourneyInsight, runIsLive, type StandaloneEvidence } from "../api/standalone";
import { flow, plain, stdoutWidth } from "../ui/ansi";
import { buildJourneyTree, drawJourneyTree, journeySummary } from "../ui/graph";

const wide = () => stdoutWidth(60, 120);

const chipTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function chipCost(usd: number): string {
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

function outcomeLines(run: StandaloneEvidence): string[] {
	const won = run.state === "succeeded";
	const chips: string[] = [];
	if (run.numTurns != null) chips.push(`${run.numTurns} turns`);
	if (run.durationMs != null) chips.push(`${(run.durationMs / 1000).toFixed(1)}s`);
	if (run.totalTokens != null) chips.push(`${chipTokens(run.totalTokens)} tokens`);
	if (run.costUsd != null) chips.push(chipCost(run.costUsd));

	return [
		"",
		`  ${pc.dim("─".repeat(Math.min(wide() - 4, 52)))}`,
		`  ${won ? pc.green("✓") : pc.red("✗")} ${pc.bold(won ? "completed" : (run.outcome ?? run.state))}${
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

export function printRun(evidence: StandaloneEvidence, json: boolean): void {
	const { insight } = evidence;
	const steps = evidence.trajectory?.steps ?? [];
	if (json) {
		const result = {
			runId: evidence.runId,
			reportUrl: evidence.reportUrl,
			state: evidence.state,
			intent: evidence.goal,
			domain: evidence.site ?? undefined,
			harness: evidence.harness,
			model: evidence.model ?? undefined,
			outcome: evidence.outcome ?? undefined,
			durationMs: evidence.durationMs ?? undefined,
			numTurns: evidence.numTurns ?? undefined,
			totalTokens: evidence.totalTokens ?? undefined,
			inputTokens: evidence.inputTokens ?? undefined,
			outputTokens: evidence.outputTokens ?? undefined,
			costUsd: evidence.costUsd ?? undefined,
			visibilityScore: insight?.visibility_score,
			intentSatisfied: insight?.intent_satisfied,
			taskSatisfied: insight?.task_satisfied,
			summary: insight?.summary,
			keyObservations: insight?.key_observations,
			frictionPoints: insight?.friction_points,
			recommendations: insight?.recommendations,
			steps,
		};
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	console.log(`  ${journeySummary(steps)}`);
	for (const row of drawJourneyTree(buildJourneyTree(steps, evidence.goal, true)))
		console.log(`  ${row}`);
	if (runIsLive(evidence)) console.log(`  ${evidence.state}`);
	else for (const row of outcomeLines(evidence)) console.log(row);
	if (insight) for (const row of insightLines(insight)) console.log(row);
	if (evidence.reportUrl) console.log(`  Report: ${plain(evidence.reportUrl)}`);
}
