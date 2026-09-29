---
created_at: 2026-09-29T18:00:00Z
updated_at: 2026-09-29T18:00:00Z
tags:
    - orchestration
    - verification
    - performance
    - api
    - web
    - feature
---
# Where an orchestration's time goes

Built by CW-13 (workstream A of [plans/orchestration-speed.md](plans/orchestration-speed.md), spec in
[plans/orchestration-timings.md](plans/orchestration-timings.md)). Agentry records when each phase
of a graph ran, links every chat it starts for a graph with its role, and answers
`GET /orchestrations/:id/timings` from what that leaves. It changes no scheduling, retry or
verification behaviour: it measures the workstreams that do.

## What is recorded

Everything comes from what Agentry already records about the CLI runs it starts. Every field is
optional, so a graph stored before it still loads, and nothing is backfilled.

| Where | Field | Set by |
|---|---|---|
| `OrchestrationIntegration` | `startedAt`, `endedAt` | `integrate()`; a re-integration overwrites both, so the phase is the last integration |
| `VerificationState` | `startedAt`, `endedAt` | `checkBranch()`; the "not run" branch sets both to one instant |
| `VerificationState` | `fixes[]` | `fix()`, one per fixer attempt: its chat (`runId`, null if it could not start), the command, the attempt, start, end and cost |
| `VerificationCommand` | `runs[]` | `checkAll()`, one per execution: `pass`, `startedAt`, `durationMs`, `passed`/`failed`, `timedOut`, `cancelled`. `durationMs` still means the last run |
| `Orchestration` | `synthesisStartedAt`, `synthesisEndedAt` | `synthesize()`, the failure path included |

A wrapper restart closes a phase it cut off at the moment it came back, so no figure counts up for
ever.

## Chats linked with a role

`ChatService.chatOrchestrations()` reads the chat records: every chat Agentry starts for a graph has
`orchestrationId` and `orchestrationTaskId`. The pseudo-ids map to roles
(`__integration__` → `integration`, `__verification__` → `verification`, `__synthesis__` →
`synthesis`, `__workflow__` → `workflow`, anything else → `task`), and `ChatOrchestration.role`
carries it. Every chat of a task is linked, including the one a clean retry replaced. So the
integrator and the fixer are no longer unlinked in the chat list, and `GET /usage` counts their cost
in the orchestration's row. Only the synthesis is a deliverable; the other roles are workers. The
chat list and the chat's `.chat-part-of` row word the role instead of taking any chat without a
task for the synthesis.

## The definitions

Computed in `packages/core/src/orchestration-timings.ts` on every read; nothing is stored and
nothing is cached. What is still running counts up to `at`.

- **Tasks phase**: from the earliest first execution of any task to the latest task end. Open
  while any task is pending, running, interrupted or blocked, or the graph waits for a decision.
- **A task's executions**: every execution of every chat whose record has the graph's id and the
  task's id, in start order. **Work** is the sum of their durations. A task with no chat left falls
  back to its own `startedAt`/`endedAt`.
- **Slot wait**: from when the task was ready (the latest end of its dependencies, or the graph's
  creation) to its first execution, when that is over a second. A ready task of a running graph
  that has not started is still waiting.
- **Limit wait**: from the end of an execution whose error is the account's limit
  (`isRateLimitError` in `chats.ts`, the classification behind a result's `cause: 'rate-limit'`) to
  the task's next execution, or to now or the graph's end if none followed.
- **Retry wait**: the same gap after any other failed or interrupted execution. A task that
  completed after all has no trailing wait.
- **Critical path**: from the task that ended last (or, running, the one still going), step to the
  dependency that ended last, until a task has none. `waitBeforeMs` is the gap from the previous
  link's end (or the graph's creation) to this link's first start; its length runs from the first
  link's start to the last link's end.
- **afterTasksMs**: from the tasks phase's end to the graph's end (or now). **parallelism**: the
  sum of every task's work over the tasks phase, so time spent waiting on a limit lowers it.
- **Integration, verification and synthesis**: the recorded fields. A graph stored before them
  falls back to the executions of its role's chats, or leaves the phase out and names the field in
  `missing`. An older graph's fixer attempts are read from its fixer chats the same way.
- **checksMs**: every run of every command. **fixerMs**: every fix. **passes**: the highest pass.

## The script

`node scripts/orchestration-timings.mjs [id|name…] [--min-tasks N] [--json]` prints the plan's
tables in Markdown against `AGENTRY_API_URL` (it exits when that is unset, without guessing a port,
and sends `AGENTRY_API_TOKEN` as a Bearer token when it is set). It needs no dependencies. The
breakdown inside the workers reads every task chat's transcript through
`GET /chats/:id/export?format=json`; the command patterns are a table at the top of the script, so
another repository can adapt them. An older graph's "Agentry running checks" is marked `~`: it is
what the other phases leave of the time after the tasks, since only each check's last run was kept.

## The panel

`TimingsPanel` closes the orchestration page: "Where the time went" / "En qué se fue el tiempo". It
is read when the page opens and again when the graph moves to another phase (the query key carries
the graph's, the integration's and the checks' status), never polled. Design rules are in
[design-system.md](design-system.md) under `.orch-timings`.

## Related

[[plans/orchestration-timings.md]] · [[plans/orchestration-speed.md]] · [[decisions/orchestration-timings-on-read.md]] · [[design-system.md]]
