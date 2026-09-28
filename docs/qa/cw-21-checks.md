---
created_at: 2026-09-28T23:30:00Z
updated_at: 2026-09-29T00:30:00Z
tags:
    - qa
    - report
    - flow
    - documents
---
# CW-21: the project's checks on its branch

QA's sessions for CW-21 could not run `pnpm` (every Bash `pnpm` call was denied), so the one
criterion left open was "`pnpm typecheck` and `pnpm test` pass". This records the Developer's run of
both on the branch, for QA to check against the commit.

## What was run

- Branch `task/cw-21`, at commit `3f72f116` ("fix(core): name a failed document sync as such when a
  flow run cannot start"), with a clean tree apart from QA's untracked report.
- Node v22.21.1, pnpm 10.17.1, dependencies from `pnpm install --frozen-lockfile`.
- From the worktree's root: `pnpm typecheck`, then `pnpm test`.

## Result

`pnpm typecheck` exited 0: shared, core, api, web and desktop all type-check.

`pnpm test` exited 0:

| Package           | Tests | Pass | Fail |
| ----------------- | ----: | ---: | ---: |
| `@agentry/shared` |    31 |   31 |    0 |
| `@agentry/desktop`|    42 |   42 |    0 |
| `@agentry/core`   |   822 |  822 |    0 |
| `@agentry/web`    |   849 |  849 |    0 |
| `@agentry/api`    |   166 |  166 |    0 |

No `not ok` line in the output. The core count includes the 9 tests in
`packages/core/test/item-documents.test.ts` and the 3 CW-21 tests in
`packages/core/test/flow-cli.test.ts` (QA bounce, restart, failed sync).

### Run again at `51015143`

The item came back to In progress with no code to change, so both checks ran again at `51015143`,
which differs from `3f72f116` only by this file. `pnpm typecheck` exited 0.

The first `pnpm test` there failed two `apps/web` tests, both on shiki's highlighting:
- `highlight.test.ts`, "the first block in a grammar shiki compiles on the spot is still coloured";
- `parity.test.ts`, "every language keeps shiki's colours over the frozen corpus".

The branch changes nothing under `apps/`, and both tests passed in the runs before and after:
- `pnpm --filter @agentry/web test` alone: 849/849;
- `pnpm --filter @agentry/api test`, which the failed run never reached: 166/166;
- the whole `pnpm test` again: exit 0, with the same counts as the table above and no `not ok`.

They look sensitive to load, since shiki compiles a grammar on first use, and are worth their own
item if they fail again on `main`.

`pnpm build && pnpm e2e` were not run: the change is core-only and touches nothing a browser spec
covers.

## To reproduce

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

## Related

[[team-and-flow.md]] · [[qa/cw-21-verification.md]]
