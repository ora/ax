import pc from "picocolors";
import type { Report, ReportSection } from "./model";

// Layered terminal report: a scored header, one block per layer with a pass
// bar, a bordered issues grid, and the payload's server-ranked Top fixes list
// rendered verbatim (thin client: ora owns the ranking). All wrapping happens
// on plain text; styling is applied to whole cell lines afterwards so escape
// codes never enter the width arithmetic.

export interface ReportView {
	/** Also list not-applicable / pending checks. */
	showSkipped?: boolean;
	/** Also list each passing check (the layer bar is the default signal). */
	showPassing?: boolean;
	/** The audit ran against a tunnel to a local target (scoped banner). */
	tunnel?: boolean;
}

type Paint = (s: string) => string;
type CellValue = string | [string, Paint];

/**
 * One line of copy for an auth-gated MCP target, shared by the report banner
 * (a stored result still carrying the legacy `mcpAuthRequired` marker) and by
 * the command's MCP_AUTH_REQUIRED branch, so the two paths never drift.
 */
export const MCP_AUTH_REQUIRED_NOTICE =
	"⚠ MCP handshake requires credentials — target is unscored (0/F means could not evaluate, not failed everything)";

const FLOOR_WIDTH = 80;
const CEIL_WIDTH = 120;
const BAR_CELLS = 10;

function reportWidth(): number {
	return Math.min(CEIL_WIDTH, Math.max(FLOOR_WIDTH, process.stdout.columns ?? 100));
}

function padTo(value: string, span: number): string {
	return value.length < span ? value + " ".repeat(span - value.length) : value;
}

// Wrap at word boundaries; a single token wider than the column (long URLs)
// gets chopped at the column edge rather than blowing up the table.
function hardWrap(value: string, span: number): string[] {
	if (span <= 0 || value.length <= span) return [value];
	const rows: string[] = [];
	let row = "";
	for (const token of value.split(/\s+/)) {
		row = row ? `${row} ${token}` : token;
		while (row.length > span) {
			const gap = row.lastIndexOf(" ");
			if (gap > 0 && row.length - gap - 1 <= span) {
				rows.push(row.slice(0, gap));
				row = row.slice(gap + 1);
			} else {
				rows.push(row.slice(0, span));
				row = row.slice(span);
			}
		}
	}
	if (row) rows.push(row);
	return rows.length ? rows : [""];
}

// --- Grid table ---

interface Col {
	title: string;
	width: number;
	paint?: Paint;
}

function tableLines(cols: Col[], rows: CellValue[][]): string[] {
	const rule = (left: string, joint: string, right: string) =>
		pc.dim(left + cols.map((c) => "─".repeat(c.width + 2)).join(joint) + right);
	const edge = pc.dim("│");

	const paintRow = (cells: CellValue[], override?: Paint): string[] => {
		const wrapped = cells.map((cell, i) =>
			hardWrap(typeof cell === "string" ? cell : cell[0], cols[i].width),
		);
		const tall = Math.max(1, ...wrapped.map((w) => w.length));
		const out: string[] = [];
		for (let line = 0; line < tall; line++) {
			const segments = wrapped.map((w, i) => {
				const padded = padTo(w[line] ?? "", cols[i].width);
				const paint =
					override ??
					(typeof cells[i] === "string" ? cols[i].paint : (cells[i] as [string, Paint])[1]);
				return ` ${paint ? paint(padded) : padded} `;
			});
			out.push(edge + segments.join(edge) + edge);
		}
		return out;
	};

	const lines = [rule("┌", "┬", "┐")];
	lines.push(
		...paintRow(
			cols.map((c) => c.title),
			pc.bold,
		),
	);
	lines.push(rule("├", "┼", "┤"));
	rows.forEach((row, i) => {
		lines.push(...paintRow(row));
		if (i < rows.length - 1) lines.push(rule("├", "┼", "┤"));
	});
	lines.push(rule("└", "┴", "┘"));
	return lines;
}

// Issues grid: glyph · Check · What's wrong · How to fix. The two prose
// columns split the remaining room evenly, never dropping under 14 chars; the
// Check column shrinks (to no less than 12) before prose does.
function issueCols(term: number, names: string[]): Col[] {
	const chrome = 4 * 2 + 5; // per-cell padding + vertical rules
	const room = Math.max(46, term - 4 - chrome); // -4: the block indent
	const floor = 14;
	let name = Math.min(26, Math.max("Check".length, ...names.map((n) => n.length)));
	let free = room - 1 - name;
	if (free < floor * 2) {
		name = Math.max(12, name - (floor * 2 - free));
		free = room - 1 - name;
	}
	const wrong = Math.max(floor, Math.ceil(free / 2));
	const fix = Math.max(floor, free - wrong);
	return [
		{ title: "", width: 1 },
		{ title: "Check", width: name, paint: pc.bold },
		{ title: "What's wrong", width: wrong },
		{ title: "How to fix", width: fix, paint: pc.cyan },
	];
}

function pairCols(term: number, names: string[], titles: [string, string], paint?: Paint): Col[] {
	const chrome = 2 * 2 + 3;
	const room = Math.max(40, term - 4 - chrome);
	const name = Math.min(30, Math.max(titles[0].length, ...names.map((n) => n.length)));
	return [
		{ title: titles[0], width: name, paint },
		{ title: titles[1], width: Math.max(20, room - name), paint },
	];
}

// --- Section pieces ---

function meter(passed: number, total: number): string {
	if (total <= 0) return pc.dim("─".repeat(BAR_CELLS));
	const lit = Math.min(BAR_CELLS, Math.max(0, Math.round((passed / total) * BAR_CELLS)));
	return pc.green("█".repeat(lit)) + pc.dim("░".repeat(BAR_CELLS - lit));
}

function sectionLines(
	section: ReportSection,
	term: number,
	label: number,
	view: ReportView,
): string[] {
	const lines: string[] = [""];

	const tally =
		section.total > 0 ? `${section.passed}/${section.total} passed` : "no applicable checks";
	const skipTail = section.skipped > 0 ? ` · ${section.skipped} skipped` : "";
	lines.push(
		`  ${pc.bold(padTo(section.name, label))}  ${meter(section.passed, section.total)} ${pc.dim(tally + skipTail)}`,
	);

	// Payload order throughout: ora already orders checks, and the ranked view
	// is the Top fixes list - re-sorting here would re-derive interpretation.
	const issues = section.checks.filter((c) => !c.passed && !c.skipped);
	if (issues.length) {
		lines.push(`    ${pc.red("✗")} ${pc.bold(`Issues (${issues.length})`)}`);
		const grid = tableLines(
			issueCols(
				term,
				issues.map((c) => c.name),
			),
			issues.map((c) => [
				c.status === "warning" ? ["⚠", pc.yellow] : ["✗", pc.red],
				c.name,
				[c.detail ?? "", (s: string) => s],
				c.hint ?? "",
			]),
		);
		lines.push(...grid.map((row) => `    ${row}`));
		const specs = issues.filter((c) => c.specUrl);
		for (const c of specs) {
			lines.push(pc.dim(`      ↳ ${c.id} spec: ${c.specUrl}`));
		}
	}

	if (view.showPassing) {
		const passing = section.checks.filter((c) => c.passed && !c.skipped);
		if (passing.length) {
			lines.push(`    ${pc.green("✓")} ${pc.bold(`Passed (${passing.length})`)}`);
			const grid = tableLines(
				pairCols(
					term,
					passing.map((c) => c.name),
					["Check", "Details"],
				),
				passing.map((c) => [c.name, c.detail ?? ""]),
			);
			lines.push(...grid.map((row) => `    ${row}`));
		}
	}

	if (view.showSkipped) {
		const skipped = section.checks.filter((c) => c.skipped);
		if (skipped.length) {
			lines.push(`    ${pc.dim(`○ Skipped (${skipped.length})`)}`);
			const grid = tableLines(
				pairCols(
					term,
					skipped.map((c) => c.name),
					["Check", "Reason"],
					pc.dim,
				),
				skipped.map((c) => [c.name, c.detail ?? ""]),
			);
			lines.push(...grid.map((row) => `    ${row}`));
		}
	}

	return lines;
}

// The payload's server-ranked fix list, order untouched. `≈` on every figure:
// estScoreGain is an estimate, and some fixes (bonus surfaces on an empty
// layer) have no estimable uplift at all.
function topFixLines(report: Report): string[] {
	if (!report.topFixes.length) return [];
	const lines = ["", `  ${pc.bold("Top fixes")} ${pc.dim("(ranked by ora)")}`];
	const idWidth = report.topFixes.reduce((w, f) => Math.max(w, f.id.length), 0);
	report.topFixes.forEach((fix, i) => {
		const gain =
			typeof fix.estScoreGain === "number" ? pc.green(`≈ +${fix.estScoreGain} pts`) : pc.dim("—");
		const bonus = fix.bonus ? pc.dim(" (bonus)") : "";
		lines.push(`  ${i + 1}. ${pc.bold(padTo(fix.id, idWidth))}  ${gain}${bonus}`);
	});
	return lines;
}

function cacheAge(seconds: number): string {
	if (seconds < 90) return `${seconds}s`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
	return `${Math.round(seconds / 3600)}h`;
}

export function renderReport(report: Report, view: ReportView = {}): string[] {
	const term = reportWidth();
	const label = report.sections.reduce((widest, s) => Math.max(widest, s.name.length), 0);

	const lines: string[] = [""];
	const scorePaint = report.score >= 70 ? pc.green : report.score >= 50 ? pc.yellow : pc.red;
	lines.push(
		`  ${pc.bold(report.target)}  ${scorePaint(pc.bold(`${report.score}/100 ${report.grade}`))}`,
	);
	if (view.tunnel) {
		lines.push(
			pc.dim(
				"  tunnel audit — disposable result, excluded from rankings; off-site checks (registry listings, brand search) usually fail for a throwaway hostname",
			),
		);
	}
	if (report.mcpAuthRequired) {
		lines.push(pc.yellow(`  ${MCP_AUTH_REQUIRED_NOTICE}`));
	}
	if (report.summary) {
		for (const row of hardWrap(report.summary, term - 4)) lines.push(`  ${pc.dim(row)}`);
	}

	for (const section of report.sections) {
		lines.push(...sectionLines(section, term, label, view));
	}

	lines.push(...topFixLines(report));

	// Remind about whatever the default view left out.
	const passing = report.sections.reduce((n, s) => n + s.passed, 0);
	const skipped = report.sections.reduce((n, s) => n + s.skipped, 0);
	const reminders: string[] = [];
	if (!view.showPassing && passing > 0) {
		reminders.push(`  Run with --show-passing to list all ${passing} passing checks`);
	}
	if (!view.showSkipped && skipped > 0) {
		reminders.push(
			`  ${skipped} check${skipped === 1 ? "" : "s"} skipped — run with --show-skipped to see them`,
		);
	}
	if (report.analysisStatus === "partial") {
		reminders.push("  Analysis still finishing — re-run shortly for the final score");
	} else if (report.analysisStatus === "stuck") {
		reminders.push("  Scan did not fully resolve — re-run with --force to complete it");
	}
	if (typeof report.cacheAgeSeconds === "number") {
		reminders.push(
			`  cached result (${cacheAge(report.cacheAgeSeconds)} old) · pass --force for a fresh scan`,
		);
	}
	if (report.reportUrl) reminders.push(`  Full report: ${report.reportUrl}`);
	if (reminders.length) {
		lines.push("");
		for (const reminder of reminders) lines.push(pc.dim(reminder));
	}
	lines.push("");
	return lines;
}
