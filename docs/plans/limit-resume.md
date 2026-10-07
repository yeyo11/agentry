---
created_at: 2026-09-28T18:00:00Z
updated_at: 2026-10-07T12:00:00Z
tags:
    - plan
    - spec
    - orchestration
    - accounts
    - rate-limit
    - performance
    - superseded
---
# Spec: a worker that hits its limit carries on (CW-4)

Workstream B (`limit-resume`) of [plans/orchestration-speed.md](orchestration-speed.md), story CW-4
of the epic CW-11 "Faster orchestrations". Status: **superseded (2026-10-07) by phase 4 of
[multi-provider.md](multi-provider.md#phase-4-rotation-between-providers)**, merged in #188. Not built
as written here; see [What replaced it](#what-replaced-it).

## What replaced it

Phase 4 (rotation between providers) solved the same problem in a wider form, and its code is on
`main`:

- A worker that hits its usage limit is not failed and spends no attempt: `settle()` in
  `packages/core/src/orchestrator.ts` hands a `rate-limit` result to the rotation when
  `limitHeld(task.runId)` is true.
- The rotation either waits for the reset in the same chat (the replayed turn is picked up by
  `waitEnded`), or moves the task to a new chat on another account or provider; the move is kept on
  the task as `task.chain`, and the task's cost sums every chat of the chain.
- The board shows the waiting task and the chain, as drawn in `DesktopOrquestacion.html`.

So the owner's answer to open question 2 (wait and resume by itself) is what runs today. The
`limited` status, `exhaustedUntil` and the 15 min fallback below were never built; the rest of this
spec is kept for the record.

## Why

`tunnel:web`, `ecosystem-board-web:web-foundation` and `web-projects` died with *"You've hit your
session limit"*. Two of them show as 110 min tasks of which about 20 min was work: the rest was the
task sitting failed until a person retried it after the reset. Two things cause it today:

1. `rotateAndResume` (`packages/core/src/index.ts`, ~line 666) rotates the account for a worker, but
   on purpose does not replay its turn (`run.orchestrationId` → "the next tasks use it").
2. `settle()` (`packages/core/src/orchestrator.ts`, ~line 1015) does not retry a failure that has a
   `cause`, so a result with `cause: 'rate-limit'` is recorded as `failed`.

The flow already solved the first half for its runs: while a rotation is on its way it holds the run
(`FlowService.awaitsRotation`, `flow.rotated`) and the turn is replayed in the same chat on the next
account ([team-and-flow.md](../team-and-flow.md), "A run that hits a rate limit waits for the account
rotation"). This story gives orchestration workers the same, and adds what nobody has yet: waiting
for the reset when no account has quota.

## The one rule

Everything comes from the CLI: the `rate_limit_event` stream-json event (`status: 'rejected'`,
`resetsAt` in epoch seconds), the 429 / "session limit" result or stderr line (`RATE_LIMIT_RE`), and
`claude-swap`'s account list. The resume is `claude --resume` in the same session. No SDK, no HTTP.

## Behaviour

### Path 1: rotation found another account

- While a rotation is coming for a worker's chat (`ChatManager.rotationComing(id)` or the id is in
  `rotations`), `settle()` does **not** record the rate-limited result. The task stays `running`.
  Mirror the flow: an `Orchestrator.awaitsRotation(chatId)` / `Orchestrator.rotated(chatId, outcome)`
  pair, called from `rotateAndResume`'s `finally` next to `this.flow.rotated(...)`.
- `rotateAndResume` no longer returns early for `run.orchestrationId`. When `result.switched`, the
  worker's chat goes on **in the same chat (same session id, same worktree)** on the new account. It
  is told a limit continuation (below), not the original objective. The transcript notice reads
  "Rate limit reached — switched to X and resuming."
- It does **not** spend an attempt: `task.attempts` is unchanged, `task.startedAt` is kept, and the
  task clock (`clockStartedAt`) is not restarted. Whatever the helper is called, it must not go
  through the `task.attempts += 1` of `continueChat`. It keeps the chat's `rotationRetries` bound
  (`MAX_ROTATION_RETRIES`) so a pool that keeps rejecting cannot loop.
- The cost the limited execution had is charged (`charge()`), as a retry does. The cost limit still
  applies to the resumed execution (`remainingUsd`).

Limit continuation prompt (English, in `orchestrator.ts` beside `continuation()`):

> Your previous turn was cut off by the account's usage limit, not by an error of yours. Everything
> you did is still in place, in the same working directory. Carry on from where you stopped instead
> of starting over. Finish with a concise report of what you did and found; it is handed to the next
> workers.

### Path 2: no account has quota

This applies when rotation found no account (`!result.switched`), and also when rotation cannot run
at all (`autoSwitch.rotateOnLimit` off, or accounts not managed by `claude-swap`). A single-account
user hits the limit too, and waiting for the reset is the only thing that helps them.

- The task goes to a new status **`limited`**. It is not `failed`, not `interrupted` and not
  `blocked`. Its new field `limit` holds:
  - `reason`: the notice text, e.g. "no account with quota left (no viable target)";
  - `resetsAt`: an ISO time, or `null` when nothing said when;
  - `since`: when the task started waiting. Workstream A's timings read it as time spent waiting on a
    limit.
- `resetsAt` comes, in this order, from:
  1. the `resetsAt` of the chat's rejected `rate_limit_event`. Today `chats.ts` only keeps it on the
     manager-wide `lastRateLimit`, so it must be kept **per chat** and handed over with the result
     or the rotation outcome;
  2. the earliest `resetsAt` of an exhausted window among the pool's accounts (`claude-swap list`);
  3. otherwise `null`. Agentry then tries again after a fallback of 15 min, and the board says
     "reset time unknown".
- Agentry resumes the task by itself at `resetsAt` + 60 s of grace, with the same limit continuation
  and **without spending an attempt**. If that execution is rejected again, the task goes back to
  `limited` with the new reset. Only a real error counts as an attempt.
- The timer survives a restart. `limit` is persisted with the orchestration. On recovery, a `limited`
  task re-arms its timer, or resumes at once if the time has passed. It is never turned into
  `interrupted` or `failed` by the restart sweep in `schedule()`.
- A person can **stop** a limited task (it becomes `stopped`, as today). They can also **retry** it,
  which resumes it now, for example after adding an account.
- The orchestration's own status stays `running` while a task is `limited`. `waiting` keeps its
  meaning, "a task failed for good and a person must decide", and integration and synthesis simply
  do not start until the limited task completes.

### No new task on an exhausted pool

- The orchestrator keeps one pool-wide `exhaustedUntil` (ISO or null), shared by **every**
  orchestration. It is set whenever a task goes `limited`, to that task's reset (or the fallback).
- While it is set and in the future, `schedule()` starts no `pending` task of any orchestration. A
  pending task stays `pending`, with no failure and no attempt spent. `limited` tasks resume on their
  own timers. The earliest one to resume clears the hold for the others once its execution gets past
  the limit.
- The hold is cleared early by an `account.switched` event (a person or a policy moved to an account
  with quota), then `schedule()` runs for every running orchestration.
- Out of scope: holding the integrator, fixer and synthesis chats. They only start after every task
  has completed, so a limited task already holds them.

### The board

`apps/web/src/components/OrchestrationBoard.tsx` (the `STATUS` map ~line 62, the status label ~line
78, the box text ~line 548), `Orchestration.tsx`/`OrchestrationDetail.tsx`, and the other places that
switch on `OrchestrationTaskStatus`. Today these are `lib/shell-live.ts`,
`pages/dashboard/model.ts`, `pages/dashboard/widgets/live.tsx`, `pages/tasks/board/LiveLine.tsx`,
`apps/desktop/src/live.ts`, and in core `event-sources.ts`, `chat-model.ts`, `chat-records.ts` and
`work-items.ts`. `tsc` finds any that are missed.

- A `limited` task reads with the **warn** tone and an icon (a clock or an hourglass from the icon set
  already in use), a word, and the reset time: en "Waiting for the limit · resumes at 14:32", es
  "Esperando al límite · se reanuda a las 14:32". When the reset is unknown, en "Waiting for the limit ·
  reset time unknown", es "Esperando al límite · hora de reinicio desconocida". The time is Geist Mono,
  tabular. It uses the date formatter in use (`formatDateTime`/`timeUntil`), and the day is added when
  the reset is not today.
- It is never shown in `bad` colour and never with the word failed. It does not move: there is no
  spinner, live rail or energy border, because nothing is working.
- In the segmented stage bar a limited task counts as **not done** (it is not in `DONE`).
- The task's actions offer Stop and Retry now.
- Reference screen: `docs/design-system/reference/DesktopOrquestacion.html` and its dark and light
  screenshots.

## Files and contract

- `packages/shared/src/types.ts`: `OrchestrationTaskStatus` gains `'limited'`.
  `OrchestrationTaskState` gains `limit?: { reason: string; resetsAt: string | null; since: string } | null`.
  Then regenerate `apps/api/src/openapi/schemas.json` (`pnpm --filter @agentry/api openapi:schemas`).
  No new route, so no change to `routes.ts` or the README's REST tables.
- `packages/core/src/chats.ts`: keep the rejected event's `resetsAt` per chat, and expose it (on
  `RunResult`, e.g. `rateLimitResetsAt?: string`, or through the rotation outcome).
- `packages/core/src/index.ts`: `rotateAndResume` handles workers (path 1), and tells the
  orchestrator its outcome with the reset time (path 2). When rotation is disabled or unmanaged it
  still tells the orchestrator, so path 2 applies.
- `packages/core/src/orchestrator.ts`: `awaitsRotation` / `rotated`, `settle()` holding a
  rate-limited result, the `limited` status with its timer and recovery, `exhaustedUntil` in
  `schedule()`, the limit continuation, and retry and stop on a limited task.
- `apps/web/src/i18n/locales/{en,es}/orchestration.json`: the new status strings, with en/es parity,
  following `GLOSSARY.md`.
- Docs: a paragraph in [team-and-flow.md](../team-and-flow.md) or [orchestrations.md](../orchestrations.md)
  on how a worker rides a limit, and the plan's workstream B marked built.

## Tests (fake CLI, `packages/core/test/`)

Reuse the `fakeCswap` pattern of `account-config.test.ts`, where a chat run on a "limited" account
dies with "You've hit your session limit", and a fake `claude` that emits a rejected
`rate_limit_event` with a known `resetsAt`.

1. **Rotation path**: a two-task graph, where the first account is limited and `switch` returns
   `{ switched: true, to: 2 }`. The worker's chat is resumed in the same chat id with `--resume`, the
   limit continuation is the prompt, the task completes, and `attempts` is still 1.
2. **No-account path**: `switch` returns `{ switched: false }`. The task is `limited`, with
   `limit.resetsAt` equal to the event's `resetsAt`, and never `failed`. A second pending task with
   no dependency does **not** start while it waits. With the clock faked or `resetsAt` a few seconds
   ahead, the task resumes by itself without an attempt, completes, and the pending task then starts.
3. Recovery: a persisted `limited` task whose `resetsAt` has passed resumes on start and is not
   swept into `failed`.

## The owner's decision

Open question 2 of the plan: with no account left, should the graph **wait for the reset** and resume
by itself, **stop for a decision**, or **wait up to a limit** (e.g. 30 min) and then stop?

This spec is written for **wait for the reset** because that is what the story asks. One case is
worth the owner's thought: a **weekly** limit can put `resetsAt` days away. The Product Owner's
recommendation is to wait for the reset when it is within 6 h. Beyond that the task becomes `failed`
with the reason "the account limit resets on <date>", so a person decides and nothing waits silently
for days. The answer, whichever it is, goes into the plan's Open questions as "Answered on <date>:
…", and changes only the rule that turns a limited result into `limited` or `failed`.

The developer does not start until that line is in the plan.

## Not in scope

- A flow run with no account left. It still fails and says why on the item, as
  [team-and-flow.md](../team-and-flow.md) describes. The flow's rotation path is already built.
- The launch-form warning about two big graphs sharing quota (open question 3, a separate item).
- Holding non-orchestration chats on an exhausted pool.

## Related

[[plans/orchestration-speed.md]] · [[team-and-flow.md]] · [[pinned-chat-rotation.md]] · [[plans/orchestration-timings.md]] · [[design-system.md]]
