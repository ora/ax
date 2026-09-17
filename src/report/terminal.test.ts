import { describe, expect, it } from "vitest";
// Captured from a real audit-format terminal event (contract 1.8.0,
// example.com, 2026-08-13). Real shape - variations are explicit deltas.
import realAuditScan from "../api/__fixtures__/audit-scan.json";
import type { AuditScanResult } from "../contract";
import { toReport } from "./model";
import { MCP_AUTH_REQUIRED_NOTICE, renderReport } from "./terminal";

const FIXTURE = realAuditScan as unknown as AuditScanResult;

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
});
