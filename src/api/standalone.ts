import type { JourneyStep } from "./platform";

/** A standalone Studio evaluation, created using POST /ax/v1/runs. */
export interface StandaloneRequest {
	goal: string;
	site?: string;
	agent?: string;
	model?: string;
}
export interface InsightRecommendation {
	title: string;
	detail: string;
	priority?: string;
}

export interface JourneyInsight {
	summary?: string;
	outcome?: string;
	visibility_score?: number;
	intent_satisfied?: boolean;
	task_satisfied?: string;
	key_observations?: string[];
	friction_points?: string[];
	recommendations?: InsightRecommendation[];
	intent_category?: string;
	journey_layers?: string[];
	/** Usage of the analyzer that produced the insight — not the run itself. */
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface StandaloneRun {
	runId: string;
	goal: string;
	site: string | null;
	harness: string;
	model: string | null;
	state:
		| "queued"
		| "pending"
		| "in_progress"
		| "succeeded"
		| "failed"
		| "timeout"
		| "error"
		| "canceled";
	createdAt: string;
	reportUrl: string | null;
}

/** Native evidence recorded for this run. The analyzer can finish after execution. */
export interface StandaloneEvidence extends StandaloneRun {
	outcome: string | null;
	durationMs: number | null;
	numTurns: number | null;
	totalTokens: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	trajectory: { steps: JourneyStep[] } | null;
	insight: JourneyInsight | null;
}

export function runIsLive(run: StandaloneRun): boolean {
	return ["queued", "pending", "in_progress"].includes(run.state);
}
