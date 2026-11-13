import type { JourneyStep } from "./platform";

// Wire shapes of the Studio endpoints a trial calls on the ora platform, read from the public
// OpenAPI spec (`/studio/v1/*`). Where the spec is loose (the trajectory and insight bodies are
// `{}`, a create's 502 and the quota guard's 402 are not listed) the shape comes from the service
// code and is named where it is used, in ./studio.ts.

/**
 * Every scope a trial needs, one per call: create (`journeys:write`), journey reads
 * (`journeys:read`), trajectory and insight reads (`runs:read`), cancel (`runs:write`), and the
 * agents and usage reads (`intents:read`).
 */
export const STUDIO_SCOPES = [
	"journeys:write",
	"journeys:read",
	"runs:read",
	"runs:write",
	"intents:read",
] as const;

export type StudioScope = (typeof STUDIO_SCOPES)[number];

/** One agent (harness and model) the organization can run, from `GET /studio/v1/agents`. */
export interface StudioAgent {
	harness: string;
	harnessName: string;
	model: string;
	modelName: string;
	provider: string;
	available: boolean;
	/** Why the agent is unavailable (a plan that does not include it); null when available. */
	reason: string | null;
}

export interface UsageMeter {
	used: number;
	/** Null when the plan sets no limit. */
	limit: number | null;
	/** Null when the plan sets no limit. */
	remaining: number | null;
}

/** This month's allowance, from `GET /studio/v1/usage`. */
export interface StudioUsage {
	runs: UsageMeter;
	/** `used` is null when the plan sets no scan limit. */
	scans: { used: number | null; limit: number | null; remaining: number | null };
	/** ISO time the counts reset; null when unknown. */
	resetsAt: string | null;
}

/** An explicit agent pair; ax always sends the catalog's model. */
export interface StudioAgentPair {
	harness: string;
	model: string;
}

export interface CreateJourneyInput {
	goal: string;
	agents: StudioAgentPair[];
	/** The site, never empty: an empty one falls back to the organization's tracked domain. */
	targetDomain: string;
}

/** One agent a create could not start. `model` is sent by the service though the spec omits it. */
export interface CreateFailure {
	harness: string;
	model?: string;
	site?: string;
	reason: string;
}

/** A create that started at least one agent. `failed` is empty on a clean create. */
export interface CreatedJourney {
	journeyId: string;
	runIds: string[];
	streamUrls: string[];
	failed: CreateFailure[];
}

/** Studio's 502 on create: no agent started, and the body still names the journey. */
export interface NotStartedJourney {
	journeyId: string;
	failed: CreateFailure[];
}

export interface JourneyRunUsage {
	durationMs: number | null;
	totalTokens: number | null;
	inputTokens: number | null;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
	outputTokens: number | null;
	numTurns: number | null;
	costUsd: number | null;
}

/** One agent's run inside a journey read. */
export interface JourneyAgentRun {
	runId: string;
	harness: string;
	model: string | null;
	/** Raw run status; the trial's outcome rules classify it. */
	status: string;
	targetDomain: string | null;
	provider: string | null;
	executionKind: string | null;
	intentText: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
	usage: JourneyRunUsage;
	/** Target pages check; ax reads none of it. */
	targetCheck: unknown;
	/** Skill use; ax reads none of it. */
	skillUse: unknown;
	/**
	 * `succeeded`, `partial`, `failed` or `not_measured` in the spec, null while the run is in
	 * flight. Typed as a string so a value the spec does not list is kept raw, never guessed.
	 */
	verdict: string | null;
}

/** One journey and its per-agent runs, from `GET /studio/v1/journeys/{id}`. */
export interface JourneyDetail {
	id: string;
	goal: string;
	targetDomain: string | null;
	status: string;
	outcome: string | null;
	competitors: string[];
	layer: string | null;
	intentId: string | null;
	intentTitle: string | null;
	createdAt: string;
	updatedAt: string;
	agents: JourneyAgentRun[];
}

/** The answer of `POST /studio/v1/runs/cancel`; every requested id lands in one list. */
export interface CancelResult {
	requested: number;
	canceled: string[];
	alreadyTerminal: string[];
	skipped: string[];
}

export type TrajectoryProfile = "raw" | "heuristic" | "full";

/** A run's normalized trajectory; the body carries more aggregates than the steps ax reads. */
export interface StudioTrajectory {
	steps: JourneyStep[];
}

export interface StudioClientOptions {
	/** The ora_sk_ account key; falls back to $ORA_API_KEY. */
	apiKey?: string;
	/** Platform API base; falls back to $ORA_PLATFORM_URL, then production. */
	baseUrl?: string;
	/** Millisecond clock the bearer refresh reads; tests inject one. */
	now?: () => number;
}

export interface StudioClient {
	/** The scopes the key's bearer carries. */
	scopes(): Promise<string[]>;
	agents(): Promise<StudioAgent[]>;
	usage(): Promise<StudioUsage>;
	/** Any 2xx is a create that started at least one agent; every non-2xx throws StudioApiError. */
	createJourney(input: CreateJourneyInput): Promise<CreatedJourney>;
	journey(id: string): Promise<JourneyDetail>;
	trajectory(runId: string): Promise<StudioTrajectory>;
	/** True once the insight reads 200, false while it is not ready; throws on anything else. */
	insightLanded(runId: string): Promise<boolean>;
	cancelRuns(runIds: readonly string[]): Promise<CancelResult>;
}
