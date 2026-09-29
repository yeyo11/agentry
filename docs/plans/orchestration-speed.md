---
created_at: 2026-09-28T13:57:10.191855215Z
updated_at: 2026-09-29T12:00:00Z
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

## Open questions

1. **Workers and e2e.** Should a worker run the one or two browser specs its change touches, on its
   own port? This catches breakage before the merge, at the cost of a build and one spec per worker.
   The alternatives are to keep "no e2e in workers" and rely on sharding alone, or to add a
   dedicated `e2e-specs` task before integration.
2. **No account left.** Should the graph wait for the reset and resume by itself, stop for a
   decision, or wait only up to a limit (for example 30 min) and then stop?
3. **Two big graphs at once.** Should the launch form warn, should the second one wait in a queue
   until the first one ends, or should the accounts be split between them?

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
