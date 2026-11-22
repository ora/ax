import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A sign-in on the machine running the tests must never reach them: every test file gets its own
// empty config directory, so `ax login`'s stored sign-in (auth/session-store.ts) starts absent.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ax-test-config-"));
