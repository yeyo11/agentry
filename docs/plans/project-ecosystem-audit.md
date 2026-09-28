---
created_at: 2026-09-27T07:12:38.39333137Z
updated_at: 2026-09-28T23:30:00Z
tags:
    - audit
    - plan
    - projects
    - work-items
    - board
    - design-system
    - verification-pending
---
# Audit: orchestration 1 of the project ecosystem

An audit of what the `ecosystem-foundation` orchestration delivered, against
[the plan](project-ecosystem.md). Run on 2026-09-27 over the integrated branch
(`agentry/ecosystem-foundation-3fd41f07`, commit `ba77298`) by five reviewers in parallel, one per
area, with the main findings checked again by hand in the code.

Status: **fixed by `ecosystem-fixes` (orchestration 1b) on 2026-09-27**, except what is listed under
[What stays open](#what-stays-open). Each finding below is marked **closed** or **open**, with the
task that closed it. `pnpm typecheck` and `pnpm test` pass on the fixes' branches; `pnpm build` and
`pnpm e2e` run in 1b's verification phase, on the merged branch, which is why the tag
`verification-pending` stays until they have.

## Where the work lands

Decided by the owner on 2026-09-27, replacing decision 40 of the plan: **every orchestration of the
ecosystem lands in one branch, `feat/project-ecosystem`**, and nothing reaches `main` until the owner
has tried the whole feature. Each orchestration starts from the head of that branch and its
integration branch is merged back into it. One pull request, at the end.

## Verdict

| Area | Blocker | Major | Minor | Verdict |
|---|---|---|---|---|
| Shared contract and project modules | 0 | 1 | 8 | Sound; one data-loss bug |
| Work item store | 0 | 0 | 10 | Sound |
| REST API and links | 0 | 3 | 9 | Sound design; three real bugs |
| Desktop prototypes (23) | 2 | 5 | many | 9 fine, 14 need fixes |
| Phone prototypes (25) | 5 | 20 | many | 5 fine, 20 need fixes |
| Documentation | 0 | 2 | 3 | Accurate; Outcome incomplete |

The backend does what the plan asked, the checks pass (typecheck, 557 core tests, the API tests,
build, e2e) and the one rule holds: nothing reaches Claude other than through the CLI. The phone
prototypes are the weak part.

Confirmed as the plan asked: five fixed columns, four types, no date other than facts, one level of
hierarchy, relations `blocks` and `blocked by`, keys built from a validated prefix and a number that
is never reused, history written only by the service, every write inside `BEGIN IMMEDIATE` (six
processes writing at once gave 480 unique numbers and ranks), every value bound in SQL, git called
with argument arrays, 29 routes each with its OpenAPI entry and README row, no AI attribution in any
commit, `CHANGELOG.md` untouched.

## Bugs to fix in the code

1. **Closed** (`fix-links`). **A person's move does not win while the agent works.** `work-links.ts`
   reads `status === 'busy' && previousStatus !== 'busy'` as a turn starting, but the coalesced
   `run.updated` the publisher emits about every 250 ms carries `previousStatus: null`. An item
   dragged back to `todo` returns to `in_progress` at once. Require a real transition, and test it
   with a null previous status.
2. **Closed** (`fix-settings`). **Reading a broken settings document overwrites it with defaults.**
   `ProjectSettingsStore.read` writes when the file does not parse, so one typo in a hand edit loses
   the modules, the limits and the key prefix on the next `GET /projects`. Answer with defaults in
   memory and leave the file.
3. **Closed** (`fix-links`). **A relaunched orchestration loses the link to its work items.**
   `specOfTask` in `packages/shared/src/orchestration.ts` does not copy `workItemId`, and the
   relaunch route skips the checks of `launchOrchestration`. A saved template now drops the items
   too. Schedules still skip the node checks: see [What stays open](#what-stays-open).
4. **Closed** (`fix-links`). **An item worked by an orchestration node shows no changes.** Only
   "Work on it" records the worktree and the branch on the item, so decision 20 is met for chats and
   not for nodes.
5. **Closed** (`fix-links`). **"Work on it" after the worktree was deleted by hand fails for good**,
   because the worktree is locked; and a plain directory at that path is taken for the worktree.
6. **Closed.** Smaller:
   - `fix-store`: link ids are not validated (a 500); search folds case for ASCII only, so `sesión`
     does not find `SESIÓN`; reordering acceptance criteria emits no event; appending to a column
     grows ranks fast enough to respread the column every 117 creates; an actor of unknown kind is
     read back as the person; `comments()` answers an empty list for a missing item; a failed
     `ROLLBACK` hides the original error.
   - `fix-links`: "Work on it" accepts an item in `done` while "Orchestrate" refuses it; a link
     write that throws leaves a chat running unlinked; start options are copied without type checks.
7. **Closed** (`fix-settings`). Contract: make `Project.key` and `Project.modules` required; decide
   `WorkItemSource.kind` and `WorkItemLinkRole` for documents and for the flow before the web is
   built on exhaustive switches; emit `project.updated` on a re-import that changes modules.

Found next to them and fixed: the first test of `apps/api/test/work-links.test.ts` took 22 s
because the fake CLI never answered `--version` (now 1.6 s); `work-items.ts` was split into the
service, its rows and its validation; the migration test no longer assumes its migration is the last.

## Design system and plan rules broken in the prototypes

1. **Closed** (`proto-fix-system`). **Raw colours in the new CSS**: `#fff` on the switch, the
   checkbox and the radio, which are not the gradient, and `hsl()` on the epic mark and the role
   avatar. They need an `--on-accent` token and a hue token. `lint.py` now finds nothing in 69 files.
2. **Closed** (`proto-fix-desktop`, `proto-fix-phone`). **"Aceptar las 3 que quedan"** on the
   assistant's proposals accepts in bulk, against decision 36.
3. **Closed** (`proto-fix-system`). **Tasks is not in the More sheet** (`MobileMas`) and the
   standalone `Sidebar` has no Tasks entry, though every board screen on the phone leads back there.
4. **Closed** (`proto-fix-system`, `proto-fix-phone`). **Touch targets under 44 px** on the phone:
   segmented controls (36 and 40 px), the column jump (38 px), chips, and three controls that are
   not controls at all (the flow switch, the checklist rows, the row naming the work item in a chat).
   `check.mjs` finds nothing on the 39 phone screens.
5. **Closed** (`proto-fix-phone`). **Always-visible checkboxes** on the phone's acceptance
   checklist. The whole row is the control, and the design system records the checklist as the one
   place a check mark is always visible.
6. **Closed** (`proto-fix-phone`). **Relations are missing on the phone**: the work item and the new
   task form have none.

## What the prototypes leave undrawn

**Closed** (`proto-fix-desktop`, `proto-fix-phone`): all 18 states are drawn, 4 on the desktop and
14 on the phone, and listed in the index.

On the phone: steps 1 and 4 of the project wizard; selection with "Orchestrate"; the filter sheet;
the Activity and Changes tabs of a work item; the Journal and CLI tabs of Memory; the Team and
Resources proposals of the assistant; the document editor. On both sizes: suggestions while they
run, the assistant on an empty project, and the Tasks view with All projects selected.

## What differs between screens

- **Closed.** The figures: 15 open against columns that add to 14, 38 in total against 27, five
  roles in the wizard against four in `project-templates.ts`. One data set now: 27 items, 15 open and
  12 done, four template roles.
- **Closed.** Four breadcrumb schemes on the project's tabs, and two page title sizes on the phone.
  Now `Proyectos / <project> / <tab>`, and every phone title is 24 px.
- **Mostly closed.** Text that carries the meaning is truncated: list titles, the four flow
  descriptions, "hidden, 23 documents kept", the live line on a card with a role avatar. Four small
  truncations on the desktop stay open.
- **Closed.** A hover toolbar covers the message the chat screen is about; the FAB covers rows on
  two lists.
- **Closed.** Copy outside the glossary: "Seleccionando", "terminado", "espera por ti", "Hacer fork".
- **Closed.** `design-system.md` says 16 illustrations; there are 15.

## What the orchestration itself got wrong

Two tasks, `work-links` and `proto-index`, ended without a final report and with commit subjects
that are not Conventional Commits. **Open, and cannot change**: those commits are history; the
squash-merged pull request gets its own message. The generators of the prototypes were left in
`/tmp` and are not in the repository. **Closed** (`proto-fix-system`): they are in
`docs/design-system/reference/tools/` and rebuild their screens byte for byte. The plan's Outcome does
not mention the undrawn phone states. **Closed** (`docs-fixes`).

## What stays open

Left by orchestration 1b, each with the reason, for the owner or the orchestration named.

In the code:

- **Closed after 1b** (see the second audit). **Schedules skip the node checks.** A schedule filled from `specOfOrchestration` carries each
  node's `workItemId`, and the scheduler launches through `orchestrator.create`, not core's checks,
  so a scheduled graph links to those items. The scheduler was outside 1b's files; stripping
  `workItemId` there, as templates now do, is the likely answer.
- **Still open after orchestration 3. Live links for the new roles.** `isLive` in
  `work-item-rows.ts` counts only `work` links. Orchestration 3's flow writes `refine` and `verify`
  chat links but left `isLive` as it was, so a card being refined or verified is not drawn live. See
  [team-and-flow.md](../team-and-flow.md#known-gaps).
- A generic error thrown while "Work on it" creates its chat reaches the client as a 400, not a
  500: the API's shared error handler, left as it is.

In the prototypes:

- **Off-scale sizes in the shared base classes**: `.btn-sm` and `.chip` at 12.5 px, `.badge` and
  `.count-pill` at 10.5, the sidebar's nav items at 13.5, the KPI figure at 28. They sit in sections
  5 to 13, used by all 104 screens and by the app already built, so changing them is the owner's
  call.
- **Small truncations on the desktop**: the sidebar's live rows, resource descriptions in the
  editor's side list, one long file name in a work item's changes, the epic select in the new task
  form.
- **`team.svg`**: the "+" touches the QA slot, and the dashed slots are faint in light.
- **`MobileDocumentos`** says "Ligados a tareas 6" and draws 4 rows, with no "more" link.
- **The bounce** ("rebote 1 de 3") is drawn on no phone screen any more.
- **Light `--live`** is `#0b6680` in the reference, for contrast on its tint, while the app's
  `tokens.css` still has `#0e7490`. Orchestration 2 takes the darker value.
- **Below the fold**: "Sin hito" on `MobileHitos` sits below the fold of a scrolled list, and desktop
  Hitos and Asistente leave empty space under their lists.

In the checks: `pnpm build` and `pnpm e2e` on the merged branch, in 1b's verification phase.

## Second audit, after orchestration 1b

Run on 2026-09-27 on the merged branch (`ce572e6`), before orchestration 2. The verification of 1b
passed in full: install, typecheck, 1,260 tests, build and all 36 e2e specs.

- **Code.** Every finding above was confirmed fixed, each with a test that fails without the fix.
  The migrations are untouched, the store split changed no behaviour, and no commit carries an AI
  attribution trailer. Three new findings and one old bug were fixed on `feat/project-ecosystem`
  right after, each with a test that fails without it:
  - **A scheduled graph took over work items** (the first item of "What stays open"): the schedule
    drops each node's `workItemId` when it is stored and again when it fires (`withoutWorkItems`).
  - **A chat announced already busy never moved its item to `in_progress`**, since `run.created` was
    not read as a turn start once the coalesced updates stopped counting.
  - **Recovering an item's worktree pruned every missing worktree of the repository**; it now
    removes only its own.
  - **Opening the database failed with "database is locked"** when another process held a lock:
    `busy_timeout` was set after the switch to WAL. It predates the feature and was what made the
    work items' concurrency test flaky.
- **Prototypes.** The 66 new screens pass `tools/lint.py` (no raw value; the 63 left are in seven
  phone screens from before the feature) and `tools/check.mjs` (contrast in both themes and 44 px
  targets on the phone) with no finding. The board, the work item, the assistant's proposals and
  the More sheet were looked at in both themes. The last copy outside the glossary, the flow
  stepper's "Uno menos / Uno más", became "Reducir / Aumentar".
- **Still open for later**, none blocking orchestration 2: relaunching a graph whose item was
  deleted answers 400 instead of dropping the link; a node's worktree recorded on an item can make
  "Work on it" refuse when the graph ran in another repository; the Orchestrations badge reads 2 on
  the More sheet and 1 elsewhere; and the prototype items listed above.

## Audit of orchestration 2, the web of the board

Run on 2026-09-27 over `0140e52..4ba3d49` (116 files, all under `apps/web`, `e2e` and `docs`), while
orchestration 3 ran, without audit agents to spare the accounts' quota.

- **Checks.** Typecheck and 1,314 unit tests pass. The full e2e suite, run alone on its own port
  (`E2E_PORT=8811`) from a clean environment, passes all 40 spec files. The verification's own e2e
  had failed three times only because its test server was killed from outside: by the audit's
  preview cleanup and by another session's e2e on port 8799. Its fixer confirmed every failing spec
  passes on its own.
- **Rules.** No native select, checkbox or range; no `any`, `@ts-ignore` or `console.log`; no raw
  colour outside `tokens.css` (the light `--live` is `#0b6680`, and the hue tokens are there); every
  commit is a Conventional Commit with no AI attribution; nothing for orchestration 4 (assistant,
  suggestions) is drawn.
- **Contract between the tasks.** The four routes exist (`/tasks`, `/tasks/:key`,
  `/tasks/milestones`, `/projects/new`); the board hands its draft to the orchestration editor in
  the router state; filters live in the URL; cards move by keyboard as well as by drag.
- **Screens against their references**, captured from the built app on a seeded project (desktop
  and phone, dark and light): the board, the work item, the wizard and the project page follow their
  prototypes closely, in structure, spacing and colour use. The phone board has no horizontal
  columns and jumps between sections; the item page puts its two actions at the bottom.
- **Open, for the owner** (none blocks orchestration 3):
  - An epic counts as an open item and against its column's limit (the prototypes drew it that way:
    "5 de 3" with the epic inside). Whether an epic should count is a product decision.
  - The wizard's summary says the template's team is "kept for when the Team module can create its
    agents"; orchestration 3 must change that line once it creates them.
  - Already listed by `web-review`: the history names a chat by its session name rather than its
    first prompt (a change in core), and the empty board's illustration always says "AGN-1".

**Closed by orchestration 4.** The owner chose option B, epics do not count, and `board-fixes`
built it together with the other three items: the wizard's team line, the history's chat label by
first prompt, and the empty board's own key. See the plan's
[Outcome](project-ecosystem.md#orchestration-4-ecosystem-assistant-1).

## Audit of orchestration 3, the team, the flow, the memory and the documents

Run on 2026-09-27 over `51170a3..2fe9a92` (104 files outside `docs/`), while orchestration 4 ran.

- **Checks.** Its verification passed after its fixer's two commits (a valid heading outline on the
  new screens; the documents and memory specs matched to the markup they check). Every task
  finished on its first attempt; the integrator resolved the overlaps in `core/src/index.ts`,
  `api/src/app.ts`, `openapi/routes.ts`, `Home.tsx`, `views.ts` and `styles.css`.
- **Rules.** No native control, no `any`, `@ts-ignore` or `console.log`, no raw colour outside
  `tokens.css`, no SDK or HTTP call to Anthropic; every commit a Conventional Commit with no AI
  attribution.
- **The flow as decided.** A run goes through `claude --agent <member> --model <model>
  --append-system-prompt <journal> --json-schema <result>`; what a member may write is enforced
  with `--permission-mode dontAsk` and an allow-list of tools (stricter than a deny-list); at most
  `flow.maxParallel` runs per project, 2 by default; driven by events, with no timer. The automatic
  flow is **off** until the person switches it on.
- **Screens**, captured from the built app on a seeded project (team from the template, journal
  entries, documents tied to an item): Team, Flow, Memory and Documents follow their references,
  with the tab strip showing Team and Documents only while their modules are on.
- **Noted in passing**: "Usar el de la plantilla" writes the members' agent files into the
  project's own `.claude/agents/`, as decision 26 asks. Trying it on a real project creates those
  files there; the owner keeps the four created on `claude-wrapper` during the trial untracked
  until the end.

## Audit of orchestration 4, the assistant and the suggestions

Run on 2026-09-27 over `24ecee1..bbc993c1` (88 files outside `docs/`), merged into the feature
branch as `8dd45e7` while its verification's e2e still ran.

- **Checks.** Every task finished on its first attempt and integrated with no conflict; install,
  typecheck, the unit tests and the build passed in its verification.
- **Rules.** No native control, no `any`, `@ts-ignore` or `console.log`, no raw colour outside
  `tokens.css`, no SDK or HTTP call to Anthropic; every commit a Conventional Commit with no AI
  attribution.
- **The assistant as decided.** A run is a CLI chat with `--permission-mode dontAsk`, an
  allow-list of read tools (`Read`, `Grep`, `Glob`, `LS` and `git log`, `git status`, `ls`) and a
  deny-list, and `--json-schema` for its answer; `sonnet` by default; one run at a time per project
  and kind, older proposals set aside as `superseded`, never deleted; on demand only, no timer.
  Nothing is written before the person accepts a proposal.
- **The audit of orchestration 2, closed.** Epics no longer count: on a seeded board, In progress
  draws four cards (an epic and three tasks) and counts three against a limit of three, not over.
- **Screens**, captured from the built app: the project assistant (desktop and phone), "Sugerir
  tareas" over the board and the resources tab with "Sugerir" and "Crear con IA" follow their
  references. A run with a real answer was not captured: the sandbox has no credentials, and the
  accept paths are covered by the fake CLI in the unit and e2e tests.

## The whole feature, checked once

On 2026-09-27, after orchestration 4's verification passed (its fixer's commits merged, the ones
that repeated orchestration 3's fixes identical and conflict-free), the feature branch at `24711ae`
was checked as a whole, alone on the machine's e2e port range (`E2E_PORT=8811`, clean
environment): typecheck, 1,476 unit tests, the build and all 47 e2e spec files pass.

## Review of the whole feature before the pull request

Run on 2026-09-28 over `origin/main...849b0ff` by five reviewers on Opus, one per area (the store
and the automation; the modules that launch agents; the API; the web wiring; a hands-on walkthrough
of the built app with the fake CLI), each reproducing what it could. The most serious items were
checked again by hand in the code.

Status: **fixed by `ecosystem-review-fixes` (orchestration 5) on 2026-09-28**, and what it left
([Still open after orchestration 5](#still-open-after-orchestration-5)) by `ecosystem-gaps`
(orchestration 6) the same day. Each finding is marked
**closed**, **partly closed** or **open** after an arrow, with the task that closed it and the test
that covers it. `review-5` re-ran every reproduction on the merged branch of the six fix tasks.
`pnpm typecheck` and `pnpm test` pass there; `pnpm build` and `pnpm e2e` run in the verification
phase, on the merged branch.

### Cost, safety and data

1. **A flow run cut by a restart can start over in a fresh chat with no item context.** When the
   cut run's chat cannot be resumed, `launchFlowRun` falls back to a new chat with only the prompt
   "Agentry restarted while you were on this run…" (`flow.ts:495`, `index.ts:1230`). The structured
   result still moves the card. Reproduced. The flow also has no restart counter, unlike the
   assistant. Fix: build the full prompt in the fallback (or fail the run) and bound restarts.
   → **Closed** by `fix-flow`: a cut run continues only in its own chat, at most twice
   (`flow_runs.restarts`), and keeps its first `started_at`; otherwise it fails with a comment on
   the item. Tests: `flow-cli.test.ts`, `flow.test.ts`.
2. **Flow members get unrestricted `Bash`, `WebFetch` and `WebSearch` in every stage**, and no run
   sets `--max-budget-usd` (`flow.ts:80`). A Product Owner or QA run can push, delete or fetch.
   Fix: tool sets per stage, deny `Bash(git push *)`, a per-run budget setting.
   → **Closed** by `fix-flow`, one decision changed: each stage has its own tools, `git push` is
   always denied, `WebFetch`/`WebSearch` only in the work stage, and `flow.maxCostUsd` is passed as
   `--max-budget-usd`. The owner decided on **no default budget**, not the plan's 2 USD. `writes`
   still does not bound the shell in the work stage
   ([team-and-flow.md](../team-and-flow.md#known-gaps)). Test: flow-cli "each stage runs with its
   own rules".
3. **The assistant is not strictly read-only.** `--allowedTools` adds to the rules of the user,
   project and local settings, `Bash(git log *)` admits `git log --output=<path>` (writes a file),
   every chat gets `--add-dir <uploads>`, and a bare `Read` is not scoped to the project
   (`assistant.ts:152`, `chats.ts:1325`). Fix: `--tools Read,Grep,Glob`, restrict setting sources,
   hand git facts in the prompt, deny `Read(./.env*)` and credential files, skip uploads.
   → **Closed** by `fix-assistant`: an assistant chat is confined (`ChatConfinement`):
   `--tools=Read,Grep,Glob`, `--setting-sources=`, `--restricted`, no `--add-dir`, reads of `.env*`,
   keys, credentials and `.git/` denied, git facts and `CLAUDE.md` handed in the prompt. Flags
   checked against CLI 2.1.282. Test: `assistant-cli.test.ts`.
4. **The Documents folder may itself be a symlink out of the project** (`documents.ts:103,240,268`):
   the file is checked against the folder, the folder never against the project. Reproduced:
   read and write through `linked -> /tmp/outside`. Fix: the resolved folder must be inside the
   resolved project.
   → **Closed** by `fix-core-data`: the resolved folder must be inside the resolved project, or a
   400. Test: the documents tests.
5. **"Retry clean" on a failed orchestration node can delete "Work on it" work.** `recordPlace`
   adopts the node's worktree for the item; `startOver` then force-removes that worktree and
   branch (`work-links.ts:385`, `orchestrator.ts:1849`). Fix: keep "Work on it" on its own
   `task/<key>` worktree, or refuse to remove a worktree an item holds.
   → **Closed** by `fix-links-api`: "Work on it" always has its own `task/<key>` worktree, branched
   from the node's branch when a node worked on the item, and a node no longer takes over an item's
   place. Test: the work-links tests.
6. **"Work on it" branches from the main checkout's HEAD, not the project's**, when the project is
   a linked worktree (`work-links.ts:169`, and `changes.ts:173` diffs the same way). Reproduced.
   A submodule project gets its worktree under `.git/modules/…`. Fix: `headCommit(projectPath)` as
   the base, and the main worktree from `git worktree list`.
   → **Closed** by `fix-links-api`: the branch and its changes use the project's HEAD; a submodule's
   main checkout is its own top level (`mainCheckout`), while the orchestrator keeps `mainTopLevel`,
   where the CLI adopts worktrees (`546d0b7`). Tests: the linked-worktree and submodule tests.
7. **A chat the flow ran keeps the member's options when a person continues it**: `dontAsk`, the
   member's allow-list, `keepAlive: false`, model and system prompt persist after `resume`
   (`chat-service.ts:519`). Reproduced from the spawn arguments. The person's own "Work on it" chat
   then silently denies their edits outside `writes`. Fix: snapshot and restore, or never resume a
   person's chat for a member.
   → **Closed** by `fix-flow` and `review-5`: resuming or forking a flow or assistant chat hands it
   back (`handBack`) with a new chat's mode and tools; member and assistant runs pass
   `--system-prompt-snapshot off`; a Developer never resumes a person's "Work on it" chat. Test:
   `assistant-cli.test.ts` drives the hand-back and the confinement together.
8. **Two processes opening a pre-feature database at once: one crashes on the migrations**
   (`db.ts:450`: `user_version` read outside a deferred transaction). Reproduced (5 of 18).
   Predates the feature, which added five migrations. Fix: `BEGIN IMMEDIATE` and re-read inside.
   → **Closed** by `fix-core-data`: each migration runs in `BEGIN IMMEDIATE` and reads
   `user_version` inside it. Test: db "two processes upgrading…".
9. **A "suggest again" run that fails to start buries the previous proposals for good**
   (`assistant.ts:329` supersedes before launching; `restore` refuses superseded). Reproduced.
   → **Closed** by `fix-assistant`: a superseding run that ends without proposals hands the previous
   ones back in the same transaction. Test: assistant "suggesting again that ends with nothing…".

### Decisions not met, and data shown wrong

10. **QA does not check the acceptance criteria one by one** (decision 18): the verify schema has
    only `verdict`, and `apply()` never marks a criterion (`flow.ts:201`). An item reaches `done`
    with every criterion unchecked. Fix: `criteria: [{ id, met, note }]` in the schema, checked as
    the agent.
    → **Closed** by `fix-flow`: the verify result carries `criteria: [{ id, met, note }]`, each met
    one is checked as QA, and the run passes only when all are met. Test: flow "QA judges each
    criterion".
11. **Epics still count with All projects** (`index.ts:1335`) and in the List view's group counts,
    while the per-project board leaves them out: the sidebar and the More sheet change their
    figure when the scope changes. Reproduced on the app.
    → **Closed** by `fix-core-data` (All projects counts) and `fix-web-tasks` (the List's group
    counts). Tests: the core counts, the API's All projects test, the e2e list group counts.
12. **Events can reach the web out of order and be dropped.** A handler that emits while an event
    is being delivered has its event sent first; the web discards the earlier id
    (`core/events.ts:43`, `web/lib/events.ts:476`). Seen: `journal.changed` before
    `workitem.moved` on a move to `done`, so other tabs never see the move; the same for
    `flow.run` and `assistant.run`. Fix: queue nested emits until the current delivery ends.
    → **Closed** by `fix-core-data`: the bus queues nested emits until the current delivery ends.
    Tests: the events and journal ordering tests.
13. **The Product Owner's write permission reads two opposite ways**: "escribe: nada, solo tareas"
    in the proposal and the template list, "En todo el proyecto" on the member card
    (`writeRules([])` gives no edit rule but the card says the opposite). And the flow prompt asks
    the Product Owner to write a spec and QA a report under `documents.path` while `writes: []`
    denies it silently (`assistant.ts:174`, `flow.ts`).
    → **Closed** by `fix-flow` (the agent file for `writes: []`, the documents folder writable in
    every stage) and `fix-web-team` (the card, the proposal and the editor name the three cases;
    saves keep `writes` absent when it was). Tests: the flow rules and team tests,
    `team-model.test.ts`, the Team e2e spec.
14. **A failed flow run is invisible on the task**: the chat shows "COMPLETADA · no movió la tarea",
    no comment, no reason; only the Team tab says "fallida".
    → **Partly closed.** A failed run carries its `error` and leaves a comment on the item
    (`fix-flow`); the Team screens show the reason in the bad colour (`fix-web-team`); the item's
    chat link reads "Ejecución fallida" and the reason (`review-5`). Tests: `tasks-screens.test.ts`,
    `tasks-review.spec.mjs` part 14, the Team e2e spec. **Open:** the web has only each member's
    latest run, so an older failed run's link reads as a normal one again (the comment stays), and
    the failed run's own chat page says nothing. Serving an item's runs from the core would close
    it.
    → **Closed by orchestration 6** (gap 2): `GET /work-items/:itemId/runs` serves every run of the
    item, the item's links read it, and a failed run's chat says the run failed and why. Tests:
    `work-item-runs-ui.test.tsx`, `flow.test.ts`, `tasks-review.spec.mjs`.
15. **Before the flow is saved, the Team screen draws a flow that does not exist** (columns per
    role shown while `settings.flow` is null).
    → **Closed** by `fix-web-team`: with `settings.flow` null the Team screen says the flow is not
    set up, and the Flow screen offers the template's proposal as a draft to save. Tests: the
    `savedFlow` and `proposedFlow` tests, the Team e2e spec.
16. **Documents between 1 MiB and 2 MiB open but never save**: the core allows 2 MB, Fastify's body
    limit is 1 MiB (`routes/documents.ts:17`).
    → **Closed** by `fix-core-data` (1 MiB in the core) and `fix-links-api` (the write route's body
    limit fits any content the core accepts). Test: API "a document of up to 1 MiB".

### Bugs a user hits

17. **"Crear otra" in New task is ignored**: `Board.tsx:350` passes `onCreated={() => closeNew()}`,
    overriding the keep-open branch. Reproduced.
    → **Closed** by `fix-web-tasks`: the form decides, and focus goes to the new card or row. Test:
    `tasks-review.spec.mjs`.
18. **Escape in a dialog opened from the item panel also closes the panel** (and the New task form
    from its relation picker), because every `Dialog` listens on `document` in capture phase.
    → **Closed** by `fix-web-tasks`: modal surfaces share one stack and only the top one hears a
    key. Test: `tasks-review.spec.mjs`.
19. **An API blip unmounts open editors and loses unsaved text**: Documents, the item page and the
    panel replace their content with an error box while a fallback poll fails
    (`Documents.tsx:67`, `Pane.tsx:168`, `Panel.tsx:32`). No dirty guard on the item's title and
    description either.
    → **Closed** by `fix-web-tasks`: `queryView()` keeps what was shown through a failed refetch,
    and an edited title or description asks before leaving. Tests: `tasks-screens.test.ts`,
    `tasks-review.spec.mjs`.
20. **The wizard only rejects names with spaces or accents after "Crear proyecto", in English**
    ("invalid project name (letters, digits, _ . - only)"), while Settings accepts such a rename.
    → **Closed** by `fix-web-team`: the wizard makes the folder from the name, says which folder
    while it is typed, and renames the project to the name as typed. Test: `projects-model.test.ts`.
21. **Filters of one project survive a project switch** (`projects=`, `epic=`, `milestone=` in the
    address), leaving "0 of N" with no chip to remove.
    → **Closed** by `fix-web-tasks`: a filter the scope does not have leaves the address, judged
    only on fresh lists. Test: `tasks-review.spec.mjs`.
22. **New task can be a dead end** when the selected project's Board is off: the palette and the
    FAB open the form with no picker and a disabled Create.
    → **Closed** by `fix-web-tasks`: New task asks for a project that has a board. Test:
    `tasks-review.spec.mjs`.
23. **Deleting an item or going back drops the board's context** (filters, view, project tab).
    → **Closed** by `fix-web-tasks`: Delete closes the panel, and Back returns to the address the
    page was opened from. Test: `tasks-review.spec.mjs`.
24. **A document tied to a task cannot be untied from the UI**; deleting the file is the only way.
    → **Closed** by `fix-web-tasks`: each tied document has an untie button that leaves the file.
    Test: `tasks-review.spec.mjs`.
25. **Assistant chats are titled with their English system prompt** in the chat list, the sidebar
    and "Retomar"; the "Trabajar en ella" prompt and the orchestration draft's prompts are in
    English too.
    → **Partly closed.** Assistant chats are titled in the person's language ("Asistente de …", from
    `Accept-Language`), and the chat list, the sidebar and "Retomar" show it (`fix-assistant`).
    **Open:** the "Work on it" prompt starts `KEY: title` rather than the plan's `KEY · title`, and
    the rest of it and the orchestration draft's prompts are English instructions for Claude; an
    assistant run relaunched after a restart is titled in English, as its language is not kept.
    → **Closed by orchestration 6** (gaps 10 and 13): "Work on it" and each draft node open with
    `KEY · title`, the draft's objective is in the person's language, a flow run's chat opens with
    "<Role> · <KEY> · <title>", and an assistant run keeps its language across a restart. The
    instructions for Claude after the first line stay in English, as the plan allows. Tests:
    `assistant.test.ts` ("a run keeps its language…"), `flow.test.ts`, the work-links tests.
26. **"Sugerir" on the Resources tab gives no feedback** when pressed from a kind section with a
    file open.
    → **Closed** by `fix-web-team`: "Sugerir" leaves the editor first (asking if it holds unsaved
    text) and shows "Sugiriendo…" with a spinner. Test: a `suggest.spec.mjs` step.
27. **Malformed bodies answer 500** (`acceptanceCriteria: "abc"`, `epicId: true`, repeated query
    parameters, writing a document "under" a file), and `description`, criteria and milestone
    descriptions have no length cap, which makes every board read heavy.
    → **Closed** by `fix-core-data` (body shapes; caps of 100,000 characters for a description,
    2,000 for a criterion and 10,000 for a milestone's description; 409 for a document under a file)
    and `fix-links-api` (repeated query parameters, journal, project and graph bodies). `review-5`
    found `POST /chats` still answered 500 to text fields of the wrong type and fixed it; a probe of
    about 45 routes finds no other 500. Tests: `api.test.ts` and the core validation tests.
28. **A `task/<key>` branch checked out elsewhere gives git's raw error as a 400**, not the
    documented 409.
    → **Closed** by `fix-links-api`: the documented 409, naming where the branch is checked out.
    Test: the work-links 409 test.
29. **Phone**: the label input is 12 px (iOS zooms) and the label controls are 24 px; the FAB covers
    a column header's role label; the sheet's close button is 30 px.
    → **Closed** by `fix-web-tasks` (a 16 px label input, 44 px label controls and sheet close
    button, section heads kept clear of the FAB) and `review-5` (the phone's resource name field).
    Tests: `tasks-review.spec.mjs`, `suggest.spec.mjs`; the FAB change is CSS with no test.
30. **Wrong save shortcut on Linux** ("⌘S" hard-coded in the document and resource editors).
    → **Closed** by `fix-web-tasks`: `shortcut()` names Ctrl+S outside Apple keyboards. Test:
    `tasks-review.spec.mjs`.

### Inconsistencies and drift

- The project header says "0 chats" on projects with assistant, flow and work chats.
  → **Closed** by `fix-links-api`: the count and the last activity come from the chat list the
  project's page reads.
- The docs overstate a key prefix change: recorded branches, worktree paths, chat titles, node ids
  and `/tasks/<old key>` links keep the old key; two projects can derive the same `task-<key>` path.
  → **Closed** by `fix-links-api`: [work-items.md](../work-items.md) says what keeps the old key,
  and an item worktree's lock records the project that made it, so two projects never share one.
  An item's page open through a prefix change follows it to the new key (`fix-web-tasks`).
- The re-import comment says the opposite of the code (modules replaced, not merged); a stale
  "orchestration 3" comment in `project-settings.ts` and `ProjectGeneral.tsx`; docs say
  "unlocked and pruned" where the code removes; OpenAPI for settings omits team, flow and documents;
  `docs/team-and-flow.md` says only Edit/Write are allowed with `writes`.
  → **Closed**: the re-import comment by `fix-core-data`, the stale comments by `fix-web-team` and
  `review-5`, `work-items.md` by `fix-links-api`, the settings' OpenAPI by `review-5`, and
  `team-and-flow.md`'s table of each stage's tools by `fix-flow`.
- Status codes differ for the same situation across routes (journal 404 vs relations 400 for a
  foreign item; `from-template` 200 vs 201 elsewhere; `PATCH {status}` silently ignored).
  → **Partly closed** by `fix-links-api`: the journal answers 400 like a relation, and a `PATCH`
  naming `status` or `afterId` is a 400 pointing at `POST /work-items/:id/move`. **Open, on
  purpose:** `from-template` keeps its 200, since it answers the whole team and sending it twice
  changes nothing.
  → **Closed by orchestration 6** (gap 18): `from-template` answers 201 when it added a member and
  200 when nothing changed. Test: `team.test.ts`.
- Two routes tie a document (`/documents` and `/links` with `kind=document`); `itemId` vs
  `otherId`; `/memory-proposals/:id` vs `/assistant/proposals/:id`.
  → **Closed as decided**: both routes stay, `/links` documented as the general form and
  `/documents` as its shorthand; the relation routes say `itemId` and `otherId` are the same item.
  The two proposal paths stay as they are.
- No `project.created` / `project.removed` events; `GET /projects/:id/settings` can write.
  → **Closed**: `fix-links-api` added both events, and the web refreshes the project lists and the
  All projects views on them. A first read of the settings still writes the document; the OpenAPI
  now says so (`review-5`).
- The Spanish glossary was not extended (Backlog, Épica, Historia, Hito, Responsable, Flujo…) and
  "tarea" now names both a work item and an orchestration node; "No se pudo…" and "No se ha
  podido…" both in use; "Arquitecto · Descartada"; toasts and prompts with English left in.
  → **Closed** by `fix-web-team` (the glossary, with "nodo" where the two meet, and "Arquitecto ·
  Propuesta descartada") and `review-5` (the copy end to end; a test in `i18n.test.ts` keeps the
  replaced forms out of every namespace). The English left in Claude's prompts is finding 25.
- Unused: `AssistantService.ownsChat`, `TeamService.memberForRole`, core's `FLOW_COLUMNS`, the
  `work_item_labels_label` index, and eight i18n keys; five web files over 400 lines.
  → **Closed**, except the file sizes: `ownsChat` removed by `fix-assistant`, `memberForRole` and
  the index by `review-5` (a migration drops it; `db.test.ts`), core no longer has `FLOW_COLUMNS`,
  and `fix-web-team` dropped nineteen unread keys. **Open:** the web files over 400 lines were not
  split.
  → **Closed by orchestration 6** (gap 24): the assistant, new project, resources, memory, task,
  shell and palette files were split without changing behaviour. No file of the feature is over 400
  lines; the files still over 400 (`Orchestration`, `Chats`, config tabs…) predate it, and it added
  nothing to them.
- Approved memory files get an unquoted YAML `description`; memory proposals are never
  de-duplicated; a flow result path like `./docs/x.md` is refused silently.
  → **Closed**: the description is written as a JSON string and a proposal of the same text for
  the same target is the one already there (`fix-core-data`); `./` and absolute paths are made
  relative, and what still cannot be tied is named in the run's comment (`review-5`).

Found by `review-5` next to the findings, and fixed: every team change wrote the whole settings
document back, undoing a module switched meanwhile (only the team and the flow are written now;
`project-settings.test.ts`); a graph node could name another project's item and move it (400;
API `work-links`); a fork of a flow or assistant chat kept the run's mode and tools; and a refine or
verify chat's inspector said the item would move to In review (`work-item-links.test.ts`).

### Improvements a user would want

- Warn when "Mover a Hecho" leaves criteria unchecked, and when deleting an item a chat is working
  on.
  → **Done** by `fix-web-tasks`: "Move to Done" asks while criteria are unchecked, and deleting an
  item a chat or a node works on says that work goes on without it.
- Every backlog card costs two back-to-back runs (refine in `backlog`, then the `todo` check);
  "Crear las seleccionadas" on eight suggestions queues eight runs with no word.
  → **Partly done**: "Crear las seleccionadas" says how many flow runs it queues, the role and how
  many run at a time (`review-5`; `team-model.test.ts`, a `suggest.spec.mjs` step). **Open:** a
  backlog card still costs two runs.
  → **Closed by orchestration 6** (gap 4): the `todo` check runs only when the refine did not pass
  or the item changed since. Test: `flow.test.ts`.
- Page the Done column and the unbounded lists; leave descriptions out of board payloads; stop
  refetching `changes` (a git diff) on every run event.
  → **Partly done**: `changes` is read again only on a turn that ended or a node that moved
  (`fix-web-team`). **Open:** paging was left out by the plan's decision, and board payloads still
  carry descriptions, now capped at 100,000 characters (finding 27).
  → **Closed by orchestration 6** (gap 20): cards carry `hasDescription` instead of the text, Done
  holds its newest 20 with "y N más" loading the next page, and the lists page by 100 with a
  cursor. Tests: the work-items store and API tests, `tasks-board.spec.mjs`.
- Keep the Tasks filters when leaving and coming back; remove or explain the Done column limit;
  validate agent-file frontmatter before saving; let "Crear con IA" pick a free name.
  → **Done**: the filters are kept through `main`'s `useListParams`
  ([persistent-filters.md](../persistent-filters.md)); the Done column has no limit control; the
  resource editor, a proposal's editor and a member's agent file check the frontmatter before
  saving; a proposal's name starts from the first free `<name>-2`, `-3`… (`fix-web-team`).

### Still open after orchestration 5

Nothing, since orchestration 6. What this section listed, each closed as
[Orchestration 6](#orchestration-6-the-known-gaps-closed) below says:

- **14:** an older failed flow run's link on the item, and a failed run's own chat page (gap 2).
- **25:** the "Work on it" and orchestration draft prompts, and an assistant run relaunched after a
  restart (gaps 13 and 10).
- `from-template` answered 200 (gap 18).
- A backlog card cost two flow runs (gap 4); board payloads carried descriptions and nothing was
  paged (gap 20).
- Web files over 400 lines (gap 24).
- `writes` did not bound the shell in the flow's work stage (gap 7).

### Verified as sound

Every store write in `BEGIN IMMEDIATE` with events after commit; deletes cascade; keys never reused;
the forward-only automation and its guards; worktree recovery; settings reads never write over a
broken file; all SQL bound and git called with argument arrays. The flow is off by default, driven
by events only, one run and one queued per item, stopped when its module or the flow goes off; the
journal's closed entry written once; agent-file frontmatter safe against newlines and `---`; the
assistant one run per project and kind. Every route behind the global guard and audited, OpenAPI and
README complete with no drift, module-off refusals and cross-project refusals correct. Every new
event type wired to the queries it affects; Markdown never renders raw HTML and links are sanitised;
no new raw colour or keyframe; keyboard drag announced. No console error on any page of the
walkthrough, and every core journey could be finished.

## Orchestration 6: the known gaps, closed

On 2026-09-28 the owner asked for every gap the documents still listed to be closed before the pull
request: the Known gaps of [work-items.md](../work-items.md), [team-and-flow.md](../team-and-flow.md)
and [assistant.md](../assistant.md), and [Still open after orchestration 5](#still-open-after-orchestration-5).
The plan numbered them 1 to 24 ([Orchestration 6](project-ecosystem.md#orchestration-6-ecosystem-gaps)),
and `ecosystem-gaps` built them from `ad1d6cf` (main 0.22.1 merged). `gaps-review` re-checked all 24
on the integrated branch, in both themes and both sizes, and fixed what was still open or broken
between tasks: the web still sending Suggest tasks' focus as `description` (9), the assistant
reachable only from the summary's phone head (8), a 30 px way back on the phone member and document
screens (21), the "Sin límite" placeholder squeezed out of the spend field (5), a running row out of
line in the team's activity (6), and the phone document editor's bar mid-screen (23).

| # | Gap | Status | Evidence |
| --- | --- | --- | --- |
| 1 | A card being refined or verified is live | Closed | `f9a8fa8` (core), `e02f111` ("Refinando", "Verificando"); `flow.test.ts`, `team-screens.test.tsx` |
| 2 | Every run of an item from core; a failed run's chat says so | Closed | `0956313`, `1097606`; `work-item-runs-ui.test.tsx`, `tasks-review.spec.mjs` |
| 3 | A rate-limited run waits for the rotation | Closed | `2a9251f`; `flow-cli.test.ts`, `flow.test.ts` |
| 4 | A backlog card costs one refine run | Closed | `150f498`; `flow.test.ts` |
| 5 | The Flow screen edits `maxParallel` and `maxCostUsd` | Closed | `3cf261f`, `4fc31de`; `team-screens.test.tsx`, `team-gaps.spec.mjs` |
| 6 | "Ver todo" opens the team's activity | Closed | `0956313`, `d98f7e0`, `75def92`; `team-screens.test.tsx`, `a11y.spec.mjs` |
| 7 | A member's `commands` bound the work stage's shell | Closed | `a204de8`, `3cf261f`; `flow.test.ts`, `team.test.ts`, `team-gaps.spec.mjs` |
| 8 | The assistant from every tab and the palette | Closed | `8e5712b`, `8d2b294`; `project-head.test.tsx`, `team-gaps.spec.mjs` |
| 9 | Suggest tasks' focus is its own field | Closed | `5d180cf`, `4e0beeb`; `assistant.test.ts`, `suggest-model.test.ts`, `suggest.spec.mjs` |
| 10 | An assistant run keeps its language | Closed | `5d180cf`; `assistant.test.ts` |
| 11 | `CLAUDE.md` shows once | Closed | `03dd0df`; `assistant.test.ts` |
| 12 | "Crear con IA" streams | Closed | `b18cb87`, `0ac4b91`, `8b26570`; `assistant-screens.test.tsx`, `create-ai-stream.spec.mjs` |
| 13 | Chats Agentry starts open in the person's language | Closed | `28a2e70`, `7fd7484`; `assistant.test.ts`, `flow.test.ts`, work-links tests |
| 14 | Template responsibilities in the person's language | Closed | `3cf261f`; a test reads `project-templates.ts` |
| 15 | A chat Agentry does not run is named by its title in the history | Closed | `354223b`; `work-item-history.test.ts` |
| 16 | `GET /work-items/by-key/:key` | Closed | `683e8f5`; `ecosystem-gaps-client.test.ts`, `shell.spec.mjs` |
| 17 | A generic start error answers 500 | Closed | `85691ec`; `chat-start-errors.test.ts` |
| 18 | `from-template` answers 201 or 200 | Closed | `0c7af0f`; `team.test.ts` |
| 19 | The `file` team action is emitted | Closed | `0c7af0f`; `team.test.ts` |
| 20 | Cards without descriptions; Done and the lists paged | Closed | `683e8f5`, `07aa24a`; work-items tests, `tasks-board.spec.mjs` |
| 21 | Phone detail screens head themselves | Closed | `972bca7`, `0dd17b6`; `shell-live.test.ts`, `team.spec.mjs`, `documents.spec.mjs` |
| 22 | "Proyectos" and "Más" marked on a project | Closed | `8432874`; `shell-nav.test.ts` |
| 23 | Small differences from the references | Closed | `08121bd`, `0ac4b91`, `8b8ada3`, `8402280`, `1847725`, `e9d7fe1`, `6f11b55`, and the model's name after the ecosystem-gaps pass; `team-screens.test.tsx`, `documents.spec.mjs`, `models.test.ts`, `chats.test.ts` |
| 24 | Web files over 400 lines split | Closed | `ca8253c`, `3e52e86`, `335c2cc` |

**The one detail that was left in gap 23, closed afterwards:** the member page writes the CLI's
own name after the model ("sonnet · Sonnet 5") only when the CLI's model list labels it, and the
list the CLI writes (`additionalModelOptionsCache` in `.claude.json`) labels none of the aliases, so
with the real CLI a member on `sonnet` showed the alias alone; the test passed only because it
injected the label. The owner chose option A on 2026-09-28 (decision 41 of the
[plan](project-ecosystem.md)): the model id a chat's `system/init` event reports is kept per alias
the chat was started with (`ModelAliasIds`, `model-aliases.json` in the data dir, recorded in
`chats.ts`), and `modelOptions` labels each alias with a name derived from that id by rule
(`modelDisplayName`: "Sonnet 5", "Opus 5.5", "Haiku 4.5"). Until a chat has run on an alias, it
shows alone. Tested in `models.test.ts` (the rule, the document) and `chats.test.ts` (recorded from
`system/init`). Described in [team-and-flow.md](../team-and-flow.md#known-gaps).

`pnpm typecheck` and `pnpm test` pass on the integrated branch; `pnpm build` and `pnpm e2e` run in
the verification phase, on the merged branch.

## Audit of orchestration 7, the design pass

Run on 2026-09-28 over orchestration 7 (`ecosystem-design`, the plan's
[Orchestration 7](project-ecosystem.md#orchestration-7-ecosystem-design)), on a trial merge of its
integration branch and its e2e fixer into `feat/project-ecosystem`, in two passes: a static one over
the diff, then a visual one that captured the built app on a seeded project (desktop and phone, dark
and light) and set each screen beside its reference in `docs/design-system/reference/` and
[the ecosystem review](../design-system/ecosystem-review.md).

**Static audit: no blockers.** Fixed on the trial merge:

- A phone document's byline is one link to its task (`e2a05e04`).
- The phone board's "show more" keeps its chevron on the text's row (`35627fbf`).
- The app-only variants of the design pass are recorded in `agentry-ds.css` section 19 and in
  `design-system.md` (`5a462f78`).
- Dead CSS dropped: the bounces header and the old show-more slot (`9c06fba2`).
- The shell decides its bare phone header through `useOwnPhoneHeader` (`1beab7cd`).
- The es copy says a stopped run's cause as "se detuvo su chat", and the glossary records "en
  marcha" as its exception (`c79ebe3f`).
- A failed strip on the board no longer carries `role=status`, so loading a board does not announce
  every failure (`9d520415`).

**Merge notes.** Orchestration 7 branched before the last commits of the feature branch, and the
merge kept both sides:

- Both migrations stay, the feature branch's `flow_runs.language` before the design pass's `cause`
  and `retry_of`; a retry stores the language of the run it retries.
- A live card's stage verb wraps, as the reference draws it, instead of the ellipsis the feature
  branch had given it (`e9277b78`).
- On the phone's Ajustes and Recursos tabs, where the only header action is Asistente, it goes
  under "⋯" to keep the reference's gap of 8.
- Team activity's header has both the filter and "⋯".

**Visual audit.** Screens that follow their reference closely: the board, the list, the card and its
strip, the work item (waiting, running, failed, criteria), the team, a member, Team activity, the
flow's model picker, the project, documents, memory, resources and the assistant. What differed, and
how each was closed:

| # | Finding | Kind | Fix |
| --- | --- | --- | --- |
| 1 | Done drew the three oldest of its 20 newest: core held the most recently closed, but in rank order, and a move to Done is ranked last | Blocker | `b64888ff`: the board's Done column comes newest first by closing time (`newestDone`), the list's Done group reads the same (joined by the board's newest once the open rows are read), and a card moved to Done heads it, on the desktop board, the phone board and the keyboard alike; nothing is reordered inside Done. `work-items.test.ts`, `tasks-board.test.ts`, `tasks-list-pages.test.ts` |
| 2 | A flow run that failed before its chat started (no account with quota, a rate limit) left no trace on its item's page, only on the board strip and in Team activity | Blocker | `26e190a9`: the item's runs are read for every item, and a run no chat link stands for joins the links in the run-row style: its role, its outcome, its worded cause and "no chat" in place of a chat id. `work-item-runs-ui.test.tsx` |
| 3 | Phone targets under 44 px: the task's pencils, "Relacionar" and "Ligar", the epic and milestone facts, and "Editar" on a member | Polish | `4858efdf`, with `--touch`. A label's "×" already had a 44 px target through its `::after`, which the capture measured as its 18 px box |
| 4 | The member count in the team's switch at 4.46:1 dark and 4.43:1 light | Polish | `df3f28ca`: `--fg-2` on the count's pill, about 6:1 in both themes |
| 5 | A document's list bullets in coral | Polish | `27c548a5`: `--fg-2` on the document page; the chat's Markdown keeps its bullets |
| 6 | A flow that is off said "APAGADO" on the team and "DESACTIVADO" on the board | Polish | `538f33c5`: "desactivado" on both, as the glossary's Enabled / Disabled; en already said "off" on both |
| 7 | The member page's back button unboxed on a desktop | Polish | `03edcb65`: boxed, with its tooltip, as the task page's |
| 8 | Role hues hashed from the name, so a role could come out red, green or cyan | Polish | `18651632`: the template roles keep the design's hues (Product Owner 300, Architect 215, Developer 90, QA 330, Technical writer 45; Researcher 250, Reviewer 275), and a role someone named takes one of six free hues outside the status ones. `team-model.test.ts`; recorded in `design-system.md` |
| 9 | "Tablero 0" and "Documentos 0" on the project's tabs | Polish | `3a8d436e`: a zero is left out, on the phone cells too |
| 10 | The agent file editor painted keys red and headings green with CodeMirror's presets | Polish | `e6e8ec57`: its own highlight style from the tokens, the reference's greys for keys and punctuation, weight for headings and `--sx-*` for the rest, in both themes |

**Stays open.**

- Not verified in the capture, because the seed could not produce them: the team board view with the
  flow on, a member's model with its resolved name, and run links with real chats.
- Left as the reference review left them: the phone's "⋯" on every card and the "Flujo automático"
  row, and the wider search field.

`pnpm typecheck` and `pnpm test` pass after the fixes, and `pnpm build` succeeds; `pnpm e2e` runs
once, in the verification before the pull request, since an orchestration held port 8799.

## Related

[[plans/project-ecosystem.md]] · [[design-system.md]] · [[work-items.md]] · [[projects.md]] ·
[[status.md]]
