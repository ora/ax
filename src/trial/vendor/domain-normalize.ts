// Copied from ora's journey code. DO NOT EDIT BY HAND.
//
// Source: ora's src/lib/journey/domain-normalize.ts at commit 075e9fe8f,
// verbatim. ./run-flags.ts matches hosts with it, and the trial spec reduces
// the site with it, so both agree with ora. Re-copy, never edit. Biome does
// not format this directory.

/** Canonical domain normalisation for journey/simulation writes and site
 *  matching (the simulations route stores the same form it rate-limits on).
 *  Kept free of server imports so browser code can share it. */
export function normalizeDomain(domain: string | null | undefined): string | null {
  const d = domain?.normalize("NFKC").trim().toLowerCase();
  return d && d.length > 0 ? d : null;
}
