import { errorBody } from "./shared";

// Client for ora's agent files generator, GET /api/agent-files/{domain}: the
// drafts of /.well-known/ard.json, ai-catalog.json and poppy.json a domain
// publishes about itself. Thin client - ora decides every byte of every file
// and every note; this module only fetches, and checks that each path it is
// told to write is one it is willing to write.

const PUBLIC_BASE = "https://ora.ai";
const TIMEOUT_MS = 30_000;

// The wire shape of ora's AgentFilesBundle / AgentFile schemas (contract
// 1.30.0). Written out here until `pnpm contract:gen` picks the schemas up from
// the deployed spec; then these become aliases in src/contract like the rest.
export interface AgentFile {
	/** Where the domain serves the file, e.g. "/.well-known/ard.json". */
	path: string;
	spec: { name: string; version: string; url: string };
	/** The JSON document to publish at `path`. */
	content: Record<string, unknown>;
	/** What to review or add before publishing. */
	notes: string[];
}

export interface AgentFilesBundle {
	domain: string;
	productName: string;
	/** When ora last scanned the domain; null when it never has. */
	scannedAt: string | null;
	files: AgentFile[];
}

/**
 * Any failure to get the files from ora. `status` is the HTTP status when ora
 * answered (400 = not a public domain), and `payload` the error body exactly as
 * served, which is what `--json` prints.
 */
export class AgentFilesApiError extends Error {
	readonly status: number | null;
	readonly payload: unknown;

	constructor(message: string, options: { status?: number | null; payload?: unknown } = {}) {
		super(message);
		this.name = "AgentFilesApiError";
		this.status = options.status ?? null;
		this.payload = options.payload;
	}
}

export interface AgentFilesOptions {
	/** Base URL override; otherwise $ORA_API_URL, otherwise https://ora.ai. */
	baseUrl?: string;
}

/**
 * The only paths a generated file may claim: one segment under /.well-known/,
 * ending in .json. Anything else (a `..`, a nested path, another directory) is
 * refused before it reaches the filesystem - this package is a trust artifact,
 * and a response must never choose where on disk it lands.
 */
const SAFE_PATH = /^\/\.well-known\/[a-z0-9][a-z0-9._-]*\.json$/;

export function isSafeAgentFilePath(path: string): boolean {
	return SAFE_PATH.test(path) && !path.includes("..");
}

/** Strip a scheme and trailing slash so `https://example.com/` reads as a domain. */
export function normalizeDomainInput(input: string): string {
	return input
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/+$/, "");
}

/** Fetch the drafted files for `domain` from ora. */
export async function fetchAgentFiles(
	domain: string,
	options: AgentFilesOptions = {},
): Promise<AgentFilesBundle> {
	const base = (options.baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE).replace(/\/+$/, "");
	const url = `${base}/api/agent-files/${encodeURIComponent(normalizeDomainInput(domain))}`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (cause) {
		throw new AgentFilesApiError(
			`could not reach ora at ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	if (!res.ok) {
		const { message, payload } = await errorBody(res);
		throw new AgentFilesApiError(message, { status: res.status, payload });
	}
	const body = (await res.json()) as AgentFilesBundle;
	if (!Array.isArray(body?.files)) {
		throw new AgentFilesApiError("ora answered without a files list", {
			status: res.status,
			payload: body,
		});
	}
	for (const file of body.files) {
		if (!isSafeAgentFilePath(file.path)) {
			throw new AgentFilesApiError(
				`ora named a file path ax will not write: ${JSON.stringify(file.path)}`,
				{
					status: res.status,
					payload: body,
				},
			);
		}
	}
	return body;
}
