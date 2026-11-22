import { exchangeKey, PlatformApiError, platformBase } from "./platform";

// Client for ora's sets API (`/ax/v1`): the backend of a set of journeys. The platform plans,
// runs, grades and counts a set; this client asks and hands the answer over. It holds no state
// and derives nothing: every method returns the JSON the platform served, untouched, which is
// also what `--json` prints (ax invariants 1 and 4).

/** A set as the caller asks for it: the request body of preview and create. */
export interface SetRequest {
	site: string;
	goals: string[];
	agents?: string[];
	levels?: boolean;
	brand?: string;
	docs?: string;
	exact?: string;
	repeat?: number;
}

export interface SkippedLevel {
	level: string;
	/** The goal the level leaves out, by number; null when the whole level is left out. */
	goal: number | null;
	note: string;
}

/** `POST /ax/v1/sets/preview`: what the set is and what it would start. Nothing is created. */
export interface SetPreview {
	site: string;
	brand: string | null;
	goals: { index: number; text: string; levels: string[] }[];
	levels: { key: string; label: string; prompt: string | null }[];
	skippedLevels: SkippedLevel[];
	agents: { id: string; chosen: "named" | "default" }[];
	repeat: number;
	runs: { total: number; limit: number; left: number | null; fits: boolean };
}

export interface SetCell {
	goal: number;
	level: string;
	agent: string;
	runs: number;
	graded: number;
	passed: number | null;
	/** The platform's rate, shown from 5 graded runs; null below that. */
	rate: number | null;
	excluded: number;
	inFlight: number;
	blocked: number | null;
	neverVisited: number | null;
}

export interface SetGap {
	from: string;
	to: string;
	direction: "better" | "worse";
	layer: "discovery" | "access_usability" | null;
	earlySignal: boolean;
	line: string;
}

/** `GET /ax/v1/sets/{id}` and the answer of create: the set and its report as it stands. */
export interface SetDocument {
	setId: string;
	site: string;
	brand: string | null;
	createdAt: string;
	state: "preparing" | "running" | "grading" | "complete" | "stopped" | "failed";
	complete: boolean;
	error: string | null;
	goals: { index: number; text: string; levels: string[] }[];
	levels: { key: string; label: string }[];
	skippedLevels: SkippedLevel[];
	agents: string[];
	repeat: number;
	runs: { planned: number; started: number; notStarted: number };
	cells: SetCell[];
	gaps: SetGap[];
	notes: string[];
	next: { command: "view" | "audit"; line: string };
}

export interface SetList {
	sets: {
		setId: string;
		site: string;
		createdAt: string;
		state: string;
		goals: number;
		plannedRuns: number;
	}[];
}

export interface SetsClient {
	preview(request: SetRequest): Promise<SetPreview>;
	create(request: SetRequest): Promise<SetDocument>;
	get(id: string): Promise<SetDocument>;
	list(): Promise<SetList>;
	cancel(id: string): Promise<unknown>;
}

export interface SetsClientOptions {
	/** The platform API base; default `platformBase()`. */
	base?: string;
	/** The platform key; default `ORA_API_KEY`. */
	secret?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 60_000;

function jsonOrNull(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		if (err instanceof SyntaxError) return null;
		throw err;
	}
}

/** The scopes a refusal says the key lacks, as a sentence; undefined when it lists none. */
function missingScopes(body: unknown): string | undefined {
	const missing = (body as { details?: { missing?: unknown } } | null)?.details?.missing;
	if (!Array.isArray(missing)) return undefined;
	const scopes = missing.filter((scope): scope is string => typeof scope === "string");
	if (scopes.length === 0) return undefined;
	return `This key does not have the ${scopes.join(" and ")} ${scopes.length === 1 ? "scope" : "scopes"}.`;
}

/** The message of an error body: its own sentence when it has one, the scopes it lists as missing, else the status. */
function messageOf(status: number, body: unknown): string {
	const lacking = missingScopes(body);
	if (lacking) return lacking;
	const said = (body ?? {}) as { message?: unknown; error?: unknown };
	const text = [said.message, said.error].find((v) => typeof v === "string" && v.length > 0);
	return typeof text === "string" ? text : `ora answered HTTP ${status}`;
}

/**
 * A client for one command's calls. The key is exchanged for a short-lived bearer on the first
 * call and again, once, when the platform answers 401 (following a set can outlive one bearer).
 */
export function createSetsClient(options: SetsClientOptions = {}): SetsClient {
	const base = options.base ?? platformBase();
	const doFetch = options.fetch ?? fetch;
	let bearer: string | null = null;

	const authorize = async (): Promise<string> => {
		const secret = options.secret ?? process.env.ORA_API_KEY;
		if (!secret) throw new PlatformApiError("ORA_API_KEY is not set.", { status: 401 });
		bearer = await exchangeKey(base, secret);
		return bearer;
	};

	const send = async (
		method: string,
		path: string,
		body: unknown,
		token: string,
	): Promise<Response> =>
		doFetch(`${base}/ax/v1${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: options.signal
				? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
				: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

	const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		let res = await send(method, path, body, bearer ?? (await authorize()));
		if (res.status === 401) {
			await res.body?.cancel().catch(() => {});
			res = await send(method, path, body, await authorize());
		}
		const payload = jsonOrNull(await res.text());
		if (!res.ok)
			throw new PlatformApiError(messageOf(res.status, payload), { status: res.status, payload });
		if (payload === null) throw new Error(`ora returned a non-JSON response (${res.status})`);
		return payload as T;
	};

	return {
		preview: (request) => call("POST", "/sets/preview", request),
		create: (request) => call("POST", "/sets", request),
		get: (id) => call("GET", `/sets/${encodeURIComponent(id)}`),
		list: () => call("GET", "/sets"),
		cancel: (id) => call("POST", `/sets/${encodeURIComponent(id)}/cancel`, {}),
	};
}
