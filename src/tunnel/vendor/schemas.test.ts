import * as upstream from "@ora-ai/tunnel-protocol";
import { describe, expect, it } from "vitest";
import * as vendored from "./schemas.js";

// The hand-written validators must agree with the package's zod schemas on
// every payload that matters: accepted shapes come out identical (defaults
// applied, unknown keys stripped) and rejected shapes are rejected by both.
const PAIRS = [
	["helloSchema", { agentVersion: "ax/1", target: { protocol: "http", host: "127.0.0.1", port: 3000 } }],
	["helloSchema", { agentVersion: "ax/1", target: { protocol: "http", host: "h", port: 1 }, maxStreams: 4, extra: 1 }],
	["helloAckSchema", { tunnelId: "t", heartbeatMs: 30000, maxStreams: 8, maxFrame: 65536 }],
	["openSchema", { method: "GET", path: "/x?y=1" }],
	["openSchema", { method: "POST", path: "/", headers: { a: "1", "set-cookie": ["x", "y"] } }],
	["responseHeadersSchema", { status: 200 }],
	["responseHeadersSchema", { status: 404, headers: { a: "1" } }],
	["resetSchema", { code: "FORWARD_ERROR" }],
	["goawaySchema", { code: "SHUTDOWN", message: "bye" }],
	["targetSchema", { protocol: "http", host: "h", port: 80 }],
] as const;

const REJECTS = [
	["helloSchema", { agentVersion: "", target: { protocol: "http", host: "h", port: 1 } }],
	["helloSchema", { agentVersion: "a", target: { protocol: "https", host: "h", port: 1 } }],
	["helloSchema", { agentVersion: "a", target: { protocol: "http", host: "h", port: 70000 } }],
	["helloSchema", { agentVersion: "a", target: { protocol: "http", host: "h", port: 1 }, maxStreams: 0 }],
	["helloAckSchema", { tunnelId: "t", heartbeatMs: 0, maxStreams: 8, maxFrame: 1 }],
	["openSchema", { method: "GET", path: "x" }],
	["openSchema", { method: "", path: "/" }],
	["openSchema", { method: "GET", path: "/", headers: { a: 1 } }],
	["openSchema", { method: "GET", path: "/", headers: [] }],
	["responseHeadersSchema", { status: 99 }],
	["responseHeadersSchema", { status: 200.5 }],
	["resetSchema", { code: "" }],
	["resetSchema", { code: "x", message: "m".repeat(1025) }],
	["targetSchema", null],
	["targetSchema", "nope"],
] as const;

describe("vendored schemas agree with @ora-ai/tunnel-protocol", () => {
	it.each(PAIRS)("%s accepts %j identically", (name, input) => {
		const ours = vendored[name].safeParse(input);
		const theirs = upstream[name].safeParse(input);
		expect(theirs.success).toBe(true);
		expect(ours.success).toBe(true);
		expect(ours.success && ours.data).toEqual(theirs.success && theirs.data);
	});

	it.each(REJECTS)("%s rejects %j like upstream", (name, input) => {
		const ours = vendored[name].safeParse(input);
		expect(upstream[name].safeParse(input).success).toBe(false);
		expect(ours.success).toBe(false);
		expect(!ours.success && ours.error.message).toMatch(/\w/);
	});
});
