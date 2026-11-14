import { fromLocalEnvFile } from "../env";

/** The variables that move where ax sends a key. */
export type KeyBaseVariable = "ORA_PLATFORM_URL" | "ORA_API_URL";

/** ax refused to send a key to the host a base URL names. */
export class KeyDestinationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KeyDestinationError";
	}
}

// `*.localhost` resolves to this machine (RFC 6761), which is how ora runs in development.
function isThisMachine(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "[::1]" ||
		/^127(\.\d{1,3}){3}$/.test(hostname)
	);
}

/**
 * Why ax will not send a key to `base`, or undefined when it may.
 *
 * The default host is always fine. Any other host gets the key only over https
 * (plain http only to this machine), and only when the user chose it: a host
 * that came from a `.env` in the current directory is refused, because that
 * file may belong to whatever repository ax happens to run in.
 */
export function keyDestinationProblem(
	base: string,
	variable: KeyBaseVariable,
	defaultBase: string,
): string | undefined {
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		return `${variable} is not a URL, so ax did not send your key anywhere.`;
	}
	if (url.origin === new URL(defaultBase).origin) return undefined;
	const local = isThisMachine(url.hostname);
	if (url.protocol !== "https:" && !local) {
		return `${variable} is ${url.origin}. ax sends your key only over https, or over plain http to this machine.`;
	}
	if (!local && fromLocalEnvFile(variable) && sameOrigin(process.env[variable], url)) {
		return `${variable} in ./.env points at ${url.host}, so ax did not send your key there. To use that host, export ${variable} in your shell.`;
	}
	return undefined;
}

function sameOrigin(value: string | undefined, url: URL): boolean {
	try {
		return value !== undefined && new URL(value).origin === url.origin;
	} catch {
		return false;
	}
}

/** Throws `KeyDestinationError` when ax must not send a key to `base`. */
export function assertKeyDestination(
	base: string,
	variable: KeyBaseVariable,
	defaultBase: string,
): void {
	const problem = keyDestinationProblem(base, variable, defaultBase);
	if (problem) throw new KeyDestinationError(problem);
}
