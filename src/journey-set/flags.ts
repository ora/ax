import { deriveRunFlags, type RunFlag, reachedSite } from "./vendor/run-flags";

export { isSiteHost, type RunFlag } from "./vendor/run-flags";

/** A trajectory step as Studio returns it; only the host and status are read. */
export type SetStep = { url_host?: string | null; status?: number | null };

export type SetFlags = { blocked: RunFlag; never_visited: RunFlag };

/**
 * The two notes a set prints beside a run's verdict; they never change it.
 * "Blocked" is ora's own rule (vendored), so it means what the free journey's
 * flag means. ora's memory flag has no Studio source, so a set raises
 * "never visited" in its place.
 */
export function deriveSetFlags(steps: readonly SetStep[], site: string): SetFlags {
	const result = { trajectory: { steps } };
	return {
		blocked: deriveRunFlags(result, site).blocked,
		never_visited: reachedSite(result, site)
			? { flagged: false }
			: { flagged: true, reason: `The agent never opened a page on ${site}.` },
	};
}
