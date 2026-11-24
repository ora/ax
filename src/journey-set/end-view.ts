import picocolors from "picocolors";
import type { SetBreakdown, SetDocument, SetGap } from "../api/sets";
import { plain } from "../ui/ansi";
import { rowLabelsOf } from "./agent-labels";
import { lineOf, pad, type Segment } from "./segments";

/** Colors this module applies when the caller asks for them (picocolors' own switch follows stdout, not the caller). */
const pc = picocolors.createColors(true);

// THE END OF A WATCHED SET, under the panel the live view left on screen: where agents drop off between the levels
// of help, the change since the last run of the same set, why the runs that did not pass did not, each agent over
// the whole set, and a link to every run's journey on ora. Every number is one the platform served (ax invariant
// 1): this module chooses words, order and bars, never a count or a rate. Text the platform sent goes through
// `plain`, and every line is cut to the terminal's width before it is painted.

export interface EndViewOptions {
	width: number;
	color: boolean;
}

const BAR_CELLS = 12;
const LABEL_WIDTH = 14;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const LAYER_WORDS: Readonly<Record<NonNullable<SetGap["layer"]>, string>> = {
	discovery: "Discovery",
	access_usability: "Access and Usability",
};

/** What a level of help did, said by the level a gap moves INTO. */
function stepWords(set: SetDocument, to: string): string {
	if (to === "brand")
		return `naming ${plain(set.brand ?? set.site ?? "the brand")} got agents to your site`;
	if (to === "docs") return "linking the docs got agents to your site";
	if (to === "exact") return "the exact page got agents through";
	return "this level got more agents through";
}

/** Beside a level: what the platform's comparison with the level before it found. */
function stepSegments(set: SetDocument, gap: SetGap | undefined, before: string): Segment[] {
	if (!gap) return [{ text: `─ no clear change from ${before}`, tint: pc.dim }];
	if (gap.direction === "worse") return [{ text: `▼ worse than ${before}`, tint: pc.red }];
	if (gap.layer === null) return [{ text: `▲ better than ${before}`, tint: pc.green }];
	return [
		{ text: "▲ ", tint: pc.green },
		{ text: LAYER_WORDS[gap.layer], tint: pc.bold },
		{ text: ` — ${stepWords(set, gap.to)}`, tint: pc.dim },
	];
}

/** A bar of `passed` over `graded` (a picture of two served counts), and the counts themselves. */
function tallySegments(graded: number, passed: number | null): Segment[] {
	const lit = graded > 0 ? Math.round(((passed ?? 0) / graded) * BAR_CELLS) : 0;
	return [
		{ text: "█".repeat(lit), tint: pc.green },
		{ text: "░".repeat(BAR_CELLS - lit), tint: pc.dim },
		{ text: "  " },
		{ text: graded > 0 ? `${passed ?? 0} of ${graded}` : "no grade", tint: pc.bold },
	];
}

const heading = (title: string): Segment[] => [
	{ text: "  ◆ ", tint: pc.cyan },
	{ text: title, tint: pc.bold },
];

function dayOf(instant: string): string {
	const at = new Date(instant);
	return Number.isNaN(at.getTime())
		? plain(instant)
		: `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/** A change in points as the platform stated it, said up, down, or within noise by its interval. */
function changeSegments(change: number, interval: [number, number]): Segment[] {
	const points = Math.round(change);
	if (interval[0] > 0) return [{ text: `▲ +${points} pp`, tint: pc.green }];
	if (interval[1] < 0) return [{ text: `▼ ${points} pp`, tint: pc.red }];
	return [{ text: `≈ ${points > 0 ? `+${points}` : points} pp, within noise`, tint: pc.dim }];
}

function dropOffLines(
	set: SetDocument,
	breakdown: SetBreakdown,
	line: (s: Segment[]) => string,
): string[] {
	const labelOf = (key: string) =>
		plain(set.levels.find((level) => level.key === key)?.label ?? key);
	const lines = [line(heading("Where agents drop off"))];
	breakdown.levels.forEach((level, i) => {
		const before = breakdown.levels[i - 1];
		const step = before
			? set.gaps.find((gap) => gap.from === before.key && gap.to === level.key)
			: undefined;
		lines.push(
			line([
				{ text: `    ${pad(labelOf(level.key), LABEL_WIDTH)} ` },
				...tallySegments(level.graded, level.passed),
				...(before ? [{ text: "   " }, ...stepSegments(set, step, labelOf(before.key))] : []),
			]),
		);
	});
	if (set.gaps.some((gap) => gap.earlySignal)) {
		const graded = new Set(breakdown.levels.map((level) => level.graded));
		const runs =
			graded.size === 1 ? `${[...graded][0]} runs a level` : "too few runs a level to decide";
		lines.push(
			line([
				{
					text: `    An early signal: ${runs}. More repeats (--repeat) turn it into a measurement.`,
					tint: pc.dim,
				},
			]),
		);
	}
	for (const said of [...set.skippedLevels.map((skipped) => skipped.note), ...set.notes]) {
		lines.push(line([{ text: `    ${plain(said)}`, tint: pc.dim }]));
	}
	return lines;
}

/** A served count as words: "3 of 4", or "no grade" when nothing was graded. */
const countOf = (graded: number, passed: number | null): string =>
	graded > 0 ? `${passed ?? 0} of ${graded}` : "no grade";

/**
 * Each level now and in the last run of the same set, side by side, and the change where the platform states one.
 * It pairs two runs goal by goal, so with one goal it states none: then the counts stand alone, and that is said.
 */
function sinceLines(
	set: SetDocument,
	breakdown: SetBreakdown,
	previous: NonNullable<SetBreakdown["previous"]>,
	line: (s: Segment[]) => string,
): string[] {
	const lines = [
		line([
			...heading("Since the last run of this set"),
			{ text: ` (${dayOf(previous.createdAt)})`, tint: pc.dim },
		]),
	];
	for (const level of set.levels) {
		const then = previous.levels.find((entry) => entry.key === level.key);
		const now = breakdown.levels.find((entry) => entry.key === level.key);
		if (!then || !now) continue;
		lines.push(
			line([
				{ text: `    ${pad(plain(level.label), LABEL_WIDTH)} ` },
				{ text: pad(countOf(now.graded, now.passed), 9), tint: pc.bold },
				// Padded only when a change follows it: a line that ends there ends at its last word.
				{
					text: then.change
						? pad(`was ${countOf(then.graded, then.passed)}`, 13)
						: `was ${countOf(then.graded, then.passed)}`,
					tint: pc.dim,
				},
				...(then.change ? changeSegments(then.change.points, then.change.interval) : []),
			]),
		);
	}
	if (set.goals.length < 2 && previous.levels.every((level) => level.change === null)) {
		lines.push(
			line([
				{
					text: "    ora states a change between runs from two goals up; with one goal, these are the counts side by side.",
					tint: pc.dim,
				},
			]),
		);
	}
	return lines;
}

function whyLines(
	set: SetDocument,
	breakdown: SetBreakdown,
	line: (s: Segment[]) => string,
): string[] {
	const { notPassed: missed, passedWithoutVisiting } = breakdown;
	if (!set.site) return [];
	const site = plain(set.site);
	const of = (n: number) => `${n} of ${missed.runs}`;
	const lines = [line(heading("Why runs did not pass"))];
	if (missed.runs === 0) lines.push(line([{ text: "    Every graded run passed." }]));
	if (missed.runs > 0 && missed.neverVisited > 0) {
		lines.push(
			line([
				{ text: `    ${of(missed.neverVisited)}`, tint: pc.bold },
				{ text: ` never visited ${site}` },
				{ text: " — they answered from memory or other sites (Discovery)", tint: pc.dim },
			]),
		);
	}
	if (missed.runs > 0 && missed.visited > 0) {
		lines.push(
			line([
				{ text: `    ${of(missed.visited)}`, tint: pc.bold },
				{ text: " visited and still missed it" },
				{ text: " — see their journeys", tint: pc.dim },
			]),
		);
	}
	if (missed.runs > 0 && missed.blocked !== null) {
		const blocked = missed.blocked;
		lines.push(
			line([
				{ text: `    ${blocked}`, tint: pc.bold },
				{ text: ` ${blocked === 1 ? "was" : "were"} blocked by the site` },
				...(blocked > 0 ? [{ text: " (Access)", tint: pc.dim }] : []),
			]),
		);
	}
	if (missed.runs > 0 && missed.unclear > 0) {
		lines.push(
			line([
				{ text: `    ${of(missed.unclear)}`, tint: pc.bold },
				{ text: `: whether they used ${site} could not be told`, tint: pc.dim },
			]),
		);
	}
	if (passedWithoutVisiting > 0) {
		const runs = `${passedWithoutVisiting} ${passedWithoutVisiting === 1 ? "run" : "runs"}`;
		lines.push(
			line([
				{ text: `    ${runs} passed without visiting ${site}`, tint: pc.yellow },
				{
					text: " — the agent already knew the answer, not from your pages",
					tint: pc.dim,
				},
			]),
		);
	}
	return lines;
}

function agentLine(
	set: SetDocument,
	breakdown: SetBreakdown,
	line: (s: Segment[]) => string,
): string {
	const labels = rowLabelsOf(set.agents);
	const each: Segment[] = breakdown.agents.flatMap((tally) => [
		{ text: `   ${labels.get(tally.agent) ?? plain(tally.agent)} `, tint: pc.dim },
		{
			text: tally.graded > 0 ? `${tally.passed ?? 0} of ${tally.graded}` : "no grade",
			tint: pc.bold,
		},
	]);
	return line([
		...heading("Agents"),
		...each,
		{ text: "   · the same goals, levels and repeats", tint: pc.dim },
	]);
}

/** The end of a watched set, as lines; empty when the platform served no breakdown (it predates it, or not complete). */
export function endViewLines(set: SetDocument, options: EndViewOptions): string[] {
	const breakdown = set.breakdown;
	if (!breakdown) return [];
	const line = (segments: Segment[]) => lineOf(segments, options.width, options.color);
	const link = set.links?.set;
	return [
		...dropOffLines(set, breakdown, line),
		...(breakdown.previous ? ["", ...sinceLines(set, breakdown, breakdown.previous, line)] : []),
		"",
		...whyLines(set, breakdown, line),
		"",
		agentLine(set, breakdown, line),
		...(link ? ["", ...linkLines(plain(link), options)] : []),
	];
}

/**
 * The link to every run's journey, never cut: a cut link opens nothing. The view is ordinary output (the live
 * region has let go of the screen), so a line longer than the terminal wraps harmlessly; on a narrow terminal the
 * link goes on a line of its own under its words.
 */
function linkLines(link: string, options: EndViewOptions): string[] {
	const words = "  Every run's journey, step by step:";
	const url = options.color ? pc.cyan(link) : link;
	return words.length + 2 + link.length <= options.width
		? [`${words}  ${url}`]
		: [words, `  ${url}`];
}

/** Why the Next line is next: the layer where the platform found agents dropping off, at the level before it. */
export function endNextWhy(set: SetDocument): string | undefined {
	const drop = set.gaps.find((gap) => gap.direction === "better" && gap.layer !== null);
	if (!drop?.layer) return undefined;
	const from = plain(set.levels.find((level) => level.key === drop.from)?.label ?? drop.from);
	return `the ${LAYER_WORDS[drop.layer]} checks behind the drop at ${from}`;
}
