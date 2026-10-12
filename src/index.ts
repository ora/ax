// The library surface of ax: the same contract-typed client the CLI
// commands use, importable as `import { audit } from "ax"`. The bin
// stays a separate self-contained bundle - this entry ships unminified with
// type declarations and has no runtime dependencies.

export {
	type AgentFile,
	AgentFilesApiError,
	type AgentFilesBundle,
	type AgentFilesOptions,
	fetchAgentFiles,
} from "./api/agent-files";
export {
	AuditApiError,
	type AuditOptions,
	type AuditOutcome,
	type AuditResult,
	performAudit as audit,
} from "./api/audit";
export {
	DeepJourneyApiError,
	type DeepJourneyOptions,
	type DeepJourneyOutcome,
	fetchJourneyAgents,
	fetchJourneyIntents,
	type JourneyAgentOption,
	type JourneyIntentOption,
	performDeepJourney as deepJourney,
	type RunAllowance,
} from "./api/deep-journey";
export {
	type FetchedSkill,
	fetchSkill,
	fetchSkillIndex,
	SkillApiError,
	type SkillEntry,
} from "./api/skills";
export {
	type AuditCheck,
	type AuditLayer,
	type AuditScanResult,
	type AuditScoreResult,
	type AuditTopFix,
	BUILT_AGAINST,
	isNewerContract,
	type JourneyCappedRun,
	type JourneyRun,
	type JourneyRunDetail,
	type JourneyRunResult,
	type JourneyTrajectoryStep,
} from "./contract";
