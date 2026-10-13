/**
 * Finding a Chrome to capture with, and refusing to capture with the wrong one.
 *
 * Two rules govern this file:
 *
 *  - **Never download a browser** (design decision #6). This starts, or
 *    attaches to, a Chrome the developer already has installed. When it cannot
 *    find one it says how to install or locate one; it never fetches one.
 *  - **Say so when the browser itself provides WebMCP.** ora's capture browser
 *    has no WebMCP support at all, and pass A asks whether `modelContext` is
 *    there without the shim having installed it. On a Chrome started with
 *    `--enable-features=WebMCPTesting` that answers yes for every site,
 *    `real-browser-eligible` passes, and the page verdict comes back `active`
 *    where ora would say `testing-only` - measured on one page, captured twice
 *    by identical code, with only the flag different. The whole point of the
 *    command is that a local run predicts the published one, so
 *    `webmcpParityWarning` below refuses to let that pass silently.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserEndpoint, CdpError, discoverEndpoint } from "./cdp";
import type { WebmcpCaptureResult } from "./vendor/types";

/** Chrome's conventional debugging port, and the one the help text names. */
export const DEFAULT_DEBUG_PORT = 9222;

export type ChromeResolution =
	| { ok: true; endpoint: BrowserEndpoint; close: () => Promise<void>; launched: boolean }
	| { ok: false; message: string };

/**
 * Get a browser to capture with.
 *
 * Launch by default; attach only when the developer names an endpoint. The
 * tempting third option - probe 9222 and attach to whatever is there - is
 * deliberately NOT taken. The `webmcp` plugin tells people to keep a Chrome
 * running with `--enable-features=WebMCPTesting` for `@ora-ai/webmcp-verify`,
 * and 9222 is exactly where it would be. Silently borrowing it would produce a
 * capture that scores higher here than the same page scores on ora, which is
 * the one failure this command exists to avoid.
 *
 * An explicit endpoint that does not answer is an error naming that endpoint -
 * the developer told us where to look and was wrong, and quietly launching our
 * own instead would hide their typo.
 */
export async function resolveChrome(explicit?: string): Promise<ChromeResolution> {
	if (explicit) {
		try {
			const endpoint = await discoverEndpoint(explicit);
			// Attached, not owned: closing someone else's browser out from under
			// them would be rude and would break the next run.
			return { ok: true, endpoint, close: async () => {}, launched: false };
		} catch (err) {
			const cause = describe(err);
			return {
				ok: false,
				message: [
					`No debuggable Chrome answered at ${explicit}.`,
					// The cause only when it adds something. `discoverEndpoint`'s
					// own "nothing answered" restates the line above it; an HTTP
					// status or a malformed version document does not.
					...(cause.startsWith("no debuggable Chrome answered") ? [] : [cause]),
					"",
					...launchLines(DEFAULT_DEBUG_PORT),
				].join("\n"),
			};
		}
	}

	try {
		const chrome = await launchChrome();
		return { ok: true, endpoint: chrome.endpoint, close: chrome.close, launched: true };
	} catch (err) {
		return { ok: false, message: describe(err) };
	}
}

/**
 * Warn when the capturing browser provided WebMCP itself.
 *
 * Read off the finished capture rather than probed up front, because there is
 * no reliable way to ask the question before navigating: `about:blank` is not a
 * secure context, so WebMCP is absent there even on a browser that has it, and
 * `Browser.getBrowserCommandLine` is refused unless the browser was started
 * with `--enable-automation`. Pass A already asks exactly this question on the
 * target page, which IS a secure context on localhost.
 *
 * A warning and not a hard stop, and deliberately a NARROW one. `nativeApi:
 * true` says the browser provided WebMCP; it does not say the score moved. A
 * page carrying a valid origin trial, or one whose tools are callable anyway,
 * is ready on its own merits and ora annotates nothing.
 * Predicting which applies would mean reimplementing a server-side condition
 * here - the exact drift `vendor/` exists to prevent - so this states the
 * browser fact and points at the availability reason ora writes, which the
 * report renders verbatim.
 */
export function webmcpParityWarning(capture: WebmcpCaptureResult): string | null {
	if (!capture.pages.some((page) => page.consumer.nativeApi)) return null;
	return [
		"This Chrome provides WebMCP itself. ora captures with a browser that does not,",
		"so anything that depended on the browser rather than on your page can read",
		"differently there.",
		"",
		"Where that actually changed a result, ora says so in the availability reason",
		"above - read that rather than this. This notice only reports what the browser",
		"did, because deciding whether it changed the outcome is ora's job, not the",
		"CLI's.",
		"",
		"If you started Chrome with --enable-features=WebMCPTesting, drop the flag (or",
		"omit --chrome-endpoint and let this command start its own).",
		"",
		"Keep a flag-enabled Chrome for `npx @ora-ai/webmcp-verify`, which needs the API",
		"present in order to call your tools.",
	].join("\n");
}

function launchLines(port: number): string[] {
	return [
		"The audit drives a Chrome you already have; it never downloads one.",
		"Start one with a debugging port and a scratch profile:",
		"",
		`  ${launchCommand(port)}`,
		"",
		"Then re-run this command. Point at a different one with --chrome-endpoint.",
		"",
		"Do not add --enable-features=WebMCPTesting: the audit measures whether a",
		"real browser gives an agent WebMCP on your page, and a browser that",
		"provides it itself answers yes for every site.",
	];
}

/**
 * The launch line, per platform. A scratch `--user-data-dir` is not optional
 * advice: Chrome refuses `--remote-debugging-port` on a profile that is already
 * open, so a developer with Chrome running would otherwise get a browser that
 * starts and immediately exits.
 */
function launchCommand(port: number): string {
	const binary =
		process.platform === "darwin"
			? '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"'
			: process.platform === "win32"
				? '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
				: "google-chrome";
	const profile = process.platform === "win32" ? "%TEMP%\\ax-webmcp" : "/tmp/ax-webmcp";
	return `${binary} --remote-debugging-port=${port} --user-data-dir=${profile}`;
}

function describe(err: unknown): string {
	if (err instanceof CdpError) return err.message;
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/**
 * A Chrome this process started, and the promise of stopping it again.
 *
 * `close` is not optional politeness: a leaked headless Chrome holds a profile
 * directory and a port until the machine is rebooted, and a dev-loop command is
 * run dozens of times a day.
 */
export interface LaunchedChrome {
	endpoint: BrowserEndpoint;
	close: () => Promise<void>;
}

/**
 * Where Chrome is installed, per platform. `CHROME_PATH` wins - it is the
 * convention chrome-launcher established, so a developer who has already set it
 * for another tool does not have to set ours too.
 */
function chromeCandidates(): string[] {
	const fromEnv = process.env.CHROME_PATH;
	if (fromEnv) return [fromEnv];
	if (process.platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		];
	}
	if (process.platform === "win32") {
		const roots = [
			process.env.PROGRAMFILES,
			process.env["PROGRAMFILES(X86)"],
			process.env.LOCALAPPDATA,
		];
		return roots
			.filter((root): root is string => Boolean(root))
			.map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`);
	}
	return [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/opt/google/chrome/chrome",
		"/snap/bin/chromium",
	];
}

/** The first candidate that exists, or null when Chrome is not installed. */
export function findChrome(): string | null {
	for (const candidate of chromeCandidates()) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Not at this path; try the next.
		}
	}
	return null;
}

/**
 * Flags for a launched Chrome.
 *
 * Mostly the flags ora's own capture browser runs with, because the browser's
 * configuration is part of what a capture measures. Three deliberate
 * differences:
 *
 *  - **No host rules.** ora makes `localhost` unresolvable, which is right for
 *    a service that dials URLs the public hands it and fatal here: reaching
 *    localhost is the entire command.
 *  - **No `--no-sandbox`.** ora needs it because the container it captures in
 *    has no SUID helper or user namespaces. A developer's machine has both, and
 *    turning Chrome's sandbox off to audit a page is not a trade this command
 *    gets to make on their behalf.
 *  - **Never `--enable-features=WebMCPTesting`.** See the note at the top of
 *    this file: a browser that provides WebMCP answers yes for every page.
 */
const LAUNCH_ARGS = [
	"--headless=new",
	"--disable-gpu",
	"--mute-audio",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-background-networking",
	"--disable-sync",
	"--disable-extensions",
	"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

/**
 * Opt out of Chrome's sandbox. Deliberately its own flag rather than a general
 * "extra args" hook: a hook would let anything through, including
 * `--enable-features=WebMCPTesting`, which is the one flag this file exists to
 * keep out.
 *
 * Set it only where the sandbox cannot work - a CI container with unprivileged
 * user namespaces restricted, which is the default on recent Ubuntu images. Do
 * not set it on a developer machine: the page being audited is untrusted, and
 * the sandbox is what contains it.
 */
function sandboxDisabled(): boolean {
	return process.env.AX_WEBMCP_NO_SANDBOX === "1";
}

/** How long to wait for a launched Chrome to publish its debugging port. */
const LAUNCH_TIMEOUT_MS = 20_000;
/** How long to wait for a killed Chrome to exit before removing its profile. */
const PROFILE_REMOVAL_GRACE_MS = 3_000;
const PROFILE_REMOVAL_ATTEMPTS = 4;
const PROFILE_REMOVAL_RETRY_MS = 150;

/**
 * Resolve once `child` has exited, or after `graceMs` either way.
 *
 * A detached child still emits `exit` in this process, but only while the event
 * loop is alive, and the timer is what stops a Chrome that ignores SIGTERM from
 * holding the command open.
 */
function exited(child: ChildProcess, graceMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			child.off("exit", done);
			resolve();
		};
		// Also not unref'd: this timer IS the thing keeping the process alive long
		// enough to remove the profile once the child is gone.
		const timer = setTimeout(done, graceMs);
		child.once("exit", done);
	});
}

/**
 * Start a Chrome the developer already has, on an ephemeral port.
 *
 * Two details that are not obvious:
 *
 *  - **Port 0, read back from `DevToolsActivePort`.** Chrome picks a free port
 *    and writes it into the profile directory. Hardcoding 9222 would collide
 *    with whatever the developer already has on it - including, at worst, a
 *    WebMCP-enabled Chrome, which would silently produce a capture that does
 *    not match ora.
 *  - **A throwaway `--user-data-dir`.** Chrome refuses `--remote-debugging-port`
 *    on a profile that is already open, so we cannot borrow the developer's
 *    running browser however much we would like its cookies. The profile is
 *    removed on close.
 */
export async function launchChrome(): Promise<LaunchedChrome> {
	const binary = findChrome();
	if (!binary) throw new CdpError(notInstalledMessage());

	const profile = mkdtempSync(join(tmpdir(), "ax-webmcp-"));
	const child = spawn(
		binary,
		[
			...LAUNCH_ARGS,
			...(sandboxDisabled() ? ["--no-sandbox"] : []),
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		{
			stdio: "ignore",
			// Detached so a Ctrl-C on the CLI does not leave Chrome reparented to
			// init with the terminal's signal already consumed; `close` kills the
			// whole group.
			detached: true,
		},
	);
	// NOT unref'd, deliberately. `detached` is here for the process-GROUP kill in
	// `cleanup`, not to outlive us: an unref'd child stops holding the event loop
	// open, and Node then exits out from under the awaited cleanup below, leaving
	// both the browser and its profile behind. Every path out of the capture
	// calls `close`, so a referenced child cannot hang the command either.

	/**
	 * Ctrl-C is the common way to end a dev-loop command, and the `finally` that
	 * normally closes the browser never runs on a signal - measured: one SIGINT
	 * mid-capture left nine Chrome processes and a profile behind.
	 *
	 * The handler stops the browser, then re-raises with our own listener already
	 * removed, so the process still dies the way the signal says it should
	 * instead of exiting 0 through a swallowed interrupt.
	 */
	const onSignal = (signal: NodeJS.Signals): void => {
		void cleanup().finally(() => {
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
			process.kill(process.pid, signal);
		});
	};

	const cleanup = async (): Promise<void> => {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		// The whole process group: a detached Chrome spawns renderer children,
		// and killing only the parent leaves them holding the profile.
		const pid = child.pid;
		try {
			if (pid !== undefined) process.kill(-pid, "SIGTERM");
			else child.kill("SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}
		}
		// Wait for Chrome to actually go before removing its profile. Removing it
		// while the process is still shutting down leaves the directory behind:
		// Chrome writes its final state (Local State, the lock files) on the way
		// out, recreating entries under a directory we just walked.
		await exited(child, PROFILE_REMOVAL_GRACE_MS);
		await removeProfile(profile);
	};

	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	try {
		const port = await waitForDevToolsPort(profile, child);
		return { endpoint: await discoverEndpoint(`127.0.0.1:${port}`), close: cleanup };
	} catch (err) {
		await cleanup();
		throw err instanceof CdpError ? err : new CdpError(describe(err));
	}
}

/** Poll the profile for the port Chrome chose. */
async function waitForDevToolsPort(profile: string, child: ChildProcess): Promise<number> {
	const portFile = join(profile, "DevToolsActivePort");
	const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new CdpError(`Chrome exited with code ${child.exitCode} before it was ready.`);
		}
		try {
			// The file's first line is the port; the second is the browser's
			// websocket path. It is written only once Chrome is actually
			// listening, which is what makes it the right thing to poll.
			const first = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
			const port = Number(first);
			if (Number.isInteger(port) && port > 0) return port;
		} catch {
			// Not written yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new CdpError(
		`Chrome did not publish a debugging port within ${LAUNCH_TIMEOUT_MS / 1000}s.`,
	);
}

/**
 * Remove the throwaway profile, retrying briefly.
 *
 * One pass is not enough: Chrome's helper processes flush a last file or two
 * (`Variations`, the lock files) as they go, and on the signal path they can
 * land just after the directory was walked - leaving a one-file directory
 * behind. Retrying a few times over a few hundred milliseconds catches that
 * without waiting on a process that has already been reaped.
 *
 * Best effort throughout: a temp directory we could not remove is litter the OS
 * will collect, never a reason to fail an audit that already succeeded.
 */
async function removeProfile(profile: string): Promise<void> {
	for (let attempt = 0; attempt < PROFILE_REMOVAL_ATTEMPTS; attempt++) {
		try {
			rmSync(profile, { recursive: true, force: true });
			if (!existsSync(profile)) return;
		} catch {
			// Still held; fall through to the wait and try again.
		}
		await new Promise((resolve) => setTimeout(resolve, PROFILE_REMOVAL_RETRY_MS));
	}
	try {
		rmSync(profile, { recursive: true, force: true });
	} catch {
		// Out of attempts.
	}
}

function notInstalledMessage(): string {
	return [
		"No Chrome found on this machine.",
		"",
		"The audit opens your page in a real browser, because WebMCP tools only",
		"exist inside a live page. This package never downloads one.",
		"",
		"Install Chrome (https://google.com/chrome), or point at one you already",
		"have with CHROME_PATH=/path/to/chrome, or start one yourself and pass",
		"--chrome-endpoint:",
		"",
		`  ${launchCommand(DEFAULT_DEBUG_PORT)}`,
	].join("\n");
}
