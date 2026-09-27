---
created_at: 2026-09-27T07:12:38.39333137Z
updated_at: 2026-09-27T07:12:38.39333137Z
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

Status: **findings open**. They are fixed by the `ecosystem-fixes` orchestration before
orchestration 2 starts.

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

1. **A person's move does not win while the agent works.** `work-links.ts` reads
   `status === 'busy' && previousStatus !== 'busy'` as a turn starting, but the coalesced
   `run.updated` the publisher emits about every 250 ms carries `previousStatus: null`. An item
   dragged back to `todo` returns to `in_progress` at once. Require a real transition, and test it
   with a null previous status.
2. **Reading a broken settings document overwrites it with defaults.** `ProjectSettingsStore.read`
   writes when the file does not parse, so one typo in a hand edit loses the modules, the limits and
   the key prefix on the next `GET /projects`. Answer with defaults in memory and leave the file.
3. **A relaunched orchestration loses the link to its work items.** `specOfTask` in
   `packages/shared/src/orchestration.ts` does not copy `workItemId`, and the relaunch route skips the
   checks of `launchOrchestration`.
4. **An item worked by an orchestration node shows no changes.** Only "Work on it" records the
   worktree and the branch on the item, so decision 20 is met for chats and not for nodes.
5. **"Work on it" after the worktree was deleted by hand fails for good**, because the worktree is
   locked; and a plain directory at that path is taken for the worktree.
6. Smaller: link ids are not validated (a 500); "Work on it" accepts an item in `done` while
   "Orchestrate" refuses it; a link write that throws leaves a chat running unlinked; start options
   are copied without type checks; search folds case for ASCII only, so `sesión` does not find
   `SESIÓN`; reordering acceptance criteria emits no event; appending to a column grows ranks fast
   enough to respread the column every 117 creates; an actor of unknown kind is read back as the
   person; `comments()` answers an empty list for a missing item; a failed `ROLLBACK` hides the
   original error.
7. Contract: make `Project.key` and `Project.modules` required; decide `WorkItemSource.kind` and
   `WorkItemLinkRole` for documents and for the flow before the web is built on exhaustive switches;
   emit `project.updated` on a re-import that changes modules.

## Design system and plan rules broken in the prototypes

1. **Raw colours in the new CSS**: `#fff` on the switch, the checkbox and the radio, which are not
   the gradient, and `hsl()` on the epic mark and the role avatar. They need an `--on-accent` token
   and a hue token.
2. **"Aceptar las 3 que quedan"** on the assistant's proposals accepts in bulk, against decision 36.
3. **Tasks is not in the More sheet** (`MobileMas`) and the standalone `Sidebar` has no Tasks entry,
   though every board screen on the phone leads back there.
4. **Touch targets under 44 px** on the phone: segmented controls (36 and 40 px), the column jump
   (38 px), chips, and three controls that are not controls at all (the flow switch, the checklist
   rows, the row naming the work item in a chat).
5. **Always-visible checkboxes** on the phone's acceptance checklist.
6. **Relations are missing on the phone**: the work item and the new task form have none.

## What the prototypes leave undrawn

On the phone: steps 1 and 4 of the project wizard; selection with "Orchestrate"; the filter sheet;
the Activity and Changes tabs of a work item; the Journal and CLI tabs of Memory; the Team and
Resources proposals of the assistant; the document editor. On both sizes: suggestions while they
run, the assistant on an empty project, and the Tasks view with All projects selected.

## What differs between screens

- The figures: 15 open against columns that add to 14, 38 in total against 27, five roles in the
  wizard against four in `project-templates.ts`.
- Four breadcrumb schemes on the project's tabs, and two page title sizes on the phone.
- Text that carries the meaning is truncated: list titles, the four flow descriptions, "hidden,
  23 documents kept", the live line on a card with a role avatar.
- A hover toolbar covers the message the chat screen is about; the FAB covers rows on two lists.
- Copy outside the glossary: "Seleccionando", "terminado", "espera por ti", "Hacer fork".
- `design-system.md` says 16 illustrations; there are 15.

## What the orchestration itself got wrong

Two tasks, `work-links` and `proto-index`, ended without a final report and with commit subjects
that are not Conventional Commits. The generators of the prototypes were left in `/tmp` and are not
in the repository. The plan's Outcome does not mention the undrawn phone states.

## Related

[[plans/project-ecosystem.md]] · [[design-system.md]] · [[work-items.md]] · [[projects.md]] ·
[[status.md]]
