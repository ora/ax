// What each of ax's commands on the Ora platform needs a credential to carry, declared once: a
// sign-in asks for exactly these (AX_SCOPES in sign-in-target.ts), and every hint that names a
// scope reads them from here.

/** A command's calls on the Ora platform, by the scopes they need. */
export interface PlatformFeature {
	readonly scopes: readonly string[];
}

/** `--tunnel ora`: create and delete the tunnel (tunnels:write), and hold its connection (tunnels:connect). */
export const TUNNEL_FEATURE: PlatformFeature = { scopes: ["tunnels:write", "tunnels:connect"] };

/** Ora platform evaluations: start a run or set (ax.sets:write), follow it and read its evidence (ax.sets:read). */
export const SETS_FEATURE: PlatformFeature = { scopes: ["ax.sets:read", "ax.sets:write"] };

/** Every feature ax has on the Ora platform. */
export const PLATFORM_FEATURES: readonly PlatformFeature[] = [TUNNEL_FEATURE, SETS_FEATURE];

/** How a hint names a feature's scopes: `tunnels:write + tunnels:connect`. */
export function scopeList(feature: PlatformFeature): string {
	return feature.scopes.join(" + ");
}
