---
created_at: 2026-09-30T14:00:00Z
updated_at: 2026-09-30T14:00:00Z
tags:
    - report
    - verification
    - e2e
---
# Checks run on CW-14

The QA sessions for CW-14 could not run commands, so this records the checks the developer ran on
the branch `task/cw-14` at `6456f369`, on 2026-09-30, each under its own `timeout`. The code under
test is unchanged since: the commit that adds this report changes no code.

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm --filter @agentry/shared test` | 31 pass, 0 fail |
| `pnpm --filter @agentry/desktop test` | 49 pass, 0 fail |
| `pnpm --filter @agentry/core test` | 839 pass, 0 fail |
| `pnpm --filter @agentry/web test` | 857 pass, 0 fail |
| `pnpm --filter @agentry/api test` | 174 pass, 0 fail |
| `pnpm --filter @agentry/api openapi:schemas`, then `git diff apps/api/src/openapi/schemas.json` | exit 0, no drift |
| `pnpm build`, then `node --test e2e/harness.test.mjs e2e/shards.test.mjs` | 27 pass, 0 fail |

## A test that flaked

In the first `pnpm test` of that run, one core test failed:
`the CLI's list of sessions is read once for everyone asking at the same time, and again once
invalidated` (`packages/core/test/chats.test.ts`), which counted 3 reads where it expected 2.
Because `pnpm -r` stops at the first package that fails, web and api did not run in that pass.

- The branch does not touch `chats.ts` or its test.
- The test passed three times out of three on its own, and the whole core suite then passed
  (839/839).
- The machine was at a load average of about 26–47 on 12 cores at the time, so a cached read most
  likely went stale between two calls.

It is recorded here as a timing flake under load, not as a regression of this branch.

## What these checks do not settle

- **The 40 % wall-time check** (`pnpm e2e` with the default shard count against
  `E2E_SHARDS=1 pnpm e2e`). It needs an idle machine. On 2026-09-30 two local embedding servers
  kept the load average above 25 all day. An attempt under that load is described in
  [plans/verify-faster.md](../plans/verify-faster.md).
- **The 25 / 40 minute targets** after a graph's last task. These are measured on graphs that run
  after the merge, and the results go into the Outcome section of
  [plans/orchestration-speed.md](../plans/orchestration-speed.md).
- **Three §1 criteria written before #128**: the gitignored `e2e/.timings.json` merged after each
  run, and `E2E_PORT` ignored when there is more than one shard. The scope trim says not to rebuild
  the sharding, so the product owner has to amend these criteria to match what #128 shipped. The
  table in [plans/verify-faster.md](../plans/verify-faster.md) proposes the amended wording.

## Related

[[plans/verify-faster.md]] · [[plans/orchestration-speed.md]] · [[reports/cw-14-qa.md]]
