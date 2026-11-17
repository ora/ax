import type { SignInTarget } from "./sign-in-target";

// The few OAuth 2.1 calls a browser sign-in from a terminal needs, over fetch and nothing else
// (ax has no runtime dependencies): discovery (RFC 8414), the device flow (RFC 8628), refresh
// with rotation, and revocation (RFC 7009). ax is a public client: its id travels in the body and
// there is no secret.

/**
 * Every request's deadline. The sign-in lock's stale window is derived from it
 * (session-store.ts), so a hung refresh can never have its lock broken while it is in flight.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The sign-in server refused, or did not answer as one. `code` is OAuth's own when it sent one. */
export class OAuthError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "OAuthError";
		this.code = code;
		this.status = status;
	}
}

export interface ServerMetadata {
	issuer: string;
	deviceAuthorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
}

export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	/** Where the person confirms the code: the code already in it when the server says so. */
	verificationUri: string;
	expiresIn: number;
	interval: number;
}

export interface TokenSet {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
	scope: string;
}

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

async function readJson(res: Response): Promise<Json> {
	const text = await res.text();
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" ? (value as Json) : {};
	} catch {
		return {};
	}
}

/** An address the server named, held to the issuer's own origin: ax sends codes and tokens nowhere else. */
function onIssuer(value: unknown, issuer: string, what: string): string {
	const raw = str(value);
	if (!raw) throw new OAuthError("invalid_metadata", `${issuer} names no ${what}`, 0);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OAuthError("invalid_metadata", `${issuer} names an invalid ${what}`, 0);
	}
	if (url.origin !== new URL(issuer).origin) {
		throw new OAuthError(
			"invalid_metadata",
			`${issuer} names its ${what} on another host (${url.host}); ax does not send a sign-in there`,
			0,
		);
	}
	return url.href;
}

/** The sign-in server's own description of itself, checked to be the one ax asked for (RFC 8414 §3.3). */
export async function discover(issuer: string, fetchFn: Fetch = fetch): Promise<ServerMetadata> {
	const res = await fetchFn(`${issuer}/.well-known/oauth-authorization-server`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new OAuthError(
			"not_offered",
			`${issuer} does not offer browser sign-in (HTTP ${res.status})`,
			res.status,
		);
	}
	const body = await readJson(res);
	if (body.issuer !== issuer) {
		throw new OAuthError(
			"issuer_mismatch",
			`${issuer} answered for another sign-in server (${String(body.issuer)})`,
			res.status,
		);
	}
	return {
		issuer,
		deviceAuthorizationEndpoint: onIssuer(
			body.device_authorization_endpoint,
			issuer,
			"device sign-in address",
		),
		tokenEndpoint: onIssuer(body.token_endpoint, issuer, "token address"),
		revocationEndpoint:
			body.revocation_endpoint === undefined
				? undefined
				: onIssuer(body.revocation_endpoint, issuer, "revocation address"),
	};
}

async function postForm(
	url: string,
	form: Record<string, string>,
	fetchFn: Fetch,
): Promise<{ status: number; body: Json }> {
	const res = await fetchFn(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	return { status: res.status, body: await readJson(res) };
}

function refusal(status: number, body: Json, what: string): OAuthError {
	const code = str(body.error) ?? "server_error";
	return new OAuthError(
		code,
		str(body.error_description) ?? `${what} (${code}, HTTP ${status})`,
		status,
	);
}

function tokenSet(body: Json): TokenSet | null {
	const accessToken = str(body.access_token);
	if (!accessToken) return null;
	const expiresIn =
		typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 900;
	return {
		accessToken,
		refreshToken: str(body.refresh_token),
		expiresIn,
		scope: str(body.scope) ?? "",
	};
}

/** RFC 8628 §3.1-3.2: a code for the person to confirm, and the device code ax polls with. */
export async function startDeviceAuthorization(
	meta: ServerMetadata,
	target: SignInTarget,
	scope: string,
	fetchFn: Fetch = fetch,
): Promise<DeviceAuthorization> {
	const { status, body } = await postForm(
		meta.deviceAuthorizationEndpoint,
		{ client_id: target.clientId, scope, resource: target.resource },
		fetchFn,
	);
	if (status !== 200) throw refusal(status, body, "the sign-in server refused to start a sign-in");
	const deviceCode = str(body.device_code);
	const userCode = str(body.user_code);
	const verification = str(body.verification_uri_complete) ?? str(body.verification_uri);
	if (!deviceCode || !userCode || !verification) {
		throw new OAuthError("invalid_response", "the sign-in server's answer had no code", status);
	}
	return {
		deviceCode,
		userCode,
		verificationUri: onIssuer(verification, meta.issuer, "sign-in page"),
		expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
		interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
	};
}

export type DevicePoll = { kind: "tokens"; tokens: TokenSet } | { kind: "pending" | "slow_down" };

/** RFC 8628 §3.4-3.5: one poll. Pending and slow-down are answers; anything else is a refusal. */
export async function pollDeviceToken(
	meta: ServerMetadata,
	target: SignInTarget,
	deviceCode: string,
	fetchFn: Fetch = fetch,
): Promise<DevicePoll> {
	const { status, body } = await postForm(
		meta.tokenEndpoint,
		{
			grant_type: DEVICE_CODE_GRANT,
			device_code: deviceCode,
			client_id: target.clientId,
			resource: target.resource,
		},
		fetchFn,
	);
	if (status === 200) {
		const tokens = tokenSet(body);
		if (!tokens)
			throw new OAuthError("invalid_response", "the sign-in server sent no token", status);
		return { kind: "tokens", tokens };
	}
	if (body.error === "authorization_pending") return { kind: "pending" };
	if (body.error === "slow_down") return { kind: "slow_down" };
	throw refusal(status, body, "the sign-in did not complete");
}

/** A new access token for a refresh token, which the server rotates: the old one is spent. */
export async function refreshTokens(
	tokenEndpoint: string,
	target: Pick<SignInTarget, "clientId" | "resource">,
	refreshToken: string,
	fetchFn: Fetch = fetch,
): Promise<TokenSet> {
	const { status, body } = await postForm(
		tokenEndpoint,
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: target.clientId,
			resource: target.resource,
		},
		fetchFn,
	);
	const tokens = status === 200 ? tokenSet(body) : null;
	if (!tokens) throw refusal(status, body, "the sign-in could not be renewed");
	return tokens;
}

/** RFC 7009: ends the sign-in on the server. True when the server took it. Never throws. */
export async function revokeToken(
	revocationEndpoint: string,
	clientId: string,
	token: string,
	fetchFn: Fetch = fetch,
): Promise<boolean> {
	try {
		const { status } = await postForm(
			revocationEndpoint,
			{ token, token_type_hint: "refresh_token", client_id: clientId },
			fetchFn,
		);
		return status === 200;
	} catch {
		return false;
	}
}
