/**
 * The terminal report for `ax webmcp-audit`.
 *
 * Thin client (design decision #1): every judgement here arrived decided. The
 * availability verdict, grade, score, pillar scores, evidence coverage, each
 * finding's status and `details`, and the whole simulation come from the server
 * payload and are rendered as given. Nothing in this file re-derives a number
 * or rewrites a sentence.
 *
 * Three distinctions the rendering must not collapse:
 *
 *  - **Availability is a verdict, not a gate.** Whether an agent can use the
 *    page is reported first, with ora's reasons, and never changes the score:
 *    a `not-ready` page still gets its score and pillars. The one case ora
 *    withholds anything is a page with only declarative form tools, whose
 *    grade is withheld beside a numeric score - and its availability reason
 *    already says why.
 *  - **`na` vs `unmeasured`.** `na` means the check had nothing to measure and
 *    the site is not charged for it. `unmeasured` means it applied and was not
 *    measured, and it counts against evidence coverage. Showing both as
 *    "skipped" would erase a line the server draws deliberately.
 *  - **A withheld grade beside a real score.** Below the coverage threshold the
 *    server reports the score and withholds the letter. That is a normal state,
 *    not an error, and the report says why rather than showing a blank.
 *
 * A pillar reading 0 is ambiguous in the same way: it can mean "measured,
 * earned nothing" or "had nothing to measure". `categoryScores` does not
 * distinguish them, so the report reads `applicableCategories`, which ora
 * publishes for exactly this, and marks a pillar it did not measure.
 *
 * A local audit is scored and returned and then forgotten. It is not stored,
 * published, ranked, or reachable by anyone else, and no copy here may suggest
 * it is.
 */

import pc from "picocolors";
import { flow, plain, stdoutWidth } from "../ui/ansi";
import { WEBMCP_CATEGORY_WEIGHTS, WEBMCP_CHECKS } from "./vendor/checks";
import type { PublicWebmcpAudit } from "./vendor/projection";
import type {
	WebmcpAvailability,
	WebmcpCategory,
	WebmcpCheckId,
	WebmcpFinding,
	WebmcpSimulation,
} from "./vendor/types";

export interface WebmcpReportView {
	/** Also list each passing check. */
	showPassing?: boolean;
}

const BAR_CELLS = 12;

/** Order findings are shown in: what is broken first, what was not measured
 * before what did not apply, what passed last. */
const STATUS_ORDER: WebmcpFinding["status"][] = ["fail", "warning", "unmeasured", "na", "pass"];

const STATUS_GLYPH: Record<WebmcpFinding["status"], [string, (s: string) => string]> = {
	fail: ["✖", pc.red],
	warning: ["▲", pc.yellow],
	unmeasured: ["?", pc.magenta],
	na: ["–", pc.dim],
	pass: ["✔", pc.green],
};

const STATUS_HEADING: Record<WebmcpFinding["status"], string> = {
	fail: "Failing",
	warning: "Warnings",
	// The two no-score statuses are named for what they mean, not for the fact
	// that neither scores - that is the whole point of keeping them apart.
	unmeasured: "Not measured",
	na: "Not applicable",
	pass: "Passing",
};

/** The four pillars, in the order the report shows them. */
const PILLARS: WebmcpCategory[] = ["shared-experience", "task-completion", "tool-quality", "trust"];

const PILLAR_TITLE: Record<WebmcpCategory, string> = {
	"shared-experience": "Shared experience",
	"task-completion": "Task completion",
	"tool-quality": "Tool quality",
	trust: "Trust",
};

/**
 * Render the whole report. Returns lines rather than printing so the shape is
 * testable without a terminal.
 */
export function renderWebmcpReport(
	audit: PublicWebmcpAudit,
	view: WebmcpReportView = {},
): string[] {
	const width = stdoutWidth(80, 120);
	return [
		"",
		...header(audit, width),
		"",
		...availabilityBlock(audit.availability, width),
		"",
		...scoreBlock(audit, width),
		"",
		...pillarBlock(audit),
		"",
		...findingsBlock(audit.findings, width, view.showPassing === true),
		...simulationBlock(audit.simulation, width),
		"",
		...footer(audit, width),
	];
}

function header(audit: PublicWebmcpAudit, width: number): string[] {
	// The URL, not the domain: a domain reduces every local project on the
	// machine to "localhost".
	const lines = [`  ${pc.bold(plain(audit.url))}`];
	const tools = `${audit.toolCount} tool${audit.toolCount === 1 ? "" : "s"}`;
	const facts = [verdictLabel(audit.verdict), tools, `Chrome ${plain(audit.chromeVersion)}`];
	if (audit.error) facts.push(pc.red(plain(audit.error)));
	lines.push(`  ${pc.dim(facts.join("  ·  "))}`);
	return lines.map((line) => truncate(line, width));
}

function verdictLabel(verdict: PublicWebmcpAudit["verdict"]): string {
	switch (verdict) {
		case "active":
			return pc.green("active");
		case "testing-only":
		case "declared-inactive":
		case "api-empty":
			return pc.yellow(verdict);
		case "blocked":
		case "load-error":
			return pc.red(verdict);
		default:
			return pc.dim(verdict);
	}
}

/**
 * The availability verdict, first and always. Informational: it never changes
 * the score below it.
 *
 * `reasons[].detail` is rendered verbatim - it is where the server puts the
 * note about a capture whose native-API claim came from the developer's own
 * browser, and the reason a declarative-only page's grade is withheld, and
 * paraphrasing it would drop both.
 */
function availabilityBlock(availability: WebmcpAvailability, width: number): string[] {
	const [label, paint] =
		availability.status === "ready"
			? ["agent-ready", pc.green]
			: availability.status === "not-ready"
				? ["not agent-ready", pc.red]
				: ["availability unknown", pc.yellow];

	const lines = [`  ${paint(pc.bold(label))}`];
	for (const reason of availability.reasons) {
		lines.push(...flow(plain(reason.detail), width - 4).map((row) => `  ${pc.dim(row)}`));
	}
	return lines;
}

function scoreBlock(audit: PublicWebmcpAudit, width: number): string[] {
	const score = audit.score === null ? "—" : String(audit.score);
	const lines = [`  ${pc.bold(`${score}/100`)}  ${gradeLabel(audit)}`];

	// A declarative-only page has its grade withheld whatever the coverage; the
	// availability reason above already says why, so nothing is added here.
	const declarativeOnly = audit.availability.reasons.some((r) => r.id === "declarative-only");
	if (audit.grade === null && audit.score !== null && !declarativeOnly) {
		// Explain rather than show a blank: the reason is a property of this
		// run, and a developer who adds the missing evidence gets the letter.
		lines.push(
			...flow(
				`The grade is withheld because only ${audit.evidenceCoverage}% of the applicable check weight was actually measured. The score above still stands; the "Not measured" checks below are what is missing.`,
				width - 4,
			).map((row) => `  ${pc.dim(row)}`),
		);
	}
	return lines;
}

function gradeLabel(audit: PublicWebmcpAudit): string {
	if (audit.grade !== null) return pc.bold(pc.green(`grade ${audit.grade}`));
	return pc.dim("grade withheld");
}

function pillarBlock(audit: PublicWebmcpAudit): string[] {
	const lines = [`  ${pc.bold("Pillars")}`];
	for (const pillar of PILLARS) {
		const value = audit.categoryScores[pillar] ?? 0;
		const weight = WEBMCP_CATEGORY_WEIGHTS[pillar];
		// A pillar can read 0 because it earned nothing, or because nothing in it
		// could be measured. ora publishes which pillars it measured, so this
		// reads that rather than guessing from the number.
		const measured = audit.applicableCategories.includes(pillar);
		const meter = measured ? bar(value) : pc.dim("░".repeat(BAR_CELLS));
		const note = measured ? `weight ${weight}` : `weight ${weight} · nothing measured`;
		lines.push(
			`    ${PILLAR_TITLE[pillar].padEnd(18)} ${meter} ${String(value).padStart(3)}%  ${pc.dim(note)}`,
		);
	}
	return lines;
}

function bar(percent: number): string {
	const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_CELLS);
	const paint = percent >= 75 ? pc.green : percent >= 40 ? pc.yellow : pc.red;
	return `${paint("█".repeat(filled))}${pc.dim("░".repeat(BAR_CELLS - filled))}`;
}

function findingsBlock(findings: WebmcpFinding[], width: number, showPassing: boolean): string[] {
	const lines: string[] = [`  ${pc.bold("Checks")}`];

	for (const status of STATUS_ORDER) {
		const group = findings.filter((f) => f.status === status);
		if (group.length === 0) continue;
		if (status === "pass" && !showPassing) {
			lines.push(`    ${pc.dim(`${group.length} passing (--show-passing to list)`)}`);
			continue;
		}
		lines.push("", `    ${pc.bold(STATUS_HEADING[status])} (${group.length})`);
		for (const finding of group) lines.push(...finding_(finding, width));
	}

	if (findings.length === 0) lines.push(`    ${pc.dim("no checks reported")}`);
	return lines;
}

function finding_(finding: WebmcpFinding, width: number): string[] {
	const [glyph, paint] = STATUS_GLYPH[finding.status];
	const title = titleFor(finding.checkId);
	// `plain` on every string that started life inside somebody else's page.
	// The server sanitizes too; this does not rely on that, because the cost of
	// being wrong is the reader's terminal.
	const head = `      ${paint(glyph)} ${title}${finding.toolName ? pc.dim(`  ${plain(finding.toolName)}`) : ""}`;
	const lines = [head];
	if (finding.details) {
		lines.push(...flow(plain(finding.details), width - 10).map((row) => `        ${pc.dim(row)}`));
	}
	if (finding.evidence) {
		lines.push(...flow(plain(finding.evidence), width - 10).map((row) => `        ${pc.dim(row)}`));
	}
	return lines;
}

/**
 * The check's human title from the registry. The payload carries ids, not
 * titles, so this is a label lookup - not a judgement. An id this build does
 * not know is shown as the id itself: the server can add a check before the CLI
 * is updated, and dropping an unknown finding would hide it entirely.
 */
function titleFor(checkId: WebmcpCheckId): string {
	return WEBMCP_CHECKS[checkId]?.title ?? checkId;
}

function simulationBlock(simulation: WebmcpSimulation | null, width: number): string[] {
	if (!simulation) return [];
	const lines = ["", `  ${pc.bold("Tool selection")}`];

	if (simulation.skipped) {
		lines.push(
			...flow(
				plain(simulation.skipReason ?? "The selection simulation did not run."),
				width - 4,
			).map((row) => `    ${pc.dim(row)}`),
		);
		return lines;
	}

	const accuracy = Math.round(simulation.accuracy * 100);
	lines.push(
		`    ${accuracy}% of ${simulation.steps.length} intent${simulation.steps.length === 1 ? "" : "s"} picked the right tool  ${pc.dim(plain(simulation.model))}`,
	);
	for (const step of simulation.steps) {
		const [glyph, paint] = step.ok ? STATUS_GLYPH.pass : STATUS_GLYPH.fail;
		const chosen = step.chosenTool ? plain(step.chosenTool) : pc.dim("nothing");
		lines.push(
			`      ${paint(glyph)} ${truncate(plain(step.intent), width - 30)} ${pc.dim("→")} ${chosen}`,
		);
	}
	return lines;
}

function footer(audit: PublicWebmcpAudit, width: number): string[] {
	// About where the CAPTURE came from, not where the page lives: this command
	// audits public URLs too, and "ran against your machine" reads as wrong the
	// moment someone points it at their production site.
	const note =
		audit.source === "local"
			? "Captured by your own browser and scored without being stored — this result is not published or ranked anywhere. Run the audit at webmcp.ora.ai for a public one."
			: "";
	return note ? flow(note, width - 4).map((row) => `  ${pc.dim(row)}`) : [];
}

function truncate(value: string, width: number): string {
	// Length math on the plain string; color is applied to whole lines only, so
	// escapes never enter the arithmetic here.
	return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}
