---
created_at: 2026-09-24T13:36:20.210175264Z
updated_at: 2026-09-25T18:55:39Z
tags:
    - status
    - project-state
    - docs
    - agentry
---
# Where the project stands

A snapshot of Agentry as it is today, for whoever — or whatever — picks it up next. The
[README](../README.md) says what it does and how to run it, the [ROADMAP](../ROADMAP.md) lists what
was built and what was refused; this page says where the work is, what is still open, and how a
change gets in.

## Today

| | |
| --- | --- |
| Version | **0.17.2**, the same across all five packages |
| Released | 2026-09-25, by release-please from the commit messages |
| Runtime | Node >= 22, pnpm workspace |
| Source | 454 tracked `.ts`/`.tsx` files; the API contract is 2,676 lines of `packages/shared/src/types.ts` |
| REST | 17 route files, documented as OpenAPI 3.1 and served at `/docs` |
| Tests | 115 unit and integration test files, plus 34 browser specs under `e2e/` |
| CI | `ci.yml` (typecheck, tests, advisories, OpenAPI drift, e2e, image smoke test), `desktop.yml`, `image.yml`, `release.yml` |

The shape is unchanged: `packages/shared` holds the types every other package imports,
`packages/core` drives the CLI and owns the store, `apps/api` serves Fastify over it, `apps/web` is
the React UI, `apps/desktop` wraps both in Electron for Linux. See
[Monorepo layout](../README.md#monorepo-layout).

The UI follows the **Night Shift** design system ([design-system.md](design-system.md)): near-black
neutrals and Geist, dark by default, a status bar on desktop, and four tabs and a FAB on a phone.
The tokens live in `apps/web/src/styles/tokens.css`, and a web test fails on any colour, radius or
duration written anywhere else.

## What is built

The ROADMAP's [Done](../ROADMAP.md#done) section lists 28 areas and is the accurate inventory. The
spine of it: chats and projects modelled as Agentry's own objects over the CLI's stream-json;
orchestration with a task DAG, parallel workers and a verification phase on the integration branch;
observability that reconstructs what an agent did from git and the transcript; several accounts
rotated before they run out; schedules; configuration and MCP servers per scope; tool presets per
chat; authentication as none, bearer token or OIDC; a progressive web app with push for phones; a
Linux desktop app; and a Docker image with a Kubernetes manifest.

## What is open

- **The editable dashboard.** Home renders any layout that validates, from a registry of widget
  types, but the layout is not editable or persisted per project, and the Documents and Flows
  widgets do not exist. Left out of the redesign deliberately — see
  [the UI redesign plan](plans/ui-redesign.md#not-in-this-orchestration). It is the only entry under
  [Next](../ROADMAP.md#next).
- **Two plans whose final verification never ran.** [`plans/roadmap-completion.md`](plans/roadmap-completion.md)
  and [`plans/post-roadmap.md`](plans/post-roadmap.md) are both marked *built; final verification
  pending*. The code landed; the closing pass over it did not.
- **What Night Shift left for later**: cron descriptions built in English in core (translating them
  needs an API change), four look-alike segmented bar classes to merge, and one unused meter
  style. See the plan's [Outcome](plans/redesign-night-shift.md#outcome).
- **Known limitations** are catalogued in the README ([Known limitations](../README.md#known-limitations)),
  and what was considered and refused is under [Decided against, for now](../ROADMAP.md#decided-against-for-now).
  Neither is a backlog: they are decisions, with the reasons attached.

## The plans, and where each stands

| Plan | Status |
| --- | --- |
| [`plans/agents-redesign.md`](plans/agents-redesign.md) | Landed — chats, projects and Agentry's own model (#60) |
| [`plans/agent-observability.md`](plans/agent-observability.md) | Landed, in full |
| [`plans/ui-redesign.md`](plans/ui-redesign.md) | Done, every task delivered |
| [`plans/mobile.md`](plans/mobile.md) | Shipped — all five tasks, see [Outcome](plans/mobile.md#outcome) |
| [`plans/roadmap-completion.md`](plans/roadmap-completion.md) | Built; final verification pending |
| [`plans/post-roadmap.md`](plans/post-roadmap.md) | Built; final verification pending |
| [`plans/spanish-copy.md`](plans/spanish-copy.md) | Landed (#94) — see [Outcome](plans/spanish-copy.md#outcome) |
| [`plans/app-updates.md`](plans/app-updates.md) | Landed (#95) — see [Outcome](plans/app-updates.md#outcome) |
| [`plans/redesign-night-shift.md`](plans/redesign-night-shift.md) | Every task landed; the merged branch's e2e verification runs in the orchestration — see [Outcome](plans/redesign-night-shift.md#outcome) |

A plan is the source of truth for the orchestration that executes it: where a task prompt and the
plan disagree, the plan wins.

## How it is checked

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm e2e
```

`pnpm typecheck` and `pnpm test` pass on the Night Shift branch (run on 2026-09-25), apart from one
core timing test that is flaky under the full parallel run and passes alone. `pnpm e2e` runs in
that orchestration's verification phase. The last full e2e run on `main` (`d6269c4`) had three
specs that failed in the full suite and passed alone: see the plan's
[Before launching](plans/redesign-night-shift.md#before-launching). The browser suite runs headless Chrome over CDP against an isolated
wrapper, with a time limit per spec and per run so it cannot hang. CI runs all of it on every pull request, and additionally fails
on a high-severity advisory in the dependency tree or on OpenAPI schemas that have drifted from the
shared types — after changing `packages/shared/src/types.ts`, run
`pnpm --filter @agentry/api openapi:schemas`.

## How a change gets in

Branch off `main`, one pull request per piece of work, squash-merged. Commits follow Conventional
Commits because release-please builds `CHANGELOG.md` and the version bump from them, which is why
the changelog is never edited by hand. A new route needs a summary and a tag in
`apps/api/src/openapi/routes.ts` and a row in the README's REST API tables.
[CONTRIBUTING.md](../CONTRIBUTING.md) is the source of truth for all of it.

Locally the wrapper uses the real `~/.claude`; set `CLAUDE_CONFIG_DIR` to experiment safely. Git
work that changes the checkout belongs in a worktree, because the dev servers run from the main one
and a restart kills the runs in flight.

## Where the knowledge is kept

In this folder, and indexed for semantic search — see [the knowledge base](knowledge-base.md). Every
new feature and every decision is written down there as it happens, which is what makes this page
possible to keep honest.

## Related

[[knowledge-base.md]] · [[deploy.md]] · [[desktop.md]] · [[plans/roadmap-completion.md]] ·
[[plans/post-roadmap.md]] · [[plans/ui-redesign.md]] · [[plans/agent-observability.md]] ·
[[plans/agents-redesign.md]] · [[plans/mobile.md]] · [[plans/spanish-copy.md]] ·
[[plans/app-updates.md]] · [[plans/redesign-night-shift.md]] · [[design-system.md]]
