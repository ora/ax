import { PlatformApiError } from "../api/platform-error";
import { platformBase } from "../api/platform-origins";
import type { NextStep } from "../report/next-line";

export function isRunLimitError(error: unknown): error is PlatformApiError {
	return error instanceof PlatformApiError && error.status === 402;
}

export function studioUsageStep(): NextStep {
	const api = URL.parse(platformBase());
	if (!api?.hostname.startsWith("api.") || !["https:", "http:"].includes(api.protocol)) {
		return { call: "Open Settings → Usage in your Studio workspace" };
	}
	const link = new URL("/d", api.origin);
	link.hostname = api.hostname.replace(/^api\./, "app.");
	link.searchParams.set("to", "/[org]/settings?tab=usage");
	return { call: link.href, why: "view your workspace’s run usage" };
}
