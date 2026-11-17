import { PlatformApiError } from "../api/platform";
import { plainLines } from "../ui/ansi";

// Who a credential is, as `ax login` and `ax whoami` print it.

export type Identity = Record<string, unknown>;

const IDENTITY_TIMEOUT_MS = 15_000;

/** A sign-in's identity, asked of the platform (GET /auth/identity answers who, and hands out no token). */
export async function readIdentity(
	base: string,
	bearer: string,
	fetchFn: typeof fetch = fetch,
): Promise<Identity> {
	const res = await fetchFn(`${base}/auth/identity`, {
		headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
		signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON: the status says enough
	}
	if (!res.ok || body === null || typeof body !== "object") {
		throw new PlatformApiError(`ora could not say who this sign-in is (${res.status})`, {
			status: res.status,
			payload: body,
		});
	}
	return body as Identity;
}

/** A key's identity: the claims of the token it was just traded for (display only, never trusted). */
export function tokenClaims(token: string): Identity {
	const payload = token.split(".")[1];
	if (!payload) return {};
	try {
		const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return value !== null && typeof value === "object" ? (value as Identity) : {};
	} catch {
		return {};
	}
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? plainLines(value) : undefined;

/**
 * The lines for a person. An organization's name, an email and a role are whatever someone
 * typed, so each is printed with its terminal control bytes dropped.
 */
export function identityLines(identity: Identity, how: string, base: string): string[] {
	const orgId = text(identity.organizationId) ?? text(identity.org) ?? "?";
	const orgName = text(identity.organizationName);
	const who = text(identity.email) ?? text(identity.name) ?? text(identity.sub);
	const role = text(identity.role);
	const scopes = Array.isArray(identity.scopes)
		? identity.scopes.filter((scope): scope is string => typeof scope === "string")
		: [];
	return [
		`signed in:     ${how}`,
		`organization:  ${orgName ? `${orgName} (${orgId})` : orgId}`,
		...(who ? [`as:            ${who}${role ? ` (${role})` : ""}`] : []),
		...(scopes.length ? [`permissions:   ${plainLines(scopes.join(", "))}`] : []),
		`platform:      ${base}`,
	];
}
