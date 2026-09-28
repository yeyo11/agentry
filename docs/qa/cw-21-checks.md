---
created_at: 2026-09-28T23:30:00Z
updated_at: 2026-09-28T23:30:00Z
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
