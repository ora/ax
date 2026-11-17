import { ApiKeyCredential } from "./api-key-credential";
import type { PlatformCredential } from "./credential";
import { NotSignedInError } from "./errors";
import type { PlatformFeature } from "./platform-features";
import { SessionStore, type SignInStore } from "./session-store";
import { SignInCredential } from "./sign-in-credential";
import { platformResource } from "./sign-in-target";

// Which credential a platform call signs with, decided in ONE place: an ordered chain of sources,
// the first with a credential for the platform winning. ORA_API_KEY comes first, so CI and
// scripts behave as before, then the sign-in `ax login` stored. Routing (does a goal run on the
// platform?), every command's credential and every "which one wins" hint ask this chain.

/** One place a platform credential can come from (Strategy). */
export interface CredentialSource {
	/** The credential it holds for the platform at `base`, or null. */
	find(base: string): PlatformCredential | null;
	/** Optional: the platform it holds a credential for instead, when that is not `base`. */
	heldFor?(base: string): string | undefined;
}

/** ORA_API_KEY, read each time it is asked (a local .env is loaded after start-up). */
export class EnvKeySource implements CredentialSource {
	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly fetchFn?: typeof fetch,
	) {}

	find(base: string): PlatformCredential | null {
		const secret = this.env.ORA_API_KEY;
		return secret ? new ApiKeyCredential(base, secret, this.fetchFn) : null;
	}
}

/** The sign-in `ax login` stored, for the platform it was issued for: its tokens go nowhere else. */
export class StoredSignInSource implements CredentialSource {
	constructor(
		readonly store: SignInStore,
		private readonly fetchFn?: typeof fetch,
	) {}

	find(base: string): PlatformCredential | null {
		const session = this.store.read();
		if (!session || session.resource !== platformResource(base)) return null;
		return new SignInCredential(base, this.store, session, this.fetchFn);
	}

	heldFor(base: string): string | undefined {
		const session = this.store.read();
		return session && session.resource !== platformResource(base) ? session.resource : undefined;
	}
}

/** The sources in the order they win. */
export class CredentialChain {
	constructor(private readonly sources: readonly CredentialSource[]) {}

	/** The credential a call to the platform at `base` signs with, or null. Never throws. */
	find(base: string): PlatformCredential | null {
		return firstFound(this.sources, base);
	}

	/** The credential used for `base` instead of `source`'s: one a source ahead of it holds. */
	ahead(base: string, source: CredentialSource): PlatformCredential | null {
		const index = this.sources.indexOf(source);
		return index === -1 ? null : firstFound(this.sources.slice(0, index), base);
	}

	/**
	 * As {@link find}, for a call that cannot go without one: none is a NotSignedInError naming
	 * both ways in, the scopes `feature` needs, and the platform a stored sign-in is for instead.
	 */
	resolve(base: string, feature?: PlatformFeature): PlatformCredential {
		const found = this.find(base);
		if (found) return found;
		const signedInFor = this.sources.map((source) => source.heldFor?.(base)).find(Boolean);
		throw new NotSignedInError({ base, feature, signedInFor });
	}
}

function firstFound(sources: readonly CredentialSource[], base: string): PlatformCredential | null {
	for (const source of sources) {
		const credential = source.find(base);
		if (credential) return credential;
	}
	return null;
}

/** The chain ax's commands use, and the stored sign-in in it (which `ax login` writes). */
export interface PlatformCredentials {
	readonly chain: CredentialChain;
	readonly signIns: StoredSignInSource;
}

/** ORA_API_KEY, then the stored sign-in: the one composition every command starts from. */
export function platformCredentials(
	deps: { store?: SignInStore; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {},
): PlatformCredentials {
	const signIns = new StoredSignInSource(deps.store ?? new SessionStore(), deps.fetchFn);
	return {
		chain: new CredentialChain([new EnvKeySource(deps.env, deps.fetchFn), signIns]),
		signIns,
	};
}
