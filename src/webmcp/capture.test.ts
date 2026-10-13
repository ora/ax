import { describe, expect, it } from "vitest";
import { deriveIframeAllow, registrationWaitComplete } from "./capture";

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
