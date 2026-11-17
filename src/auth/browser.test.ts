import { describe, expect, it } from "vitest";
import { browserOpener } from "./browser";

// Whether ax tries to open a browser, and with what. Nothing is launched here.

const URL = "https://account.ora.test/device?user_code=ABCD-EFGH";

describe("opening the sign-in page", () => {
	it.each([
		["darwin", {}, { command: "open", args: [URL] }],
		["win32", {}, { command: "rundll32", args: ["url.dll,FileProtocolHandler", URL] }],
		["linux", { DISPLAY: ":0" }, { command: "xdg-open", args: [URL] }],
		["linux", { WAYLAND_DISPLAY: "wayland-0" }, { command: "xdg-open", args: [URL] }],
	] as const)("on %s %j uses the platform's own opener", (platform, env, expected) => {
		expect(browserOpener(URL, env, platform)).toEqual(expected);
	});

	it.each([
		["in CI", { CI: "true", DISPLAY: ":0" }, "darwin"],
		["over SSH", { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, "darwin"],
		["in an SSH terminal", { SSH_TTY: "/dev/pts/0" }, "win32"],
		["on Linux with no display", {}, "linux"],
	] as const)("is not tried %s: the printed link is the way in", (_, env, platform) => {
		expect(browserOpener(URL, env, platform)).toBeNull();
	});

	it("passes the address as one argument, never through a shell", () => {
		const hostile = "https://account.ora.test/device?user_code=A;rm -rf ~";
		expect(browserOpener(hostile, {}, "darwin")?.args).toEqual([hostile]);
	});
});
