// The level ladder a trial climbs: how much help the prompt gives the agent.
// Every prompt comes from a fixed template here, never from a model, so
// whether the need level leaks the site is decided in code (namesSite).

export type Level = "need" | "brand" | "docs" | "exact";

/** Least help first. Prompts, launch order, report rows and gap adjacency all follow this order. */
export const LEVELS: readonly Level[] = ["need", "brand", "docs", "exact"];

export const LEVEL_LABELS: Readonly<Record<Level, string>> = {
	need: "Need only",
	brand: "Brand named",
	docs: "Docs linked",
	exact: "Exact target",
};

/** Second level labels that country registries sell under (`co.uk`, `com.au`, `ne.jp`). */
const GENERIC_SECOND_LEVEL: ReadonlySet<string> = new Set([
	"ac",
	"co",
	"com",
	"edu",
	"go",
	"gob",
	"gov",
	"ltd",
	"mil",
	"ne",
	"net",
	"or",
	"org",
	"plc",
]);

/**
 * The domain's name label with its first letter uppercased: `linear.app`, `www.linear.app` and
 * `docs.linear.app` all give `Linear`. A generic second level label before a two letter country
 * code counts as part of the suffix (`bbc.co.uk` gives `Bbc`), while a brand there stays the
 * brand (`docs.ora.ai` gives `Ora`). A guess, not a lookup: the preview names the brand it used
 * and `--brand` overrides it.
 */
export function defaultBrand(site: string): string {
	const labels = site.split(".").filter(Boolean);
	const last = labels.length - 1;
	const countrySuffix =
		labels.length >= 3 && labels[last].length === 2 && GENERIC_SECOND_LEVEL.has(labels[last - 1]);
	const label = labels[Math.max(0, last - (countrySuffix ? 2 : 1))] ?? "";
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/** `{task.}`: the trimmed task, with a period unless it already ends in `.`, `?` or `!`. */
function sentence(task: string): string {
	const trimmed = task.trim();
	return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function needPrompt(task: string): string {
	return task.trim();
}

export function brandPrompt(task: string, brand: string): string {
	return `${sentence(task)} Use ${brand}.`;
}

export function docsPrompt(task: string, brand: string, docs: string): string {
	return `${sentence(task)} Use ${brand}. Its documentation is at ${docs}.`;
}

export function exactPrompt(task: string, exact: string): string {
	return `${sentence(task)} Start at ${exact}.`;
}

/** Compared form: NFKC and lowercase, so a fullwidth or mixed-case spelling still matches. */
function fold(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `word` appears in `text` with no letter, digit or underscore touching either end. */
function hasWholeWord(text: string, word: string): boolean {
	if (!word) return false;
	const edge = "[\\p{L}\\p{N}_]";
	return new RegExp(`(?<!${edge})${escapeRegExp(word)}(?!${edge})`, "u").test(text);
}

/**
 * What in the task names the site: the brand as configured when it appears as
 * a whole word, otherwise the domain when it appears anywhere, otherwise null.
 * Case insensitive; `nonlinear` does not name `Linear`.
 */
export function siteTermIn(task: string, site: string, brand: string): string | null {
	const text = fold(task);
	if (hasWholeWord(text, fold(brand.trim()))) return brand;
	if (site && text.includes(fold(site))) return site;
	return null;
}

/** The need-level leak check: true when the task names the site's domain or its brand. */
export function namesSite(task: string, site: string, brand: string): boolean {
	return siteTermIn(task, site, brand) !== null;
}

/** Why the need level is skipped; `term` is what siteTermIn found. */
export function needSkipNote(term: string): string {
	return `The task names ${term}, so the need level is skipped. Write the task without it to include that level.`;
}

export const DOCS_SKIP_NOTE =
	"No --docs URL, so the docs level is skipped. Add --docs <url> to include it.";

export const EXACT_SKIP_NOTE =
	"No --exact URL, so the exact level is skipped. Add --exact <url> to include it.";
