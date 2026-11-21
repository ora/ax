import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ORA_PLATFORM_ORIGINS,
	oraPlatformOrigin,
	PLATFORM_BASE,
	platformBase,
	platformDestinationProblem,
} from "./platform-origins";

// ora's platform addresses: one table, read by the destination rule and by ax login.

afterEach(() => vi.unstubAllEnvs());

describe("ora's platform addresses", () => {
	it("have exactly one canonical address, ax's default", () => {
		const canonical = ORA_PLATFORM_ORIGINS.filter((row) => row.canonical);
		expect(canonical).toHaveLength(1);
		expect(PLATFORM_BASE).toBe(canonical[0].origin);
		expect(PLATFORM_BASE).toBe("https://api.ora.ai");
	});

	it("are recognised whatever the spelling, and nothing else is", () => {
		expect(oraPlatformOrigin("https://API.agentfront.sh/")).toEqual({
			origin: "https://api.agentfront.sh",
			canonical: false,
		});
		expect(oraPlatformOrigin("https://api.ora.ai")?.canonical).toBe(true);
		expect(oraPlatformOrigin("https://api.example.test")).toBeUndefined();
		expect(oraPlatformOrigin("not a url")).toBeUndefined();
	});

	it("may each be sent a credential, and a refusal elsewhere names what was not sent", () => {
		for (const { origin } of ORA_PLATFORM_ORIGINS) {
			expect(platformDestinationProblem(origin, "a sign-in")).toBeUndefined();
		}
		const refused = platformDestinationProblem("http://api.example.test", "a sign-in");
		expect(refused).toContain("ax sends a sign-in only over https");
		expect(refused).not.toContain("your key");
	});
});

describe("platformBase", () => {
	it("is the override, else ORA_PLATFORM_URL, else the canonical address, without a trailing slash", () => {
		vi.stubEnv("ORA_PLATFORM_URL", "");
		expect(platformBase("https://api.example.test/")).toBe("https://api.example.test");
		vi.stubEnv("ORA_PLATFORM_URL", "https://api.staging.test//");
		expect(platformBase()).toBe("https://api.staging.test");
	});
});
