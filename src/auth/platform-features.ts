// What each of ax's commands on ora's platform needs a credential to carry, declared once: a
// sign-in asks for exactly these (AX_SCOPES in sign-in-target.ts), and every hint that names a
// scope reads them from here.

/** A command's calls on ora's platform, by the scopes they need. */
export interface PlatformFeature {
	readonly scopes: readonly string[];
}

/** A journey on a goal: create the run (runs:write), follow its stream and read its totals (runs:read). */
export const JOURNEY_FEATURE: PlatformFeature = { scopes: ["runs:read", "runs:write"] };

/** `--tunnel ora`: create and delete the tunnel (tunnels:write), and hold its connection (tunnels:connect). */
export const TUNNEL_FEATURE: PlatformFeature = { scopes: ["tunnels:write", "tunnels:connect"] };

/** A set of journeys: preview, start and stop one (ax.sets:write), read and list them (ax.sets:read). */
export const SETS_FEATURE: PlatformFeature = { scopes: ["ax.sets:read", "ax.sets:write"] };

/** Every feature ax has on ora's platform. */
export const PLATFORM_FEATURES: readonly PlatformFeature[] = [
	JOURNEY_FEATURE,
	TUNNEL_FEATURE,
	SETS_FEATURE,
];

/** How a hint names a feature's scopes: `tunnels:write + tunnels:connect`. */
export function scopeList(feature: PlatformFeature): string {
	return feature.scopes.join(" + ");
}
