<p align="center">
  <a href="https://ora.ai"><img src="https://raw.githubusercontent.com/ora/ax/main/.github/assets/ora-mark.svg" width="72" height="72" alt="ora" /></a>
</p>

<h1 align="center">ax</h1>

<p align="center">Score any site's agent readiness from your terminal or CI — and watch real AI agents navigate it.<br />The open-source CLI for <a href="https://ora.ai">ora</a>.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ax"><img src="https://img.shields.io/npm/v/ax?label=npm&color=14B8A6" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/ax"><img src="https://img.shields.io/npm/dm/ax?color=14B8A6" alt="npm downloads" /></a>
  <a href="https://github.com/ora/ax/actions/workflows/ci.yml"><img src="https://github.com/ora/ax/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/ax#provenance"><img src="https://img.shields.io/badge/npm-provenance-14B8A6" alt="npm provenance" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1A1A1A" alt="MIT license" /></a>
</p>

```
npx ax audit https://stripe.com
```

**No account, no API key.** Everything below works out of the box — the one exception is [`journey`](#for-ora-partners), which drives ora's partner platform.

<p align="center">
  <img src="https://raw.githubusercontent.com/ora/ax/main/.github/assets/demo.gif" width="880" alt="ax audit https://stripe.com — live progress, then the layered report and ora's ranked top fixes" />
</p>

Five commands:

- **`audit <url>`** — run ora's hosted agent-readiness audit against a site: live progress, then a layered report of what passed, what's broken, and ora's ranked list of the highest-impact fixes (or `--json` for the raw contract payload). No account or API key needed. Gate CI with `--min-score`.
- **`webmcp-audit <url>`** — audit a page's `document.modelContext` tools in a real browser. Works on any http(s) URL, localhost included, so you can check a surface before you publish it. Measures the page the way ora's capture worker does and has ora score it; nothing is stored, published, or ranked.
- **`deep-journey <url>`** — run a real AI agent at a site on one of ora's curated tasks through the public journey API: no key, no workspace. A partner API key unlocks free-text tasks (`--task`) and a larger allowance.
- **`journey "<intent>"`** — send a real AI agent (claude-code, codex, …) at a site and watch its navigation live as a boxed node-graph, then get the scored insight, tokens, and cost. Partner-only: needs an `ORA_API_KEY` (see [For ora partners](#for-ora-partners)).
- **`skill [name]`** — list, print, or install ora's agent skills, digest-verified from the public registry.

## audit

```
ax audit <url> [--min-score n] [--max-age s] [--force] [--tunnel ora] [--tunnel-cmd c] [--api-key k] [--json] [--show-passing] [--show-skipped]
```

```
  stripe.com  78/100 B+
  Stripe offers strong developer resource discoverability, but lacks an OpenAPI specification.

  Discovery   ██████░░░░ 6/9 passed · 1 skipped
    ✗ Issues (2)
    ┌───┬──────────────┬───────────────────────────┬──────────────────────────────┐
    │   │ Check        │ What's wrong              │ How to fix                   │
    ├───┼──────────────┼───────────────────────────┼──────────────────────────────┤
    │ ✗ │ sitemap.md   │ status 404                │ Publish /sitemap.md listing… │
    ├───┼──────────────┼───────────────────────────┼──────────────────────────────┤
    │ ⚠ │ robots.txt   │ partially restricted      │ Allow AI crawlers in robots… │
    └───┴──────────────┴───────────────────────────┴──────────────────────────────┘

  Top fixes (ranked by ora)
  1. sitemap-md   ≈ +4 pts
  2. robots-txt   ≈ +1.2 pts

  cached result (43 min old) · pass --force for a fresh scan
  Full report: https://ora.ai/stripe.com
```

| Flag | Effect |
|---|---|
| `--min-score <n>` | Exit `1` when the score is below `n` (0-100) — the CI gate |
| `--max-age <s>` | Accept a cached result up to `s` seconds old (server default 6h, clamped to 1-24h) |
| `--force` | Bypass the cache and rescan — spends the stricter 6/day force budget |
| `--tunnel ora` | Expose a local target through ora's own tunnel and audit it — needs `ORA_API_KEY` with the `tunnels:write` + `tunnels:connect` scopes (also read from `ORA_TUNNEL`) |
| `--tunnel-cmd <c>` | Bring your own tunnel: a command that exposes the local target and prints its public `https://` URL (also read from `ORA_TUNNEL_CMD`) |
| `--api-key <k>` | ora-issued scan API key — lifts every scan rate limit (also read from `ORA_SCAN_API_KEY`) |
| `--json` | The raw ora audit payload on stdout, exactly as the API served it |
| `--show-passing` | List every passing check, not just the per-layer summary bar |
| `--show-skipped` | Include not-applicable/pending checks with their reason |

The **Top fixes** list is ranked by ora server-side (non-bonus fixes first, then estimated score uplift) — the CLI renders it verbatim. All `≈ +N pts` figures are estimates. Check *tiers* (required / recommended / emerging) are advisory display metadata and never determine the score.

### CI gate

```yaml
- name: Agent-readiness gate
  run: npx ax audit https://your-site.com --min-score 70
```

Exit codes are the contract:

| Code | Meaning |
|---|---|
| `0` | success (and score ≥ `--min-score` when given) |
| `1` | score below `--min-score` |
| `2` | usage error — bad flags, malformed URL, local target without a tunnel |
| `3` | API unreachable, timeout, or rate limit exhausted |

Budget notes: ora allows 30 scans + 6 `--force` scans per rolling 24h per IP (plus a 10/min burst limit). Results served from the freshness cache cost nothing, so a CI job that audits on every push stays well inside the budget — tune the window with `--max-age`, and reserve `--force` for verifying a fix you just deployed. High-volume callers can present an ora-issued scan API key (`--api-key` or `ORA_SCAN_API_KEY`), which exempts them from all of these limits; keys are issued manually by ora (no self-serve signup), and an unrecognized key silently falls back to the keyless limits rather than erroring. An auth-gated MCP target reports `mcpAuthRequired` and scores 0 as "could not evaluate"; `--min-score` deliberately skips the gate rather than failing on it.

### Auditing localhost (`--tunnel ora`, `--tunnel-cmd`)

A local dev server only exists on your machine, so ora can't reach it. The simplest option is to audit a publicly reachable deployment of the same code (e.g. a preview URL). To audit localhost itself, run it through a tunnel. The result is stored as **ephemeral** either way: excluded from ora's rankings and leaderboard, served with `Cache-Control: no-store`, never indexed, and deleted after 7 days.

**ora's own tunnel.** With an ora platform key (`ora_sk_…`, scopes `tunnels:write` + `tunnels:connect`) in `ORA_API_KEY`, `ax` creates a tunnel, connects it, audits the public hostname, and deletes the tunnel when done — nothing to install, nothing left behind:

```
ax audit localhost:3000 --tunnel ora
```

The hostname is an unguessable UUID under `*.t.agentfront.sh` that stops answering the moment the audit finishes (or you press Ctrl-C). Today the tunnel is opened in `public` mode, because ora's scanner cannot yet present a per-tunnel credential; a `protected` mode the scanner can use is on the roadmap.

**Bring your own tunnel.** Pass `--tunnel-cmd` (or set `ORA_TUNNEL_CMD`) with any command that exposes the local server and prints its public `https://` URL. The CLI runs it, audits the URL it prints, and tears the tunnel down when done:

```
ax audit localhost:3000 --tunnel-cmd 'ora tunnel 3000 --access public'   # ora's tunnel CLI (npm i -g @ora-ai/cli; ora login)
ax audit localhost:3000 --tunnel-cmd 'ngrok http 3000 --log stdout'
```

- **The CLI ships no tunnel vendor and never downloads executables at runtime** — ora's own tunnel is first-party protocol code over Node's built-in WebSocket; any other tunnel tool you already have works through `--tunnel-cmd`, as long as it prints its public URL to stdout or stderr.
- With `ora tunnel`, `--access public` is required today: `protected` prints a tokenized link the scanner cannot use.
- Off-site checks (registry listings, brand search) usually fail for a throwaway tunnel hostname — the report says so. Use tunnel audits to iterate on your on-site surface, not to compare scores.
- Free tiers of some tunnel vendors serve an interstitial warning page to browser-like requests, which can distort what the scanner sees — prefer a vendor/plan that serves your origin directly.

## webmcp-audit

```
ax webmcp-audit <url> [--chrome-endpoint e] [--min-score n] [--api-key k] [--json] [--show-passing]
```

```bash
ax webmcp-audit http://localhost:3000
```

The dev-loop counterpart to the audit at [webmcp.ora.ai](https://webmcp.ora.ai): check the
`document.modelContext` tools your page registers *before* you ship it, and get the same answer
you will get once it is public.

Any `http(s)` URL works — a dev server, a staging host, or a site you do not own. A page with no
WebMCP surface is not an error: it comes back `absent` with the checks that cannot apply marked
`Not applicable`, which is a perfectly good way to see what the audit looks like before you have
written any tools.

**It uses a Chrome you already have.** WebMCP tools only exist inside a live page, so the audit
opens yours in a real browser. It finds your installed Chrome, starts a headless one on a throwaway
profile, and stops it when the audit finishes — nothing to set up, and this package never downloads
or bundles a browser. Set `CHROME_PATH` if yours lives somewhere unusual.

To drive a browser you started yourself, pass `--chrome-endpoint` (a `ws://` URL, an http origin,
or `host:port`) and start it with `--remote-debugging-port`. The command never attaches to a
browser you did not name — including anything already on port 9222 — because silently borrowing a
Chrome with the WebMCP flags on would score your page higher here than it scores on ora.

**Do not enable the WebMCP flags on a Chrome you point it at.** The audit asks whether a real
browser gives an agent WebMCP on your page. A Chrome started with `--enable-features=WebMCPTesting`
answers yes for every site, so a page can come back `active` here and `testing-only` on ora. The
report tells you when the browser answered for the page; where that actually moved a check, ora
annotates that check itself. Keep a flag-enabled Chrome for
[`@ora-ai/webmcp-verify`](https://www.npmjs.com/package/@ora-ai/webmcp-verify), which needs the API
present in order to call your tools.

**What it measures, and where.** The capture is local: three passes over your entry page, the same
passes and the same probe code ora's worker runs, plus a viewport screenshot at ora's 1280×720. As
ora does, it loads the page with images, media and webfonts refused — stylesheets still apply — so
the screenshot the grader sees is the one ora would have taken. That capture is
posted to ora, which runs the 16 checks, two model hops and the tool-selection simulation, and
streams back a score. The CLI scores nothing itself (design decision #1) — grade, findings,
category scores and the simulation are all rendered as ora sent them.

**Availability is a gate, not a score.** Before anything is graded, ora decides whether an
in-browser agent can use the page at all. A page that cannot comes back `not agent-ready` with the
reasons why, and no score or grade — the reasons are the answer.

Past that gate the score is four pillars — `shared-experience` (30), `task-completion` (25),
`tool-quality` (25), `trust` (20). It is **not** the 0–100 agent-readiness score from `ax audit`:
different inputs, different rubric, never comparable.

A pillar can read 0 because it earned nothing or because nothing in it could be measured; the
report marks the second case rather than leaving you to guess.

**Two check statuses mean "no score" and are not the same thing.** `Not applicable` means the check
had nothing to measure and your page is not charged for it. `Not measured` means it applied and
could not be measured — that counts against evidence coverage, and below the coverage gate ora
withholds the letter grade while still reporting the score. A withheld grade beside a real score is
normal, not an error.

**What leaves your machine.** Scoring happens on ora's side, so the capture is uploaded: the page
URL, every tool your page registers (names, descriptions, JSON Schemas, annotations), the WebMCP
evidence found in your page's own scripts, and **a 1280×720 screenshot of the page**. Point it at a
logged-in or seeded dev environment and that screenshot shows whatever was on screen. Your source
code is never read and never sent.

**Nothing is stored.** A local audit is scored and returned and then forgotten. It never reaches
the leaderboard, the badge, or your public scorecard — to appear there, publish and run the audit
on webmcp.ora.ai. Pass `--json` and pipe it to a file if you want to see exactly what was sent
back; the capture itself is what the report's header describes.

Anonymous use is rate-limited to 10/min and 20 per 24h per IP; an ora API key
(`--api-key` / `ORA_API_KEY`) lifts that.

### CI gate

```yaml
- run: npx ax webmcp-audit http://localhost:3000 --min-score 70
```

Any CI image with Chrome installed works; nothing to launch first.

Exit codes match `audit`: `0` ok · `1` below `--min-score` · `2` usage (including no debuggable
Chrome) · `3` API. The gate reads the score, not the grade — a withheld grade would otherwise let
everything through.

## deep-journey

```
ax deep-journey <url> [--intent id | --task text] [--agent id] [--api-key k] [--no-stream] [--json]
```

```
ax deep-journey stripe.com --intent pricing
ax deep-journey zapier.com --task "Find how to build a Slack → Sheets zap"   # needs a partner key
```

Runs a real AI agent at a site through ora's **public** journey API — no key, no workspace needed for curated tasks. The agent's trajectory streams live as progress lines; the terminal output is ora's verdict, the billable step count, and the generated insight:

```
  ✓ task satisfied  stripe.com
  14 steps · 6 turns · 41.2s

  The agent found the pricing page in two hops via llms.txt and correctly
  summarised the standard and custom tiers.
    - llms.txt was load-bearing: it linked /pricing directly
    - no web search was needed; every path came from on-site links

  For the 4-layer readiness audit, run: ax audit stripe.com
```

Anonymous callers run curated intents (`pricing`, `signup`, `api-docs`, `integrate`, `support`, …) — list them with `GET https://ora.ai/api/journey/intents`, and the accepted agents with `GET https://ora.ai/api/journey/agents`. The public caps are 100 runs per rolling 24h per target and 200 runs per 24h per IP (plus a 20/min burst limit); a target at its cap answers with the most recent stored run (`rate_limited: true`) instead of an error, so repeat CI invocations are cheap. Verdict and step count come from ora's contract as-is — the CLI never re-judges a run.

**Keyed tier:** an ora-issued partner API key (`--api-key`, or `ORA_PARTNER_API_KEY` / `ORA_SCAN_API_KEY` in the environment) unlocks `--task` — a free-text task of 4–300 characters that replaces the curated intent — and moves the caller to an allowance of 1000 runs per rolling 24h per key with no per-target cap and no burst guard. Keys are issued manually by ora (no self-serve signup). A wrong or unrecognized key with a *curated* intent silently degrades to the anonymous tier; `--task` without a recognized key is an error.

If the live stream goes quiet (no frames for 120s) the CLI does not abandon the run — it switches to polling the run detail until the server reports a terminal state.

| Flag | Effect |
|---|---|
| `--intent <id>` | Curated task id (server default when omitted) |
| `--task <text>` | Free-text task — needs a partner API key; mutually exclusive with `--intent` |
| `--api-key <k>` | ora partner API key; also read from `ORA_PARTNER_API_KEY` (then `ORA_SCAN_API_KEY`) |
| `--agent <id>` | Agent from the public roster (default: ora's pick) |
| `--no-stream` | Poll for the result instead of streaming the trajectory |
| `--json` | Print the terminal run detail (verdict, step_count, result) as JSON |

deep-journey exit codes: `0` run succeeded (any verdict) · `1` run failed · `2` usage error · `3` API unreachable / rate-limited.

This differs from `ax journey` (below), which drives the authenticated platform with free-text goals and renders the full trajectory graph; `deep-journey` is the zero-setup public path.

## skill

```
ax skill                                # list the registry
ax skill agent-ready-website            # print a SKILL.md
ax skill agent-ready-website --install  # write .claude/skills/<name>/SKILL.md
ax skill --json                         # the raw registry index
```

Skills come from ora's public registry (`https://ora.ai/.well-known/agent-skills/`) and every byte is verified against the registry's sha256 digest before it is printed or installed. Skill content is never bundled into this package. `--dir <path>` overrides the install directory, and `--json` prints the registry index as JSON instead of the formatted list.

## Library use

The same contract-typed client the CLI uses is importable:

```ts
import { audit } from "ax";

const { result } = await audit("stripe.com");
console.log(result.score, result.grade, result.topFixes);
```

`result` is the raw versioned audit payload (`AuditScanResult` / `AuditScoreResult`, generated from ora's OpenAPI spec). `fetchSkill` / `fetchSkillIndex` expose the digest-verified skill registry.

The public journey client is exported too — the same no-key path as `ax deep-journey`:

```ts
import { deepJourney, fetchJourneyAgents } from "ax";

const { agents, defaultId } = await fetchJourneyAgents();
const agent = agents.find((a) => a.id === defaultId)!;
const { detail } = await deepJourney("stripe.com", {
	intentId: "pricing",
	harness: agent.harness,
	model: agent.model,
});
console.log(detail.verdict, detail.step_count, detail.result?.insight.summary);
```

`detail` is the contract's `JourneyRunDetail`; `fetchJourneyIntents` lists the curated intents. The same public caps apply — a capped target resolves with the most recent stored run (`cached: true` on the outcome), not an error.

## For ora partners

Everything above runs without an account. The commands and flags in this section are for teams working with ora directly: they need an ora-issued API key, and there is no self-serve signup — keys are issued by ora (contact [hello@ora.ai](mailto:hello@ora.ai)). A partner key also lifts the anonymous rate limits on `audit`, `webmcp-audit`, and `deep-journey` via their `--api-key` flags.

### journey

```
ax journey "<intent>" [--domain d] [--harness h] [--model m] [--json]
```

```
ax journey "Find the API docs and how to authenticate" --domain stripe.com
```

Triggers a real agent run on ora's platform and renders the journey live — the whole graph repaints in place as the agent moves:

```
  ▶ stripe.com  ·  claude-code

  9 steps  ·  3 reasoning  ·  1 search

  ╭────────────────────────────────────────────────────────────────────────────────╮
  │ ◆ Find the API docs and how to authenticate. Fetch the actual pages to verify. │
  ╰─┬──────────────────────────────────────────────────────────────────────────────╯
    │  (…) The user is asking me to find the API documentation for Stripe…
    │  ╭──────────────────────────────────────────────╮
    ╰──┤ 🔍 "Stripe API documentation authentication" │
       ╰─┬────────────────────────────────────────────╯
         │  ╭─────────────────────────────────────────╮
         ├──┤ 🌐 docs.stripe.com/api/authentication ✓ │
         │  ╰─────────────────────────────────────────╯
         │  ╭───────────────────────────╮
         ╰──┤ 🌐 docs.stripe.com/apis ✓ │
            ╰───────────────────────────╯

  ────────────────────────────────────────────────────
  ✓ completed  9 turns · 30.8s · 119.1k tokens · $0.031

  Visibility  █████████████████████░ 95/100   ✓ intent satisfied
```

Edges come from ora's own per-step attribution (link-follows nest under the page that linked them; searches hang off the intent). `(…)` markers are the agent's reasoning, placed above the action it led to.

| Flag | Effect |
|---|---|
| `--domain <d>` | Site the agent targets (e.g. `stripe.com`) |
| `--harness <h>` | Agent harness: `claude-code` (default), `codex`, `openclaw`, `hermess`, `claude-agent`, `eve`, … |
| `--model <m>` | Model override (e.g. `claude-haiku-4-5-20251001` — cheap and good for demos) |
| `--json` | Full result as JSON: run metadata, usage, insight, and the raw trajectory |

Note: run-to-run variance is real — agents sometimes answer from search snippets without fetching, which scores differently. Run a few journeys before drawing conclusions.

Journey exit codes: `0` run outcome `success` · `1` non-success outcome · `2` any error.

#### Setup

`journey` needs an ora platform API key (scopes `runs:read` + `runs:write`):

```sh
export ORA_API_KEY=ora_sk_...        # your shell, CI secret store, etc.
ax journey "Find the pricing page" --domain example.com
```

For local development, copy `.env.example` to `.env` — the CLI reads a `.env` in the working directory on startup (exported variables win over the file).

## Environment variables

All configuration is environment-first: the consumer defines the variables, the CLI only reads them.

A `.env` in the working directory is read on startup — copy `.env.example` and fill it in. Anything already exported wins over the file, so a key set for your shell or by CI beats a stale `.env`.

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `ORA_API_URL` | audit, deep-journey, skill | `https://ora.ai` | Public API base (no auth) |
| `ORA_PLATFORM_URL` | journey, audit `--tunnel ora` | `https://api.agentfront.sh` | Authenticated platform API base |
| `ORA_TUNNEL` | audit | — (optional) | `ora` opens ora's own tunnel for a local target (same as `--tunnel ora`) |
| `ORA_TUNNEL_CMD` | audit | — (optional) | Tunnel command for a local target (same as `--tunnel-cmd`); wins over `ORA_TUNNEL` |
| `ORA_API_URL` | webmcp-audit | `https://ora.ai` | Also the ingest base for `webmcp-audit` |
| `ORA_API_KEY` | journey, audit `--tunnel ora`, webmcp-audit | — (required for journey and `--tunnel ora`) | Secret key (`ora_sk_…`); journey and `--tunnel ora` exchange it for a bearer token (the tunnel needs the `tunnels:write` + `tunnels:connect` scopes), webmcp-audit sends it to lift the ingest rate limits |
| `ORA_SCAN_API_KEY` | audit, deep-journey | — (optional) | ora-issued scan API key; lifts every scan rate limit (issued manually by ora). deep-journey accepts it as a partner-key fallback |
| `ORA_PARTNER_API_KEY` | deep-journey | — (optional) | ora-issued partner API key; unlocks `--task` and the 1000/24h keyed allowance |

## Contract versioning

The audit types are generated from ora's served OpenAPI spec (`pnpm contract:gen`); the build is pinned to a contract version and CI fails when production drifts from the checked-in types. At runtime, the CLI prints one stderr warning when ora reports a newer contract than the build — upgrade with `npm i -g ax@latest`.

## Migrating from 0.1.x

- `ax scan` is now `ax audit` (no alias).
- `--json` prints the raw ora audit payload instead of the old reshaped envelope: stable check ids, layer ids, `grade`, `topFixes`, and `contractVersion` — key your scripts to those fields.
- Audit API failures now exit `3` (usage errors stay `2`).

## Development

```sh
pnpm install
pnpm test            # vitest (watch)
pnpm test:ci         # single run + coverage
pnpm typecheck
pnpm lint
pnpm contract:gen    # regenerate src/contract/ from the served OpenAPI spec
pnpm build           # tsup → dist/main.cjs (bin) + dist/index.* (library)
pnpm smoke           # run the built binary the way a user would (needs build)
pnpm smoke:webmcp    # webmcp-audit end to end: real Chrome + mock ingest (needs build)
pnpm verify:pack     # check the tarball npm would publish (needs build)
node dist/main.cjs audit https://example.com
```

`webmcp-audit` is the one command whose core cannot be unit-tested — it needs a browser. Two
commands cover it, and CI runs both on every PR:

```sh
AX_WEBMCP_LIVE=1 pnpm test:capture   # the three capture passes against a real Chrome
pnpm build && pnpm smoke:webmcp      # the whole chain: browser → capture → ingest → report
```

Both launch their own headless Chrome and stop it again. In a container where Chrome's sandbox
cannot start, set `AX_WEBMCP_NO_SANDBOX=1` — never on a development machine, since the page being
audited is untrusted and the sandbox is what contains it.

Manual testing without burning the live rate limits:

```sh
node scripts/mock-scan-server.mjs &
ORA_API_URL=http://localhost:8799 node dist/main.cjs audit https://example.com
```

```sh
node scripts/mock-webmcp-ingest.mjs &
ORA_API_URL=http://localhost:8798 node dist/main.cjs webmcp-audit http://localhost:3000
```

The webmcp mock replays the checked-in real ingest fixture, and takes a failure mode as its second
argument — `shim`, `rate`, `scoring` or `stream` — so every error branch is reachable without the
live endpoint.

To exercise the published-package experience locally: `npm pack`, then `npx ./ax-<version>.tgz audit https://example.com`, or `pnpm link --global` and use `ax` directly.

## Releasing

Publishing runs from GitHub Actions only. Every push to `main` updates a
release-please PR; merging it tags, creates the GitHub Release, and publishes
to npm with provenance. See [RELEASING.md](RELEASING.md) for the runbook,
required setup, and failure recovery.

## License

MIT
