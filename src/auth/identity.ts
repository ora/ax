import { jsonOrNull, PlatformApiError } from "../api/platform-error";
import { plainLines } from "../ui/ansi";

// Who a credential is, as `ax login` and `ax whoami` print it.

export type Identity = Record<string, unknown>;

const IDENTITY_TIMEOUT_MS = 15_000;

/**
 * Who `bearer` is, asked of the platform: GET /auth/identity answers for the two credentials a
 * caller presents directly (a platform key, sent as itself, and a sign-in's access token), runs
 * the same checks a call would, and hands out no token.
 */
export async function fetchIdentity(
	base: string,
	bearer: string,
	fetchFn: typeof fetch = fetch,
): Promise<Identity> {
	const res = await fetchFn(`${base}/auth/identity`, {
		headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
		signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
	});
	const body = jsonOrNull(await res.text());
	if (!res.ok || body === null || typeof body !== "object") {
		throw new PlatformApiError(`ora could not say who this credential is (${res.status})`, {
			status: res.status,
			payload: body,
		});
	}
	return body as Identity;
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
