import pkg from "../../package.json";
import { plain } from "../ui/ansi";
import type { JourneyStep } from "./platform";
import { exchangeKeyGrant, jsonOrNull, PlatformApiError, platformBase } from "./platform";
import type {
	CancelResult,
	CreateFailure,
	JourneyDetail,
	NotStartedJourney,
	StudioAgent,
	StudioClient,
	StudioClientOptions,
	StudioUsage,
	TrajectoryProfile,
} from "./studio-types";

// Client for the Studio endpoints a trial calls on the ora platform: agents, usage, journey
// create and read, a run's trajectory and insight, and the batch cancel. It holds one bearer from
// platform.ts's key exchange and exchanges the key again shortly before the bearer expires, so a
// long follow never runs on a stale token. Every Studio request names itself as a trial.

export const STUDIO_USER_AGENT = `ax/${pkg.version} (trial)`;

/** Exchange the key again once less than this remains of the bearer's lifetime. */
const REFRESH_MARGIN_MS = 60_000;
/** How long a bearer is used when the exchange gives no lifetime. */
const UNDATED_TOKEN_MS = 10 * 60_000;
/** `POST /studio/v1/runs/cancel` takes 1 to 500 run ids. */
const MAX_CANCEL_IDS = 500;
/** The insight read's 404 while the judge has not written it (run-spine artifact-serve.ts:21). */
const INSIGHT_NOT_READY = "insight_not_ready";

/**
 * The trajectory read sends no `?profile`, so Studio serves its stored artifact (studio-service
 * config TRACE_PROFILE_DEFAULT, default `full`). Every profile carries `url_host` per step:
 * trace-normalize stamps the host while ingesting each step, before attribution runs, and the
 * step builder copies it out (packages/node/trace-normalize/src/classify.ts:250,
 * trajectory-state.ts:230, builder/merge-step.ts:164).
 */
export const TRAJECTORY_PROFILE: TrajectoryProfile | undefined = undefined;

/**
 * Studio answered with an HTTP error. `code` is the Error body's `code`, or the snake_case
 * `error` a runs route answers with instead (`run_not_found`); `missingScopes` is a 403's
 * `details.missing`, empty otherwise.
 */
export class StudioApiError extends PlatformApiError {
	readonly code: string | null;
	readonly missingScopes: string[];

	constructor(
		message: string,
		options: { status: number; payload: unknown; code: string | null; missingScopes: string[] },
	) {
		super(message, options);
		this.name = "StudioApiError";
		this.code = options.code;
		this.missingScopes = options.missingScopes;
	}

	/** A 502 without Studio's own body: a gateway failed, so runs may have started. */
	get gateway(): boolean {
		return this.status === 502 && notStartedJourney(this) === null;
	}
}

interface Answer {
	status: number;
	payload: unknown;
}

export function createStudioClient(options: StudioClientOptions = {}): StudioClient {
	const secret = options.apiKey || process.env.ORA_API_KEY;
	if (!secret) {
		throw new Error(
			"Missing ORA_API_KEY. Set it in your environment or a local .env file (see .env.example).",
		);
	}
	const base = platformBase(options.baseUrl);
	const bearer = tokenKeeper(base, secret, options.now ?? Date.now);

	async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${await bearer()}`,
			accept: "application/json",
			"user-agent": STUDIO_USER_AGENT,
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		const res = await fetch(`${base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, payload: jsonOrNull(await res.text()) };
	}

	async function expectOk(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
		const answer = await send(method, path, body);
		if (answer.status < 200 || answer.status > 299) throw studioError(answer);
		return answer.payload;
	}

	const runPath = (runId: string, leaf: string) =>
		`/studio/v1/runs/${encodeURIComponent(runId)}/${leaf}`;

	return {
		scopes: async () => scopesClaim(await bearer()),

		async agents() {
			const what = "GET /studio/v1/agents";
			const data = unwrap(await expectOk("GET", "/studio/v1/agents"), what);
			expectShape(Array.isArray(data.agents), what, "an agents list");
			return data.agents as StudioAgent[];
		},

		async usage() {
			const what = "GET /studio/v1/usage";
			const data = unwrap(await expectOk("GET", "/studio/v1/usage"), what);
			expectShape(isRecord(data.runs), what, "a runs meter");
			return data as unknown as StudioUsage;
		},

		async createJourney(input) {
			if (!input.targetDomain.trim()) {
				throw new Error(
					"createJourney needs a targetDomain: an empty one runs against the account's tracked domain instead.",
				);
			}
			const what = "POST /studio/v1/journeys";
			const data = unwrap(
				await expectOk("POST", "/studio/v1/journeys", {
					goal: input.goal,
					agents: input.agents.map(({ harness, model }) => ({ harness, model })),
					targetDomain: input.targetDomain,
				}),
				what,
			);
			expectShape(
				typeof data.journeyId === "string" && Array.isArray(data.runIds),
				what,
				"a journey id and run ids",
			);
			return {
				journeyId: data.journeyId as string,
				runIds: data.runIds as string[],
				streamUrls: Array.isArray(data.streamUrls) ? (data.streamUrls as string[]) : [],
				failed: failuresOf(data.failed),
			};
		},

		async journey(id) {
			const path = `/studio/v1/journeys/${encodeURIComponent(id)}`;
			const data = unwrap(await expectOk("GET", path), `GET ${path}`);
			expectShape(Array.isArray(data.agents), `GET ${path}`, "an agents list");
			return data as unknown as JourneyDetail;
		},

		// Served bare, without the envelope (run-spine trajectory-serve.ts).
		async trajectory(runId) {
			const query = TRAJECTORY_PROFILE ? `?profile=${TRAJECTORY_PROFILE}` : "";
			const path = `${runPath(runId, "trajectory")}${query}`;
			const body = await expectOk("GET", path);
			expectShape(isRecord(body) && Array.isArray(body.steps), `GET ${path}`, "a steps list");
			return { steps: (body as { steps: JourneyStep[] }).steps };
		},

		// A 404 is pending only with Studio's not-ready body; a run_not_found 404 is an error
		// (runs-api run-detail-proxy-routes.ts, run-spine run-access.ts:75).
		async insightLanded(runId) {
			const answer = await send("GET", runPath(runId, "insight"));
			if (answer.status === 200) return true;
			if (
				answer.status === 404 &&
				isRecord(answer.payload) &&
				answer.payload.error === INSIGHT_NOT_READY
			) {
				return false;
			}
			throw studioError(answer);
		},

		// The report comes back bare, relayed from runs-service (cancel-runs-route.ts).
		async cancelRuns(runIds) {
			if (runIds.length < 1 || runIds.length > MAX_CANCEL_IDS) {
				throw new RangeError(
					`cancelRuns takes 1 to ${MAX_CANCEL_IDS} run ids, got ${runIds.length}.`,
				);
			}
			const what = "POST /studio/v1/runs/cancel";
			const body = await expectOk("POST", "/studio/v1/runs/cancel", { runIds: [...runIds] });
			expectShape(
				isRecord(body) &&
					typeof body.requested === "number" &&
					Array.isArray(body.canceled) &&
					Array.isArray(body.alreadyTerminal) &&
					Array.isArray(body.skipped),
				what,
				"a cancel report",
			);
			return body as unknown as CancelResult;
		},
	};
}

/**
 * Studio's own 502 on create: no agent started, and the body still names the journey and each
 * agent that failed (apps/studio-service/src/journeys/journeys-router.ts:340). Null for any other
 * error, a gateway's 502 included, since that does not prove nothing started.
 */
export function notStartedJourney(error: unknown): NotStartedJourney | null {
	if (!(error instanceof StudioApiError) || error.status !== 502) return null;
	const data = isRecord(error.payload) ? error.payload.data : undefined;
	if (
		!isRecord(data) ||
		typeof data.journeyId !== "string" ||
		!Array.isArray(data.runIds) ||
		data.runIds.length > 0
	) {
		return null;
	}
	return { journeyId: data.journeyId, failed: failuresOf(data.failed) };
}

/** One bearer for the client, shared by calls that start together, exchanged again before expiry. */
function tokenKeeper(base: string, secret: string, now: () => number): () => Promise<string> {
	type Held = { token: string; refreshAt: number };
	let held: Held | undefined;
	let exchanging: Promise<Held> | undefined;

	const exchange = async (): Promise<Held> => {
		const startedAt = now();
		const grant = await exchangeKeyGrant(base, secret);
		const usable =
			grant.expiresIn === undefined ? UNDATED_TOKEN_MS : grant.expiresIn * 1000 - REFRESH_MARGIN_MS;
		return { token: grant.token, refreshAt: startedAt + usable };
	};

	return async () => {
		if (held && now() < held.refreshAt) return held.token;
		exchanging ??= exchange().finally(() => {
			exchanging = undefined;
		});
		held = await exchanging;
		return held.token;
	};
}

/**
 * The bearer's `scopes` claim, decoded without verification: it only tells the preview what the
 * key lacks, and Studio enforces scopes itself. Anything but a list reads as no scopes, as the
 * server reads it (packages/node/auth/src/middleware/require-scope.ts:39).
 */
function scopesClaim(token: string): string[] {
	const payload = token.split(".")[1] ?? "";
	const claims = jsonOrNull(Buffer.from(payload, "base64url").toString("utf8"));
	return isRecord(claims) ? stringList(claims.scopes) : [];
}

function studioError({ status, payload }: Answer): StudioApiError {
	const code = errorCode(payload);
	const details = isRecord(payload) ? payload.details : undefined;
	const missingScopes = status === 403 && isRecord(details) ? stringList(details.missing) : [];
	const message = plain(failureMessage(status, code, payload, missingScopes));
	return new StudioApiError(message, { status, payload, code, missingScopes });
}

// 402 and 502 are told apart by status alone: the quota guard's body is not in the public spec,
// and a gateway's 502 has no Studio body at all.
function failureMessage(
	status: number,
	code: string | null,
	payload: unknown,
	missingScopes: string[],
): string {
	if (status === 401) return "ora rejected the request (401). Check ORA_API_KEY.";
	if (status === 402) return "Your ora plan has no runs left for this (402).";
	if (missingScopes.length > 0) return `The ora API key lacks ${missingScopes.join(", ")} (403).`;
	const said = isRecord(payload) ? stringField(payload.message) || stringField(payload.error) : "";
	return `ora request failed (${status}${code ? ` ${code}` : ""})${said ? `: ${said}` : ""}`;
}

function errorCode(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	if (typeof payload.code === "string") return payload.code;
	const error = stringField(payload.error);
	return /^[a-z][a-z0-9_]*$/.test(error) ? error : null;
}

/** Studio's `{ success, data }` envelope, unwrapped in this one place. */
function unwrap(payload: unknown, what: string): Record<string, unknown> {
	expectShape(isRecord(payload) && isRecord(payload.data), what, "its { success, data } envelope");
	return (payload as { data: Record<string, unknown> }).data;
}

function expectShape(ok: boolean, what: string, expected: string): void {
	if (!ok) throw new Error(`ora answered ${what} without ${expected}.`);
}

function failuresOf(value: unknown): CreateFailure[] {
	return Array.isArray(value) ? (value as CreateFailure[]) : [];
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
