import { plain } from "../ui/ansi";
import { PlatformApiError } from "./platform";
import type { CreateFailure, NotStartedJourney } from "./studio-types";

// The ways a Studio call fails, and the body readers they need. `isStudioFailure` is the one rule
// for which errors are the platform's (an HTTP error, no connection, an answer of the wrong shape),
// so a caller retries or reports those and lets a bug in ax surface.

/** An HTTP answer as the client read it: the status and the parsed body, or null. */
export interface StudioAnswer {
	status: number;
	payload: unknown;
}

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

/** No answer came back: the request failed to connect, broke off, or timed out. */
export class StudioConnectionError extends Error {
	constructor(base: string, cause: unknown) {
		super(
			`could not reach ora at ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{
				cause,
			},
		);
		this.name = "StudioConnectionError";
	}
}

/** An answer came back without the shape the public spec gives it. */
export class StudioShapeError extends Error {
	constructor(what: string, expected: string) {
		super(`ora answered ${what} without ${expected}.`);
		this.name = "StudioShapeError";
	}
}

/** True for the platform's failures; false for anything else, which is a bug to let through. */
export function isStudioFailure(error: unknown): boolean {
	return (
		error instanceof PlatformApiError ||
		error instanceof StudioConnectionError ||
		error instanceof StudioShapeError
	);
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

export function studioError({ status, payload }: StudioAnswer): StudioApiError {
	const code = errorCode(payload);
	const details = isRecord(payload) ? payload.details : undefined;
	const missingScopes = status === 403 && isRecord(details) ? stringList(details.missing) : [];
	const message = plain(failureMessage(status, code, payload, missingScopes));
	return new StudioApiError(message, { status, payload, code, missingScopes });
}

export function expectShape(ok: boolean, what: string, expected: string): void {
	if (!ok) throw new StudioShapeError(what, expected);
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

export function failuresOf(value: unknown): CreateFailure[] {
	return Array.isArray(value) ? (value as CreateFailure[]) : [];
}

export function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
