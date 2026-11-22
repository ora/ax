import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileLock, type FileLockTiming } from "./file-lock";
import { REQUEST_TIMEOUT_MS } from "./oauth";

// THE ONE FILE AX WRITES (invariant 7): the sign-in `ax login` stores, so later commands can act
// as you. Only your own account can read it (0600, in a 0700 directory), it holds tokens and no
// password, and `ax logout` removes it.

export interface StoredSignIn {
	version: 1;
	/** ora's sign-in server it came from. */
	issuer: string;
	clientId: string;
	/** The platform origin its tokens are for: ax sends them to no other host. */
	resource: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
	accessToken: string;
	refreshToken: string;
	/** When the access token expires (epoch ms). */
	expiresAt: number;
	scope: string;
}

/** Where the sign-in `ax login` stored is kept: the file below, or a test's own. */
export interface SignInStore {
	/** The stored sign-in, or null when there is none or this ax cannot read it. */
	read(): StoredSignIn | null;
	/** True when a sign-in file is there, whether or not this ax can read it. */
	present(): boolean;
	write(session: StoredSignIn): void;
	clear(): void;
	/**
	 * Runs `fn` while no other ax command changes this sign-in: a refresh, `ax login` storing a new
	 * one, or `ax logout` removing it.
	 */
	withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** `$XDG_CONFIG_HOME/ax`, else `%APPDATA%\ax` on Windows, else `~/.config/ax`. */
export function configDir(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string {
	if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "ax");
	if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "ax");
	return join(home, ".config", "ax");
}

function isStoredSignIn(value: unknown): value is StoredSignIn {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.version === 1 &&
		["issuer", "clientId", "resource", "tokenEndpoint", "accessToken", "refreshToken"].every(
			(key) => typeof v[key] === "string" && v[key] !== "",
		) &&
		typeof v.expiresAt === "number"
	);
}

/**
 * The sign-in lock's timing, derived from the one request its holder makes: a refresh, which the
 * sign-in server answers within {@link REQUEST_TIMEOUT_MS} or not at all. A live holder is done
 * within that deadline, so a lock twice as old was left by an ax that died; a waiter outlasts
 * that window by one more request before it gives up.
 */
export const SIGN_IN_LOCK_TIMING: FileLockTiming = {
	staleMs: 2 * REQUEST_TIMEOUT_MS,
	waitMs: 3 * REQUEST_TIMEOUT_MS,
	pollMs: 100,
};

export class SessionStore implements SignInStore {
	readonly file: string;
	private readonly lock: FileLock;

	constructor(readonly dir: string = configDir()) {
		this.file = join(dir, "session.json");
		this.lock = new FileLock(join(dir, "session.lock"), SIGN_IN_LOCK_TIMING);
	}

	read(): StoredSignIn | null {
		try {
			const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			return isStoredSignIn(value) ? value : null;
		} catch {
			return null;
		}
	}

	present(): boolean {
		return existsSync(this.file);
	}

	/** Written whole, then renamed into place: another ax never reads half a file. */
	write(session: StoredSignIn): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.file);
	}

	clear(): void {
		rmSync(this.file, { force: true });
	}

	/**
	 * Runs `fn` holding the sign-in's lock, so two ax commands never refresh at once: the server
	 * rotates the refresh token on every use, and a second use of a spent one is read as a stolen
	 * token and ends the sign-in. `fn` makes at most one request to the sign-in server.
	 */
	withLock<T>(fn: () => Promise<T>): Promise<T> {
		return this.lock.withLock(fn);
	}
}
