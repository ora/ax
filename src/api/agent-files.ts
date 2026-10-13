import { errorBody } from "./shared";

// Client for ora's agent files generator, GET /api/agent-files/{domain}: the
// drafts of /.well-known/ard.json, ai-catalog.json and poppy.json a domain
// publishes about itself, plus (asked for with ?include=all) llms.txt, an edit
// of its robots.txt, an RFC 9727 api-catalog and draft MCP server cards. Thin client - ora decides every byte of every file
// and every note; this module only fetches, and checks that each path it is
// told to write is one it is willing to write.

const PUBLIC_BASE = "https://ora.ai";
const TIMEOUT_MS = 30_000;

// The wire shape of ora's AgentFilesBundle / AgentFile schemas (contract
// 1.31.0). Written out here until `pnpm contract:gen` picks the schemas up from
// the deployed spec; then these become aliases in src/contract like the rest.
// The 1.31.0 fields are optional so a 1.30.0 server (three JSON files, no
// body/url/notes) still works.
export interface AgentFile {
	/** Where the file is served, as a path on its host, e.g. "/.well-known/ard.json". */
	path: string;
	spec: { name: string; version: string; url: string };
	/** The JSON document to publish at `path`; `{}` for a text file (see `body`). */
	content: Record<string, unknown>;
	/** What to review or add before publishing. */
	notes: string[];
	/** Content-Type to serve the file with. */
	mediaType?: string;
	/** The exact bytes to publish. */
	body?: string;
	/** The full address the file is served at; a server card can live on a subdomain. */
	url?: string;
}

export interface AgentFilesBundle {
	domain: string;
	productName: string;
	/** When ora last scanned the domain; null when it never has. */
	scannedAt: string | null;
	files: AgentFile[];
	/** Why an included file is absent, in plain sentences. */
	notes?: string[];
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
 * The only paths a generated file may claim: one to six lowercase segments of
 * `[a-z0-9._-]`, none of them `.` or `..`, e.g. `/robots.txt`,
 * `/.well-known/ard.json` or `/mcp/server-card`. Anything else is refused
 * before it reaches the filesystem - this package is a trust artifact, and a
 * response must never choose where on disk it lands. The command applies its
 * own allowlist on top (src/commands/generate-files.ts).
 */
const SAFE_SEGMENT = /^[a-z0-9._-]+$/;

export function isSafeAgentFilePath(path: string): boolean {
	if (!path.startsWith("/")) return false;
	const segments = path.slice(1).split("/");
	return (
		segments.length >= 1 &&
		segments.length <= 6 &&
		segments.every((seg) => SAFE_SEGMENT.test(seg) && seg !== "." && seg !== "..")
	);
}

/**
 * Drop trailing slashes with a scan rather than `/\/+$/`: that regex retries
 * at every `/` of a long run that is not at the end, quadratic on input a
 * caller controls (CodeQL js/polynomial-redos).
 */
export function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end--;
	return value.slice(0, end);
}

/** Strip a scheme and trailing slash so `https://example.com/` reads as a domain. */
export function normalizeDomainInput(input: string): string {
	return trimTrailingSlashes(input.trim().replace(/^https?:\/\//i, ""));
}

/** Fetch the drafted files for `domain` from ora. */
export async function fetchAgentFiles(
	domain: string,
	options: AgentFilesOptions = {},
): Promise<AgentFilesBundle> {
	const base = trimTrailingSlashes(options.baseUrl ?? process.env.ORA_API_URL ?? PUBLIC_BASE);
	const url = `${base}/api/agent-files/${encodeURIComponent(normalizeDomainInput(domain))}?include=all`;
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
