import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/** The bytes written for one file: ora's `body` when it sent one, else its JSON pretty-printed. */
export function serializeAgentFile(file: {
	content: Record<string, unknown>;
	body?: string;
}): string {
	return typeof file.body === "string" ? file.body : `${JSON.stringify(file.content, null, 2)}\n`;
}

/**
 * The files ax writes at fixed places, keyed by the path ora names. The value -
 * constant segments, never the server's string - is what reaches the
 * filesystem, so a response cannot choose where on disk anything lands (on top
 * of the client's path check in ../api/agent-files).
 */
const WRITABLE_FILES: ReadonlyMap<string, readonly string[]> = new Map([
	["/.well-known/ard.json", [".well-known", "ard.json"]],
	["/.well-known/ai-catalog.json", [".well-known", "ai-catalog.json"]],
	["/.well-known/poppy.json", [".well-known", "poppy.json"]],
	["/.well-known/api-catalog", [".well-known", "api-catalog"]],
	["/llms.txt", ["llms.txt"]],
	["/robots.txt", ["robots.txt"]],
]);

/** An MCP server card: `<server path>/server-card`, segments already vetted by the client. */
const CARD_SUFFIX = "/server-card";

type BundleFile = AgentFilesBundle["files"][number];

export interface PlannedWrites {
	writes: { target: string; file: BundleFile }[];
	/** Files to serve from another host (an MCP server on a subdomain): not written, but named. */
	elsewhere: BundleFile[];
	/** Paths this ax does not know: not written; a newer ax may. */
	unknown: BundleFile[];
}

/** True when the file belongs on the domain itself (a 1.30.0 server sends no url). */
function onDomain(file: BundleFile, domain: string): boolean {
	if (!file.url) return true;
	try {
		return new URL(file.url).hostname === domain;
	} catch (err) {
		if (err instanceof TypeError) return false;
		throw err;
	}
}

/** Where each file of the bundle lands under `out`. */
export function plannedWrites(bundle: AgentFilesBundle, out: string): PlannedWrites {
	const root = resolve(out);
	const planned: PlannedWrites = { writes: [], elsewhere: [], unknown: [] };
	for (const file of bundle.files) {
		if (!onDomain(file, bundle.domain)) {
			planned.elsewhere.push(file);
			continue;
		}
		const fixed = WRITABLE_FILES.get(file.path);
		if (fixed) {
			planned.writes.push({ target: join(root, ...fixed), file });
		} else if (file.path.endsWith(CARD_SUFFIX)) {
			const target = join(root, ...file.path.slice(1).split("/"));
			// Belt and braces on top of the client's segment check: never outside `out`.
			if (relative(root, target).startsWith(".."))
				throw new AgentFilesApiError(`refusing to write outside ${root}: ${file.path}`);
			planned.writes.push({ target, file });
		} else {
			planned.unknown.push(file);
		}
	}
	return planned;
}

/**
 * How a written path is shown: relative to the working directory when it is
 * inside it, absolute otherwise (`--out /tmp/x` from elsewhere printed
 * `../../../../tmp/x/...`).
 */
export function displayPath(target: string, cwd: string = process.cwd()): string {
	const rel = relative(cwd, target);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : target;
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
	const { writes, elsewhere, unknown } = plannedWrites(bundle, out);
	for (const file of unknown) {
		console.error(
			pc.yellow(
				`skipped ${file.path}: this version of ax does not write it - upgrade with npm i -g ax@latest`,
			),
		);
	}
	const existing = writes.filter((w) => existsSync(w.target));
	if (existing.length > 0 && !input.force) {
		console.error("These files already exist, so nothing was written:");
		for (const w of existing) console.error(`  ${displayPath(w.target)}`);
		console.error(
			pc.dim("Pass --force to overwrite them, or --out <dir> to write somewhere else."),
		);
		return EXIT.USAGE;
	}

	for (const { target, file } of writes) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, serializeAgentFile(file));
	}

	const printNotes = (notes: readonly string[]) => {
		for (const note of notes) {
			const [first, ...rest] = wrap(note, 74, "");
			console.log(pc.dim(`    - ${first}`));
			for (const row of rest) console.log(pc.dim(`      ${row}`));
		}
	};

	console.log("");
	console.log(
		`  ${pc.bold(bundle.domain)} ${pc.dim(bundle.scannedAt ? `from ora's scan of ${bundle.scannedAt.slice(0, 10)}` : "not scanned by ora yet")}`,
	);
	console.log("");
	for (const { target, file } of writes) {
		console.log(
			`  ${pc.green("wrote")} ${displayPath(target)}  ${pc.dim(`${file.spec.name} ${file.spec.version}`)}`,
		);
		printNotes(file.notes);
		console.log("");
	}
	for (const file of elsewhere) {
		console.log(
			`  ${pc.yellow("not written")} ${file.url}  ${pc.dim(`${file.spec.name} ${file.spec.version}`)}`,
		);
		printNotes([
			"This file is served from another host, so it is not written here. Run with --json to get its body.",
			...file.notes,
		]);
		console.log("");
	}
	if (bundle.notes && bundle.notes.length > 0) {
		console.log(`  ${pc.bold("Not drafted")}`);
		printNotes(bundle.notes);
		console.log("");
	}
	console.log(
		pc.dim(
			`  Publish them at https://${bundle.domain}/ from your web root - these are drafts, review each before you ship it.`,
		),
	);
	console.log("");
	return EXIT.OK;
}
