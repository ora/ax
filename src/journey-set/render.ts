import type { SetCell, SetDocument, SetList, SetPreview } from "../api/sets";
import { plain } from "../ui/ansi";

// The preview and the report as text. Every number printed is one the platform served; this
// module chooses words, alignment and order, never a count or a rate (ax invariant 1). Text the
// platform sent is passed through `plain` so it cannot move the cursor.

const pad = (value: string, width: number): string =>
	value + " ".repeat(Math.max(0, width - value.length));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The preview a person reads before anything is launched. */
export function renderPreview(preview: SetPreview): string {
	const lines: string[] = [`${preview.site}: a set of journeys`];
	for (const goal of preview.goals) lines.push(`  Goal ${goal.index}: ${plain(goal.text)}`);
	if (preview.brand !== null) lines.push(`  Brand: ${plain(preview.brand)}`);
	lines.push("  Levels:");
	for (const level of preview.levels) {
		lines.push(
			`    ${pad(plain(level.label), 14)}${level.prompt === null ? "the goal as written" : `the goal, then "${plain(level.prompt)}"`}`,
		);
	}
	for (const skipped of preview.skippedLevels) {
		lines.push(`  ${skipped.goal === null ? "" : `Goal ${skipped.goal}: `}${plain(skipped.note)}`);
	}
	lines.push(
		`  Agents: ${preview.agents.map((agent) => `${plain(agent.id)}${agent.chosen === "default" ? " (chosen for you)" : ""}`).join(", ")}`,
		`  Repeats: ${preview.repeat}`,
		`  Runs: ${preview.runs.total} (a set may start at most ${preview.runs.limit})`,
		preview.runs.left === null
			? "  Your plan's runs left could not be read."
			: `  Your plan has ${plural(preview.runs.left, "run", "runs")} left.`,
	);
	return lines.join("\n");
}

/** Why a preview that answered cannot be launched, or null when it can. */
export function previewProblem(preview: SetPreview): string | null {
	if (preview.runs.total > preview.runs.limit) {
		return `This set would start ${preview.runs.total} runs; a set may start at most ${preview.runs.limit}. Use fewer goals, agents, levels or repeats.`;
	}
	if (!preview.runs.fits) {
		const left = preview.runs.left;
		return `This set needs ${preview.runs.total} runs${left === null ? "" : ` and your plan has ${left} left`}.`;
	}
	return null;
}

/**
 * One cell: "60% (3 of 5)" where the platform gives a rate, the counts alone where it does not.
 * `over`: the set has ended (complete, stopped or failed), so an ungraded cell is not waiting for anything.
 */
export function cellText(cell: SetCell | undefined, over = false): string {
	if (!cell) return "-";
	if (cell.graded === 0) {
		if (cell.inFlight > 0) return "running";
		return over ? "no grade" : "no grade yet";
	}
	const counts = `${cell.passed ?? 0} of ${cell.graded}`;
	return cell.rate === null ? counts : `${Math.round(cell.rate * 100)}% (${counts})`;
}

/** A cell's other runs, each kind on its own, only the kinds that have any. */
function cellExtras(cell: SetCell): string[] {
	const extras: [number | null, string][] = [
		[cell.inFlight, "still running"],
		[cell.excluded, "excluded (never counted against your site)"],
		[cell.blocked, "blocked by your site"],
		[cell.neverVisited, "never visited your site"],
	];
	return extras.filter(([n]) => (n ?? 0) > 0).map(([n, words]) => `${n} ${words}`);
}

const STATE_LINE: Readonly<Record<SetDocument["state"], string | null>> = {
	preparing: "The set is being prepared.",
	running: "Runs are still going.",
	grading: "Every run has ended; grades are still being written.",
	complete: null,
	stopped: "The set was stopped before it finished.",
	failed: "The set failed.",
};

/**
 * The report: one block per goal, levels down, agents across. `cells: false` leaves those blocks out, for a screen
 * the live view already left them on: the set's id and state, then what it found (gaps, skipped levels, notes).
 */
export function renderReport(set: SetDocument, options: { cells?: boolean } = {}): string {
	const lines: string[] = [`${set.site}  set ${set.setId}`];
	const state = STATE_LINE[set.state];
	if (state) lines.push(`${state}${set.error ? ` ${plain(set.error)}` : ""}`);
	if (set.runs.notStarted > 0)
		lines.push(`${plural(set.runs.notStarted, "run was", "runs were")} planned and not started.`);
	const over = set.state === "complete" || set.state === "stopped" || set.state === "failed";
	const labelOf = (key: string): string =>
		plain(set.levels.find((level) => level.key === key)?.label ?? key);
	const labelWidth = Math.max(5, ...set.levels.map((level) => plain(level.label).length)) + 2;
	const agentWidth = Math.max(14, ...set.agents.map((agent) => plain(agent).length)) + 2;
	for (const goal of options.cells === false ? [] : set.goals) {
		lines.push(
			"",
			`Goal ${goal.index}: ${plain(goal.text)}`,
			`  ${pad("Level", labelWidth)}${set.agents.map((agent) => pad(plain(agent), agentWidth)).join("")}`.trimEnd(),
		);
		for (const level of goal.levels) {
			const cells = set.agents.map((agent) =>
				set.cells.find((c) => c.goal === goal.index && c.level === level && c.agent === agent),
			);
			lines.push(
				`  ${pad(labelOf(level), labelWidth)}${cells.map((cell) => pad(cellText(cell, over), agentWidth)).join("")}`.trimEnd(),
			);
			for (const [i, cell] of cells.entries()) {
				if (!cell) continue;
				for (const extra of cellExtras(cell)) lines.push(`    ${plain(set.agents[i])}: ${extra}`);
			}
		}
	}
	const closing = [
		...set.gaps.map((gap) => gap.line),
		...set.skippedLevels.map((s) => `${s.goal === null ? "" : `Goal ${s.goal}: `}${s.note}`),
		...set.notes,
	];
	if (closing.length > 0) lines.push("", ...closing.map((line) => `  ${plain(line)}`));
	return lines.join("\n");
}

/** A served instant to the minute in UTC; anything that is not an instant is printed as served. */
function minuteOf(instant: string): string {
	const at = new Date(instant);
	if (Number.isNaN(at.getTime())) return plain(instant);
	return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `ax run set list`: the organization's sets, newest first, as the platform ordered them. */
export function renderList(list: SetList): string {
	if (list.sets.length === 0) return "No sets yet.";
	return list.sets
		.map(
			(set) =>
				`${pad(plain(set.setId), 38)}${pad(plain(set.site), 24)}${pad(plain(set.state), 11)}${plural(set.goals, "goal", "goals")}, ${plural(set.plannedRuns, "run", "runs")}  ${minuteOf(set.createdAt)}`,
		)
		.join("\n");
}
