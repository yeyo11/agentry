---
created_at: 2026-10-07T16:00:00Z
updated_at: 2026-10-07T16:00:00Z
tags:
    - effort
    - models
    - orchestration
    - flow
    - providers
    - feature
---
# Effort: how hard a model thinks

Story CW-25, part of the epic CW-23 "Prompts and effort tuned for Opus 5.5 and Sonnet 5.5". An
effort level can be chosen wherever a model is chosen, is recorded on each run and is shown next to
the model.

Effort is the main control of how much Opus 5.5 and Sonnet 5.5 think. Levels are calibrated per
model, so a setting is never carried from one model to another. Everything goes through Claude Code's
CLI flag `--effort`, with no SDK and no API call, so it respects [the one rule](providers.md).

## Levels and the recommendation

Levels: `low`, `medium`, `high`, `xhigh`, `max` (`EFFORT_LEVELS` in `packages/shared/src/effort.ts`).
`xhigh` and `max` are offered but marked as costly (`COSTLY_EFFORTS`): they add review rounds.

Unset means the recommended default for the model and the use. `recommendedEffort(model, use)`
returns it; `effortRecommendation` also returns a reason code (`opus-medium`, `sonnet-medium`,
`sonnet-high`) that a client words and translates for a tooltip. A model the helper does not know
gets `null`, which means the CLI's own default. Opus 5.5 and Sonnet 5.5 are recognised by alias
(`opus`, `sonnet`) or by id (`claude-opus-5-5`, `claude-sonnet-5-5`, with a date or a `[1m]` suffix).

| use | Opus 5.5 | Sonnet 5.5 | other models |
|---|---|---|---|
| chat, refine, verify, work, worker, assistant | medium | medium | null (CLI default) |
| planner, fixer | medium | high | null |

Why, from the prompting guides:

- **Opus 5.5.** Thinking is always on. The default `medium` matches or beats Opus 5 at `high` on coding
  and knowledge work, and `low` comes close on many coding tasks at much lower cost. `xhigh` and `max`
  are for work where a gain was measured.
- **Sonnet 5.5.** The API default is `high`. For agentic coding, `medium` suits well-specified tasks
  and `high` hard or long ones (a plan, a fix of what fails). For chat and latency-sensitive work use
  `medium` or `low`. At `low` it may skip verification.
- To think less, lower the effort: an instruction in the prompt does not reliably reduce thinking
  (see [prompts.md](prompts.md)).

## Where each run gets its effort

`resolveEffort(use, model, ...chosen)` in `packages/core/src/effort.ts` takes the first level someone
chose, in the order below, else the recommendation for the model and the use.

| Run | Order |
|---|---|
| Chat | `ChatStartOptions.effort`; resume and fork reuse the last execution's effort unless given |
| Flow run | the member's `effort` (`settings.team.members[]`), then the recommendation for the stage |
| Orchestration worker | the task's `effort`, then the orchestration's, then `worker` |
| Synthesizer | the orchestration's, then `worker` |
| Planner | `PlanRequest.effort`, then `planner` |
| Fixer | `VerificationSpec.effort`, then `fixer` |
| Assistant run | `StartAssistantRunRequest.effort`, then `assistant` |
| Schedule | carries it inside its target (`NewChatRequest` or `OrchestrationSpec`) |

The orchestrator is in `packages/core/src/orchestrator.ts` (`workerEffort`), the flow in
`flow.ts` and `team.ts`, the assistant in `assistant.ts` and `assistant-answer.ts`, schedules in
`schedules.ts`, the fixer in `verification.ts`. Relaunch and templates carry the effort because
`cleanTask`, `specOfTask` and `specOfOrchestration` keep it.

## The provider rule

Effort is provider-aware (see the `effort` capability in [providers.md](providers.md)). A provider
whose driver does not declare `effort` gets none: nothing is passed, and the control is hidden or
disabled with a tooltip. Claude Code declares it and passes `--effort`. Each run records what was
actually passed, not what was asked.

## Decided edge cases

- **A live chat cannot change effort.** `ChatSettingsUpdate` does not accept it and
  `PATCH /chats/:id` answers 400; a new value applies from the next message after a resume.
- **The `workflow` engine** uses only the orchestration's effort. The per-task control is disabled with
  a tooltip saying so, and the tasks' efforts are not passed.
- **The supervisor's housekeeping chat** (haiku) is out of scope and gets none.
- **The assistant's proposed team members** carry a recommended effort and its reason code
  (`recommendedMemberEffort`).
- **The planner's own task efforts** are dropped from the draft on purpose.
- **An unknown level** is a 400 on every route that takes a model, and an orchestration refuses it at
  launch (`validateEffort`) instead of a worker dying mid-graph.

## Where it is recorded and shown

- Executions (`ChatExecution.effort`), flow runs and assistant runs (a new `effort` column on
  `flow_runs` and `assistant_runs`, one migration appended last in `packages/core/src/db.ts`),
  orchestration chain entries and fixer attempts. Null means none was passed (the CLI default, or a
  provider without `effort`); absent means the run was written before it was kept.
- Shown next to the model by `EffortPicker`, which sits beside `ModelPicker` in
  `apps/web/src/components/controls`: "medium · recommended" when unset, the reason in a tooltip.
  The Decisions tab uses it instead of its own `Segmented`.
- Tests: `packages/shared`, `packages/core/test/effort.test.ts` and `apps/api/test/effort.test.ts`.

## Related

- [[providers.md]]
- [[prompts.md]]
- [[team-and-flow.md]]
- [[orchestrations.md]]
- [[assistant.md]]
- [[plans/decision-engine.md]]
