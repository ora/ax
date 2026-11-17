/**
 * The documented exit-code contract (README + --help), shared by every command that has no
 * codes of its own:
 *   0 success (and score >= --min-score when given)
 *   1 score below --min-score
 *   2 usage error (bad flags, malformed URL, local target without a tunnel, no credential)
 *   3 API unreachable / timeout / rate limit exhausted / ora refused
 */
export const EXIT = { OK: 0, BELOW_MIN_SCORE: 1, USAGE: 2, API: 3 } as const;
