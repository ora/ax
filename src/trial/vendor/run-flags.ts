// Copied from ora's journey code. DO NOT EDIT BY HAND.
//
// Source: ora's src/lib/journey/run-flags.ts at commit 075e9fe8f. A trial's
// "blocked" flag has to mean what the free journey's flag means, so this file
// is a COPY of ora's rule rather than a reimplementation of it. One deviation,
// marked inline: the step type. Re-copy the whole directory whenever ora's
// file changes. Biome does not format this directory.

/**
 * Run flags: two honest notes that sit beside a journey verdict and never
 * change it. Derived only from the stored trajectory steps and run signals.
 *
 * - blocked: the site refused the agent's first request that got an HTTP
 *   status (401, 403 or 429), or more than half of those requests. Status
 *   codes only, because the engine sends no signal for bot challenge pages.
 *   404 never counts: agents probe for files that do not exist. A step with
 *   no status (the fetch tool often reports none) is no evidence either way.
 * - answered_from_memory: half or more of the answer's sections came from the
 *   model's memory rather than a page it fetched.
 *
 * Reach is computed here from each step's host, never from the engine's
 * anchor signals: those key on the request's domain, which a run may omit.
 *
 * Pure and browser safe: the run page derives flags from the live result with
 * the same functions REST and MCP use. Type imports only.
 */
import { normalizeDomain } from "./domain-normalize";
// ax deviation: ora's engine-contract module is not vendored; this is the slice of its
// TrajectoryStep the flags read. Studio trajectories send a null status where ora's omit it.
type TrajectoryStep = { url_host?: string | null; status?: number | null };

type FlagStep = Pick<TrajectoryStep, "url_host" | "status">;

/** The fields the flags read. A stored RunResult and its public projection both fit. */
export type RunFlagsInput<S extends FlagStep = FlagStep> = {
  trajectory?: { steps?: readonly S[] };
  run_signals?: { answer_basis?: { memory_share: number } };
};

export type RunFlag = { flagged: boolean; reason?: string };

export type RunFlags = { blocked: RunFlag; answered_from_memory: RunFlag };

/** Why a flag was raised; `runFlagReason` turns it into plain words. */
export type RunFlagCause =
  | { flag: "blocked"; kind: "first_request"; status: number }
  | { flag: "blocked"; kind: "most_requests"; refused: number; answered: number; statuses: number[] }
  | { flag: "answered_from_memory"; memoryShare: number };

const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
const MEMORY_SHARE_THRESHOLD = 0.5;

/** True when `host` is the site or one of its subdomains. */
export function isSiteHost(host: string | null | undefined, site: string | null | undefined): boolean {
  const normalizedSite = normalizeDomain(site);
  const normalizedHost = host?.toLowerCase();
  if (!normalizedSite || !normalizedHost) return false;
  return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
}

/** The run's steps on the site, in trajectory order. */
export function onSiteSteps<S extends FlagStep>(result: RunFlagsInput<S>, site: string | null | undefined): S[] {
  return (result.trajectory?.steps ?? []).filter((step) => isSiteHost(step.url_host, site));
}

/** True when any step reached the site. */
export function reachedSite(result: RunFlagsInput, site: string | null | undefined): boolean {
  return (result.trajectory?.steps ?? []).some((step) => isSiteHost(step.url_host, site));
}

export function deriveRunFlags(result: RunFlagsInput, site: string | null | undefined): RunFlags {
  return {
    blocked: toFlag(blockedCause(result, site)),
    answered_from_memory: toFlag(memoryCause(result)),
  };
}

/** The reasons of the raised flags, in a fixed order (blocked first). */
export function raisedFlagReasons(flags: RunFlags | null | undefined): string[] {
  if (!flags) return [];
  return [flags.blocked, flags.answered_from_memory].flatMap((flag) =>
    flag.flagged && flag.reason ? [flag.reason] : [],
  );
}

/** The one label map from a flag's cause to the words every surface shows. */
export function runFlagReason(cause: RunFlagCause): string {
  if (cause.flag === "answered_from_memory") {
    const portion = cause.memoryShare > MEMORY_SHARE_THRESHOLD ? "Most" : "Half";
    return `${portion} of this answer came from the model's memory, not from pages it fetched`;
  }
  if (cause.kind === "first_request") {
    return `The site refused the agent's first request with HTTP ${cause.status}`;
  }
  return `The site refused ${cause.refused} of the agent's ${cause.answered} requests that got a response, with HTTP ${listStatuses(cause.statuses)}`;
}

function blockedCause(result: RunFlagsInput, site: string | null | undefined): RunFlagCause | null {
  const statuses = onSiteSteps(result, site).flatMap((step) =>
    typeof step.status === "number" ? [step.status] : [],
  );
  if (statuses.length === 0) return null;
  if (REFUSAL_STATUSES.has(statuses[0])) {
    return { flag: "blocked", kind: "first_request", status: statuses[0] };
  }
  const refused = statuses.filter((status) => REFUSAL_STATUSES.has(status));
  if (refused.length * 2 <= statuses.length) return null;
  return {
    flag: "blocked",
    kind: "most_requests",
    refused: refused.length,
    answered: statuses.length,
    statuses: [...new Set(refused)].sort((a, b) => a - b),
  };
}

function memoryCause(result: RunFlagsInput): RunFlagCause | null {
  const memoryShare = result.run_signals?.answer_basis?.memory_share;
  if (typeof memoryShare !== "number" || memoryShare < MEMORY_SHARE_THRESHOLD) return null;
  return { flag: "answered_from_memory", memoryShare };
}

function toFlag(cause: RunFlagCause | null): RunFlag {
  return cause ? { flagged: true, reason: runFlagReason(cause) } : { flagged: false };
}

/** [403] -> "403", [401, 403] -> "401 and 403", [401, 403, 429] -> "401, 403 and 429". */
function listStatuses(statuses: readonly number[]): string {
  if (statuses.length <= 1) return statuses.join("");
  return `${statuses.slice(0, -1).join(", ")} and ${statuses[statuses.length - 1]}`;
}
