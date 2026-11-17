import { randomBytes } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

// A lock that is a file, for the moments two ax processes on one machine must not overlap (a
// sign-in's refresh: see session-store.ts). It is taken by creating the file exclusively, held by
// a random token written into it, and given back only while the file still holds that token.

export interface FileLockTiming {
	/** A lock older than this was left by a holder that died, and may be broken. */
	readonly staleMs: number;
	/** How long a waiter waits for the lock before it gives up. */
	readonly waitMs: number;
	/** How often a waiter looks again. */
	readonly pollMs: number;
}

const TOKEN_BYTES = 16;

interface Seen {
	token: string;
	ageMs: number;
}

export class FileLock {
	constructor(
		readonly path: string,
		private readonly timing: FileLockTiming,
	) {}

	/** Runs `fn` holding the lock, waiting for another holder first. */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const token = randomBytes(TOKEN_BYTES).toString("hex");
		const started = Date.now();
		while (!this.tryTake(token)) {
			if (Date.now() - started > this.timing.waitMs) {
				throw new Error(`another ax command is holding the lock at ${this.path}`);
			}
			await new Promise((resolve) => setTimeout(resolve, this.timing.pollMs));
		}
		try {
			return await fn();
		} finally {
			this.giveBack(token);
		}
	}

	private tryTake(token: string): boolean {
		let fd: number;
		try {
			fd = openSync(this.path, "wx", 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			this.breakIfStale();
			return false;
		}
		try {
			writeSync(fd, token);
		} catch (err) {
			closeSync(fd);
			rmSync(this.path, { force: true });
			throw err;
		}
		closeSync(fd);
		return true;
	}

	/**
	 * Removes the lock only while it still holds this holder's token. A holder that outlived the
	 * stale window had its lock broken, and the file there now is its successor's: removing it
	 * would let a third command in beside the second.
	 */
	private giveBack(token: string): void {
		if (this.inspect(this.path)?.token === token) rmSync(this.path, { force: true });
	}

	/**
	 * A dead holder's lock is moved aside, then looked at again: it is removed only when it is
	 * still the stale lock judged a moment ago (the same token, still old). Another waiter may
	 * have broken it first and taken a fresh one meanwhile, and a fresh lock is put back.
	 */
	private breakIfStale(): void {
		const seen = this.inspect(this.path);
		if (!seen || seen.ageMs <= this.timing.staleMs) return;
		const aside = `${this.path}.${process.pid}.${randomBytes(TOKEN_BYTES).toString("hex")}`;
		try {
			renameSync(this.path, aside);
		} catch {
			return; // another waiter moved it first
		}
		const moved = this.inspect(aside);
		if (moved && moved.token === seen.token && moved.ageMs > this.timing.staleMs) {
			rmSync(aside, { force: true });
			return;
		}
		try {
			renameSync(aside, this.path);
		} catch {
			rmSync(aside, { force: true }); // its holder is gone; nothing to restore
		}
	}

	private inspect(path: string): Seen | undefined {
		try {
			return { token: readFileSync(path, "utf8"), ageMs: Date.now() - statSync(path).mtimeMs };
		} catch {
			return undefined;
		}
	}
}
