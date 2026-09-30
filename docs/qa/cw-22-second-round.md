---
created_at: 2026-09-29T14:00:00Z
updated_at: 2026-09-29T14:00:00Z
tags:
    - qa
    - report
    - work-items
    - pull-requests
---
# CW-22: QA's second round

Branch `task/cw-22` at `8a958381`. The first round ([[qa/cw-22-verification]]) left two criteria
open because they can only be settled by running things: the axe and motion specs, and the screens
against their references. This round checks what the Developer did about them.

## What could not be run, again

This session could not run `pnpm` either. `pnpm typecheck` was denied directly, and again through a
subagent, in "don't ask" mode. So the two open criteria rest on three things:

- the Developer's recorded run in [[qa/cw-22-checks]]:
  - typecheck 0;
  - shared 31, desktop 49, core 852, api 181 and web 870 tests, all green;
  - under heavy load, one timing test failed per full run, never the same one and never in a changed
    file, and each passed alone;
  - the build ran, and in the e2e specs a11y-*, tasks-*, team-* and motion passed, with
    `tasks-pull-request` passing alone;
- the committed spec `e2e/specs/tasks-pull-request.spec.mjs`, which QA read;
- the code, which QA read.

**Before merging, a person should run `pnpm build && pnpm e2e` once on this branch.** The e2e runner
picks up every `*.spec.mjs` in `e2e/specs/`, so the new spec runs with the rest.

## What reading confirmed this round

- The spec seeds every PR phase into `work_item_pull_requests` and asserts the following in dark
  and in light:
  - passing CI is `badge-ok`;
  - pending CI has no status class, no `is-live`, no animation and no spinner;
  - failing CI is `badge-bad`, with a word;
  - a conflict is warn and names its base and file count;
  - a PR that failed to open is `is-fail` and offers the approval again;
  - a project that is not ready keeps "Move to Done" and says why;
  - the PR number has tabular figures;
  - the strip link opens in a new tab;
  - axe finds nothing on the board or on the item.

  On a phone (390 × 844) it asserts a 44 px PR row, no sideways scroll, and axe clean.
- The code agrees with the spec:
  - `CiBadge` gives passing `ok`, failing `bad`, and pending and none no tone, each with an icon
    and a word.
  - The new CSS in `board.css`, `work-item.css` and `documents.css` uses tokens only. It has no hex,
    `rgb()`, pixel radius or millisecond value, and no animation, so `motion.spec.mjs` has nothing new
    to stop.
  - The phone strip link is `var(--touch)`, and `.is-phone .item-pr` has `min-height: var(--touch)`.
- `docs/design-system.md` gains rows for the strip's PR states, the checkout line and the item's PR
  row. `agentry-ds.css` gains `.wi-strip.warn`, `.pr-num`, `.pr-link`, `.no-pr`, `.pr-ci`,
  `.wi-checkout` and `.pr-row`.
- The first round's minor notes are fixed:
  - `WorkItemWaitReason` now describes `merge`.
  - `FlowRunCause` documents `conflict-unresolved`.
  - The API tests now cover a conflicting approval, a PR closed unmerged and a busy item.

## Not verified by QA's own eyes

The comparison with DesktopTableroEquipo, MobileTablero, DesktopTarea and MobileTarea is the
Developer's, from the spec's `E2E_SHOTS` screenshots. Those screenshots are not in the repository,
so QA could not look at them.

## Related

- [[qa/cw-22-verification]]
- [[qa/cw-22-checks]]
- [[plans/work-item-pull-requests]]
- [[design-system]]
