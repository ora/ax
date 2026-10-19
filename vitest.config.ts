import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts"],
		// vitest 4's restoreAllMocks only restores vi.spyOn spies; it no longer
		// clears vi.fn() call history. Clear it before every test so one test's
		// calls never leak into the next one's assertions.
		clearMocks: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "json"],
			exclude: ["src/main.ts", "node_modules/", "dist/"],
		},
	},
});
