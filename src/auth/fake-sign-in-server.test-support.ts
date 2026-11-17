import { vi } from "vitest";

// A stand-in for ora's sign-in server and the platform's identity address, for tests: it answers
// fetch the way the real ones do, counts what it was asked, and lets a test set each answer.

export const PLATFORM = "https://api.ora.test";
export const ISSUER = "https://account.ora.test";

export interface FakeServerState {
	/** Each device poll answers the next of these; the last one repeats. */
	polls: Array<"pending" | "slow_down" | "approve" | "denied" | "expired">;
	/** What a refresh answers. */
	refresh: "ok" | "invalid_grant" | "down";
	/** What discovery answers. */
	discovery: "ok" | "missing" | "other-issuer" | "off-host";
	/** What the device start answers. */
	start: "ok" | "invalid_client";
	refreshes: number;
	revoked: string[];
	identityCalls: string[];
	issued: number;
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeSignInServer(overrides: Partial<FakeServerState> = {}) {
	const state: FakeServerState = {
		polls: ["approve"],
		refresh: "ok",
		discovery: "ok",
		start: "ok",
		refreshes: 0,
		revoked: [],
		identityCalls: [],
		issued: 0,
		...overrides,
	};
	const forms: Array<{ url: string; form: URLSearchParams }> = [];
	const tokens = () => {
		state.issued += 1;
		return {
			access_token: `access-${state.issued}`,
			refresh_token: `refresh-${state.issued}`,
			expires_in: 900,
			scope: "runs:read runs:write tunnels:read tunnels:write tunnels:connect",
			token_type: "Bearer",
		};
	};
	const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
		if (init?.method === "POST") forms.push({ url, form });
		if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
			if (state.discovery === "missing") return json({ error: "not found" }, 404);
			const host = state.discovery === "off-host" ? "https://elsewhere.test" : ISSUER;
			return json({
				issuer: state.discovery === "other-issuer" ? "https://account.other.test" : ISSUER,
				device_authorization_endpoint: `${host}/oauth2/device/auth`,
				token_endpoint: `${ISSUER}/oauth2/token`,
				revocation_endpoint: `${ISSUER}/oauth2/revoke`,
			});
		}
		if (url === `${ISSUER}/oauth2/device/auth`) {
			if (state.start === "invalid_client") return json({ error: "invalid_client" }, 401);
			return json({
				device_code: "device-1",
				user_code: "ABCD-EFGH",
				verification_uri: `${ISSUER}/device`,
				verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
				expires_in: 600,
				interval: 5,
			});
		}
		if (url === `${ISSUER}/oauth2/token`) {
			if (form.get("grant_type") === "refresh_token") {
				state.refreshes += 1;
				if (state.refresh === "down") throw new TypeError("fetch failed");
				if (state.refresh === "invalid_grant") return json({ error: "invalid_grant" }, 400);
				return json(tokens());
			}
			const next = state.polls.length > 1 ? state.polls.shift() : state.polls[0];
			if (next === "approve") return json(tokens());
			if (next === "denied") return json({ error: "access_denied" }, 400);
			if (next === "expired") return json({ error: "expired_token" }, 400);
			return json({ error: next === "slow_down" ? "slow_down" : "authorization_pending" }, 400);
		}
		if (url === `${ISSUER}/oauth2/revoke`) {
			state.revoked.push(form.get("token") ?? "");
			return new Response("", { status: 200 });
		}
		if (url === `${PLATFORM}/auth/identity`) {
			const bearer = String(new Headers(init?.headers).get("authorization"));
			state.identityCalls.push(bearer);
			if (bearer === "Bearer access-expired") return json({ code: "INVALID_CREDENTIAL" }, 401);
			return json({
				sub: "user-1",
				type: "delegated",
				organizationId: "org-1",
				organizationName: "Acme",
				email: "member@acme.test",
				role: "developer",
				scopes: ["runs:read", "runs:write", "tunnels:connect", "tunnels:read", "tunnels:write"],
			});
		}
		return json({ error: "unexpected", url }, 599);
	});
	/** The form of the last POST the server received: a test that expected none has failed. */
	const lastForm = (): URLSearchParams => {
		const last = forms.at(-1);
		if (!last) throw new Error("the sign-in server received no form");
		return last.form;
	};
	return { state, forms, lastForm, fetchFn: fetchFn as unknown as typeof fetch, calls: fetchFn };
}
