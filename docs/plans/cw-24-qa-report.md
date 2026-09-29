---
created_at: 2026-09-29T14:00:00Z
updated_at: 2026-09-29T14:00:00Z
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

## Related

[[prompts.md]] · [[team-and-flow.md]] · [[assistant.md]] · [[plans/orchestration-speed.md]] · [[plans/verify-faster.md]]
