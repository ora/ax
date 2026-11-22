import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ISSUER, PLATFORM, unreachable } from "./fake-sign-in-server.test-support";
import {
	discover,
	pollDeviceToken,
	refreshTokens,
	revokeToken,
	type ServerMetadata,
} from "./oauth";
import { OAuthError, postForm, refusal, send } from "./oauth-transport";
import { AX_CLIENT_ID } from "./sign-in-target";

// How ax talks to the sign-in server: a redirect is refused (two real servers on 127.0.0.1 and
// Node's own fetch, since a stand-in fetch cannot follow one), and every answer that is not a
// success is told apart: transient (no answer, a 5xx or 429, a page with no OAuth error), which
// the caller may wait out, or the server's own OAuth error, which ends the request.

const TOKEN_URL = `${ISSUER}/oauth2/token`;
const FORM = { grant_type: "refresh_token", refresh_token: "refresh-0", client_id: AX_CLIENT_ID };

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers every request with `make()`. */
const answering =
	(make: () => Response): typeof fetch =>
	async () =>
		make();

/** A fetch that never gets an answer, failing with `error`. */
const failing =
	(error: Error): typeof fetch =>
	async () => {
		throw error;
	};

interface Received {
	method: string;
	path: string;
	body: string;
}

interface Listening {
	origin: string;
	host: string;
	received: Received[];
	close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1, answering with `answer` and keeping every request it received. */
async function listen(
	answer: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Listening> {
	const received: Received[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			received.push({ method: req.method ?? "", path: req.url ?? "", body });
			answer(req, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		host: `127.0.0.1:${port}`,
		received,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

describe("a redirect from the sign-in server", () => {
	let status = 307;
	let issuer: Listening;
	let elsewhere: Listening;

	beforeAll(async () => {
		// Where a followed redirect would take the request: it answers as a working sign-in server
		// would, so following it would succeed, and handing it a code or a token would be the harm.
		elsewhere = await listen((req, res) => {
			const body = req.url?.endsWith("/.well-known/oauth-authorization-server")
				? {
						issuer: issuer.origin,
						device_authorization_endpoint: `${issuer.origin}/oauth2/device/auth`,
						token_endpoint: `${issuer.origin}/oauth2/token`,
					}
				: { access_token: "access-elsewhere", refresh_token: "refresh-elsewhere", expires_in: 900 };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		});
		// The issuer answers every request with a redirect to the same path on the other server.
		issuer = await listen((req, res) => {
			res.writeHead(status, { location: `${elsewhere.origin}${req.url ?? "/"}` });
			res.end();
		});
	});

	afterAll(async () => {
		await issuer?.close();
		await elsewhere?.close();
	});

	beforeEach(() => {
		issuer.received.length = 0;
		elsewhere.received.length = 0;
	});

	const target = () => ({ issuer: issuer.origin, resource: PLATFORM, clientId: AX_CLIENT_ID });
	const meta = (): ServerMetadata => ({
		issuer: issuer.origin,
		deviceAuthorizationEndpoint: `${issuer.origin}/oauth2/device/auth`,
		tokenEndpoint: `${issuer.origin}/oauth2/token`,
		revocationEndpoint: `${issuer.origin}/oauth2/revoke`,
	});

	it.each([307, 308])(
		"on a refresh (HTTP %i) is refused, and the refresh token goes nowhere else",
		async (redirect) => {
			status = redirect;
			const error = await refreshTokens(
				`${issuer.origin}/oauth2/token`,
				target(),
				"refresh-0",
				fetch,
			).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(OAuthError);
			expect(error).toMatchObject({ code: "redirected", status: redirect, transient: false });
			expect((error as Error).message).toBe(
				`the sign-in could not be renewed: ${issuer.host} answered with a redirect (HTTP ${redirect}), and ax does not follow one with a sign-in`,
			);
			expect(issuer.received).toEqual([
				expect.objectContaining({ method: "POST", path: "/oauth2/token" }),
			]);
			expect(issuer.received[0]?.body).toContain("refresh_token=refresh-0");
			expect(elsewhere.received).toEqual([]);
		},
	);

	it.each([307, 308])(
		"on a device poll (HTTP %i) is refused, and the device code goes nowhere else",
		async (redirect) => {
			status = redirect;
			const error = await pollDeviceToken(meta(), target(), "device-1", fetch).catch(
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(OAuthError);
			expect(error).toMatchObject({ code: "redirected", status: redirect, transient: false });
			expect(issuer.received).toHaveLength(1);
			expect(issuer.received[0]?.body).toContain("device_code=device-1");
			expect(elsewhere.received).toEqual([]);
		},
	);

	it.each([307, 308])("on discovery (HTTP %i) is refused, never followed", async (redirect) => {
		status = redirect;
		const error = await discover(issuer.origin, fetch).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({ code: "redirected", status: redirect, transient: false });
		expect(issuer.received).toEqual([
			expect.objectContaining({
				method: "GET",
				path: "/.well-known/oauth-authorization-server",
			}),
		]);
		expect(elsewhere.received).toEqual([]);
	});

	it("on a revocation is not taken for one, and the refresh token goes nowhere else", async () => {
		status = 307;
		expect(
			await revokeToken(`${issuer.origin}/oauth2/revoke`, AX_CLIENT_ID, "refresh-9", fetch),
		).toBe(false);
		expect(issuer.received).toHaveLength(1);
		expect(issuer.received[0]?.body).toContain("token=refresh-9");
		expect(elsewhere.received).toEqual([]);
	});
});

describe("an answer that is not a success", () => {
	it.each([
		[
			"a proxy's 502 page",
			() =>
				new Response("<html><body>502 Bad Gateway</body></html>", {
					status: 502,
					headers: { "content-type": "text/html" },
				}),
			502,
		],
		[
			"a 503 that carries an OAuth error",
			() => json({ error: "temporarily_unavailable" }, 503),
			503,
		],
		["a 429", () => json({ message: "Too many requests" }, 429), 429],
		["a 400 with no OAuth error", () => json({ message: "Bad Request" }, 400), 400],
	] as const)(
		"%s is transient: the same request may work in a moment",
		async (_what, make, status) => {
			const answer = await postForm(TOKEN_URL, FORM, answering(make));
			const error = refusal(answer);
			expect(error).toBeInstanceOf(OAuthError);
			expect(error).toMatchObject({
				status,
				transient: true,
				message: `account.ora.test answered HTTP ${status}`,
			});
		},
	);

	it("an OAuth error on a 4xx is the server's word on the request: terminal, with OAuth's code", async () => {
		const answer = await postForm(
			TOKEN_URL,
			FORM,
			answering(() => json({ error: "invalid_grant" }, 400)),
		);
		const error = refusal(answer);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({ code: "invalid_grant", status: 400, transient: false });
	});

	it("a context opens the message, before the server's own description", async () => {
		const answer = await postForm(
			TOKEN_URL,
			FORM,
			answering(() => json({ error: "invalid_grant", error_description: "revoked" }, 400)),
		);
		expect(refusal(answer, "the sign-in could not be renewed").message).toBe(
			"the sign-in could not be renewed: revoked",
		);
	});
});

describe("no answer at all", () => {
	it("a refused connection is transient, naming the host and Node's code", async () => {
		const error = await send(TOKEN_URL, {}, failing(unreachable())).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({
			code: "unreachable",
			status: 0,
			transient: true,
			message: "could not reach account.ora.test (ECONNREFUSED)",
		});
	});

	it("a passed deadline is transient, naming the host and the deadline", async () => {
		const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
		const error = await postForm(TOKEN_URL, FORM, failing(timedOut)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({
			code: "unreachable",
			transient: true,
			message: "account.ora.test did not answer within 15 s",
		});
	});

	it("an answer whose body breaks off is no answer either", async () => {
		const reset = unreachable("ECONNRESET");
		const cutOff = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new TextEncoder().encode('{"access_token":'));
						controller.error(reset);
					},
				}),
				{ status: 200 },
			);
		const error = await postForm(TOKEN_URL, FORM, answering(cutOff)).catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "unreachable",
			transient: true,
			message: "could not reach account.ora.test (ECONNRESET)",
		});
	});
});
