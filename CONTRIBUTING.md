# Contributing to ax

Thanks for helping improve `ax`, the Ora CLI.

## Setup

Requires Node >= 22.4 and [pnpm](https://pnpm.io) (version pinned in the
`packageManager` field of `package.json` — `corepack enable` picks it up).

```sh
pnpm install
```

## Working on a change

```sh
pnpm test          # vitest, watch mode
pnpm lint          # biome
pnpm typecheck     # tsc --noEmit
pnpm build         # bundle to dist/
pnpm smoke         # run the bundled binary the way a user would
pnpm verify:pack   # prove the npm tarball would be publishable
```

CI runs lint, typecheck, tests on Node 22/24, build, smoke, and the pack
check on every PR. All of it must be green before merge.

## Commit messages and PR titles

This repo squash-merges, so **your PR title becomes the commit message on
`main`** and must follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat: …`, `fix: …`, `chore(scope): …`). CI lints the title on every PR;
individual commit messages on your branch are yours to shape freely.

## Contract types

`src/contract/` is generated from the production Ora OpenAPI spec — never
edit it by hand. The daily Contract sync workflow regenerates it from
production and opens (or updates) a `contract-sync` PR when anything differs.
It goes red only when a type or the contract version changed; reworded spec
descriptions just get the PR. Review that PR and merge it, or run
`pnpm contract:gen && pnpm contract:drift` yourself, review the diff, and
commit the result.

## Releases

Maintainers release by merging the release-please PR (see `RELEASING.md`).
Contributors never need to bump versions or publish.
