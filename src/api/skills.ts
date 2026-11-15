import { createHash } from "node:crypto";
import { errorBody } from "./shared";

// Client for ora's digest-bound skill registry at
// /.well-known/agent-skills/index.json. Skill content is NEVER bundled into
// this package - it is fetched from the registry and verified against the
// index's sha256 digest before it is printed or installed, so what lands on
// disk is provably the bytes ora published.

const PUBLIC_BASE = "https://ora.ai";

export type SkillErrorCode =
	| "REGISTRY_UNREACHABLE"
	| "REGISTRY_ERROR"
	| "UNKNOWN_SKILL"
	| "DIGEST_MISMATCH";

/**
 * Any failure to get a skill from the registry; `code` says which. `payload`
 * is the registry's error body exactly as served when it was JSON (what
 * `--json` prints), null or undefined otherwise.
 */
export class SkillApiError extends Error {
	readonly code: SkillErrorCode;
	readonly payload: unknown;

	constructor(message: string, code: SkillErrorCode, options: { payload?: unknown } = {}) {
		super(message);
		this.name = "SkillApiError";
		this.code = code;
		this.payload = options.payload;
	}
}

export interface SkillEntry {
	name: string;
	type?: string;
	description?: string;
	/** Path or absolute URL to the SKILL.md. */
	url: string;
	/** `sha256:<hex>` over the exact SKILL.md bytes. */
	digest?: string;
}

export function resolveBase(baseUrl?: string): string {
	return (baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE).replace(/\/+$/, "");
}

export async function fetchSkillIndex(baseUrl?: string): Promise<SkillEntry[]> {
	const base = resolveBase(baseUrl);
	let res: Response;
	try {
		res = await fetch(`${base}/.well-known/agent-skills/index.json`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (cause) {
		throw new SkillApiError(
			`could not reach the skill registry at ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
			"REGISTRY_UNREACHABLE",
		);
	}
	if (!res.ok) {
		const { payload } = await errorBody(res);
		throw new SkillApiError(`skill registry answered HTTP ${res.status}`, "REGISTRY_ERROR", {
			payload,
		});
	}
	const body = (await res.json()) as { skills?: SkillEntry[] };
	if (!Array.isArray(body.skills)) {
		throw new SkillApiError("skill registry index has no skills[]", "REGISTRY_ERROR");
	}
	return body.skills;
}

export function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface FetchedSkill {
	entry: SkillEntry;
	/** The exact SKILL.md bytes, digest-verified against the index. */
	bytes: Uint8Array;
}

/**
 * Fetch one skill's SKILL.md and verify it against the index digest. A
 * mismatch is refused outright - never serve bytes the index does not vouch
 * for.
 */
export async function fetchSkill(name: string, baseUrl?: string): Promise<FetchedSkill> {
	const base = resolveBase(baseUrl);
	const index = await fetchSkillIndex(base);
	const entry = index.find((s) => s.name === name);
	if (!entry) {
		const known = index.map((s) => s.name).join(", ");
		throw new SkillApiError(
			`unknown skill ${JSON.stringify(name)} - the registry has: ${known}`,
			"UNKNOWN_SKILL",
		);
	}

	const url = entry.url.startsWith("http") ? entry.url : `${base}${entry.url}`;
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	} catch (cause) {
		throw new SkillApiError(
			`could not fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
			"REGISTRY_UNREACHABLE",
		);
	}
	if (!res.ok) {
		const { payload } = await errorBody(res);
		throw new SkillApiError(
			`skill fetch answered HTTP ${res.status} for ${url}`,
			"REGISTRY_ERROR",
			{ payload },
		);
	}
	const bytes = new Uint8Array(await res.arrayBuffer());

	if (entry.digest && digestOf(bytes) !== entry.digest) {
		throw new SkillApiError(
			`digest mismatch for ${name}: index says ${entry.digest}, served bytes hash to ${digestOf(bytes)} - refusing to use them`,
			"DIGEST_MISMATCH",
		);
	}
	return { entry, bytes };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * The section of a SKILL.md under the heading `title` (any level, matched
 * case-insensitively), heading included, up to the next heading of the same
 * or a higher level. A `#` line inside a fenced code block is content, not a
 * heading: ora's skills carry example reports that start with `## `. Null when
 * the skill has no such heading.
 */
export function skillSection(markdown: string, title: string): string | null {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const wanted = title.trim().toLowerCase();
	let fence: string | undefined;
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i++) {
		const fenceOpen = FENCE.exec(lines[i]);
		if (fenceOpen) {
			const marker = fenceOpen[1];
			// Only a bare marker closes a fence; "```bash" inside one is content.
			if (fence === undefined) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length && !fenceOpen[2].trim()) {
				fence = undefined;
			}
			continue;
		}
		if (fence !== undefined) continue;
		const heading = HEADING.exec(lines[i]);
		if (!heading) continue;
		const depth = heading[1].length;
		if (start === -1) {
			if (heading[2].toLowerCase() === wanted) {
				start = i;
				level = depth;
			}
		} else if (depth <= level) {
			return lines.slice(start, i).join("\n").trimEnd();
		}
	}
	return start === -1 ? null : lines.slice(start).join("\n").trimEnd();
}
