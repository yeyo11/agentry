---
created_at: 2026-09-29T12:00:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - qa
    - report
    - work-items
    - pull-requests
---
# CW-22: QA's verification of approving into a pull request

Branch `task/cw-22`, commits `c34d3cfc..334a2b8f` (spec, core, tests, docs, web). The tree was clean.

## What could not be run

This QA session could not run a single `pnpm` command. Every Bash call to `pnpm typecheck`, `pnpm test`,
`pnpm build`/`pnpm e2e` and even a `python3` script was denied ("don't ask mode"), the same way CW-21's QA session was
([cw-21-checks.md](cw-21-checks.md)). So the verdict below comes from reading the diff and the tests, not from
running them. Two criteria can only be settled by running things, so they stay open:

- **79b7…**: "the axe and motion specs stay green", dark/light and phone. This needs `pnpm build && pnpm e2e`
  (at least `axe` and `motion.spec.mjs`).
- **c244…**: "the card matches DesktopTableroEquipo/MobileTablero and the item matches DesktopTarea/MobileTarea".
  This needs the running UI in both themes, compared against `docs/design-system/reference/`.

To close them, run `pnpm typecheck`, `pnpm test` and `pnpm build && pnpm e2e` on `334a2b8f` and record the output,
as was done for CW-21, then look at the board and item screens in both themes on desktop and phone.

## What reading found

- **Core** (`packages/core/src/pull-requests.ts`):
  - Readiness has all six reasons and a 60 s cache.
  - `approve` refuses with 400 for an epic and 409 with the codes `not-in-review`, `busy` and
    `nothing-to-propose`, plus the readiness reason. It answers 200 for an open or preparing PR, and the check is
    repeated under `BEGIN IMMEDIATE`.
  - `prepare` runs commit → fetch → merge → push → `gh pr create --body-file -` → `gh pr view`.
  - A conflict leaves the merge in progress and moves the item as person with `pr.conflict` and the paths in
    history.
  - `settleConflict` returns the paths still conflicted, or commits the merge. `verified` resumes the approval
    unless a person moved the item: both `personMovedSince` and `observe` leave out `pr.*` causes.
  - The watcher has the 60 s interval, the start tick, the refresh, a 5 min back-off per project, the
    `ciOf` mapping, and emits only on change.
  - A merge is guarded on phase `open`, moves the item to Done from any column, removes only a clean
    worktree (with unlock), keeps the branch, and fast-forwards only on the default branch with no tracked
    changes.
  - `checkout()` reports `not-on-default`, `dirty` or `diverged`.
- **Flow**:
  - The conflict section in the work prompt lists every path and says "Do not push".
  - `unresolved()` returns the `conflict-unresolved` cause.
  - `DENIED_TOOLS` is unchanged. Tests check that every stage variant, and the conflict run's launch, deny both
    `Bash(git push)` and `Bash(git push *)`.
- **One rule**: only the `git` and `gh` CLIs are used. There is no SDK and no Anthropic HTTP call.
- **Contract**:
  - `WorkItemPullRequest`, `WorkItemWaitReason` `merge`, `FlowRunCause` `conflict-unresolved`,
    `WORK_ITEM_PR_CAUSE` and `BoardCheckout` are all in shared.
  - The `work_item_pull_requests` migration is there, and `schemas.json` is regenerated.
  - Both routes are in `routes.ts` with the Work items tag, and both have a README row.
- **Web**:
  - The strip has the states `pr-preparing` (neutral, still), `pr-conflict` (warn), `pr-awaiting`,
    `pr-open` (idle, mono tabular number, CI badge with a word, external link at 44 px on a phone),
    `pr-closed` and `pr-failed`, each with an icon and a word.
  - "Aprobar y abrir PR" shows only when the project is ready. Otherwise the warn `NotReadyNote` sits above
    "Aprobar y pasar a Hecho".
  - The item page has `PullRequestState`, with "Abrir PR" for any `in_review` item. Changes ends with the PR row.
  - The board shows the warn checkout line with no command.
  - CSS uses tokens only.
  - The `en`/`es` diffs match line for line: 60, 54 and 7 each.
- **Docs**:
  - `work-items.md` drops the old sentence and covers readiness, approving, conflicts, the watcher as "the one
    deliberate poll", merged, closed, the checkout line and storage.
  - `team-and-flow.md` covers the PR the approval opens, the remembered approval, `conflict-unresolved` and
    that runs stay denied `git push`.
  - `design-system.md` and `agentry-ds.css` gain the PR strip, CI badge, checkout and PR row variants.

## Minor notes (not blocking)

- The TSDoc of `WorkItemWaitReason` in `packages/shared/src/types.ts` still reads "Either ends when a person
  moves it" and does not describe `merge`. The Failed list of `FlowRunCause` does not name
  `conflict-unresolved`. Both descriptions flow into `schemas.json`, so the OpenAPI text misses the new values.
- The API tests cover approve, the 200 repeat, merged via refresh, and the 400/409/404 refusals. Conflict,
  closed and `busy` are covered only in core.
- The "merge handled once" test runs two `PullRequestService`s on one `Db` connection, not two processes. The
  guard is SQL-level (`UPDATE … WHERE phase IN ('open')`), so it holds across processes too.

## Related

- [[plans/work-item-pull-requests]]
- [[work-items]]
- [[team-and-flow]]
- [[qa/cw-21-checks]]
