import { assertKeyDestination, keyDestinationProblem } from "./key-destination";

// ora's platform API, by its addresses: one table, read by the rule for where a credential may go
// (any of them may get one) and by `ax login` (a sign-in is issued for the canonical one only).

export interface PlatformOrigin {
	readonly origin: string;
	/** The address ora's sign-in server issues tokens for, and ax's default. Exactly one row. */
	readonly canonical: boolean;
}

export const ORA_PLATFORM_ORIGINS: readonly PlatformOrigin[] = [
	{ origin: "https://api.ora.ai", canonical: true },
	// ax's default before 0.12, and what `.env.example` used to set: the same API, where a key
	// still goes. A sign-in is not issued for it.
	{ origin: "https://api.agentfront.sh", canonical: false },
];

const [CANONICAL] = ORA_PLATFORM_ORIGINS.filter((row) => row.canonical);

/** ora's canonical platform address: ax's default, and the one its sign-in is issued for. */
export const PLATFORM_BASE = CANONICAL.origin;

/** The platform API base: explicit override, else $ORA_PLATFORM_URL, else the canonical address. */
export function platformBase(override?: string): string {
	return (override ?? process.env.ORA_PLATFORM_URL ?? PLATFORM_BASE).replace(/\/+$/, "");
}

/** The row for the ora platform address `base` names, whatever its spelling, if it names one. */
export function oraPlatformOrigin(base: string): PlatformOrigin | undefined {
	let origin: string;
	try {
		origin = new URL(base).origin;
	} catch {
		return undefined;
	}
	return ORA_PLATFORM_ORIGINS.find((row) => row.origin === origin);
}

const ORIGINS = ORA_PLATFORM_ORIGINS.map((row) => row.origin);

/**
 * Why ax will not send `credential` (as a person reads it: "a sign-in") to the platform `base`
 * names, or undefined when it may. ora's own addresses always may.
 */
export function platformDestinationProblem(base: string, credential: string): string | undefined {
	return keyDestinationProblem(base, "ORA_PLATFORM_URL", ORIGINS, credential);
}

/** Throws `KeyDestinationError` when ax must not send a platform key to `base`. */
export function assertPlatformDestination(base: string): void {
	assertKeyDestination(base, "ORA_PLATFORM_URL", ORIGINS);
}
