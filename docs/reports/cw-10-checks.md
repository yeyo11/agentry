---
created_at: 2026-09-29T14:00:00Z
updated_at: 2026-09-29T14:00:00Z
tags:
    - qa
    - security
    - chats
    - report
---
# Checks for CW-10: typecheck, tests and OpenAPI drift

The output QA asked for in [cw-10-qa.md](cw-10-qa.md), which could not run the checks itself. These
were run on branch `task/cw-10` at commit `c6361f75`, in the item's worktree, on 2026-09-29. No code
was changed to get them green.

## `pnpm typecheck`

Exit code 0. All five workspace packages (`shared`, `core`, `api`, `web`, `desktop`) report `Done`
with no errors.

## `pnpm --filter @agentry/api openapi:schemas`

Exit code 0. Afterwards `git status --short` shows no modified tracked file and `git diff --stat` is
empty. The only untracked path was `docs/reports/`. So the committed `schemas.json` already matches
the new `AuditEntry.actor` comment: no drift.

## `pnpm test`

| Package | Tests | Pass | Fail |
|---|---|---|---|
| `packages/shared` | 31 | 31 | 0 |
| `apps/desktop` | 49 | 49 | 0 |
| `packages/core` | 841 | 840 / 839 | 1 / 2 (timing, see below) |
| `apps/api` | 183 | 183 | 0 |
| `apps/web` | 856 | 855 | 1 (timing, see below) |

`pnpm -r` stops at the first failing package, so `apps/api` was also run on its own
(`pnpm --filter @agentry/api test`, exit 0, 183 of 183). Every new chat-token test in
`packages/core/test/chats.test.ts`, `packages/core/test/chat-tokens.test.ts` and
`apps/api/test/security.test.ts` passed in both full runs.

The machine was under heavy load: load average about 60, with another worktree (`task-cw-26`)
running its own core and web suites at the same time. `pgrep` found no test process of this
worktree's still running. The two full runs failed on four tests, each in only one of the runs.
Every one of them passes when run on its own:

| Test | Failure | On its own | Touched by CW-10 |
|---|---|---|---|
| `chat-activity.test.ts` "what a chat is doing goes out at most once per window…" | throttle window | 3 of 3 pass | no |
| `chats.test.ts` "the CLI's list of sessions is read once for everyone asking…" | `3 !== 2` reads after 6 s | pass | no: `claude agents --json`, not `spawnProcess` |
| `tunnel.test.ts` "an address that never answers is not shown…" | 5 s wait timed out | pass | no |
| `apps/web` `highlight.test.ts` "the first block in a grammar shiki compiles…" | 13 s grammar compile | 2 of 2 pass | no |

The session-list test sits in a file CW-10 added tests to, but its failure is a cache that went
stale because the test ran slowly. It never reaches the chat-token code.

## Result

- Typecheck: clean.
- OpenAPI schemas: no drift.
- Every suite passes except four timing-sensitive tests, which failed only under outside load and
  pass on their own. None of them exercises code this change touched.

## Related

[[reports/cw-10-qa.md]] · [[plans/chat-api-token.md]] · [[chat-environment.md]]
