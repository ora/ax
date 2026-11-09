import { describe, expect, it } from "vitest";
// Captured from a real audit-format terminal event (contract 1.8.0,
// example.com, 2026-08-13). Real shape - variations are explicit deltas.
import realAuditScan from "../api/__fixtures__/audit-scan.json";
import type { AuditScanResult } from "../contract";
import { toReport } from "./model";
import { MCP_AUTH_REQUIRED_NOTICE, renderReport } from "./terminal";

const FIXTURE = realAuditScan as unknown as AuditScanResult;

// brand-search-accuracy is a real na row (web search did not reply); the
// delta adds only the marker ora now sends for that cause.
const withUnverified = (): Partial<AuditScanResult> => ({
	layers: FIXTURE.layers.map((layer) => ({
		...layer,
		checks: layer.checks.map((c) =>
			c.id === "brand-search-accuracy" ? { ...c, naKind: "unverified" as const } : c,
		),
	})),
});

const render = (extra: Partial<AuditScanResult> = {}): string =>
	renderReport(toReport({ result: { ...FIXTURE, ...extra } }, "example.com")).join("\n");

describe("renderReport", () => {
	// The legacy marker rides a scored result, so the banner explains the 0/F
	// the header prints right above it. The command's MCP_AUTH_REQUIRED branch
	// has no score to explain and shares the notice without that clause.
	it("explains the 0/F beside the shared notice on a legacy marked result", () => {
		const out = render({ mcpAuthRequired: true, score: 0, grade: "F" });
		expect(out).toContain(MCP_AUTH_REQUIRED_NOTICE);
		expect(out).toContain("0/F means could not evaluate, not failed everything");
		expect(MCP_AUTH_REQUIRED_NOTICE).not.toContain("0/F");
	});

	it("says nothing about the MCP handshake for an ordinary result", () => {
		expect(render()).not.toContain(MCP_AUTH_REQUIRED_NOTICE);
	});

	it("lists an unverified check under Couldn't verify by default, apart from skipped", () => {
		const out = render(withUnverified());
		expect(out).toContain("Couldn't verify (1)");
		expect(out).toContain("1 couldn't verify");
		expect(out).toContain("Brand search not available");
		expect(render()).not.toContain("Couldn't verify");

		const withSkipped = renderReport(
			toReport({ result: { ...FIXTURE, ...withUnverified() } }, "example.com"),
			{ showSkipped: true },
		).join("\n");
		const skippedBlock = withSkipped.slice(withSkipped.indexOf("Skipped ("));
		expect(skippedBlock).not.toContain("Brand search not available");
	});
});
