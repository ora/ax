import type { PlatformCredential } from "../auth/credential";
import { jsonOrNull, PlatformApiError } from "./platform-error";

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
	/**
	 * Follow a set live (`GET /ax/v1/sets/{id}/stream`, server-sent events): `onSet` gets each
	 * document the platform sends, the set's whole state every time. Resolves when the platform ends
	 * the stream (it does once the set is over), rejects when it cannot be opened.
	 */
	follow(id: string, onSet: (set: SetDocument) => void, signal: AbortSignal): Promise<void>;
}

export interface SetsClientOptions {
	/** The platform API base (`platformBase()`). */
	base: string;
	/** What signs every call: the credential the command resolved (auth/resolve-credential.ts). */
	credential: PlatformCredential;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** The scopes a refusal says the credential lacks, joined as a hint names them; undefined when it lists none. */
function missingScopes(body: unknown): string | undefined {
	const missing = (body as { details?: { missing?: unknown } } | null)?.details?.missing;
	if (!Array.isArray(missing)) return undefined;
	const scopes = missing.filter((scope): scope is string => typeof scope === "string");
	return scopes.length === 0 ? undefined : scopes.join(" + ");
}

/**
 * The message of an error body: for a refusal that lists missing scopes, the credential's own words
 * for that (a key and a sign-in are fixed differently); else the body's sentence; else the status.
 */
function messageOf(status: number, body: unknown, credential: PlatformCredential): string {
	const lacking = missingScopes(body);
	if (lacking) return credential.refusal.forbidden(lacking);
	const said = (body ?? {}) as { message?: unknown; error?: unknown };
	const text = [said.message, said.error].find((v) => typeof v === "string" && v.length > 0);
	const sentence = typeof text === "string" ? text : `ora answered HTTP ${status}`;
	const lines = validationLines(body);
	return lines.length > 0 ? `${sentence}: ${lines.join("; ")}` : sentence;
}

/**
 * What a validation refusal lists as wrong (`details.errors.<part>`), in ora's words. Its message
 * alone is "Validation failed", which tells a person nothing about which limit they hit.
 */
function validationLines(body: unknown): string[] {
	const errors = (body as { details?: { errors?: unknown } } | null)?.details?.errors;
	if (errors === null || typeof errors !== "object") return [];
	return Object.values(errors)
		.flat()
		.filter((line): line is string => typeof line === "string" && line.length > 0);
}

/**
 * A client for one command's calls. The credential hands out the bearer, and a new one, once,
 * when the platform answers 401 (following a set can outlive one bearer). A 401 that survives the
 * renewal is the credential's own to word: a key ora rejects, a sign-in that has ended.
 */
export function createSetsClient(options: SetsClientOptions): SetsClient {
	const { base, credential } = options;
	const doFetch = options.fetch ?? fetch;

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
		let res = await send(method, path, body, await credential.bearer());
		if (res.status === 401) {
			await res.body?.cancel().catch(() => {});
			res = await send(method, path, body, await credential.renew());
		}
		const payload = jsonOrNull(await res.text());
		if (res.status === 401) {
			throw credential.rejected(
				"ora did not accept your credential for a set of journeys",
				new PlatformApiError(messageOf(401, payload, credential), { status: 401, payload }),
			);
		}
		if (!res.ok) {
			throw new PlatformApiError(messageOf(res.status, payload, credential), {
				status: res.status,
				payload,
			});
		}
		if (payload === null) throw new Error(`ora returned a non-JSON response (${res.status})`);
		return payload as T;
	};

	const openStream = (id: string, token: string, signal: AbortSignal): Promise<Response> =>
		doFetch(`${base}/ax/v1/sets/${encodeURIComponent(id)}/stream`, {
			headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
			signal,
		});

	const follow: SetsClient["follow"] = async (id, onSet, signal) => {
		let res = await openStream(id, await credential.bearer(), signal);
		if (res.status === 401) {
			await res.body?.cancel().catch(() => {});
			res = await openStream(id, await credential.renew(), signal);
		}
		if (!res.ok || res.body === null) {
			const payload = jsonOrNull(await res.text().catch(() => ""));
			throw new PlatformApiError(messageOf(res.status, payload, credential), {
				status: res.status,
				payload,
			});
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
			let end = pending.indexOf("\n\n");
			while (end >= 0) {
				const block = pending.slice(0, end);
				pending = pending.slice(end + 2);
				// One event: its data lines joined. A keepalive comment has none.
				const data = block
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				const set = data === "" ? null : jsonOrNull(data);
				if (set !== null && typeof set === "object" && "setId" in set) onSet(set as SetDocument);
				end = pending.indexOf("\n\n");
			}
		}
	};

	return {
		follow,
		preview: (request) => call("POST", "/sets/preview", request),
		create: (request) => call("POST", "/sets", request),
		get: (id) => call("GET", `/sets/${encodeURIComponent(id)}`),
		list: () => call("GET", "/sets"),
		cancel: (id) => call("POST", `/sets/${encodeURIComponent(id)}/cancel`, {}),
	};
}
