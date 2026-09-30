---
created_at: 2026-09-29T12:50:00Z
updated_at: 2026-09-29T12:50:00Z
tags:
    - qa
    - report
    - pull-request
    - work-items
    - design-system
---
# CW-22: the project's checks on its branch, and the screens against their references

QA's session for CW-22 could not run `pnpm` (every Bash `pnpm` call was denied), so two criteria
stayed open: the axe and motion specs green with the PR states in dark, light and on a phone, and
the card and item matched against DesktopTableroEquipo, MobileTablero, DesktopTarea and MobileTarea.
This records the Developer's run of the checks and the visual comparison, for QA to check against
the commits.

## What was run

- Branch `task/cw-22`. Checks at `245b837a` ("test(api): cover a conflicting approval, a PR closed
  unmerged and a busy item"). The new e2e spec `e2e/specs/tasks-pull-request.spec.mjs` is committed
  after that, with this record; it changes no product code.
- Node v22.21.1, pnpm 10.17.1, dependencies from `pnpm install --frozen-lockfile`.
- The machine was under heavy load throughout (load average 24–34 on 12 cores, from other
  sessions), which matters for the timing tests below.

## Typecheck and tests

`pnpm typecheck` exited 0: shared, core, api, web and desktop all type-check.

`pnpm test` was run twice in full, and each package once more on its own:

| Package            | Tests | Pass | Fail | Notes |
| ------------------ | ----: | ---: | ---: | ----- |
| `@agentry/shared`  |    31 |   31 |    0 | |
| `@agentry/desktop` |    49 |   49 |    0 | |
| `@agentry/core`    |   852 |  852 |    0 | see below |
| `@agentry/api`     |   181 |  181 |    0 | 7 in `work-item-pull-requests.test.ts` |
| `@agentry/web`     |   870 |  870 |    0 | see below |

Under that load each full run had one timing test fail, never the same one, and none in a file this
branch changes:

- `chats.test.ts`, "the CLI's list of sessions is read once for everyone asking at the same time"
  (an extra read, 3 for 2): passes alone 3 of 3, and the whole file 3 of 3.
- `stuck-signals.test.ts`, "a command that ends well is recorded with how long it took" ("took
  882 ms"): passes alone.
- web `highlight.test.ts`, "the first block in a grammar shiki compiles on the spot is still
  coloured": passes alone, and in the web suite's own run (870 of 870).

To tell load from this change, the full core suite ran side by side on the branch and on the base
commit `c34d3cfc`, in a throwaway worktree, under the same load. The branch passed 852 of 852. The
base failed one, a timing test of its own (`candidates are the busiest directories not imported…`).

## e2e

`pnpm build` exited 0. Then, on port 8931 with `E2E_SHARDS=1`:

```
✓ a11y-core.spec.mjs
✓ a11y-projects.spec.mjs
✓ a11y-shell.spec.mjs
✓ a11y-team.spec.mjs
✓ tasks-board.spec.mjs
✓ tasks-item-runs.spec.mjs
✓ team-gaps.spec.mjs
✓ team-review.spec.mjs
✓ team.spec.mjs
✓ motion.spec.mjs
✓ tasks-item.spec.mjs
✓ tasks-pull-request.spec.mjs   (run alone after two fixes to the spec itself)
```

The first runs of `tasks-pull-request.spec.mjs` failed on the spec's own mistakes: it set
`localStorage` before the app's first page, and it looked for the PR row on a phone without opening
the Changes section, where the phone keeps it. With both fixed it passes. It seeds every state the
watcher can leave (open with CI passing, pending and failing; conflict; closed; failed; a card QA
passed in a project that cannot open PRs) and checks the following:

- **On the board, in dark and light:** each state's words and tone:
  - passing is `badge-ok`;
  - pending is neutral, never `live`, with no animation and no spinner;
  - failing is `badge-bad`;
  - the conflict is warn and names `main` and "2 files";
  - a failure to open is `is-fail` and offers the approval again;
  - the not-ready project keeps "Move to Done" and says why.

  The PR number has tabular figures, and the strip links to GitHub in a new tab. axe finds nothing.
- **On the item, in dark and light:** the PR row under Changes is an external link
  (`target="_blank" rel="noreferrer"`) naming the branch and base. The conflict panel lists both
  paths. axe finds nothing on either page.
- **On a phone (390 × 844):** the PR row is 44 px tall, and the page does not scroll sideways. axe
  finds nothing on the item or on the board.

## The screens against their references

The four references were rendered from `docs/design-system/reference/` in the same headless Chrome
(served over HTTP; they render blank from `file://`), and compared with the spec's screenshots
(`E2E_SHOTS`):

- **Card, against DesktopTableroEquipo:** the PR states sit in the card's foot strip, as the
  reference's "Te espera · QA la dio por buena". They use the idle tint for "waiting for merge", a
  mono uppercase badge for the CI state, and the warn colour and icon for a conflict. The strip is
  the same size and place in both themes, and the column and card chrome is unchanged.
- **Card, against MobileTablero:** the phone's single-column board shows the same strips inside the
  cards, above the tab bar and the FAB.
- **Item, against DesktopTarea:** the head, the badges ("Waits for you"), "Move to Done", "Work on
  it" and the side panel are as in the reference. The PR panel takes the waiting panel's place above
  the title, and the PR row is a card under "Changes in its worktree".
- **Item, against MobileTarea:** the head, the chips, the Detail / Activity / Changes segments and
  the bottom bar are as in the reference. The PR panel leads Detail, "Open PR #N on GitHub" is a
  full-width row, and the PR row is in Changes.

No gradient was added. The one colour on each state is its status colour, with its word.

The seeded items have no branch of their own, so their Changes say "Nothing has worked on it in a
worktree yet" above the PR row. A real item with a PR always has its branch, and shows its commits
there.

## Related

[[qa/cw-22-verification.md]] · [[plans/work-item-pull-requests.md]] · [[work-items.md]] · [[design-system.md]] · [[qa/cw-21-checks.md]]
