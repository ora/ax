import { describe, expect, it } from "vitest";
import { PlatformApiError } from "../api/platform-error";
import { TunnelError } from "../tunnel";
import { errorChain, servedBody } from "./error-chain";

describe("errorChain", () => {
	it("is the error and every error it wraps, outermost first", () => {
		const inner = new Error("inner");
		const outer = new Error("outer", { cause: inner });
		expect([...errorChain(outer)]).toEqual([outer, inner]);
	});

	it("stops at a cause that is not an error, and at a cycle", () => {
		expect([...errorChain(new Error("x", { cause: "a string" }))]).toHaveLength(1);
		const a = new Error("a");
		const b = new Error("b", { cause: a });
		Object.assign(a, { cause: b });
		expect([...errorChain(b)]).toEqual([b, a]);
		expect([...errorChain("not an error")]).toEqual([]);
	});
});

describe("servedBody", () => {
	it("is the first body a server answered with, through any wrapper", () => {
		const served = { error: "insufficient_scope" };
		const refused = new PlatformApiError("refused", { status: 403, payload: served });
		expect(servedBody(new TunnelError("no tunnel", { cause: refused }))).toBe(served);
	});

	it("skips an error whose body was not JSON, and is undefined when none answered", () => {
		const notJson = new PlatformApiError("bad gateway", { status: 502, payload: null });
		expect(servedBody(notJson)).toBeUndefined();
		expect(servedBody(new Error("plain"))).toBeUndefined();
	});
});
