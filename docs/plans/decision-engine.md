---
created_at: 2026-09-28T13:40:32.928075489Z
updated_at: 2026-09-28T18:10:37.144581306Z
tags:
    - decisions
    - jev
    - typesafe
    - parked
    - research
---
# Decision engine with Jev: parked until the project ecosystem is in main

Status: **parked on 2026-09-28 by the owner; design decisions being closed meanwhile.** The plan document (`docs/plans/decision-engine.md`) is written only once `feat/project-ecosystem` is merged into main, because the ecosystem (the project assistant and the new features of orchestrations 6 and 7) adds more places where Jev fits, and the plan has to start from that code. A first draft exists on the local branch `docs/decision-engine-plan` (commit 28f63c65, not pushed): input only.

## What Jev is

TypeSafe's jev-1.13, a "System One" model: no text or code, only typed answers to questions over a state: Choice (up to 255 options, probability each), Score (2-10 levels), Noul (probability of yes), each with a confidence. `POST https://api.typesafe.ai/v1/systemone`, Bearer key, SDK `@typesafe-ai/sdk` (Node 20+). $0.042 per million input tokens, output free, 64k tokens per request, 0.1-0.3 s. Optimised for English; zero retention only on enterprise; steerable by injected content, weak at numbers, counting and dates.

## Why optional, with the owner's key

Separate provider and bill; content leaves the machine (no other outside service Agentry calls receives a person's content); the one rule requires Agentry to work in full with the CLI alone; quality must be measured on the owner's data.

## Decisions taken by the owner (2026-09-28)

1. **Engine**: one decision engine, primitives choice / score / noul; providers `cli` (default, a housekeeping CLI chat with `--json-schema`) and `jev` (optional, the owner's key).
2. **Modes** off / shadow / active per decision point, all shipped off. Suggest points vs act points; act points act only when confidence clears the threshold.
3. **Settings layout**: new Settings -> Agentry -> Decisions tab (Engine, Decision points, Supervisor, History) that absorbs the Supervisor tab; **per-project overrides from the start**.
4. **Language**: every technical text in English, Jev questions and rubrics included, and the records agents write. See [[decisions/english-technical-language.md]].
5. **Jev client**: the official SDK (`@typesafe-ai/sdk`) **behind an adapter** of our own.
6. **CLI confidence is `null`**: act points never act on their own with the CLI provider; suggest points work with both.
7. **Supervisor file**: `supervisor.json` stays; only its card moves into the Decisions tab (`?tab=supervisor` still lands there).
8. **Jev per project**: allowed with the one global key while the global provider is the CLI.
9. **History**: 30 days, editable.
10. **Jev unavailable**: fall back to today's behaviour without waiting, record "provider unavailable", the tab warns when it repeats.
11. **Jev version pinned** (jev-1.13.0), with a notice and a suggested shadow period when a new one ships.
12. **Privacy**: consent per decision point with a preview of the exact state of its last request, plus a general notice when saving the key.
13. **Shadow accuracy**: inferred from what happened plus the person's useful / not useful on a decision's mark.
14. **Metrics**: per point in the Decisions tab, plus a line in Usage with Jev's cost and the Claude runs saved.
15. **The "decided · 0.93" mark** only where a decision changed something visible.
16. **CONTRIBUTING.md**: a bounded exception to the one rule for typed decision services.
17. **Scope: one delivery, every point.** No v1 / v2 / later split: all the decision points below are built together. The order below only sequences the work inside that delivery. Every point still ships off.
18. **No voice point.** The voice-actions plan (a Siri shortcut dictating an objective) was discarded by the owner, so there is no `voice.intent`; natural-language intent routing lives only in the command palette.

## Decision points (all in the one delivery, in build order)

Order criteria: Claude quota saved, quality, how cleanly shadow can measure it, effort, risk.

**First, with an outcome signal already stored:**

| Point | Kind | Scope | Where (ecosystem branch) | Outcome signal |
| --- | --- | --- | --- | --- |
| `flow.refine-needed` | act | P | `flow.ts` refine stage, before launch | card later bounced or edited by the person |
| `flow.bounce` | act | P | `flow.ts:805` (fixed `maxBounces` today) | next QA verdict |
| `orchestration.retry` | act | P | `orchestrator.ts` `settle` | the retry's result |
| `supervisor.intervene` | act | G | `supervisor.ts` | hint sent or discarded |
| `memory.triage` | suggest | P | `memory-proposals.ts` | approve / reject rows |
| `assistant.rerank` | suggest | P | `assistant.ts` proposals | accept / discard rows |

**Then:** `journal.relevance` (today `journal.ts` hands the newest entries up to 16 KB, so old decisions fall off), `board.triage` (live suggestions while typing), scope-drift check per commit, acceptance-criteria pre-check before QA, semantic loop detection (health.ts only catches exact repeats), `health.test-weakening` (content written by the agent it judges: injection risk, suggest only until shadow data says otherwise), `orchestration.model` (suggest only, in the draft plan).

**Also in the same delivery:** unexplained hunks in changes review (DiffView), natural-language command palette intent routing, `team.assign`, notification urgency.

## When the ecosystem is merged

Write the English rule into CONTRIBUTING.md and CLAUDE.md and apply it to the ecosystem prompts; map every decision point again on main (assistant included, and the global Agentry assistant if it exists by then) and add any new ones; write `docs/plans/decision-engine.md` from scratch with the decisions above, as one delivery split into orchestrations landing on one feature branch; then prototypes.

Related: [[plans/project-ecosystem.md]], [[plans/agent-observability.md]], [[decisions/english-technical-language.md]].
