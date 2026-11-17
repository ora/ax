import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** A lock older than this was left by an ax that died: every request made while holding it has a 15 s deadline. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 40_000;
const LOCK_POLL_MS = 100;

export class SessionStore {
	readonly file: string;
	private readonly lockFile: string;

	constructor(readonly dir: string = configDir()) {
		this.file = join(dir, "session.json");
		this.lockFile = join(dir, "session.lock");
	}

	read(): StoredSignIn | null {
		try {
			const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			return isStoredSignIn(value) ? value : null;
		} catch {
			return null;
		}
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
	 * token and ends the sign-in.
	 */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const started = Date.now();
		while (!this.tryLock()) {
			if (Date.now() - started > LOCK_WAIT_MS) {
				throw new Error(`another ax command is holding the sign-in (${this.lockFile})`);
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
		}
		try {
			return await fn();
		} finally {
			rmSync(this.lockFile, { force: true });
		}
	}

	private tryLock(): boolean {
		try {
			closeSync(openSync(this.lockFile, "wx", 0o600));
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			this.breakIfStale();
			return false;
		}
	}

	/**
	 * A dead holder's lock is moved aside, then looked at: another waiter may have broken it first
	 * and taken a fresh one in the meantime, and a fresh lock is put back untouched.
	 */
	private breakIfStale(): void {
		if (this.ageMs(this.lockFile) <= LOCK_STALE_MS) return;
		const aside = `${this.lockFile}.${process.pid}.${Date.now()}`;
		try {
			renameSync(this.lockFile, aside);
		} catch {
			return;
		}
		if (this.ageMs(aside) <= LOCK_STALE_MS) {
			try {
				renameSync(aside, this.lockFile);
			} catch {
				// the holder is gone or a new lock exists; either way nothing to restore
			}
			return;
		}
		rmSync(aside, { force: true });
	}

	private ageMs(path: string): number {
		try {
			return Date.now() - statSync(path).mtimeMs;
		} catch {
			return 0;
		}
	}
}
