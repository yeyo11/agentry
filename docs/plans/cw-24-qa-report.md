---
created_at: 2026-09-29T14:00:00Z
updated_at: 2026-09-29T16:00:00Z
tags:
    - qa
    - report
    - prompts
---
# QA report: CW-24, Agentry's prompts for Opus 5.5 and Sonnet 5.5

This report covers the branch at `0f100fe4`: three commits (feat, test, docs) and 47 files. I read
the diff in full for `packages/core/src` and `packages/shared/src`, the new tests, the OpenAPI
schema diff, the en/es copy and the docs.

## Verdict: fail. The checks could not be run.

The code review found every criterion met. But this QA run could not execute `pnpm typecheck`,
`pnpm test`, or even `tsx --test` on one file: the session's permission mode denied every one of
them. `git` and `node --version` ran. So criterion `564ce460` ("pnpm typecheck and pnpm test pass")
is **not verified**, and the item cannot pass on reading alone.

**To close it**, run `pnpm typecheck`, `pnpm test` and
`pnpm --filter @agentry/api openapi:schemas` (then `git diff --exit-code apps/api/src/openapi`) on
this branch. If all three pass, nothing else I found blocks a pass.

## What the reading confirmed

- **`prompt-rules.ts`** exports `UNATTENDED`, `SCOPE_AND_COMPLETION`, `REAL_VERIFICATION`,
  `THINK_THROUGH` (exact text), `PASTED_NOTE`, `FRONTEND`, `timeSignal()` and `pasted()`.
  - A grep of `packages/core/src` finds the texts only there.
  - The one exception is justified: the workflow runtime's `paste()` is a string inside the
    generated sandbox script, and it uses `pastedId()`.
- **`open-items.ts`**: `openItems()` is pure. `prompt-rules.test.ts` covers every case: a schema
  run with no result, uncommitted paths (and the "N more" count), an offer to continue, a
  non-blocking question, and an announced next step.
- **Flow continuation**:
  - A guarded `UPDATE flow_runs SET continuations` records each one.
  - The message is held until `chatEnded`, and the same chat is resumed.
  - The flow test drives three continuations and then the outcome, over a scripted chat. It also
    covers uncommitted paths, and an error after a continuation.
- **Worker continuation**:
  - `task.continuations` is not an attempt.
  - It carries `WORKER_CLOSING` and `timeSignal`.
  - It is tested over the fake CLI with `FAKE-TEXT-ONCE`.
- **`stop_reason`**:
  - It is read from stream-json: `message_delta.delta.stop_reason`, the main agent's
    `message.stop_reason`, and the result event's field.
  - Flow runs fail with the new `max-tokens` cause. The assistant fails with
    `assistant.error.max-tokens`, and the planner with `planner failed: …max_tokens…`.
  - The planner test gets its stop reason through the fake CLI's stream-json.
- **Types and copy**:
  - `FlowRunCause`, `FLOW_RUN_CAUSES` and `MAX_CONTINUATIONS` are in shared.
  - `schemas.json` has both `continuations` fields and the new cause.
  - The en/es copy is in `team.json`, `tasks.json` and `workItem.json`, and the web cause lists
    have the new value.
- **Pasted blocks**: each builder has its own test for the flow, work-links, assistant (including
  CLAUDE.md), journal, orchestrator (worker, integrator, synthesis, planner), fixer, supervisor and
  workflow-engine. `PASTED_NOTE` is next to every block.
- **Docs**:
  - `docs/prompts.md` has the inventory, all twelve points for each prompt, and the Known gaps
    (the title line, the CLAUDE.md the CLI loads). It records point 12 as belonging to CW-12, and
    the member's effort as deferred to CW-25.
  - `team-and-flow.md`, `assistant.md`, `plans/orchestration-speed.md` and `plans/verify-faster.md`
    describe the new prompts and link to `prompts.md`.
  - `docs/plans/orchestration-timings.md` does not exist. Only `scripts/orchestration-timings.mjs`
    does, and the criterion's "or a section of docs/prompts.md they link to" covers it.

## Observations (not blocking)

- **A worker's report can be continued needlessly.** The `NEXT_STEPS` patterns (`/\bnext steps?:/i`,
  `/\bi('m| am) (now )?going to\b/i`) are checked against the last paragraph of the final text. A
  worker told to "finish with a concise report" often ends with a "Next steps:" list of
  recommendations for other workers. That report would be sent back up to three times. The cost
  has a ceiling, but it is paid. The QA verify stage has the same risk: a summary that ends in "?"
  would also be sent back.
- In `flow.ts`, the new `uncommittedPaths` sits between `chatFailure`'s JSDoc and `chatFailure`.
  The comment now documents the wrong function.
- Assistant error codes (`assistant.error.*`, the new one included) have no `server:` keys in the
  web locales, so they show in English. This was true before CW-24, and the criterion does not
  require them.

## Second round, at `236e0b8b`

The fix commit acts on the first two observations:

- `NEXT_STEPS` drops `next steps?:` and `I'm going to`.
- A trailing question only counts when it is put to the person (`you`, `your`, `should I`, `can I`,
  and so on).
- The JSDoc is back on `chatFailure`.

I read the new tests by hand against the regexes:

- The announced-step cases still match: "Next, I will", "Now I'll", "The next step is".
- A "Next steps:" list and a rhetorical question at the end now give no open items.
- The worker test's `FAKE-TEXT-ONCE` text still matches.

Nothing that depended on the removed patterns is left.

**The verdict is still fail, for the same reason.** This session is in don't-ask mode, and every
`pnpm` call is denied, `pnpm --version` included. So `564ce460` (typecheck and tests pass) is not
verified for a second time. A person, or a QA run that is allowed to run `pnpm`, needs to run
`pnpm typecheck`, `pnpm test` and `pnpm --filter @agentry/api openapi:schemas && git diff
--exit-code apps/api/src/openapi`. If all three pass, the item passes.

## The checks, run by the Developer on 236e0b8b (2026-09-29)

The Developer's session can run `pnpm`, so these were run on the branch at `236e0b8b`:

- `pnpm typecheck`: exit 0, no errors.
- `pnpm --workspace-concurrency=1 test`: exit 0. That is `pnpm test` with the packages run one
  after another instead of in parallel. The totals: shared 31, desktop 49, core 865, web 856,
  api 174, and no failures.
- `pnpm --filter @agentry/api openapi:schemas && git diff --exit-code apps/api/src/openapi`: no
  drift.

One web test fails in plain parallel `pnpm test` on this machine: `highlight.test.ts`, "the first
block in a grammar shiki compiles on the spot is still coloured". That failure also stops the run
before the api suite reports. The test compiles shiki's C++ grammar within a per-line time budget,
so it misses the budget when the core suite loads the CPU at the same time. It passes whenever the
web suite runs without that load. This branch's changes to `apps/web` are the cause lists, their
en/es copy and test fixtures, none of them near highlighting. The test's timing belongs to another
item.

## Related

[[prompts.md]] · [[team-and-flow.md]] · [[assistant.md]] · [[plans/orchestration-speed.md]] · [[plans/verify-faster.md]]
