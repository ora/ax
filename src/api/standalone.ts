import type { JourneyStep } from "./platform";

/** A standalone Studio evaluation, created using POST /ax/v1/runs. */
export interface StandaloneRequest {
	goal: string;
	site?: string;
	agent?: string;
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

/** The member's child-run evidence returned by GET /ax/v1/runs/:setId. */
export interface StandaloneEvidence {
	setId: string;
	runId: string | null;
	run: {
		harness: string;
		model: string;
		outcome: string | null;
		durationMs: number | null;
		numTurns: number | null;
		totalTokens: number | null;
		inputTokens: number | null;
		outputTokens: number | null;
		costUsd: number | null;
		intentSatisfied: boolean | null;
		insightSummary: string | null;
		qualityScore: number | null;
		rubricResults: { criterion: string; passed: boolean; note?: string }[] | null;
		judgeModel: string | null;
		gradedAt: string | null;
	} | null;
	trajectory: { steps: JourneyStep[] } | null;
	insight: JourneyInsight | null;
}
