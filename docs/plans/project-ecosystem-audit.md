---
created_at: 2026-09-27T07:12:38.39333137Z
updated_at: 2026-09-27T21:30:00Z
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

## Related

[[plans/project-ecosystem.md]] · [[design-system.md]] · [[work-items.md]] · [[projects.md]] ·
[[status.md]]
