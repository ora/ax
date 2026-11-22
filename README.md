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

**No account, no API key.** Everything below works out of the box. The exceptions are [`journey`](#for-ora-partners) on a goal of your own and `audit --tunnel ora`, which need you [signed in to ora](#sign-in) (`ax login`) or an ora platform key; a goal of your own on the free path needs a partner key instead.

<p align="center">
  <img src="https://raw.githubusercontent.com/ora/ax/main/.github/assets/demo.gif" width="880" alt="ax audit https://stripe.com — live progress, then the layered report and ora's ranked top fixes" />
</p>

Six commands:

- **`audit <url>`** — run ora's hosted agent-readiness audit against a site: live progress, then a layered report of what passed, what's broken, and ora's ranked list of the highest-impact fixes (or `--json` for the raw contract payload). No account or API key needed. Gate CI with `--min-score`.
- **`webmcp-audit <url>`** — audit a page's `document.modelContext` tools in a real browser. Works on any http(s) URL, localhost included, so you can check a surface before you publish it. Measures the page the way ora's capture worker does and has ora score it; nothing is stored, published, or ranked.
- **`journey --domain <site>`** — run a real AI agent at a site on one of ora's curated tasks through the public journey API: no key, no workspace. A partner API key unlocks a goal of your own and a larger allowance. `ax deep-journey <url>` is the older name and still works.
- **`journey "<goal>"`** — send a real AI agent (claude-code, codex, …) at a site and watch its navigation live as a boxed node-graph, then get the scored insight, tokens, and cost. Partner-only: needs `ax login` or an `ORA_API_KEY` (see [For ora partners](#for-ora-partners)). Several goals, agents, repeats or levels of help against one site are [a set of journeys](#a-set-of-journeys), run and graded on ora's platform.
- **`skill [name]`** — list, print, or install ora's agent skills, digest-verified from the public registry.
- **`generate-files <domain>`** — draft the files agents look for on a site (`ard.json`, `ai-catalog.json`, `poppy.json`, `llms.txt`, a `robots.txt` edit, an API catalog, MCP server cards), filled in from ora's last scan of the domain.

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
| `--tunnel ora` | Expose a local target through ora's own tunnel and audit it — needs `ax login`, or `ORA_API_KEY` with the `tunnels:write` + `tunnels:connect` scopes (also read from `ORA_TUNNEL`) |
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

Budget notes: ora allows 30 scans + 6 `--force` scans per rolling 24h per IP (plus a 10/min burst limit). Results served from the freshness cache cost nothing, so a CI job that audits on every push stays well inside the budget — tune the window with `--max-age`, and reserve `--force` for verifying a fix you just deployed. High-volume callers can present an ora-issued scan API key (`--api-key` or `ORA_SCAN_API_KEY`), which exempts them from these limits (a key scoped to `pap:read` keeps a daily cap and cannot `--force`); keys are issued manually by ora (no self-serve signup), and an unrecognized key silently falls back to the keyless limits rather than erroring. An auth-gated MCP target is not a failure: ora answers with an `MCP_AUTH_REQUIRED` error and no score; ax prints the notice (or the error object with `--json`), skips `--min-score`, and exits `0`.

### Auditing localhost (`--tunnel ora`, `--tunnel-cmd`)

A local dev server only exists on your machine, so ora can't reach it. The simplest option is to audit a publicly reachable deployment of the same code (e.g. a preview URL). To audit localhost itself, run it through a tunnel. The result is stored as **ephemeral** either way: excluded from ora's rankings and leaderboard, served with `Cache-Control: no-store`, never indexed, and deleted after 7 days.

**ora's own tunnel.** Signed in with [`ax login`](#sign-in), or with an ora platform key (`ora_sk_…`, scopes `tunnels:write` + `tunnels:connect`) in `ORA_API_KEY`, `ax` creates a tunnel, connects it, audits the public hostname, and deletes the tunnel when done — nothing to install, nothing left behind:

```
ax audit localhost:3000 --tunnel ora
```

The hostname is an unguessable UUID under `*.t.agentfront.sh` that stops answering the moment the audit finishes (or you press Ctrl-C). A tunnel opened with a sign-in also closes, within about half a minute, when that sign-in ends. Today the tunnel is opened in `public` mode, because ora's scanner cannot yet present a per-tunnel credential; a `protected` mode the scanner can use is on the roadmap.

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
Chrome with the WebMCP flags on would make your page read differently here than it does on ora.

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
posted to ora, which runs its 20 checks, two model hops and the tool-selection simulation, and
streams back a score. The CLI never calls your tools, so the three checks that need a tool call
(`invoke-success-rate`, `visible-effect`, `hint-vs-observed`) read `Not applicable` on a local
audit. The CLI scores nothing itself (design decision #1) — grade, findings,
category scores and the simulation are all rendered as ora sent them.

**Availability is reported, not scored.** ora says whether an in-browser agent can use the page
(`agent-ready`, `not agent-ready`, or unknown) and why, and the report leads with it. It never
changes the score: a `not agent-ready` page still gets its score and pillars. The one exception is
a page whose only tools are declarative forms: its pillars are scored, and its grade is withheld,
because ora finds those tools in the markup and cannot watch a browser register them.

The score is four pillars — `shared-experience` (30), `task-completion` (25),
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

Anonymous use is rate-limited to 10/min and 20 per 24h per IP. An ora-issued partner or scan API
key (`--api-key`, or `ORA_PARTNER_API_KEY` / `ORA_SCAN_API_KEY`) lifts the daily limit; the
per-minute limit still applies.

### CI gate

```yaml
- run: npx ax webmcp-audit http://localhost:3000 --min-score 70
```

Any CI image with Chrome installed works; nothing to launch first.

Exit codes follow `audit`: `0` ok · `1` below `--min-score` · `2` usage (no debuggable Chrome, the
page did not load, or a capture ora would refuse) · `3` API, a failed capture, or no score
returned. The gate reads the score, not the grade — a withheld grade would otherwise let
everything through.

<a id="deep-journey"></a>

## journey, free on a curated task

```
ax journey --domain <site> [--intent id] [--agent id] [--api-key k] [--no-stream] [--json]
ax journey "<goal>" --domain <site> --api-key k [--agent id] [--no-stream] [--json]
```

```
ax journey --domain stripe.com --intent pricing
ax journey "Find how to build a Slack → Sheets zap" --domain zapier.com --api-key k   # needs a partner key
```

`ax deep-journey <url>` is the older name for this command. It keeps its flags (`--task` included) and exit codes, prints the `ax journey` call it stands for on stderr, and will be removed in a future major release.

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

Anonymous callers run curated intents (`pricing`, `signup`, `api-docs`, `integrate`, `support`, …) — list them with `GET https://ora.ai/api/journey/intents`, and the publicly offered agents with `GET https://ora.ai/api/journey/agents`. The public caps are 100 runs per rolling 24h per target and task, and 20 runs per 24h per IP (plus a 20/min burst limit and a shared ceiling of 3,000 anonymous runs a day across all callers); a target at its cap answers with the most recent stored run (`rate_limited: true`) instead of an error, so repeat CI invocations are cheap. Verdict and step count come from ora's contract as-is — the CLI never re-judges a run.

**Keyed tier:** an ora-issued partner API key (`--api-key`, or `ORA_PARTNER_API_KEY` / `ORA_SCAN_API_KEY` in the environment) unlocks a goal of your own — a free-text task of 4–300 characters that replaces the curated intent — and moves the caller to an allowance of 1000 runs per rolling 24h per key with no per-target cap and no burst guard. Keys are issued manually by ora (no self-serve signup). A wrong or unrecognized key with a *curated* intent silently degrades to the anonymous tier; a goal of your own without a recognized key is an error. A goal with only a partner key set (no `ORA_API_KEY`) takes this path; with `ORA_API_KEY` set too, it runs on ora's platform unless you add a flag of this path (`--intent`, `--agent`, `--api-key`, `--no-stream`).

The CLI always follows the run's stream to the end, `--no-stream` included, because ora saves a finished run from inside the stream. If the stream drops or goes quiet (no frames for 120s), the CLI reopens it, which resumes the same run without re-running the agent. A stream `429` is waited out (up to 60s) before reopening; any other HTTP error from the stream (a `404`, an auth error, a `5xx`) ends the command at once. Only after five failed reopens does it fall back to polling the run detail, within a 15-minute budget shared with the stream.

| Flag | Effect |
|---|---|
| `--intent <id>` | Curated task id (server default when omitted) |
| `"<goal>"` | A goal of your own; needs a partner API key and cannot be combined with `--intent` |
| `--api-key <k>` | ora partner API key; also read from `ORA_PARTNER_API_KEY` (then `ORA_SCAN_API_KEY`) |
| `--agent <id>` | Agent from the public roster (default: `cas-haiku`, Claude Code on the Haiku model ora's roster lists) |
| `--no-stream` | Hide the live trajectory view and print only the final result |
| `--json` | Print the terminal run detail (verdict, step_count, result) as JSON |

Exit codes: `0` run succeeded (any verdict) · `1` run failed · `2` usage error · `3` API unreachable / rate-limited.

Mixing these flags with `--harness` or `--model`, which are for a goal of your own on ora's platform ([below](#journey)), is a usage error (exit 2) naming both. This is the zero-setup public path; the platform path renders the full trajectory graph.

## skill

```
ax skill                                # list the registry
ax skill agent-ready-website            # print a SKILL.md
ax skill agent-ready-website --install  # write .claude/skills/<name>/SKILL.md
ax skill --json                         # the raw registry index
```

Skills come from ora's public registry (`https://ora.ai/.well-known/agent-skills/`) and every skill whose index entry carries a sha256 digest is verified against it, byte for byte, before it is printed or installed. Skill content is never bundled into this package. `--dir <path>` overrides the install directory, and `--json` prints the registry index as JSON instead of the formatted list.

## generate-files

```
ax generate-files example.com               # writes into the current directory
ax generate-files example.com --out public  # writes into public/ (your site's web root)
ax generate-files example.com --json        # ora's payload, files + notes, nothing written
```

Drafts the files agents look for on a site, filled in from ora's last scan of the domain (no new crawl). For a domain ora has never scanned you get only a website entry and a minimal `poppy.json`, so run `ax audit` first to fill in the rest:

| File | Written to | What it is |
|---|---|---|
| `ard.json`, `ai-catalog.json` | `.well-known/` | An [Agentic Resource Discovery](https://agenticresourcediscovery.org/) catalog (the same document at the [AI Catalog Standard](https://ai-catalog.io/)'s path). Every entry is anchored to your domain, not to ora |
| `poppy.json` | `.well-known/` | A [Personal Agent Protocol](https://personalagentprotocol.org/docs/1.0/spec) (version 1.0) file for signed-out browsing; the OAuth issuer and APIs ora saw are printed as notes, because naming them is only correct once they implement the protocol |
| `llms.txt` | web root | An index of the docs, APIs and agent endpoints ora found; skipped when you already publish one |
| `robots.txt` | web root | An edit of your current robots.txt: every line kept, a group added for AI search crawlers and user-requested agents your `User-agent: *` rules block (copying your other rules), and a `Sitemap:` line. Training crawlers and crawlers you block by name are never touched |
| `api-catalog` | `.well-known/` | An [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727) API catalog pointing at your OpenAPI description |
| `server-card` | `<mcp path>/` | A draft MCP server card for each MCP server that has none. A card for a server on another host (`mcp.example.com`) is listed with its URL, not written; `--json` carries its body |

A file ora cannot draft honestly (you already publish it, ora never read the original, or ora found nothing to put in it) is left out and explained under "Not drafted". These are drafts: read each file and its notes before you publish.

Nothing is overwritten: if any target file exists - your `robots.txt` included - nothing is written and the command exits `2`. Pass `--force` to overwrite, or `--out <dir>` to write elsewhere and compare. Exit codes: `0` written, `2` usage (bad domain, files exist), `3` API. Same files as the web generator at [directory.ora.ai/generate](https://directory.ora.ai/generate) and `GET https://ora.ai/api/agent-files/{domain}?include=all`.

## Library use

The same contract-typed client the CLI uses is importable:

```ts
import { audit } from "ax";

const { result } = await audit("stripe.com");
console.log(result.score, result.grade, result.topFixes);
```

`result` is the raw versioned audit payload (`AuditScanResult` / `AuditScoreResult`, generated from ora's OpenAPI spec). `fetchSkill` / `fetchSkillIndex` expose the digest-verified skill registry, and `fetchAgentFiles` the agent files generator.

The public journey client is exported too — the same no-key path as `ax journey --domain`:

```ts
import { deepJourney, fetchJourneyAgents } from "ax";

const { agents, defaultId } = await fetchJourneyAgents();
const agent = agents.find((a) => a.id === defaultId)!;
const { detail } = await deepJourney("stripe.com", {
	intentId: "pricing",
	harness: agent.harness,
	model: agent.model,
});
console.log(detail.verdict, detail.step_count, detail.result?.insight?.summary);
```

`detail` is the contract's `JourneyRunDetail`; `fetchJourneyIntents` lists the curated intents. The same public caps apply — a capped target resolves with the most recent stored run (`cached: true` on the outcome), not an error.

## For ora partners

Everything above runs without an account. The commands in this section are for teams working with ora directly, and there is no self-serve signup: accounts and keys come from ora (contact [hello@ora.ai](mailto:hello@ora.ai)). `journey` on a goal of your own (and `audit --tunnel ora`) runs on ora's platform as a member of your organization: [sign in](#sign-in) with `ax login`, or use an ora platform key (`ora_sk_…`). A separate partner or scan key, passed with `--api-key`, lifts the anonymous rate limits on `audit` and the free `journey`, and the daily limit on `webmcp-audit`.

### Sign in

```
ax login      # sign in through your browser
ax whoami     # who ax calls ora's platform as
ax logout     # end the sign-in, on ora and on this machine
```

`ax login` prints a link and a short code, opens the link in your browser, and waits while you sign in and approve. If ora's sign-in server stops answering for a moment while you do, ax waits a little longer and tries again. Pass `--no-browser` to only print the link, for example over SSH. Approve only a sign-in you started yourself. ax asks for what its commands use and nothing more: `runs:read` + `runs:write` for journeys and `tunnels:write` + `tunnels:connect` for `--tunnel ora`, which creates, connects and deletes its tunnel and never lists one. ora never grants more than your role allows. A viewer, for example, can hand over read access only.

The sign-in renews itself, and is stored in `~/.config/ax/session.json` (`$XDG_CONFIG_HOME/ax` when set, `%APPDATA%\ax` on Windows), readable by your account only. It lasts until you run `ax logout` or disconnect **ax** in ora under Settings › Connected apps. `ax logout` removes the file first and then ends the sign-in on ora, so nothing is left on disk even when ora can't be reached; it also removes a file this version of ax can't read. After that, ora refuses the next command, and a tunnel the sign-in opened closes within about half a minute. A sign-in is for the platform it was made for: point `ORA_PLATFORM_URL` elsewhere and ax neither uses nor sends it.

`ORA_API_KEY`, when set, is used before the sign-in, so CI and scripts work as before. Use a key wherever no person is at the terminal.

`ax whoami` asks ora who the credential ax would use is, a sign-in or a key alike, and exits `0` · `2` neither a sign-in nor a key, or a platform address ax will not send one to · `3` ora refused the credential or could not answer. `ax login` exits `0` signed in · `2` a platform address ax will not sign in to · `3` the sign-in did not complete (cancelled, expired, or ora unreachable).

### journey

```
ax journey "<goal>" [--domain d] [--harness h] [--model m] [--json]
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

`journey` needs a [sign-in](#sign-in), or an ora platform API key with the `runs:read` + `runs:write` scopes:

```sh
ax login                             # once, at your terminal
ax journey "Find the pricing page" --domain example.com
```

```sh
export ORA_API_KEY=ora_sk_...        # your shell, CI secret store, etc.
ax journey "Find the pricing page" --domain example.com
```

For local development, copy `.env.example` to `.env` — the CLI reads a `.env` in the working directory on startup (exported variables win over the file).

### A set of journeys

One journey is one agent, one goal, one run. A set asks a wider question: across several goals, several agents and several amounts of help, where does your site lose the agent?

```
ax journey "<goal>" ["<goal>" ...] --domain <site> [--agents <a>,...] [--levels] [--brand <b>] [--docs <url>] [--exact <url>] [--repeat N] [--yes] [--wait <minutes>] [--json]
ax journey view <id> [--watch] [--wait <minutes>] [--json]
ax journey list [--json]
ax journey cancel <id> [--json]
```

```
ax journey "Find how to create an issue from the API" \
           "Find how to receive a webhook from Linear when an issue is updated." \
  --domain linear.app --agents claude-code,codex --levels --exact https://linear.app/developers
```

`ax journey` runs a set when you give it more than one goal or any set flag (`--agents`, `--levels`, `--brand`, `--docs`, `--exact`, `--repeat`, `--yes`, `--wait`, `--watch`). One goal with none of them is the single journey above. If ora refuses that run because your organization does not have the product single runs belong to, ax runs the goal as a set of one instead (one run, on the agent you named or your plan's own) and follows it live.

A set runs on ora's platform, in your organization. The platform starts the runs, has each one graded and counts them; ax asks, waits and prints. The report here, `--json` and the platform's own pages therefore show the same numbers, and nothing is kept on your machine: a set is found again by its id (`ax journey list`).

#### Levels of help

With `--levels`, each goal is run several times, each time telling the agent a little more about your site. Every level is one fixed sentence added after your goal; no model rewrites a prompt.

| Level | What the agent is told | Runs when |
|---|---|---|
| Need only | The goal as written | `--levels`. A goal that already names your brand or domain skips this level |
| Brand named | The goal, then `Use <brand>.` | `--levels` |
| Docs linked | The goal, then `Use <brand>. Its documentation is at <url>.` | `--docs <url>` |
| Exact target | The goal, then `Start at <url>.` | `--exact <url>` |

`--brand`, `--docs` and `--exact` each turn levels on. The brand defaults to the domain's name (`linear.app` gives `Linear`); the preview shows the one used.

Where the agents start succeeding tells you which layer to fix. Agents that fail at *Need only* and succeed once the brand is named or the docs are linked did not find you: a **Discovery** gap. Agents that still fail until they are handed the exact page found you and could not get the answer out of your site: an **Access and Usability** gap.

A run counts as satisfied when a panel of judge models finds all three of: the answer is specific and usable, it is about your product, and it is supported by a page on your site that the agent opened during the run.

#### Preview, then launch

Before anything starts, ax prints what the set is and what it will use (on stderr), then asks:

```
linear.app: a set of journeys
  Goal 1: Find how to create an issue from the API
  Goal 2: Find how to receive a webhook from Linear when an issue is updated.
  Brand: Linear
  Levels:
    Need only     the goal as written
    Brand named   the goal, then "Use Linear."
    Exact target  the goal, then "Start at https://linear.app/developers."
  Goal 2: The goal names Linear, so the need level is skipped. Write the goal without it to include that level.
  No --docs URL, so the docs level is skipped. Add --docs <url> to include it.
  Agents: claude-code/claude-haiku-4-5-20251001, codex/gpt-5.4-mini
  Repeats: 1
  Runs: 10 (a set may start at most 200)
  Your plan has 190 runs left.
Launch 10 runs? [y/N]
```

Answer `y` to launch. `--yes` launches without asking, and is required where there is no terminal to ask on (CI, a pipe): without it ax prints the preview and exits `2` having started nothing. A set takes up to 5 goals, 4 agents and 10 repeats, and may start at most 200 runs. Runs count against your plan like any other; a set that does not fit is refused before it starts.

#### The report

ax then watches the set and prints its report when every run has ended and been graded:

```
linear.app  set 593eea5e-c76d-4394-8dd7-dc52c6fbb61d

Goal 1: Find how to create an issue from the API
  Level         claude-code/claude-haiku-4-5-20251001  codex/gpt-5.4-mini
  Need only     0 of 1                                 0 of 1
    claude-code/claude-haiku-4-5-20251001: 1 never visited your site
    codex/gpt-5.4-mini: 1 never visited your site
  Brand named   0 of 1                                 1 of 1
    codex/gpt-5.4-mini: 1 never visited your site
  Exact target  0 of 1                                 1 of 1

Goal 2: Find how to receive a webhook from Linear when an issue is updated.
  Level         claude-code/claude-haiku-4-5-20251001  codex/gpt-5.4-mini
  Brand named   1 of 1                                 1 of 1
  Exact target  1 of 1                                 1 of 1

  linear.app loses agents at the Discovery layer: 0 of 2 runs satisfied at Need only, 3 of 4 at Brand named. An early signal: not enough runs to decide.
  Goal 2: The goal names Linear, so the need level is skipped. Write the goal without it to include that level.
  No --docs URL, so the docs level is skipped. Add --docs <url> to include it.
  At the need level the prompt does not name your site, so an agent can reach the goal without using it.
Next: ax audit linear.app
```

- A cell is `satisfied of graded` runs for one goal, level and agent. From 5 graded runs it also shows the rate, as `60% (3 of 5)`. Use `--repeat` to get there: one run per cell is a first look, not a measurement.
- Under a cell, ax lists the runs that need a second look: `never visited your site` (the agent answered without opening a page of yours), `blocked by your site` (your site refused the agent's request), `excluded` (the run was lost to the platform's own infrastructure, never to your site, and is never counted against you) and `still running`.
- A closing line names a gap between two neighbouring levels when the platform's comparison finds one. `An early signal: not enough runs to decide.` means exactly that: the direction is visible, the evidence is thin.

#### Watching live

With `--watch` on a terminal, ax follows the set over ora's live stream and repaints one panel in place: what you asked for, the state with a progress bar, and one row per agent under each level, with one box per repeat that fills as its run ends. In color the boxes are green, red, grey, cyan, yellow and empty; without color (`NO_COLOR`) their shapes tell them apart:

```
  ◆ linear.app · a set of journeys                                              set ebafe3d5
    Goal     Find how to create an issue from the API
    Levels   Need only › Brand named › Exact target
    Brand    Linear
    Agents   claude-code/claude-haiku-4-5-20251001 · codex/gpt-5.4-mini
    Runs     12 · 2 repeats of each goal, level and agent

  ◇ grading   ████████████▒▒▒▒▒▒▒▒▒▒▒▒  6 of 12 graded · 12 started   1m 19s

    Need only
      ✓ claude-code   × ×   0 of 2 passed · 2 never visited
      ✓ codex         × ×   0 of 2 passed · 2 never visited
    Brand named
      ◈ claude-code   ▣ ▣   grading
      ◇ codex         ▣ ▣   grading
    Exact target
      ✓ claude-code   ■ ×   1 of 2 passed
      ◆ codex         ▣ ▣   grading

    ■ passed  × not passed  · excluded  ▣ grading  ▸ running  □ waiting
    Ctrl-C stops watching; the runs go on.
    Pick it up again: ax journey view ebafe3d5-8a74-4eb4-b532-2732055d31c0 --watch
```

When watching ends, the panel's last frame stays on screen, and the report under it leaves out the cells the panel already shows: its closing lines and the Next line follow. Off a terminal (CI, a pipe, a file) `--watch` prints a line each time something moves instead, and the report is printed whole.

#### Watching, leaving and stopping

| Flag or command | Effect |
|---|---|
| `--agents <list>` | 1 to 4 agents, comma separated, each `harness` or `harness/model` (default: the one the preview names). `--harness` and `--model` name a single agent instead |
| `--levels` | Run each goal at the levels of help |
| `--brand <name>` | The brand the brand and docs levels name |
| `--docs <url>` | Adds the *Docs linked* level |
| `--exact <url>` | Adds the *Exact target* level |
| `--repeat <n>` | Runs per goal, level and agent, 1 to 10 (default 1) |
| `--yes` | Launch without asking |
| `--wait <minutes>` | How long to watch (default 60). When it runs out ax prints the set as it stands and exits `0` |
| `--watch` | Follow the set over ora's live stream: on a terminal a live panel (see *Watching live*), elsewhere a line each time the state or a level and agent's runs move. Without it ax reads the set every few seconds and prints the state. If the stream is not available ax says so and reads instead |
| `--json` | The set exactly as the platform served it, on stdout; the preview and progress stay on stderr |
| `ax journey view <id>` | Print a set as it stands now; with `--wait`, watch it until it finishes |
| `ax journey list` | Your organization's sets, newest first |
| `ax journey cancel <id>` | Stop the runs still going. Runs that already finished keep their results; the set then reads `stopped`, and a cell whose runs were stopped reads `no grade`. A set with no run still going is left as it is: ax prints what ora says about it and exits `0` |

The runs go on at the platform whether or not ax is watching. Ctrl-C stops watching, prints the set as it stands and exits `130`; `ax journey view <id>` picks it up again.

Set exit codes: `0` a report was printed, or you answered no · `2` usage, or the platform refused the set before launch (not enough runs left, an unknown agent, a missing scope, no terminal and no `--yes`) · `3` the platform failed · `130` Ctrl-C.

#### Setup for sets

A set signs in the way a journey does: `ax login` once (a browser sign-in, which asks for the scopes a set needs), or an ora platform API key in `ORA_API_KEY` with the `ax.sets:write` and `ax.sets:read` scopes. A key with `ax.sets:read` alone can `list` and `view`. Your organization also needs ora Study, the product a set runs on and is billed to. A new account made on the way through `ax login` starts on it; for an existing organization, an owner or admin adds it on the approval page of the sign-in.

## Environment variables

All configuration is environment-first: the consumer defines the variables, the CLI only reads them.

A `.env` in the working directory is read on startup — copy `.env.example` and fill it in. Anything already exported wins over the file, so a key set for your shell or by CI beats a stale `.env`.

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `ORA_API_URL` | audit, webmcp-audit, journey (free), skill, generate-files | `https://ora.ai` | Public API base (no auth); also the ingest base for `webmcp-audit` |
| `ORA_PLATFORM_URL` | journey, audit `--tunnel ora`, login, whoami, logout | `https://api.ora.ai` | Authenticated platform API base. `ax login` signs in at its `account.` host. `https://api.agentfront.sh`, the default before 0.12, serves the same API and still works with a key |
| `ORA_TUNNEL` | audit | — (optional) | `ora` opens ora's own tunnel for a local target (same as `--tunnel ora`) |
| `ORA_TUNNEL_CMD` | audit | — (optional) | Tunnel command for a local target (same as `--tunnel-cmd`); wins over `ORA_TUNNEL` |
| `ORA_API_KEY` | journey, audit `--tunnel ora`, whoami | — (or `ax login`) | ora platform key (`ora_sk_…`); exchanged for a bearer token for a journey, the tunnel (which needs the `tunnels:write` + `tunnels:connect` scopes) and a set of journeys (`ax.sets:write` + `ax.sets:read`), and sent as itself to ora's `/auth/identity` by `whoami`, held to the same address rule. Used before a sign-in when both are there |
| `ORA_SCAN_API_KEY` | audit, journey (free), webmcp-audit | — (optional) | ora-issued scan API key; lifts every scan rate limit (issued manually by ora). the free journey and webmcp-audit accept it as a partner-key fallback |
| `ORA_PARTNER_API_KEY` | journey (free), webmcp-audit | — (optional) | ora-issued partner API key; unlocks a goal of your own and the 1000/24h keyed allowance on the free journey, and lifts webmcp-audit's daily limit |
| `CHROME_PATH` | webmcp-audit | — (auto-detected) | The Chrome to launch, when yours is not in a standard location |
| `AX_WEBMCP_NO_SANDBOX` | webmcp-audit | — (unset) | `1` launches Chrome without its sandbox. Containers only: the audited page is untrusted and the sandbox contains it |

`ORA_API_URL` and `ORA_PLATFORM_URL` decide where your keys go, so ax checks them before it sends one. Their defaults always work. Any other host gets a key only over https (plain http only to this machine, such as `localhost`), and only when you set the variable in your shell: a `.env` belongs to whatever directory you run in, so a host named there is refused before anything is sent (`ax journey` exits 2 with `KEY_DESTINATION_REFUSED`). The exceptions are `localhost`, `127.0.0.1` and `[::1]`. Requests that carry no key are not checked. `ax login` holds `ORA_PLATFORM_URL` to the same rule, since the sign-in's tokens will go there.

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
