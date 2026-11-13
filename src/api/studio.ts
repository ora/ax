import pkg from "../../package.json";
import type { JourneyStep } from "./platform";
import { exchangeKeyGrant, jsonOrNull, PlatformApiError, platformBase } from "./platform";
import {
	expectShape,
	failuresOf,
	isRecord,
	type StudioAnswer,
	StudioConnectionError,
	StudioShapeError,
	stringList,
	studioError,
} from "./studio-errors";
import type {
	CancelResult,
	JourneyDetail,
	StudioAgent,
	StudioClient,
	StudioClientOptions,
	StudioUsage,
	TrajectoryProfile,
} from "./studio-types";

export {
	isStudioFailure,
	notStartedJourney,
	StudioApiError,
	StudioConnectionError,
	StudioShapeError,
} from "./studio-errors";

// Client for the Studio endpoints a trial calls on the ora platform: agents, usage, journey
// create and read, a run's trajectory and insight, and the batch cancel. It holds one bearer from
// platform.ts's key exchange and exchanges the key again shortly before the bearer expires, so a
// long follow never runs on a stale token. Every Studio request names itself as a trial.

export const STUDIO_USER_AGENT = `ax/${pkg.version} (trial)`;

/** Exchange the key again once less than this remains of the bearer's lifetime. */
const REFRESH_MARGIN_MS = 60_000;
/** How long a bearer is used when the exchange gives no lifetime. */
const UNDATED_TOKEN_MS = 10 * 60_000;
/** How long one Studio request may take; a create fans out every agent before it answers. */
const REQUEST_TIMEOUT_MS = 60_000;
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

export function createStudioClient(options: StudioClientOptions = {}): StudioClient {
	const secret = options.apiKey || process.env.ORA_API_KEY;
	if (!secret) {
		throw new Error(
			"Missing ORA_API_KEY. Set it in your environment or a local .env file (see .env.example).",
		);
	}
	const base = platformBase(options.baseUrl);
	const bearer = tokenKeeper(base, secret, options.now ?? Date.now);

	// Only the network sits in each try, so any rejection there is the connection's, never a bug.
	async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<StudioAnswer> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${await bearer()}`,
			accept: "application/json",
			"user-agent": STUDIO_USER_AGENT,
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		try {
			const res = await fetch(`${base}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			return { status: res.status, payload: jsonOrNull(await res.text()) };
		} catch (cause) {
			throw new StudioConnectionError(base, cause);
		}
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

/** One bearer for the client, shared by calls that start together, exchanged again before expiry. */
function tokenKeeper(base: string, secret: string, now: () => number): () => Promise<string> {
	type Held = { token: string; refreshAt: number };
	let held: Held | undefined;
	let exchanging: Promise<Held> | undefined;

	const exchange = async (): Promise<Held> => {
		const startedAt = now();
		const grant = await exchangeKeyGrant(base, secret).catch((cause: unknown) => {
			// The shared exchange throws PlatformApiError on an HTTP error, lets fetch's rejection
			// through, and throws a plain Error only for a 200 that carries no token.
			if (cause instanceof PlatformApiError) throw cause;
			if (cause instanceof TypeError || cause instanceof DOMException) {
				throw new StudioConnectionError(base, cause);
			}
			throw new StudioShapeError("POST /auth/token", "a token");
		});
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

/** Studio's `{ success, data }` envelope, unwrapped in this one place. */
function unwrap(payload: unknown, what: string): Record<string, unknown> {
	expectShape(isRecord(payload) && isRecord(payload.data), what, "its { success, data } envelope");
	return (payload as { data: Record<string, unknown> }).data;
}
