---
created_at: 2026-09-28T16:00:00Z
updated_at: 2026-09-28T16:00:00Z
tags:
    - plan
    - spec
    - orchestration
    - verification
    - e2e
    - performance
    - proposed
---
# Spec: cheaper checks inside workers (CW-15)

Workstream D (`worker-checks`) of [plans/orchestration-speed.md](orchestration-speed.md), story
CW-15 of the epic CW-11 "Faster orchestrations". Status: **refined, not built**.

## Why

The measurements in the plan (section 4, "Inside the workers") show where worker time goes outside
model turns:

- 85 whole-monorepo `pnpm test` runs (2.0 h) and 112 whole-monorepo type checks (1.0 h), when the
  worker changed one package.
- About 2 h of `until … sleep` / `while sleep` polling on commands the worker had sent to the
  background.
- 6,281 Bash reads (`grep`, `sed`, `cat`), each one a model turn more.
- Verification failed on 6 of 9 runs, mostly on e2e specs that went stale because a worker changed
  the UI they cover. Nobody noticed before the merge.

## What changes

Only the text that `workerChecks(verification: boolean)` returns, in
`packages/core/src/verification.ts`, and its tests in `packages/core/test/verification.test.ts`.
`orchestrator.ts` (line ~740, the worker prompt) keeps calling it the same way. The signature does
not change unless point 3 needs it (see below). No type, route, OpenAPI schema or UI changes.

The wording has to hold for **any repository Agentry drives**. It must not name `pnpm`, `e2e/`,
`E2E_PORT` or any other file or tool of this repo, except as an example after "for example". The
existing rule "the project's own commands for them" stays.

### 1. Scoped checks

Replace "run the type check and the unit tests of what you changed" with an explicit scope. Run the
type check and tests **of the package, or the test files, you changed**, not the whole repository's.
For example, `pnpm --filter <pkg> test`, or the test runner pointed at one file. The whole suite runs
once, later: in the verification phase when one exists, otherwise at integration. Keep "do not go on
until they pass".

### 2. Foreground under `timeout`, no polling

Keep the existing `timeout` sentence and add: run long commands **in the foreground**. Never send
them to the background (`&`, `run_in_background`, `nohup`) and then poll them with `sleep` loops.
Keep "leave no process of yours running when you finish".

### 3. One browser spec per worker (depends on the owner's answer)

Open question 1 of the plan: should a worker run the one or two browser specs its change touches,
on its own port? This reverses part of the decision in
[plans/agent-observability.md](agent-observability.md) ("Workers … may write or update e2e specs but
do not run the suite"). **The developer asks the owner before building this point.** The owner's
answer, with the date, goes into the plan's Open questions as "Answered: …", and into this document.

- **If approved**, only when `verification` is true: a worker that changes what a browser spec
  covers, or changes the spec itself, builds what the spec needs and runs **that spec alone** (one
  or two at most, never the whole suite), on **a free port of its own**, under `timeout`. It says in
  its report which specs it ran and how they ended. For this repo that is, as an example only,
  `timeout 300 env E2E_PORT=<free port> pnpm e2e <spec-prefix>`; `e2e/run.mjs` already filters by
  argv prefix and reads `E2E_PORT`. When `verification` is false, the current "do not run the
  suite" wording stays.
- **If rejected**, or the owner picks sharding alone, or a separate `e2e-specs` task: the current
  wording for both branches stays as it is, and CW-15 ships points 1, 2 and 4 only. A separate
  `e2e-specs` task belongs to workstream E (`graph-shape`), not here.

### 4. Batch reads

Add: read several files in one call where you can (one tool call that reads or searches several
paths), because every call costs a model turn.

## Tests

In `packages/core/test/verification.test.ts`, extend the test "workers are told the split of
checks…" (or add one next to it) so that it pins:

- the scoped-checks wording (for example `/package|files you changed/` and `/not the whole/`), for
  both `workerChecks(true)` and `workerChecks(false)`;
- `/foreground/` and a ban on background polling (for example `/sleep/`), for both;
- the batched-reads wording (for example `/several files/`), for both;
- no repo-specific name outside an example: for example, `assert.doesNotMatch(text, /E2E_PORT/)`
  unless it appears after "for example";
- point 3: if it was approved, `workerChecks(true)` matches `/that spec alone|only that spec/` and
  `/own port/`, and `workerChecks(false)` still matches `/Do not run the end-to-end or browser
  suite/`. If it was rejected, both still match the current "Do not run" wording.

The existing assertions (`under \`timeout\``, `verification phase` only when true) keep passing.

## Out of scope

- Sharding the e2e suite, parallel check groups and failed-spec parsing for the fixer (workstream C,
  `verify-faster`).
- Changing the graph shape or adding an `e2e-specs` task (workstream E, `graph-shape`).
- The fixer prompt (`fixerPrompt`), which already says "one spec or test file at a time".

## How it is measured

Taken from the plan: whole-monorepo test and type check runs by workers drop from about 200 to a
handful per graph, `sleep` polling falls below 1 % of worker time, and, if point 3 is approved,
verification stops failing on specs that went stale. `scripts/orchestration-timings.mjs` (workstream
A) reports it.

## Related

[[plans/orchestration-speed.md]] · [[plans/agent-observability.md]] · [[orchestrations.md]] · [[e2e]]
