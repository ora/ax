import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { fetchSkill, fetchSkillIndex, SkillApiError } from "../api/skills";
import { reportError } from "../report/json-error";
import { axCall, printNext } from "../report/next-line";
import { EXIT } from "./audit";

export interface SkillCommandInput {
	/** Skill name; omitted = list the registry. */
	name?: string;
	/** Write <dir>/<name>/SKILL.md instead of printing. */
	install: boolean;
	/** Install directory (default .claude/skills). */
	dir?: string;
	json: boolean;
}

const DEFAULT_INSTALL_DIR = ".claude/skills";

function wrap(text: string, width: number, indent: string): string[] {
	const rows: string[] = [];
	let row = "";
	for (const word of text.split(/\s+/)) {
		if (row && `${row} ${word}`.length > width) {
			rows.push(indent + row);
			row = word;
		} else {
			row = row ? `${row} ${word}` : word;
		}
	}
	if (row) rows.push(indent + row);
	return rows;
}

export async function skillCommand(input: SkillCommandInput): Promise<number> {
	try {
		if (!input.name) {
			const index = await fetchSkillIndex();
			const next = index[0]
				? { call: axCall(["skill", index[0].name, "--install"]), why: "or any name in the list" }
				: { call: axCall(["learn"]), why: "the registry is empty; print the ax workflow instead" };
			if (input.json) {
				process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
				printNext(next, { stderr: true });
				return EXIT.OK;
			}
			console.log("");
			for (const entry of index) {
				const digest = entry.digest ? pc.dim(`  ${entry.digest.slice(0, 19)}…`) : "";
				console.log(`  ${pc.bold(entry.name)}${digest}`);
				if (entry.description) {
					for (const row of wrap(entry.description, 76, "    ")) console.log(pc.dim(row));
				}
				console.log("");
			}
			printNext(next, { stderr: false });
			return EXIT.OK;
		}

		const { entry, bytes } = await fetchSkill(input.name);
		if (input.install) {
			const dir = join(input.dir ?? DEFAULT_INSTALL_DIR, entry.name);
			mkdirSync(dir, { recursive: true });
			const path = join(dir, "SKILL.md");
			writeFileSync(path, bytes);
			console.log(`Installed ${entry.name} to ${path}`);
			if (entry.digest) console.log(pc.dim(`verified ${entry.digest}`));
			printNext(
				{
					call: axCall(["learn"]),
					why: "the workflow: scan, read the report, run a journey, read its result",
				},
				{ stderr: false },
			);
			return EXIT.OK;
		}
		// stdout is the SKILL.md bytes alone, so `ax skill <name> > SKILL.md` works.
		process.stdout.write(bytes);
		printNext(
			{
				call: axCall(["skill", entry.name, "--install"]),
				why: `write it to ${DEFAULT_INSTALL_DIR}`,
			},
			{ stderr: true },
		);
		return EXIT.OK;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		// An unknown name is a usage mistake; everything else is registry trouble.
		const unknown = cause instanceof SkillApiError && cause.code === "UNKNOWN_SKILL";
		const retry = axCall([
			"skill",
			...(input.name ? [input.name] : []),
			...(input.install ? ["--install"] : []),
			...(input.dir ? ["--dir", input.dir] : []),
		]);
		reportError(
			{
				code: cause instanceof SkillApiError ? cause.code : "REGISTRY_ERROR",
				message,
				next: unknown
					? { call: axCall(["skill"]), why: "list the skills the registry has" }
					: { call: retry, why: "retry; the registry may be briefly unreachable" },
			},
			{
				json: input.json,
				display: `Skill command failed: ${message}`,
				served: cause instanceof SkillApiError ? cause.payload : undefined,
			},
		);
		return unknown ? EXIT.USAGE : EXIT.API;
	}
}
