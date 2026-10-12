import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import pc from "picocolors";
import { AgentFilesApiError, type AgentFilesBundle, fetchAgentFiles } from "../api/agent-files";
import { EXIT } from "./audit";

export interface GenerateFilesCommandInput {
	domain: string;
	/** Directory the site serves from; files land in <out>/.well-known/. Default ".". */
	out?: string;
	/** Overwrite files that already exist. */
	force: boolean;
	/** Print ora's payload as JSON and write nothing. */
	json: boolean;
	baseUrl?: string;
}

/** The bytes written for one file: the JSON ora drafted, pretty-printed, newline-terminated. */
export function serializeAgentFile(content: Record<string, unknown>): string {
	return `${JSON.stringify(content, null, 2)}\n`;
}

/** Where each file of the bundle lands under `out` (paths already vetted by the client). */
export function plannedWrites(
	bundle: AgentFilesBundle,
	out: string,
): { target: string; file: AgentFilesBundle["files"][number] }[] {
	const root = resolve(out);
	return bundle.files.map((file) => {
		const target = resolve(root, `.${file.path}`);
		// Belt and braces on top of the client's path check: never outside `out`.
		if (relative(root, target).startsWith("..")) {
			throw new AgentFilesApiError(`refusing to write outside ${root}: ${file.path}`);
		}
		return { target, file };
	});
}

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

export async function generateFilesCommand(input: GenerateFilesCommandInput): Promise<number> {
	if (!input.domain?.trim()) {
		console.error("Usage: ax generate-files <domain>");
		return EXIT.USAGE;
	}

	let bundle: AgentFilesBundle;
	try {
		bundle = await fetchAgentFiles(input.domain, { baseUrl: input.baseUrl });
	} catch (cause) {
		if (input.json && cause instanceof AgentFilesApiError && cause.payload !== undefined) {
			process.stdout.write(`${JSON.stringify(cause.payload, null, 2)}\n`);
		} else {
			console.error(
				`generate-files failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
		// ora's 400 means the domain itself is not acceptable: a usage mistake.
		return cause instanceof AgentFilesApiError && cause.status === 400 ? EXIT.USAGE : EXIT.API;
	}

	if (input.json) {
		process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
		return EXIT.OK;
	}

	const out = input.out ?? ".";
	const writes = plannedWrites(bundle, out);
	const existing = writes.filter((w) => existsSync(w.target));
	if (existing.length > 0 && !input.force) {
		console.error("These files already exist, so nothing was written:");
		for (const w of existing) console.error(`  ${relative(process.cwd(), w.target) || w.target}`);
		console.error(
			pc.dim("Pass --force to overwrite them, or --out <dir> to write somewhere else."),
		);
		return EXIT.USAGE;
	}

	for (const { target, file } of writes) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, serializeAgentFile(file.content));
	}

	console.log("");
	console.log(
		`  ${pc.bold(bundle.domain)} ${pc.dim(bundle.scannedAt ? `from ora's scan of ${bundle.scannedAt.slice(0, 10)}` : "not scanned by ora yet")}`,
	);
	console.log("");
	for (const { target, file } of writes) {
		console.log(
			`  ${pc.green("wrote")} ${relative(process.cwd(), target) || target}  ${pc.dim(`${file.spec.name} ${file.spec.version}`)}`,
		);
		for (const note of file.notes) {
			const [first, ...rest] = wrap(note, 74, "");
			console.log(pc.dim(`    - ${first}`));
			for (const row of rest) console.log(pc.dim(`      ${row}`));
		}
		console.log("");
	}
	console.log(
		pc.dim(
			`  Publish them at https://${bundle.domain}/.well-known/ - these are drafts, review each before you ship it.`,
		),
	);
	console.log("");
	return EXIT.OK;
}
