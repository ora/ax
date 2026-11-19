// Pure helpers for scripts/contract-drift.mjs, split out so they can be tested
// without touching git or the network.
//
// The question the drift check answers is "does production's contract differ
// from the one this build was generated against, in a way the code can see?"
// openapi-typescript copies every spec `description` into a JSDoc comment, so
// a reworded description changes types.gen.ts without changing a single type.
// Those changes are worth reading (they are how ora documents behaviour) but
// not worth a red build, so the check sorts drift into two kinds.

/**
 * Returns `source` with every // and /* *\/ comment removed. String literals
 * are copied through untouched, so a literal such as "*\/*" or
 * "https://ora.ai" can never be mistaken for a comment.
 */
export function stripComments(source) {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (ch === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (ch === "/" && next === "/") {
			const end = source.indexOf("\n", i + 2);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
			out += source.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/** Code with comments, indentation and blank lines removed, for comparison. */
export function codeShape(source) {
	return stripComments(source)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join("\n");
}

/**
 * Classifies the difference between committed and regenerated files.
 *
 * @param {Array<{ committed: string, generated: string }>} files
 * @returns {"none" | "docs" | "contract"} `docs` when only comments or
 *   whitespace changed, `contract` when any type or the pinned version changed.
 */
export function classifyDrift(files) {
	let drift = "none";
	for (const { committed, generated } of files) {
		if (committed === generated) continue;
		if (codeShape(committed) !== codeShape(generated)) return "contract";
		drift = "docs";
	}
	return drift;
}
