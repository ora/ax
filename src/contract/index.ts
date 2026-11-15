import type { components } from "./types.gen";
import { BUILT_AGAINST } from "./version";

// The hand-written face of the generated contract: friendly aliases for the
// schemas the CLI consumes, plus the runtime newer-contract warning. Only this
// module imports from types.gen.ts directly.

export type AuditScanResult = components["schemas"]["AuditScanResult"];
export type AuditScoreResult = components["schemas"]["AuditScoreResult"];
export type AuditCheck = components["schemas"]["AuditCheck"];
export type AuditLayer = components["schemas"]["AuditLayer"];
export type AuditTopFix = AuditScanResult["topFixes"][number];

export type JourneyRun = components["schemas"]["JourneyRun"];
export type JourneyCappedRun = components["schemas"]["JourneyCappedRun"];
export type JourneyRunDetail = components["schemas"]["JourneyRunDetail"];
export type JourneyRunResult = components["schemas"]["JourneyRunResult"];
export type JourneyTrajectoryStep = components["schemas"]["JourneyTrajectoryStep"];
export type JourneyNextAction = components["schemas"]["JourneyNextAction"];

export { BUILT_AGAINST };

function minor(version: string): [number, number] {
	const [major = 0, min = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
	return [major, min];
}

/**
 * True when the server reports a newer contract (major or minor) than the one
 * this build was generated against. Patch drift is spec-prose only - silent.
 */
export function isNewerContract(payloadVersion: string | undefined): boolean {
	if (!payloadVersion || !/^\d+\.\d+\.\d+$/.test(payloadVersion)) return false;
	const [serverMajor, serverMinor] = minor(payloadVersion);
	const [builtMajor, builtMinor] = minor(BUILT_AGAINST);
	return serverMajor > builtMajor || (serverMajor === builtMajor && serverMinor > builtMinor);
}

let warned = false;

/** One stderr line per process when the server's contract is newer than ours. */
export function warnOnNewerContract(payloadVersion: string | undefined): void {
	if (warned || !isNewerContract(payloadVersion)) return;
	warned = true;
	process.stderr.write(
		`ora reports contract ${payloadVersion}; this CLI was built against ${BUILT_AGAINST}. ` +
			"Newer fields may be missing from the output - upgrade with: npm i -g ax@latest\n",
	);
}

/** Test hook: reset the once-per-process warning latch. */
export function resetContractWarning(): void {
	warned = false;
}
