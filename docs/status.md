---
created_at: 2026-09-24T13:36:20.210175264Z
updated_at: 2026-09-24T13:52:26.250868944Z
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
| Version | **0.17.1**, the same across all five packages |
| Released | 2026-09-24, by release-please from the commit messages |
| Runtime | Node >= 22, pnpm workspace |
| Source | 412 tracked `.ts`/`.tsx` files; the API contract is 2,642 lines of `packages/shared/src/types.ts` |
| REST | 168 route registrations across 17 route files, documented as OpenAPI 3.1 and served at `/docs` |
| Tests | 107 unit and integration test files, plus 33 browser specs under `e2e/` |
| CI | `ci.yml` (typecheck, tests, advisories, OpenAPI drift, e2e, image smoke test), `desktop.yml`, `image.yml`, `release.yml` |

The shape is unchanged: `packages/shared` holds the types every other package imports,
`packages/core` drives the CLI and owns the store, `apps/api` serves Fastify over it, `apps/web` is
the React UI, `apps/desktop` wraps both in Electron for Linux. See
[Monorepo layout](../README.md#monorepo-layout).

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

A plan is the source of truth for the orchestration that executes it: where a task prompt and the
plan disagree, the plan wins.

## How it is checked

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm e2e
```

`pnpm typecheck` and `pnpm test` both pass on `main` at `d2baea9` (run on 2026-09-24); `pnpm e2e`
was not run for this snapshot. The browser suite runs headless Chrome over CDP against an isolated
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
[[plans/agents-redesign.md]] · [[plans/mobile.md]]
