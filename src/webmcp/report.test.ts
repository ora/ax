import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderWebmcpReport } from "./report";
import type { PublicWebmcpAudit } from "./vendor/projection";

const AUDIT = (
	JSON.parse(
		readFileSync(new URL("./__fixtures__/local-catalogue-audit.json", import.meta.url), "utf8"),
	) as { audit: PublicWebmcpAudit }
).audit;

/**
 * Rendered lines as one plain, whitespace-collapsed string.
 *
 * Both steps are needed. The renderer wraps prose to the terminal width, so a
 * phrase can straddle a line; and it colours whole lines, so SGR escapes sit
 * between the words - and whether picocolors emits them at all depends on
 * whether stdout is a TTY, which differs between a local run and CI. Asserting
 * on raw output passes in one and fails in the other.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const ANSI = /\u001b\[[0-9;]*m/g;
const flat = (lines: string[]) => lines.join(" ").replace(ANSI, "").replace(/\s+/g, " ");

/** Neutralise ESC the same way the renderer's `plain` does, so a payload can be
 * rendered twice - once hostile, once already-safe - and compared. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralising ESC is the point
const ESC = /\u001b/g;
const despatch = (value: string) => value.replace(ESC, " ");

describe("renderWebmcpReport", () => {
	it("keeps a withheld grade beside a real score, and says why", () => {
		// The fixture's own state: coverage 51 sits under the threshold, so ora
		// reports the score and withholds the letter. Rendering that as a blank,
		// or as an error, would misreport a normal outcome.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toContain("73/100");
		expect(out).toContain("grade withheld");
		expect(out).toMatch(/only 51% of the applicable check weight/);
	});

	it("leads with the availability verdict and renders its reasons verbatim", () => {
		// Its `detail` is where the server puts the note about a native-API claim
		// that came from the developer's own browser, and why a declarative-only
		// page's grade is withheld. Paraphrasing it would drop both.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toContain("agent-ready");
		expect(out).toContain(AUDIT.availability.reasons[0].detail.slice(0, 60));
	});

	it("keeps the score and pillars for a page that is not agent-ready", () => {
		// Availability is informational on ora: it never gates the score. A
		// not-ready page is reported with its reasons AND its scorecard.
		const notReady = {
			...AUDIT,
			availability: {
				status: "not-ready" as const,
				reasons: [
					{
						id: "stub-tools" as const,
						detail: "None of the registered tools declares an execute handler.",
					},
				],
			},
		};
		const out = flat(renderWebmcpReport(notReady));
		expect(out).toContain("not agent-ready");
		expect(out).toContain("None of the registered tools declares an execute handler.");
		expect(out).toContain("73/100");
		expect(out).toContain("Pillars");
		expect(out).not.toMatch(/No score is reported/);
	});

	it("lets the declarative-only reason explain a withheld grade", () => {
		// ora withholds the grade of a declarative-only page whatever its
		// coverage, and says why in the availability reason. The coverage
		// sentence would give the wrong cause.
		const detail = "This page exposes only declarative form tools.";
		const declarativeOnly = {
			...AUDIT,
			grade: null,
			evidenceCoverage: 90,
			availability: {
				status: "not-ready" as const,
				reasons: [{ id: "declarative-only" as const, detail }],
			},
		};
		const out = flat(renderWebmcpReport(declarativeOnly));
		expect(out).toContain(detail);
		expect(out).toContain("73/100");
		expect(out).toContain("grade withheld");
		expect(out).not.toMatch(/of the applicable check weight/);
	});

	it("marks a pillar that reads 0 because nothing in it was measured", () => {
		// task-completion is 0 in this fixture because nothing in it was measured
		// (tool-selection unmeasured, the invoke checks not applicable). That is
		// not a measured zero; ora says so in `applicableCategories`.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toMatch(/Task completion .*nothing measured/);
		expect(out).toMatch(/Trust .*weight 20/);
		expect(out).not.toMatch(/Trust .*nothing measured/);
	});

	it("names the four pillars, not the retired categories", () => {
		const out = flat(renderWebmcpReport(AUDIT));
		for (const pillar of ["Shared experience", "Task completion", "Tool quality", "Trust"]) {
			expect(out).toContain(pillar);
		}
		expect(out).not.toMatch(/WebMCP use|Usefulness|Human experience/);
	});

	it("shows na and unmeasured as different things", () => {
		// The server draws this line deliberately: `na` is not charged, while
		// `unmeasured` counts against coverage. One "skipped" bucket would erase it.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toContain("Not measured");
		expect(out).toContain("Not applicable");
	});

	it("never claims a local audit was published or ranked", () => {
		// Collapsed, because the footer is wrapped prose: asserting on the raw
		// join would break the moment a phrase straddles a line.
		const out = flat(renderWebmcpReport(AUDIT));
		expect(out).toMatch(/not published or ranked anywhere/);
		expect(out).toMatch(/scored without being stored/);
		// It says where the capture came from, not where the page lives - this
		// command audits public URLs too.
		expect(out).not.toMatch(/ran against your machine/);
	});

	it("hides passing checks until asked, then lists them", () => {
		expect(flat(renderWebmcpReport(AUDIT))).toMatch(/passing \(--show-passing to list\)/);
		expect(flat(renderWebmcpReport(AUDIT, { showPassing: true }))).toMatch(/Passing \(\d+\)/);
	});

	it("strips terminal control characters out of page-authored text", () => {
		// Verified against a real capture: a page can register a tool whose name and
		// description carry ANSI sequences, and they survive the shim intact. An
		// erase-display sequence reaching the terminal would blank the report the
		// reader is looking at.
		const hostile = {
			...AUDIT,
			findings: [
				{
					...AUDIT.findings[0],
					// `fail` so it is rendered: passing checks are hidden by default,
					// and a hidden finding would make this assert nothing.
					status: "fail" as const,
					toolName: "search\u001b[31m",
					details: "line one\u001b[2Jcleared",
					evidence: "evidence\u001b[1m",
				},
			],
		};
		// Compared against the SAME payload with the escapes already replaced by
		// spaces: if the two render identically, the page's control bytes reached
		// nothing. Asserting "no ESC in the output" instead would be wrong - the
		// renderer emits its own SGR colour, and whether picocolors is enabled
		// depends on whether stdout is a TTY, which differs between a local run
		// and CI.
		const benign = {
			...hostile,
			findings: hostile.findings.map((f) => ({
				...f,
				toolName: f.toolName === null ? null : despatch(f.toolName),
				details: despatch(f.details),
				evidence: f.evidence === null ? null : despatch(f.evidence),
			})),
		};
		expect(renderWebmcpReport(hostile)).toEqual(renderWebmcpReport(benign));

		// And specifically: the erase-display sequence, which would blank the
		// report the reader is looking at, never survives.
		expect(renderWebmcpReport(hostile).join("\n")).not.toContain("\u001b[2J");

		// The words themselves are still there - this strips control bytes, it
		// does not rewrite what the server said.
		const out = flat(renderWebmcpReport(hostile));
		expect(out).toContain("cleared");
		expect(out).toContain("search");
	});
});
