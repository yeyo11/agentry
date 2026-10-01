---
created_at: 2026-09-24T13:36:20.210175264Z
updated_at: 2026-10-01T19:20:00Z
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
| Version | **0.23.1** on `main`, the same across all five packages |
| Released | 2026-09-28 (v0.23.1, #121; 0.23.0 in #119 right after the ecosystem in #118), by release-please from the commit messages |
| Runtime | Node >= 22, pnpm workspace |
| Source | 703 tracked `.ts`/`.tsx` files on `main`; the API contract is 4,630 lines of `packages/shared/src/types.ts` |
| REST | 24 route files, documented as OpenAPI 3.1 and served at `/docs` |
| Tests | 188 unit and integration test files, plus 58 browser specs under `e2e/specs/` |
| CI | `ci.yml` (a `checks` job: advisories, OpenAPI drift, typecheck, tests, build; four `e2e (k/4)` shards, skipped on docs-only pull requests; the `test` gate; the image smoke test), `desktop.yml`, `image.yml`, `release.yml` |

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

The newest piece is the **project ecosystem**, merged into `main` in #118 on 2026-09-28, server side and screens: its board,
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

The **decision engine** was merged into `main` in #141 on 2026-09-30.
It gives the small judgments Agentry makes (refine or not, retry or not, which journal entries an
agent reads, a hint for a stuck worker) one home: three typed questions, two providers (the Claude
Code CLI by default, TypeSafe's Jev with the owner's own key), a mode per point (`off`, `shadow`,
`active`) and a Decisions tab in Settings. All 22 points ship `off`; nothing is sent anywhere until
the owner consents to a point. See [decision-engine.md](decision-engine.md).

## What is open

- **The decision engine's shadow period.** Nothing has been measured yet. All 22 points have a
  resolver (CW-28 added `palette.intent`, `notification.urgency` and `orchestration.model`), and the `cli` provider
  waits for CW-4's quota hold and CW-25's effort control; see the plan's
  [Outcome](plans/decision-engine.md#outcome).
- **The project ecosystem** was merged into `main` in #118 and is no longer open as a whole; see the
  plan's [Outcome](plans/project-ecosystem.md#the-ecosystem-as-a-whole) and the Known gaps of
  [work-items.md](work-items.md#known-gaps), [team-and-flow.md](team-and-flow.md#known-gaps) and
  [assistant.md](assistant.md#known-gaps) for what stays open per area.
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
  in [the plan](plans/project-ecosystem.md#separate-job-recorded-here-so-it-is-not-lost); left out
  of #118, a separate job.
- **The editable dashboard.** Home renders any layout that validates, from a registry of widget
  types, but the layout is not editable or persisted per project, and the Documents and Flows
  widgets do not exist. Left out of the redesign deliberately — see
  [the UI redesign plan](plans/ui-redesign.md#not-in-this-orchestration). It is listed under [Next](../ROADMAP.md#next).
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
| [`plans/roadmap-completion.md`](plans/roadmap-completion.md) | Verified — see [Verification](plans/roadmap-completion.md#verification-2026-10-01) (2026-10-01, 0.29.1; a full `pnpm e2e` run still open) |
| [`plans/post-roadmap.md`](plans/post-roadmap.md) | Verified — see [Verification](plans/post-roadmap.md#verification-2026-10-01) (2026-10-01, 0.29.1; a full `pnpm e2e` run still open) |
| [`plans/spanish-copy.md`](plans/spanish-copy.md) | Landed (#94) — see [Outcome](plans/spanish-copy.md#outcome) |
| [`plans/app-updates.md`](plans/app-updates.md) | Landed (#95) — see [Outcome](plans/app-updates.md#outcome) |
| [`plans/redesign-night-shift.md`](plans/redesign-night-shift.md) | Landed (#101) — see [Outcome](plans/redesign-night-shift.md#outcome) |
| [`plans/tunnel.md`](plans/tunnel.md) | Landed (#110) — see [Outcome](plans/tunnel.md#outcome) and [tunnel.md](tunnel.md) |
| [`plans/changes-review.md`](plans/changes-review.md) | Landed (#115) — see [Outcome](plans/changes-review.md#outcome) |
| [`plans/project-ecosystem.md`](plans/project-ecosystem.md) | Landed (#118) — see [Outcome](plans/project-ecosystem.md#outcome) |
| [`plans/decision-engine.md`](plans/decision-engine.md) | Landed (#141): the engine, both providers, 22 points (all ship off) and the Decisions tab. See [Outcome](plans/decision-engine.md#outcome) and [decision-engine.md](decision-engine.md). The owner's 18 decisions are in [`decisions/decision-engine.md`](decisions/decision-engine.md) |
| [`plans/orchestration-speed.md`](plans/orchestration-speed.md) | Proposed, not started |
| [`plans/agent-wire-format.md`](plans/agent-wire-format.md) | Proposed (2026-09-30): compact JSON with only the needed fields for the MCP tools, TOON for flat lists only if a CLI bench proves it; ZON rejected. The UI ↔ API side is built, see [api-wire.md](api-wire.md) |
| [`plans/agentry-assistant.md`](plans/agentry-assistant.md) | Proposed, next after the ecosystem |
| [`plans/flow-start-and-chat-token.md`](plans/flow-start-and-chat-token.md) | Proposed; part 1 (starting the waiting cards) built by CW-9 on its own branch, not yet on `main`; part 2 (the chat token) not started |
| [`plans/multi-provider.md`](plans/multi-provider.md) | Phase 1 landed (#150): five provider manifests (Claude Code, Codex, Gemini, Copilot, OpenCode), readiness detection, `/providers` routes, the first-run Providers step, Settings → Providers and the status bar dots; the one rule generalised. Phase 2 landed (#155): Claude Code behind the driver interface on its CLI (no Agent SDK, decision 2), `ToolPolicy`, the neutral `RunEvent`, the `provider` column and the conformance suite. Phase 3 landed (#167): the Codex driver on `codex app-server`, one ACP driver for Copilot, Gemini and OpenCode, OpenCode's SQLite transcripts and the provider on the chat page; recordings that need a signed-in account are the owner's. Phase 4 planned (2026-10-01): a limit per provider, handoff, restart or wait at a limit, the `provider.on-limit`, `provider.pick` and `provider.model-map` decision points, automated work that names its provider and policy, and claude-swap retired; four decisions open for the owner. See [Phase 4](plans/multi-provider.md#phase-4-rotation-between-providers), [Outcome of phase 3](plans/multi-provider.md#outcome-of-phase-3), [Outcome of phase 1](plans/multi-provider.md#outcome-of-phase-1) and [`providers.md`](providers.md) |
| [`plans/code-hosts.md`](plans/code-hosts.md) | Phases 1–2 built (2026-10-01): hosts and readiness, `gh` and `glab` adapters at parity, Settings → Integrations, neutral PR/MR copy (#159); CI checks with logs, re-run, cancel, manual jobs, **Fix failing checks** and the `checks.fix` point; phases 3–6 planned. GitHub (`gh` ≥ 2.92.0) and GitLab (`glab` ≥ 1.120.0) as code hosts, complete — PRs/MRs, CI checks and fixing them, reviews, merging from Agentry — and GitHub/GitLab issues, Jira (`acli`) and YouTrack (`youtrack-app`) as work items; polling with optional webhooks. Six phases, each a task graph of orchestrations (prototypes, core, web); one execution layer for every CLI call; an action matrix of 138 GitHub/GitLab cells (110 recorded, 11 doc-only, 17 done outside the CLI) plus 24 doc-only Jira/YouTrack cells recorded before phase 5; the owner's four decisions settled |
| [`plans/agentry-mcp-server.md`](plans/agentry-mcp-server.md) | Built (2026-10-01): Agentry's own MCP server, `@agentry/mcp`, with 15 read-only tools over the REST API, handed to a chat through `--mcp-config` with the confinement, and packaged as `apps/api/dist/mcp.mjs` and in the desktop app. The write tools (CW-17) and the global assistant chat (CW-18) wait for the owner's choice in [`plans/agentry-assistant.md`](plans/agentry-assistant.md). See [`agentry-mcp-server.md`](agentry-mcp-server.md) |
| [`plans/web-packages.md`](plans/web-packages.md) | Planned (2026-09-30): the web UI split into two internal workspace packages, `@agentry/ui` (primitives, tokens, controls, renderers) and `@agentry/chat-ui` (the conversation, behind an injected client), with guard tests on the dependency direction and vendor names; no screen changes. Runs beside phase 2 of multiple providers on `feat/web-packages` |

A plan is the source of truth for the orchestration that executes it: where a task prompt and the
plan disagree, the plan wins.

## How it is checked

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm e2e
```

Last run on 2026-10-01 by the verification of the two roadmap plans
([roadmap-completion](plans/roadmap-completion.md#the-checks),
[post-roadmap](plans/post-roadmap.md#the-checks)), on `main` at `7242b4fe` (0.29.1) plus two
commits of its own (`e0efe0eb`), with a load average between 23 and 58:

- `pnpm typecheck`: passes.
- `pnpm test`: passes, 2,714 tests across the seven packages (core 1,443, web 967, api 217, desktop
  49, shared 31, chat-ui 4, ui 3), none failing.
- `pnpm build`: passes. The OpenAPI schemas regenerate with no drift.
- `node --test e2e/harness.test.mjs`: 14 of 14 pass on their own. A whole run under load failed 4
  with `API did not start`, because the runner waits about 20 s for the server.
- Browser specs: only the 12 that prove the two plans ran, one at a time. All pass, and
  `connectors.spec.mjs` is flaky under load: it failed once and passed alone. **The full suite was
  not run.** Its last full run is the one below.

The full suite last ran on `main` at `cc08204e` (0.23.0, the ecosystem of #118 plus its release), on 2026-09-28,
on a machine with a load average near 50. `main` has changed a great deal since then (multiple
providers, code hosts, the web packages), so treat this as history, not as today's state:

- `pnpm typecheck`: passes.
- `pnpm test`: passes, 1,898 tests across the five packages (core 810, web 849, api 166, desktop 42,
  shared 31), none failing.
- `pnpm build && pnpm e2e`: the build passes; **the e2e run fails.** Of the 55 specs, 47 passed,
  `chat.spec.mjs` was skipped (it needs `E2E_LIVE=1`), 6 failed, and the run hit its 1,500 s limit
  before `tasks-links.spec.mjs` (`a11y.spec.mjs` alone took 540 s). Each failing spec re-run on its
  own with `node e2e/run.mjs <spec>`:
  - `orchestration-v2.spec.mjs` (searching finds the graph by name), `team.spec.mjs` (the
    template's four roles with their models) and `tasks-item.spec.mjs` (Cancel closes it) pass
    alone, and so does `tasks-links.spec.mjs`;
  - `home.spec.mjs` (the figures are a strip under the hero) fails alone too;
  - `paging.spec.mjs` (no long tasks while typing) fails alone too, with long tasks of 55–72 ms
    that the load on the machine may explain;
  - `shell.spec.mjs` fails alone too, on "and on the project's tabs" (in the full run it failed
    earlier, on "Settings opens on Appearance").

The older run on `main` (`d6269c4`), with three specs that failed in the full suite and passed alone,
is in [Before launching](plans/redesign-night-shift.md#before-launching). The browser suite runs headless Chrome over CDP against an isolated
wrapper, with a time limit per spec and per run so it cannot hang, split into shards that run side by
side (`E2E_SHARDS`, [plans/verify-faster.md](plans/verify-faster.md#what-1-built)). CI runs all of it on
every pull request, the e2e suite as four parallel shards, which it skips when a pull request changes
only documentation ([plans/ci-e2e-shards.md](plans/ci-e2e-shards.md#what-was-built)), and additionally fails
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
[[plans/app-updates.md]] · [[plans/verify-roadmap-plans.md]] · [[plans/redesign-night-shift.md]] · [[plans/changes-review.md]] ·
[[plans/tunnel.md]] · [[design-system.md]] · [[plans/project-ecosystem.md]] ·
[[plans/project-ecosystem-audit.md]] · [[projects.md]] · [[work-items.md]] · [[team-and-flow.md]] · [[assistant.md]] ·
[[decision-engine.md]] · [[plans/decision-engine.md]] · [[decisions/decision-engine.md]] · [[plans/orchestration-speed.md]] · [[plans/agentry-assistant.md]] ·
[[decisions/english-technical-language.md]] · [[plans/flow-start-and-chat-token.md]] · [[plans/web-packages.md]] · [[api-wire.md]] · [[plans/agent-wire-format.md]] · [[plans/multi-provider.md]] · [[providers.md]]
