---
created_at: 2026-09-28T18:00:00Z
updated_at: 2026-09-28T18:00:00Z
tags:
    - plan
    - spec
    - orchestration
    - verification
    - performance
    - api
    - web
    - proposed
---
# Spec: record where an orchestration's time goes (CW-13)

Workstream A (`timings`) of [plans/orchestration-speed.md](orchestration-speed.md), story CW-13 of
the epic CW-11 "Faster orchestrations". Status: **refined, not built**. It is the `timings-core` and
`timings-web` nodes of the plan's graph: `timings-core` owns `types.ts` and the OpenAPI schemas.

## Why

The plan's tables had to be rebuilt by hand, from chats matched by title, because:

- `OrchestrationIntegration`, `VerificationState` and the synthesis carry no time at all. Only the
  graph's `endedAt` and each task's `startedAt`/`endedAt` do.
- `VerificationCommand.durationMs` is overwritten on every pass (`checkAll` in
  `packages/core/src/orchestrator.ts`, `entry.durationMs = outcome.durationMs`), so the first failing
  e2e run of 15 min disappears once the re-run after the fixer ends.
- The fixer's run id lives only in `VerificationControl.fixerRunId` and is cleared afterwards, so
  nothing on the graph points at the fixer chats.
- The integrator, fixer and synthesis chats *are* started with `{ orchestrationId, orchestrationTaskId:
  '__integration__' | '__verification__' | '__synthesis__' }` (so their chat record has
  `origin: 'orchestration'`). But `ChatService.chatOrchestrations()` (`packages/core/src/chat-service.ts`)
  only maps task session ids and `synthesisRunId`. The integrator and the fixer therefore get
  `chat.orchestration: null`. The chat list shows them as unlinked, and `usage-report.ts`, which
  buckets by `chat.orchestration`, leaves their cost out of the orchestration's row.

This is measurement only. It changes no scheduling, retry or verification behaviour. Workstreams B–E
change behaviour and are measured with what this one adds.

## The one rule

Everything comes from what Agentry already records about the CLI runs it starts: execution start and
end, outcome and error, and the transcripts the CLI writes (read by the script through the existing
`/chats/:id/export?format=json`). No new call to anything but the CLI.

## 1. Recorded times (`packages/shared/src/types.ts`, `packages/core/src/orchestrator.ts`)

Every new field is optional in the type, so graphs stored before it still load. A graph that lacks
one is reported in `missing` by the route (§3). Nothing is backfilled.

| Where | New field | Set when |
|---|---|---|
| `OrchestrationIntegration` | `startedAt?: string \| null`, `endedAt?: string \| null` | `integrate()` builds the state / after `state.commit` is read or the catch runs. A re-integration (`retryIntegration`, late arrivals, rerun) overwrites both: the phase is the last integration |
| `VerificationState` | `startedAt?: string \| null`, `endedAt?: string \| null` | `checkBranch()` sets `startedAt` with `status: 'running'`, and `endedAt` in its final persist. The "not run" branch sets both to the same instant |
| `VerificationState` | `fixes?: VerificationFix[]` | one entry per fixer attempt in `fix()`: `{ runId: string \| null, command: string, attempt: number, startedAt, endedAt, costUsd }`. `runId` is null when the fixer could not start |
| `VerificationCommand` | `runs?: VerificationRun[]` | one entry appended per execution of that command in `checkAll()`: `{ pass: number, startedAt, durationMs, status: 'passed' \| 'failed', timedOut?: boolean, cancelled?: boolean }`. `pass` is 1 for the first pass over the list and goes up by one each time a fix sends every check back to pending |
| `Orchestration` | `synthesisStartedAt?: string \| null`, `synthesisEndedAt?: string \| null` | around the synthesis run in `synthesize()`, including the failure path |

`VerificationCommand.durationMs` stays, meaning the last run, so current clients keep working.
`runs` is the history. `pendingCommand()` starts it as `[]`. A manual `POST /orchestrations/:id/verify`
starts a fresh `VerificationState` (as today, `orch.verification = null`), so the runs of an earlier
verification are not carried over.

## 2. Chats linked with a role (`ChatOrchestration`)

```ts
export type OrchestrationChatRole = 'task' | 'integration' | 'verification' | 'synthesis' | 'workflow';

export interface ChatOrchestration {
  id: string;
  name: string;
  /** What the chat does for the graph; `task` is the only role with a taskId */
  role: OrchestrationChatRole;
  taskId: string | null;
  taskName: string | null;
}
```

- `chatOrchestrations()` builds the map from the chat records' `orchestrationId` and
  `orchestrationTaskId`, which every chat Agentry starts for a graph already has. The pseudo-ids map
  to roles: `__integration__` → `integration`, `__verification__` → `verification`, `__synthesis__` →
  `synthesis`, `__workflow__` → `workflow`, and any other id → `task`. The current
  task-session and `synthesisRunId` entries stay as a fallback for chats without a record. Every
  task chat of a task is linked, including one replaced by `retry-clean`, and not only the current
  `sessionId`.
- `usage-report.ts` needs no change of its own. Once `chat.orchestration` is set, the integrator's
  and the fixer's cost land in the orchestration's row.
- Web: `Chats.tsx` (the `taskName ?? synthesis` label) and the chat's `.chat-part-of` row word the
  role instead of assuming "no task means synthesis". The row reads "· integration",
  "· verification" or "· synthesis" instead of a stage. New keys go in `en` and `es`.

## 3. `GET /orchestrations/:id/timings`

Computed on read from the stored orchestration and the chat records and executions of its chats.
Nothing new is stored for it, and there is no cache. `404` for an unknown id, `200` for any graph,
running (durations counted up to now) or finished, of either engine. A workflow graph has only the
phases it has.

```ts
export type OrchestrationPhaseName = 'tasks' | 'integration' | 'verification' | 'synthesis';
export type TaskWaitKind = 'slot' | 'limit' | 'retry';

export interface OrchestrationTimings {
  orchestrationId: string;
  /** When the figures were computed; durations of what is still running count up to here */
  at: string;
  createdAt: string;
  endedAt: string | null;
  wallMs: number;
  /** Phases in order; one that did not happen is left out */
  phases: Array<{ phase: OrchestrationPhaseName; startedAt: string; endedAt: string | null; durationMs: number }>;
  /** From the last task's end to the graph's end (or now) */
  afterTasksMs: number;
  /** Sum of every task's working time divided by the tasks phase; the plan's "effective parallelism" */
  parallelism: number | null;
  criticalPath: {
    durationMs: number;
    links: Array<{ taskId: string; taskName: string; startedAt: string; endedAt: string | null; workMs: number; waitBeforeMs: number; waits: TaskWait[] }>;
  };
  waits: { slotMs: number; limitMs: number; retryMs: number; items: TaskWait[] };
  verification: {
    checksMs: number;
    fixerMs: number;
    passes: number;
    commands: Array<{ command: string; install: boolean; totalMs: number; runs: VerificationRun[] }>;
    fixes: VerificationFix[];
  } | null;
  /** Figures an older graph could not give, e.g. "integration.startedAt" or "verification.runs" */
  missing: string[];
}

export interface TaskWait { taskId: string; kind: TaskWaitKind; startedAt: string; endedAt: string | null; durationMs: number; reason: string | null }
```

Definitions, one per figure, so the tests can pin them:

- **tasks phase**: the earliest first-execution start of any task → the latest task `endedAt`.
- **A task's executions**: every execution of every chat whose record has this `orchestrationId` and
  `orchestrationTaskId`, in start order. **Work** is the sum of their durations.
- **slot wait**: from when the task was ready (the latest `endedAt` of its dependencies, or the
  graph's `createdAt`) to its first execution's start, when that is over 1 s.
- **limit wait**: from the end of an execution whose error is a rate limit (the same classification
  the flow uses for `rate-limit`/`no-account`, reused and not copied) to the start of the task's next
  execution, or to now/the graph's end if none followed.
- **retry wait**: the same gap after any other failed or interrupted execution, which is a person or
  the automatic retry deciding.
- **critical path**: start at the task with the latest `endedAt`. Step to the dependency with the
  latest `endedAt`, and repeat until a task has no dependencies. Links are listed first to last.
  `waitBeforeMs` is the gap between the previous link's end (or `createdAt`) and this link's first
  start. `waits` are that link's slot/limit/retry waits.
- **integration / verification / synthesis phases**: the fields of §1. For a graph stored before
  them, the phase falls back to the executions of its role's chats (§2) when there are any.
  Otherwise it is left out and named in `missing`.
- **checksMs**: the sum of every run of every command. **fixerMs**: the sum of `fixes` durations.
  **passes**: the highest `pass`.

## 4. `scripts/orchestration-timings.mjs`

A dependency-free Node script (`node scripts/orchestration-timings.mjs [id…] [--min-tasks N]
[--json]`). It reads `AGENTRY_API_URL` and exits with a clear message when the variable is unset,
without guessing a port. It sends `Authorization: Bearer $AGENTRY_API_TOKEN` when that is set. It
prints the plan's tables in Markdown, in the same columns:

1. Phase split over the finished graphs with at least `--min-tasks` tasks (default 5): Tasks vs
   After the tasks, hours and share.
2. Per graph: after the tasks, Agentry running checks, fixer (attempts). This comes from
   `/timings`.
3. Per graph: critical path chain (`a → b → c`), its length, and parallelism.
4. Limit waits per task, over 5 min.
5. Inside the workers: model turns (count, hours, median), `pnpm test`, type check, `sleep`
   polling and Bash reads. These are read from `/chats/:id/export?format=json` for every task chat.
   The patterns are a small table at the top of the script, so another repository can adapt them.

`--json` prints the raw figures instead. The script is documented in the README next to the route.
It is run once against the dev server, and its output goes under "Measured with the script" in
`orchestration-speed.md`. It should come close to the hand-built tables. Where it differs, the
section says why (graphs added since, definitions now exact).

## 5. Web: "Where the time went" panel

On `apps/web/src/pages/OrchestrationDetail.tsx`, matched against
`docs/design-system/reference/DesktopOrquestacion.html` and its dark and light screenshots. The data
comes from the new route, fetched when the page opens and again when the graph's status changes. It
is not polled every second.

- A section titled "Where the time went" / "En qué se fue el tiempo". Its label is in Geist Mono,
  on the 11 label size. It is collapsed by default while the graph runs and open once it has ended.
- One horizontal bar split by phase (tasks, integration, verification, synthesis), drawn with the
  existing `ProgressBar variant="segments"` and `cells`. It adds no new bar component. Phase cells
  are **neutral**. Each shows a legend row with its name and duration in mono tabular numbers.
- The critical path as a list of its links: task name, work time, and the wait before it.
  Waits are drawn in status colours with a word: limit and slot waits in `warn` ("waiting on a
  limit", "waiting for a slot"), retry waits in `idle`. A failed verification run is `bad` with
  the word "failed". Nothing else takes a status colour.
- Verification: one row per command with its runs as small cells (neutral when passed, `bad` with a
  word when failed), and the pass number and duration in mono.
- `missing` renders one muted line ("Older graph: some phases were not recorded"), never an error.
- No gradient, no energy border and no animation: the panel is history, not a live surface. A
  running graph shows figures up to now without looping motion.
- Tokens only; both themes at ≥ 4.5:1 text contrast; `en`/`es` parity following
  `apps/web/src/i18n/GLOSSARY.md`. On a phone, the panel stacks and the bar keeps full width.
  Rows are ≥ 44 px when they are tappable. It is covered by the page's axe spec.
- If the panel needs a class the design system lacks, it goes into `docs/design-system.md` and
  `agentry-ds.css` in the same PR.

## 6. Contract and docs

- `packages/shared/src/types.ts`: the types above. Then `pnpm --filter @agentry/api openapi:schemas`.
- `apps/api/src/openapi/routes.ts`: `'GET /orchestrations/:id/timings'` with a summary, the
  `Orchestration` tag and `ok: ref('OrchestrationTimings')`.
- README REST table (Orchestrations): a row for the route, placed after `GET /orchestrations/:id`.
- `docs/orchestrations.md` or the orchestration doc that exists when this lands: a short
  "Timings" section with the definitions of §3.

## Tests

- Core (`orchestrator` tests with the fake CLI): integration, verification and synthesis get
  `startedAt ≤ endedAt`. A check that fails, is fixed and passes has two `runs` with passes 1 and
  2, and `fixes` has one entry with the fixer's `runId`.
- Core: `chatOrchestrations()` gives each role for the integrator, fixer, synthesis and task
  chats, and a `retry-clean` task's first chat is still linked. A usage report over them attributes
  the fixer's cost to the orchestration.
- Timings unit tests on hand-built graphs cover a chain with a slot wait, a limit wait followed by a
  resumed execution, a retry wait, a critical path through the longest dependency, an older graph
  without the new fields (`missing` filled, 200), and a running graph.
- API: `GET /orchestrations/:id/timings` gives 200 with the schema, and 404 for an unknown id.
- Web: a unit test of the panel with timings fixtures in both locales.

## Related

[[plans/orchestration-speed.md]] · [[plans/worker-checks.md]] · [[plans/agent-observability.md]] · [[design-system.md]]
