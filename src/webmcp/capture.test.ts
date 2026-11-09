import { describe, expect, it } from "vitest";
import realCapture from "./__fixtures__/local-catalogue-capture.json";
import {
	deriveIframeAllow,
	mapAnnotations,
	mapDeclarativeTools,
	mapShimTools,
	registrationWaitComplete,
} from "./capture";
import { declarativeInputSchemas } from "./vendor/declarative-schema";
import {
	WEBMCP_MAX_DECLARATIVE_FORMS,
	type WebmcpShimDeclarativeForm,
	type WebmcpShimToolRecord,
} from "./vendor/shim";
import type { WebmcpCaptureResult } from "./vendor/types";

// The cases below are ora's own, copied alongside the logic they cover. That is
// the point: this file is not checking that our implementation is reasonable, it
// is checking that it answers the way ora answers. A case that has to be
// softened to pass here is a divergence, not a bad test.

describe("deriveIframeAllow", () => {
	it("is null when the page says nothing about the tools feature", () => {
		expect(deriveIframeAllow(null)).toBeNull();
		expect(deriveIframeAllow("geolocation=(), camera=(self)")).toBeNull();
		expect(deriveIframeAllow("model-context=*")).toBeNull();
	});

	it("is false when the feature is closed or kept to the page itself", () => {
		expect(deriveIframeAllow("tools=()")).toBe(false);
		expect(deriveIframeAllow("tools=(self)")).toBe(false);
		expect(deriveIframeAllow("camera=(), tools=(self)")).toBe(false);
	});

	it("is true when the feature is delegated beyond the page", () => {
		expect(deriveIframeAllow("tools=*")).toBe(true);
		expect(deriveIframeAllow('tools=(self "https://embed.example.com")')).toBe(true);
		expect(deriveIframeAllow('tools=("https://embed.example.com")')).toBe(true);
	});
});

describe("registrationWaitComplete", () => {
	it("keeps listening through the initial window when nothing registered yet", () => {
		expect(
			registrationWaitComplete({
				elapsedMs: 2_000,
				quietMs: 2_000,
				hasRegistered: false,
				initialWaitMs: 5_000,
				maxWaitMs: 12_000,
			}),
		).toBe(false);
	});

	it("stops after the initial window when no registration ever arrives", () => {
		expect(
			registrationWaitComplete({
				elapsedMs: 5_000,
				quietMs: 5_000,
				hasRegistered: false,
				initialWaitMs: 5_000,
				maxWaitMs: 12_000,
			}),
		).toBe(true);
	});

	it("waits for two quiet seconds after the first registration", () => {
		const base = {
			elapsedMs: 6_000,
			hasRegistered: true,
			initialWaitMs: 5_000,
			maxWaitMs: 12_000,
		};
		expect(registrationWaitComplete({ ...base, quietMs: 1_999 })).toBe(false);
		expect(registrationWaitComplete({ ...base, quietMs: 2_000 })).toBe(true);
	});

	it("always respects the hard ceiling", () => {
		expect(
			registrationWaitComplete({
				elapsedMs: 12_000,
				quietMs: 0,
				hasRegistered: true,
				initialWaitMs: 5_000,
				maxWaitMs: 12_000,
			}),
		).toBe(true);
	});
});

// The shim record behind the real capture's one tool: the same name,
// description, schema and annotations, plus the bookkeeping fields only the
// shim carries. Variations below are explicit deltas on it.
const capturedTool = (realCapture as unknown as WebmcpCaptureResult).pages[0].tools[0];
const shimRecord = (delta: Partial<WebmcpShimToolRecord> = {}): WebmcpShimToolRecord => ({
	name: capturedTool.name,
	description: capturedTool.description,
	descriptionTruncated: false,
	inputSchema: capturedTool.inputSchema,
	annotations: capturedTool.annotations,
	hasExecute: capturedTool.hasExecute,
	entryPoint: "document",
	source: "registerTool",
	registrationMs: capturedTool.registrationMs ?? 0,
	unregistered: false,
	unregisteredMs: null,
	...delta,
});

describe("mapAnnotations", () => {
	it("keeps WebMCP's consequentialHint and debugging beside the older keys", () => {
		expect(
			mapAnnotations({
				readOnlyHint: false,
				untrustedContentHint: true,
				consequentialHint: true,
				debugging: false,
				title: "Book a table",
			}),
		).toEqual({
			readOnlyHint: false,
			untrustedContentHint: true,
			consequentialHint: true,
			debugging: false,
			title: "Book a table",
		});
	});

	it("copies by shape: a non-boolean hint is not a declaration", () => {
		expect(mapAnnotations({ consequentialHint: "yes", debugging: 1 })).toEqual({});
	});
});

describe("mapShimTools", () => {
	it("maps the real capture's tool to what the capture recorded", () => {
		const [tool] = mapShimTools([shimRecord()], capturedTool.pageUrl);
		expect(tool).toEqual({ ...capturedTool, title: null });
	});

	it("reads the spec's top-level title, capped like an annotation title", () => {
		const [titled] = mapShimTools([shimRecord({ title: "Search books" })], capturedTool.pageUrl);
		expect(titled.title).toBe("Search books");
		const [long] = mapShimTools([shimRecord({ title: "t".repeat(600) })], capturedTool.pageUrl);
		expect(long.title).toHaveLength(512);
		// A shim that did not record it, or a page that declared none: null.
		const [absent] = mapShimTools([shimRecord({ title: undefined })], capturedTool.pageUrl);
		expect(absent.title).toBeNull();
	});

	it("carries outputSchema when the page declared one, and omits it otherwise", () => {
		const outputSchema = { type: "object", properties: { results: { type: "array" } } };
		const [declared] = mapShimTools([shimRecord({ outputSchema })], capturedTool.pageUrl);
		expect(declared.outputSchema).toEqual(outputSchema);
		for (const missing of [undefined, null]) {
			const [tool] = mapShimTools([shimRecord({ outputSchema: missing })], capturedTool.pageUrl);
			expect("outputSchema" in tool).toBe(false);
		}
	});
});

describe("mapDeclarativeTools", () => {
	const form: WebmcpShimDeclarativeForm = {
		toolName: "search_books",
		toolDescription: "Search the catalogue by title or author.",
		action: "/search",
		method: "get",
		fieldCount: 1,
		fields: [
			{
				tag: "input",
				type: "text",
				name: "q",
				disabled: false,
				readOnly: false,
				required: true,
				multiple: false,
				paramDescription: null,
				labels: ["Query"],
				ariaDescription: null,
				min: null,
				max: null,
				step: null,
				value: null,
				pattern: null,
				checkedValue: null,
				options: [],
			},
		],
		fieldsTruncated: false,
	};

	it("takes each form's schema from the engine's own derivation", () => {
		const [tool] = mapDeclarativeTools([form], "https://example.com/");
		expect(tool.inputSchema).toEqual(declarativeInputSchemas([form])[0]);
		expect(tool.inputSchema).not.toBeNull();
		expect(tool.via).toBe("declarative");
	});

	it("stops at the shim's per-page form cap", () => {
		const forms = Array.from({ length: WEBMCP_MAX_DECLARATIVE_FORMS + 3 }, (_, i) => ({
			...form,
			toolName: `form_${i}`,
		}));
		expect(mapDeclarativeTools(forms, "https://example.com/")).toHaveLength(
			WEBMCP_MAX_DECLARATIVE_FORMS,
		);
	});
});
