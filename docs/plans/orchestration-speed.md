---
created_at: 2026-09-28T13:57:10.191855215Z
updated_at: 2026-10-07T12:00:00Z
tags:
    - plan
    - orchestration
    - verification
    - e2e
    - performance
    - proposed
---
# Plan: faster orchestrations

Cut the wall-clock time of an orchestration where it is actually spent. The target is to take a
typical recent graph from about 2 h 45 min to under 2 h, with no loss in what gets checked.

Status: **proposed on 2026-09-28**, not started. The measurements below come from the API of the
dev server (`GET /orchestrations`, `GET /chats?origin=orchestration,internal` and every worker
transcript), as of that day. Three questions for the owner are open under
[Open questions](#open-questions).

## What was measured

There were 21 orchestrations, 20 of them finished. The 14 with five tasks or more add up to 33 h of
wall clock:

| Phase | Hours | Share |
|---|---|---|
| Tasks (first task started → last task ended) | 26.1 | 79 % |
| After the tasks: integration, verification, synthesis | 7.0 | 21 % |

The recent graphs (`ecosystem-*`, `tunnel`) take 2 h 45 min on average, and about 50 min of that
comes after the last task.

### 1. The critical path is a chain, and it sets the time

The task phase lasts almost exactly as long as its critical path. Effective parallelism is only
1.4–1.6 with a concurrency of 3–4, so raising the concurrency would change nothing. Every graph has
the same shape:

```
types → core → web → web-review → docs
```

- The tail `review` + `docs` always runs in series and adds 25–50 min per graph: for example
  `gaps-review` took 37 min and `gaps-docs` 14 min.
- A leading `types` task (8–15 min) holds back every other task.

### 2. Verification runs the e2e suite twice, and the suite keeps growing

After a fix, every check runs again from the first (`checkAll` in `orchestrator.ts`, on purpose,
because one fix can break another check). Meanwhile the e2e suite on the merged branch went from
5.8 min (`post-roadmap`) to 18.3 min (`ecosystem-gaps`). It failed on 6 of 9 verifications, mostly
because specs no longer matched a UI that had changed. The usual sequence was a failing e2e run
(about 15 min), then the fixer (12–33 min), then everything again (about 20 min).

| Graph | After the tasks | Agentry running checks | Fixer |
|---|---|---|---|
| ecosystem-board-web | 75 min | 52 | 22 (3 attempts) |
| ecosystem-team | 67 min | 33 | 33 |
| ecosystem-assistant | 51 min | 31 | 19 |
| ecosystem-review-fixes | 49 min | 36 | 12 |
| tunnel | 41 min | 32 | 7 |

### 3. A worker that hits its session limit just waits

`tunnel:web`, `ecosystem-board-web:web-foundation` and `web-projects` died with *"You've hit your
session limit"*. The first two show as 110 min tasks, but only about 20 min of that was work. The
rest was the task sitting failed until someone retried it after the reset. Two big graphs were
running at the same time. `rotateAndResume` (`packages/core/src/index.ts`) does rotate the account
for a worker, but on purpose it does not replay the turn ("the next tasks use it"). `settle()` then
does not retry a failure that has a `cause`, so the task stays failed.

### 4. Inside the workers (144 chats, 41.9 h)

| Where | Hours | Share | Note |
|---|---|---|---|
| Model turns | 26.5 | 63 % | 17,083 turns, median 2.8 s: many short turns, not slow ones |
| `pnpm test` | 4.8 | 11 % | 85 whole-monorepo runs (1.4 min each) are 2.0 h of it |
| Type check | 3.1 | 7 % | 112 whole-monorepo runs are 1.0 h |
| `until … sleep` / `while sleep` polling | ~2 | ~5 % | waiting on commands they had sent to the background |
| Bash reads (`grep`, `sed`, `cat`…) | 1.3 | 3 % | 6,281 calls, each one a model turn more |

Waiting for a free slot only mattered in `roadmap-completion` and `post-roadmap` (19 and 17 tasks).
It does not matter in the recent graphs.

### Measured with the script

Run on 2026-09-29 with `node scripts/orchestration-timings.mjs` (workstream A, built by CW-13), against
this branch's API over a copy of the dev server's data (the dev server itself ran a build without
`GET /orchestrations/:id/timings`). Everything below is the script's output, unedited.

#### Phase split (15 finished graphs with 5 tasks or more)

| Phase | Hours | Share |
|---|---|---|
| Tasks (first task started → last task ended) | 30.3 | 77 % |
| After the tasks: integration, verification, synthesis | 9.3 | 23 % |

#### After the tasks

| Graph | After the tasks | Agentry running checks | Fixer |
|---|---|---|---|
| ecosystem-design | 51 min | ~45 | 5 |
| ecosystem-gaps | 87 min | ~18 | 17 (2 attempts) |
| ecosystem-review-fixes | 49 min | ~36 | 12 |
| ecosystem-assistant | 51 min | ~31 | 19 |
| ecosystem-team | 67 min | ~33 | 33 |
| ecosystem-board-web | 75 min | ~52 | 22 (3 attempts) |
| tunnel | 41 min | ~32 | 7 |
| ecosystem-fixes | 11 min | ~10 | – |
| ecosystem-foundation | 11 min | ~10 | – |
| mobile-pwa | 9 min | ~8 | – |
| ui-redesign | 21 min | ~7 | 7 |
| post-roadmap | 37 min | ~6 | 9 |
| roadmap-completion | 39 min | – | – |
| chats-redesign | 7 min | – | – |
| agentry-live-events-notifications-execution-detail | 1 min | – | – |

#### Critical paths

| Graph | Critical path | Length | Tasks phase | Parallelism |
|---|---|---|---|---|
| ecosystem-design | design-core → design-shell → design-project → design-review → design-docs | 254 min | 254 min | 1.0 |
| ecosystem-gaps | gaps-shared → gaps-flow → gaps-web-team → gaps-review → gaps-docs | 152 min | 152 min | 1.4 |
| ecosystem-review-fixes | fix-core-data → fix-links-api → fix-web-tasks → review-5 → docs-5 | 117 min | 117 min | 1.6 |
| ecosystem-assistant | assistant-types → assistant-core → web-suggest → web-review-4 → docs-4 | 97 min | 97 min | 1.4 |
| ecosystem-team | team-types → documents-core → flow-core → web-memory-docs → web-review-3 → docs-3 | 115 min | 115 min | 1.4 |
| ecosystem-board-web | web-foundation → web-item → web-review → docs-web | 203 min | 203 min | 1.0 |
| tunnel | types → settings-layers → tunnel-core → push-current-url → web → docs | 187 min | 187 min | 0.6 |
| ecosystem-fixes | proto-fix-system → proto-fix-desktop → proto-fix-review → docs-fixes | 108 min | 108 min | 1.6 |
| ecosystem-foundation | proto-foundation → proto-team → proto-index → docs | 85 min | 85 min | 2.1 |
| mobile-pwa | push-model → push-server → push-web → docs | 61 min | 61 min | 1.4 |
| ui-redesign | live-activity → lists → media → docs | 87 min | 87 min | 2.4 |
| post-roadmap | types → scheduling-2 → web-schedules-usage-2 → media → docs | 89 min | 89 min | 2.1 |
| roadmap-completion | types → connectors → web-orchestration-v2 → docs | 91 min | 91 min | 3.0 |
| chats-redesign | model → chats-core → context-cost → web-home-nav → a11y → verification | 112 min | 112 min | 1.4 |
| agentry-live-events-notifications-execution-detail | event-feed → notifications → integrate | 63 min | 63 min | 1.3 |

#### Limit waits over 5 min

| Task | Waited | From | Why |
|---|---|---|---|
| ecosystem-design:design-project | 94 min | 2026-09-28 14:02 | You've hit your session limit · resets 8:10pm (Europe/Madrid) |
| ecosystem-board-web:web-foundation | 87 min | 2026-09-27 11:57 | You've hit your session limit · resets 3:10pm (Europe/Madrid) |
| tunnel:web | 87 min | 2026-09-27 11:57 | You've hit your session limit · resets 3:10pm (Europe/Madrid) |

#### Inside the workers (138 chats, 42.3 h)

| Where | Hours | Share | Note |
|---|---|---|---|
| Model turns | 22.8 | 54 % | 14,868 turns, median 2.9 s |
| `pnpm test` | 5.7 | 14 % | 405 calls |
| Type check | 1.6 | 4 % | 474 calls |
| `until … sleep` / `while sleep` polling | 2.6 | 6 % | 156 calls |
| Bash reads (`grep`, `sed`, `cat`…) | 1.4 | 3 % | 6,830 calls |

13 graphs were stored before some figures were recorded; a `~` figure is derived from the others. Missing: ecosystem-design (verification.runs); ecosystem-gaps (verification.runs); ecosystem-review-fixes (verification.runs); ecosystem-assistant (integration.startedAt, verification.runs); ecosystem-team (verification.runs); ecosystem-board-web (verification.runs); tunnel (verification.runs); ecosystem-fixes (integration.startedAt, verification.startedAt, verification.runs, verification.fixes); ecosystem-foundation (integration.startedAt, verification.startedAt, verification.runs, verification.fixes); mobile-pwa (integration.startedAt, verification.startedAt, verification.runs, verification.fixes); ui-redesign (verification.runs); post-roadmap (verification.runs); agentry-live-events-notifications-execution-detail (integration.startedAt, synthesisStartedAt).

How it differs from the hand-built tables above:

- **Graphs added since.** 15 graphs now have five tasks or more (`ecosystem-design` finished after
  the tables were made), so the phase split is 30.3 h / 9.3 h instead of 26.1 h / 7.0 h. The share
  barely moves: 77 % / 23 % against 79 % / 21 %.
- **The after-the-tasks table matches.** For the five graphs the plan listed, the time after the
  tasks, the checks and the fixer come out exactly as built by hand (75/52/22 with 3 attempts,
  67/33/33, 51/31/19, 49/36/12, 41/32/7). Those graphs were stored before check runs were kept, so
  "Agentry running checks" is derived (`~`): the time after the tasks less the fixer, integration
  and synthesis, which is how the hand-built figure was reached. A graph run from now on reports
  every run instead.
- **Parallelism is now exact, and lower where a limit hit.** It is the sum of every task's
  executions over the tasks phase, so the 87 min `tunnel:web` and `web-foundation` spent waiting on
  the session limit no longer count as work: `tunnel` reads 0.6 and `ecosystem-board-web` 1.0,
  against 1.4–1.6 from task spans.
- **The limit waits are found by their error**, not by title: the three the plan names are there
  (`tunnel:web`, `ecosystem-board-web:web-foundation`, and `ecosystem-design:design-project`, which
  ran after the tables were made). `web-projects` hit the limit too, but was resumed within 5 min.
- **Inside the workers** counts the task chats of the graphs above (138, 42.3 h, against 144 and
  41.9 h over every graph). A model turn now runs from the entry before an assistant entry to it,
  so 22.8 h against 26.5 h. The patterns are wider for tests (`node --test`, `vitest`, filtered
  runs: 405 calls, 5.7 h) and narrower for type checks (`tsc` and `pnpm typecheck` only: 474 calls,
  1.6 h), and polling now includes `sleep N; tail …` loops (2.6 h).

## The work

Five workstreams. Each lists what it changes, where, and how its effect will be measured.

### A. `timings`: record where the time goes

Today the time spent after the tasks has to be reconstructed from the chats' executions, matched by
title. The integration and verification chats carry no orchestration id, and a check keeps only
the `durationMs` of its last run, so earlier runs are overwritten.

- `packages/shared/src/types.ts`: add `startedAt`/`endedAt` to `OrchestrationIntegration`,
  `VerificationState` and the synthesis. `VerificationCommand` gets `runs: Array<{ startedAt,
  durationMs, status }>`, so a re-run adds to the record instead of overwriting it.
- Give the integrator, fixer and synthesis chats the orchestration link (`orchestration.id`, with a
  role instead of a `taskId`), so the chat list and the usage report attribute them.
- `GET /orchestrations/:id/timings`: the phases, the critical path (the task chain that ended last,
  with the waits between links), the time tasks spent waiting on a limit or a slot, and the
  verification runs. Computed when it is read, from what is already stored.
- `scripts/orchestration-timings.mjs`: the analysis in this document, reproducible against any
  running Agentry (`AGENTRY_API_URL`), including the worker breakdown read from the transcripts.
- Web: a "Where the time went" panel on the orchestration page, from the new route. It uses the
  segmented bars and neutral colours of the design system, and status colours only for waits and
  failures.

Measured by: the route answers for every finished graph, and the script reproduces the tables above.

### B. `limit-resume`: a worker that hits its limit carries on

- When a worker of an orchestration hits its rate limit and rotation found another account,
  continue the worker's chat on the new account (`continueChat`) without spending one of its
  attempts. This replaces "the next tasks use it".
- When no account has quota left, the task goes into a waiting state with the reason and the time
  the limit resets, which the CLI already sends as `resetsAt` in `rate_limit_event` (`chats.ts`).
  At that time Agentry resumes it by itself. While it waits, no new task of any orchestration
  starts on an exhausted pool.
- On the board, a task waiting on a limit reads as warn, with a word and the reset time, never as
  failed.
- When a second big orchestration is launched while another one runs, the launch form warns that
  they share the accounts' quota ([open question 3](#open-questions)).

Measured by: no task in the next graphs spends more than a few minutes between hitting a limit and
resuming, when another account has quota.

### C. `verify-faster`: a shorter verification phase

- **Sharded e2e** in `e2e/run.mjs`: `E2E_SHARDS=N` starts N child runs. Each child gets its own
  sandbox, a free port (not the fixed 8799) and its own Chrome. The specs are split by their last
  known duration, kept in a gitignored timings file, and the output is merged in spec order. Specs
  that ask for `fakeCli` stay together in one shard. The default comes from the CPU count, capped
  at 4. This targets the 15–18 min runs, and they should fall to about 5.
  Built on 2026-09-29 with CI's matrix (CW-3), with a checked-in duration table instead of the
  gitignored file, so that every CI job computes the same split: see
  [verify-faster.md, What §1 built](verify-faster.md#what-1-built).
- **Parallel groups** in `VerificationSpec.commands`: an entry can be a list of commands that run at
  the same time, for example `[ ["pnpm typecheck", "pnpm test"], "pnpm build", "pnpm e2e" ]`. This
  saves 2–4 min on every pass, and there are two passes whenever the fixer works. Re-running
  everything from the first check after a fix is kept, for the reason `checkAll` gives.
- The fixer is told which specs failed, parsed from the `✗ <file>` lines of the runner. That way it
  goes straight to them instead of reading the tail of the output.

Measured by: in the next graphs, the time between the last task and the end of the graph is at most
25 min when the fixer has nothing to do, and at most 40 min when it has one attempt.

### D. `worker-checks`: cheaper checks, and e2e breakage caught earlier

This changes `workerChecks()` in `packages/core/src/verification.ts`. Its wording has to hold for
any repository Agentry drives, not only this one.

- Run the type check and the tests **of the package or files you changed**, not the whole
  repository's. The whole suite runs once, in verification.
- Run long commands in the foreground under `timeout`. Do not send them to the background and poll
  them with `sleep` loops.
- When verification exists, a worker that changes what a browser spec covers runs **that spec
  only**, on its own port. This is [open question 1](#open-questions): it partly reverses the
  decision in [plans/agent-observability.md](agent-observability.md) that workers run no e2e at all.
- Read several files in one call where you can: every call costs a model turn.

Measured by: whole-monorepo test and type check runs by workers drop from about 200 to a handful per
graph, polling falls below 1 %, and verification stops failing on specs that went stale.

### E. `graph-shape`: shorter chains

Most of the task-phase time is the critical path, and the path comes from how the graph is written.
That happens by hand in a plan (for example `project-ecosystem.md`) or through the planner.

- The planner prompt (`startPlan` in `orchestrator.ts`) and a new document,
  [orchestrations.md](../orchestrations.md), on writing a graph. No such document exists yet: this
  workstream writes it.
  - No stand-alone `types` task. Put the contract in the plan, so the core and web tasks can start
    in parallel against it, or fold it into the first core task.
  - `docs` depends on the implementation tasks, not on `review`, so that the two run in parallel.
    Or leave the Outcome to the synthesis.
  - When verification is on, a `review` task looks at the design and at what the checks cannot
    see. Its prompt says so, so it does not re-run the suite.
  - `sonnet` for tasks that only write prose (docs).
  - Name the files and routes each task will touch, so the worker does not have to find them.
- The launch form and the editor show the number of stages in series and the longest chain, as a
  hint (not a block) when there are more than four.

Measured by: the next graphs have at most four stages in series, and the task phase stays within
10 % of the longest single chain.

## Expected effect on a typical recent graph

| Change | Saves |
|---|---|
| E: `docs` in parallel with `review`, no leading `types` | 20–25 min |
| C: sharded e2e, parallel groups | 20–30 min |
| B: resume on limit | up to 90 min when it happens |
| D: fewer fixer rounds, scoped checks | 5–15 min |
| **Total, without a limit hit** | **about 165 → 110–120 min** |

## How it is built

The work runs as one orchestration, shaped the way workstream E asks, with verification on:

```
timings-core ─┬─ timings-web ─┐
limit-resume  │               ├─ docs (sonnet)
verify-faster ┤               │
worker-checks ┘ graph-shape ──┘
```

- `timings-core` owns the `types.ts` change and the OpenAPI schemas, so the web task depends on it,
  and nothing else does.
- `limit-resume` and `verify-faster` touch different parts of `orchestrator.ts`
  (`settle`/`rotateAndResume` and `checkAll`). The integrator handles the merge.
- `verify-faster` owns `e2e/run.mjs`, and its own specs cover sharding with `E2E_SPECS_DIR`, as
  `harness.test.mjs` does.
- It is launched when no other big orchestration is running, and the next three graphs after it are
  measured with `scripts/orchestration-timings.mjs`. Their numbers go into an Outcome section here.

## Outcome

Filled in as the workstreams land and the graphs after them are measured.

- **C. `verify-faster`** (CW-14): sharded e2e shipped in #128 (0.24.0; 4 shards ran the suite in
  312 s on the dev machine, against about 17 min in one process on CI). Parallel groups in
  `verification.commands` and the failed specs in the fixer's prompt were built in `task/cw-14`.
  **Not measured yet:** the 25-minute (nothing to fix) and 40-minute (one fixer attempt) targets
  after the last task, on the next graphs with verification on after the merge; and the
  `E2E_SHARDS=1` wall time on an idle machine. See [plans/verify-faster.md](verify-faster.md).

## Open questions

1. **Workers and e2e.** Should a worker run the one or two browser specs its change touches, on its
   own port? This catches breakage before the merge, at the cost of a build and one spec per worker.
   The alternatives are to keep "no e2e in workers" and rely on sharding alone, or to add a
   dedicated `e2e-specs` task before integration.

   **Answered on 2026-09-30: a dedicated `e2e-specs` task (option C).** Workers keep running no e2e;
   before integration a task runs the browser specs that the graph's changes touch, on its own
   port. This is what CW-15 builds; built on 2026-10-07, see
   [worker-checks.md](worker-checks.md#outcome-2026-10-07).
2. **No account left.** Should the graph wait for the reset and resume by itself, stop for a
   decision, or wait only up to a limit (for example 30 min) and then stop?

   **Answered on 2026-09-30: wait and resume by itself (option A).** A task or flow run with no
   account left is *waiting for quota* (warn, with the time the first account resets), never
   failed, and Agentry resumes it in its own chat as soon as an account has room. While it waits,
   nothing new starts on the exhausted pool. This is what CW-4 builds.
3. **Two big graphs at once.** Should the launch form warn, should the second one wait in a queue
   until the first one ends, or should the accounts be split between them?

   **Answered on 2026-09-30: warn at launch (option A).** The launch form says the graphs share the
   accounts' quota and how much is left; the person decides.

## The prompts the orchestration builds

CW-24 rewrote the planner, worker, integrator, fixer, synthesis and workflow lead prompts for Opus
5.5 and Sonnet 5.5. [prompts.md](../prompts.md) describes each one and the continuation. In short:

- **Workers** carry the unattended instruction against the four premature stops, real
  verification, scope and completion, and the frontend rules. `workerChecks` keeps its split. The
  objective and the dependencies' results reach them as `<pasted_content>` blocks.
- **A worker whose turn ends as a report** (it offers to continue, asks, or announces a next step)
  goes back to its chat with a message naming what is open and a time signal: `elapsed Ns / budget
  Ms` against `limits.maxMinutes`, or "Time matters here…". This happens at most three times,
  counted in `OrchestrationTaskState.continuations`, and it is not an attempt.
- **The integrator and the fixer** carry the unattended instruction and real verification, with the
  objective, the task results and the check's output wrapped.
- **The planner** reads the directory before it plans ("may inspect … first" is gone). It thinks
  the problem through on Sonnet, and a plan whose turn stopped on `max_tokens` is refused.
- **The workflow lead** ends with the time signal. A workflow has no budget, so it reads "Time
  matters here…".

## Related

[[prompts.md]] · [[plans/agent-observability.md]] · [[pinned-chat-rotation.md]] · [[plans/post-roadmap.md]] · [[status.md]]
