import { spawn } from "node:child_process";

export interface BrowserOpener {
	command: string;
	args: string[];
}

/**
 * How this machine opens an address in a browser, or null when it has no way to show one (CI, an
 * SSH session, Linux with no display): then the printed link is the way in. The address is one
 * argument to the platform's opener and never passes through a shell.
 */
export function browserOpener(
	url: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): BrowserOpener | null {
	if (env.CI || env.SSH_CONNECTION || env.SSH_TTY) return null;
	if (platform === "darwin") return { command: "open", args: [url] };
	if (platform === "win32") {
		return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
	}
	if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
	return { command: "xdg-open", args: [url] };
}

/**
 * Opens `url` in your browser, best effort; false when it could not. Only a sign-in page on ora's
 * own sign-in server is ever passed here (`ax login` checks it first).
 */
export function openBrowser(url: string): boolean {
	const opener = browserOpener(url);
	if (!opener) return false;
	try {
		const child = spawn(opener.command, opener.args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
