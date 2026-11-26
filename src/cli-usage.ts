import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// Each entry is a primary API request and the ax commands that can initiate it.
// A watch also reads a report, but only an explicit view counts as a view.
const commandsFor = {
	audit: ["audit"],
	journey: ["journey", "deep-journey"],
	agentFiles: ["generate-files"],
	webmcp: ["webmcp-audit"],
	identity: ["login", "whoami"],
	runCreate: ["run"],
	runView: ["run-view"],
	setPreview: ["run-set-create"],
	setCreate: ["run-set-create"],
	setList: ["run-set-list"],
	setView: ["run-set-view"],
	setCancel: ["run-set-cancel"],
} as const;

export type UsageOperation = keyof typeof commandsFor;
type Command = (typeof commandsFor)[UsageOperation][number];
const knownCommands = Object.values(commandsFor).flat();
const invocation = new AsyncLocalStorage<{ command: Command; header: string; readView: boolean }>();

/** Called only by the executable. The library has no invocation to report. */
export function withCliUsage<T>(version: string, args: string[], run: () => T): T {
	if (process.env.DO_NOT_TRACK === "1") return run();
	const [name, subcommand, action] = args;
	let candidate = name;
	if (name === "run" && subcommand === "set") candidate = `run-set-${action}`;
	else if (name === "run" && subcommand === "view") candidate = "run-view";
	const command = knownCommands.find((known) => known === candidate);
	if (!command || !/^\d+\.\d+\.\d+$/.test(version)) return run();

	const end = args.indexOf("--");
	const options = end === -1 ? args : args.slice(0, end);
	const flags = (options.includes("--json") ? "j" : "") + (options.includes("--watch") ? "w" : "");
	const header = `ax/${version} ${randomUUID()} ${command} ${flags || "-"}`;
	return invocation.run({ command, header, readView: false }, run);
}

function isUsageDestination(base: string): boolean {
	const url = URL.parse(base);
	if (url?.protocol !== "https:" || url.port || url.username || url.password) return false;
	return (
		url.hostname === "ora.ai" ||
		/^api\.(?:(?:staging\.)?(?:ora\.ai|agentfront\.sh)|ws-[a-z0-9-]+\.dev\.agentfront\.sh)$/.test(
			url.hostname,
		)
	);
}

/** Bind the marker once per logical API call. Transport retries reuse it. */
export function cliFetch(
	base: string,
	operation: UsageOperation,
	fetchFn: typeof fetch = fetch,
): typeof fetch {
	const active = invocation.getStore();
	if (
		!active ||
		!commandsFor[operation].some((name) => name === active.command) ||
		!isUsageDestination(base)
	)
		return fetchFn;
	if (operation === "runView" || operation === "setView") {
		if (active.readView) return fetchFn;
		active.readView = true;
	}
	return async (input, init) => {
		// These API clients always pass a URL string on their configured origin.
		if (typeof input !== "string" || new URL(input).origin !== new URL(base).origin)
			return fetchFn(input, init);
		const url = new URL(input);
		if (operation === "agentFiles") url.searchParams.set("cli", "1");
		const headers = new Headers(init?.headers);
		headers.set("x-ora-cli", active.header);
		const response = await fetchFn(url.href, { ...init, headers, redirect: "manual" });
		const location = response.headers.get("location");
		if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;

		// fetch forwards custom headers across redirects. Drop ours on the first hop,
		// then let fetch handle the rest. These clients send only GET and JSON POST.
		await response.body?.cancel();
		const target = new URL(location, url);
		const forward = new Headers(init?.headers);
		if (target.origin !== url.origin) {
			for (const name of ["authorization", "proxy-authorization", "cookie"]) forward.delete(name);
		}
		const get = init?.method === "POST" && [301, 302, 303].includes(response.status);
		if (get) forward.delete("content-type");
		return fetchFn(target.href, {
			...init,
			headers: forward,
			...(get ? { method: "GET", body: undefined } : {}),
		});
	};
}
