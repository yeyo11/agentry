---
created_at: 2026-09-24T13:36:20.210175264Z
updated_at: 2026-09-28T22:00:00Z
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
| Version | **0.22.1** on `main`, the same across all five packages |
| Released | 2026-09-27, by release-please from the commit messages |
| Runtime | Node >= 22, pnpm workspace |
| Source | 634 tracked `.ts`/`.tsx` files on `feat/project-ecosystem` with `main` merged in; the API contract is 4,338 lines of `packages/shared/src/types.ts` |
| REST | 24 route files, documented as OpenAPI 3.1 and served at `/docs` |
| Tests | 166 unit and integration test files, plus 51 browser specs under `e2e/specs/` |
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

The ROADMAP's [Done](../ROADMAP.md#done) section lists 33 areas and is the accurate inventory. The
spine of it: chats and projects modelled as Agentry's own objects over the CLI's stream-json;
orchestration with a task DAG, parallel workers and a verification phase on the integration branch;
observability that reconstructs what an agent did from git and the transcript; several accounts
rotated before they run out; schedules; configuration and MCP servers per scope; tool presets per
chat; authentication as none, bearer token or OIDC; a progressive web app with push for phones; a
Linux desktop app; a Docker image with a Kubernetes manifest; and remote access through a
localhost.run tunnel over settings that change at runtime ([tunnel.md](tunnel.md),
[layered-settings.md](layered-settings.md)).

Changes are reviewed inside Agentry: one screen for a chat, a task and the integration branch,
drawn by a diff comparator of its own in Reading, Unified and Side by side, with a Step by step lens
that replays every edit of the transcript with the sentence Claude wrote before it. The editor
integration (links, the copied diff command, Settings → Editor and `/settings/editor`) is gone. See
[the plan's Outcome](plans/changes-review.md#outcome) and design system
[§5](design-system.md#5-diff-comparator).

The newest piece is the **project ecosystem**, now complete, server side and screens: its board,
its team and its assistant. Projects are created in a wizard from a template, and switch modules on
and off in their settings ([projects.md](projects.md)). The Board module gives them a Tasks board, a list,
milestones and work items that chats and orchestrations work on and move
([work-items.md](work-items.md)). The Team module gives them a team of agents, each a CLI agent
file, and a flow by column in which a card entering a column starts its role's run. Shared memory
adds a journal and memory proposals the person approves, and Documents the repository's documents
folder with documents tied to tasks ([team-and-flow.md](team-and-flow.md)). The **project
assistant** reads a project through a read-only CLI chat and proposes a team, resources and first
tasks. You accept or discard each proposal on its own, and only an accept writes anything. It runs
after the wizard, from the Team screen, from the project header's "Asistente" on every tab and the
palette, from the board ("Sugerir tareas") and from the Resources tab ("Sugerir", "Crear con IA")
([assistant.md](assistant.md)).

## What is open

- **The project ecosystem, waiting for the owner.** All six orchestrations are built, on
  `feat/project-ecosystem`, which reaches `main` in one pull request once the owner has tried the
  whole feature:
  - **1** (`ecosystem-foundation`, fixed by 1b after [its audit](plans/project-ecosystem-audit.md)):
    the contract, the store, the API, the links with chats and orchestrations, and 66 prototype
    screens, which the owner validated;
  - **2** (`ecosystem-board-web`): the wizard, the project tabs, the board, the list and a work item;
  - **3** (`ecosystem-team`): the team, the flow by column, the journal and memory proposals, and
    documents;
  - **4** (`ecosystem-assistant`): the assistant, suggested tasks and resources with AI, and the four
    items the audit of orchestration 2 had left for the owner;
  - **5** (`ecosystem-review-fixes`): the fixes of the review of the whole feature, each finding
    marked closed or open in [the audit](plans/project-ecosystem-audit.md#review-of-the-whole-feature-before-the-pull-request);
  - **6** (`ecosystem-gaps`): every gap the documents still listed after 5, 24 in all, closed
    ([the plan](plans/project-ecosystem.md#orchestration-6-ecosystem-gaps)); the last detail of gap 23,
    a member's model reading "sonnet · Sonnet 5", was closed after it by the plan's decision 41;
  - **7** (`ecosystem-design`): the screens brought to the designer's official reference of the
    ecosystem (2026-09-28): the card with its strip, failed runs told in the person's words with a
    retry (`POST /flow-runs/:runId/retry`), Team activity, the Flow's Límites card, the model picker,
    and phone headers on the ecosystem's screens. What it applied screen by screen, and what it
    left, is at the end of [the review's note](design-system/ecosystem-review.md#applied-in-development).

  Each orchestration's `pnpm build` and `pnpm e2e` run in its verification phase, on the merged
  branch. The Known gaps of [work-items.md](work-items.md#known-gaps),
  [team-and-flow.md](team-and-flow.md#known-gaps) and [assistant.md](assistant.md#known-gaps) list
  what stays open per area, and [the audit](plans/project-ecosystem-audit.md#still-open-after-orchestration-5)
  has nothing left open.

  See the plan's [Outcome](plans/project-ecosystem.md#the-ecosystem-as-a-whole).
- **Phone headers for the rest of the app, a separate job.** Night Shift draws every phone detail
  screen with a back arrow, its title and a "⋯" sheet, and no app top bar; the app still shows the
  global top bar on most of them. Orchestration 7 switched only the ecosystem's screens over (the
  project and its tabs, Tasks, a work item, the assistant, the new project wizard), by the owner's
  decision, since the incoherence predates the ecosystem. The rest waits: a chat, a task's chat and
  a flow run's chat (the chat page, which keeps its own header with the ecosystem's rows under it),
  an orchestration, accounts, changes and the other screens drawn with a back arrow. It is cheap
  now: the shell decides by route (`PHONE_HEADER_ROUTES` in `apps/web/src/components/shell/phone-header.ts`,
  where a route marked `phoneHeader: 'page'` hides `.topbar` on a phone), so each screen is one
  entry there plus the page drawing `PhoneHeader` (back, title, "⋯" through `MoreActions`). Recorded
  in [the plan](plans/project-ecosystem.md#separate-job-recorded-here-so-it-is-not-lost); not part
  of the ecosystem's pull request.
- **The editable dashboard.** Home renders any layout that validates, from a registry of widget
  types, but the layout is not editable or persisted per project, and the Documents and Flows
  widgets do not exist. Left out of the redesign deliberately — see
  [the UI redesign plan](plans/ui-redesign.md#not-in-this-orchestration). It is listed under [Next](../ROADMAP.md#next).
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
| [`plans/redesign-night-shift.md`](plans/redesign-night-shift.md) | Landed (#101) — see [Outcome](plans/redesign-night-shift.md#outcome) |
| [`plans/tunnel.md`](plans/tunnel.md) | Landed (#110) — see [Outcome](plans/tunnel.md#outcome) and [tunnel.md](tunnel.md) |
| [`plans/changes-review.md`](plans/changes-review.md) | Landed (#115) — see [Outcome](plans/changes-review.md#outcome) |
| [`plans/project-ecosystem.md`](plans/project-ecosystem.md) | All seven orchestrations built: 1 (server side and prototypes, fixed by 1b after [its audit](plans/project-ecosystem-audit.md)), 2 (the board's web), 3 (the team, the flow, memory and documents), 4 (the assistant), 5 (the review's fixes), 6 (the known gaps) and 7 (the screens brought to the designer's reference). `main` (0.22.1) is merged into the branch; it awaits its e2e run on the merged branch, then the owner's trial and one pull request to `main` — see [Outcome](plans/project-ecosystem.md#outcome) |

A plan is the source of truth for the orchestration that executes it: where a task prompt and the
plan disagree, the plan wins.

## How it is checked

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm e2e
```

`pnpm typecheck` and `pnpm test` pass on `feat/project-ecosystem` with `main` (0.22.1) merged in and
orchestration 6 integrated, on 2026-09-28: 1,812 tests across the five packages and none failing. `pnpm e2e` runs on
the merged branch before its pull request. The last full e2e run on `main` (`d6269c4`) had three
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
[[plans/app-updates.md]] · [[plans/redesign-night-shift.md]] · [[plans/changes-review.md]] ·
[[plans/tunnel.md]] · [[design-system.md]] · [[plans/project-ecosystem.md]] ·
[[plans/project-ecosystem-audit.md]] · [[projects.md]] · [[work-items.md]] · [[team-and-flow.md]] · [[assistant.md]]
