---
created_at: 2026-09-30T11:13:00Z
updated_at: 2026-09-30T11:13:00Z
tags:
    - decisions
    - decision-engine
    - jev
    - shadow
    - report
---
# Jev in shadow: first measurements

A report on what the decision engine ([decision-engine.md](../decision-engine.md)) recorded with
**Jev as the provider and every point in shadow**, read from `GET /decisions` and
`GET /decisions/stats` on the owner's desktop app (0.26.0). It is updated as data arrives; the
figures below are from **2026-09-30 11:12 UTC**.

## Verdict

**The integration works; whether Jev adds value cannot be said yet.** The sample is 51 decisions in
23 minutes, from one project and one day of use, with 4 of them resolved. It is a smoke test, not an
evaluation. Nothing here justifies moving any point to `active`.

## The sample

| | |
| --- | --- |
| Decisions | **51** (first 10:49:45, last 11:12:09 UTC) |
| Provider, mode | 51 Jev, 51 shadow |
| Answered / unavailable | **51 / 0** |
| Acted | 0 (shadow cannot act) |
| Resolved (outcome and agreement written) | **4** (2 agreed, 2 did not); 1 marked Useful by the owner |
| Latency | median **348 ms**, p90 624 ms, max 775 ms |
| Input tokens | 76,403 in total, about 1,498 per decision |
| Cost | about **0.003 US$** at 0.042 US$ per million input tokens. The app records **`costUsd: null` on every row** and shows 0 US$ |
| Claude runs saved | 0, by design: only `active` points save runs |

It grew from 37 decisions (10:49 to 11:07) in the first reading to 51 (to 11:12) in this one.

## By point

Confidence is the answer's confidence; the act threshold is 0.85.

| Point | n | Mean confidence (range) | At or above 0.85 | Answers | Agreement |
| --- | ---: | --- | ---: | --- | --- |
| `health.semantic-loop` | 19 | 0.69 (0.55 to 0.79) | 0 | not a loop: 19 of 19 | none resolved |
| `notification.urgency` | 10 | 0.71 (0.08 to 0.98) | 6 | normal 8, high 2 | 1 of 1 |
| `changes.unexplained-hunk` | 5 | 0.60 (0.53 to 0.65) | 0 | unexplained: 5 of 5 | none resolved |
| `journal.relevance` | 3 | **0.00** | 0 | no real answer | none resolved |
| `team.assign` | 3 | 0.71 (0.66 to 0.74) | 0 | developer: 3 of 3 | none resolved |
| `run.continuation` | 2 | 0.69 (0.46 to 0.91) | 1 | done 1, owes work 1 | 0 of 1 |
| `flow.scope-drift` | 1 | 0.72 | 0 | not drifting | none resolved |
| `flow.criteria-precheck` | 1 | 0.86 | 1 | every criterion met or unknown | none resolved |
| `supervisor.intervene` | 1 | 0.85 | 1 | intervene | 1 of 1 |
| `memory.triage` | 1 | 0.59 | 0 | high | none resolved |
| `flow.criteria-merge` | 1 | 0.55 | 0 | no duplicate | none resolved |
| `flow.refine-needed` | 1 | 0.50 | 0 | refine | 0 of 1 |
| `board.triage` | 1 | 0.40 | 0 | story, medium, not a duplicate | none resolved |

## The four resolved rows

| Point | Jev said (confidence) | What happened | Agreed |
| --- | --- | --- | --- |
| `supervisor.intervene` | intervene (0.85) | the hint was sent | yes |
| `notification.urgency` | normal (0.96) | the owner marked it Useful | yes |
| `run.continuation` | owes work (0.46) | nothing was left undone | **no** |
| `flow.refine-needed` | refine (0.50) | the refine changed nothing | **no** |

Both misses had confidence at or below 0.5, so at the 0.85 threshold neither would have acted. That
is what a calibrated confidence should do, but four rows prove nothing.

## What the data suggests

1. **Jev is fast and cheap.** Sub-second and a fraction of a cent for 51 questions, with no failure.
2. **Confidence is low almost everywhere.** Only 9 of 51 answers clear 0.85 (6 of
   `notification.urgency`, and one each of `supervisor.intervene`, `flow.criteria-precheck` and
   `run.continuation`). With the default threshold almost no point would act in `active`, which is
   right until accuracy is measured.
3. **`notification.urgency` is the only point that discriminates.** It separates clear cases (a run
   finishing: normal, 0.98) from health alerts, and it is the most promising candidate.
4. **`health.semantic-loop` says "not a loop" every time** (19 of 19, confidence 0.55 to 0.79). It may
   be right, since no chat was looping, but there is **no positive case** to show it would detect
   one.
5. **`changes.unexplained-hunk` marks every hunk unexplained** (5 of 5, confidence 0.53 to 0.65), yet
   these were memory and document edits made by the chat that had just said why. It looks too strict
   on this sample.
6. **`journal.relevance` returns confidence 0 with the four levels almost tied** (irrelevant 0.51,
   related 0.18, relevant 0.09, essential 0.22). It carries no information. Either the question is
   a poor fit for Jev or the state it receives is not enough.
7. **`flow.criteria-precheck` answered "met or unknown" for every criterion** with confidence 0.86 to
   1.0 on a card that had just been built: plausible, but it cannot tell met from unknown, which is
   its design.

## Defects found while measuring

- **The cost of Jev is not recorded.** `costUsd` is `null` on every row and `jevCostUsd` is 0, so the
  Usage line under-reports. The input tokens are stored, so the cost can be derived
  (`inputTokens x 0.042 / 1,000,000`). To fix.
- **Shadow agreement is empty for three points** until CW-28 adds their resolvers
  (`palette.intent`, `notification.urgency`, `orchestration.model`). CW-28 is in QA review at the
  time of writing.

## What to do next

1. **Keep every point in shadow for about seven days of normal use**, with the flow and
   orchestrations running, until each point that matters has 20 to 30 resolved cases.
2. **Fix the cost measurement** before reading the Usage line.
3. **Re-read this report** with the new resolvers in place, and only then consider `active`, one
   point at a time, starting with `notification.urgency`.
4. **Review `journal.relevance` and `changes.unexplained-hunk`** before relying on them.

## Related

- [[decision-engine.md]]: the feature.
- [[plans/decision-engine.md]]: the plan and its Outcome.
- [[decisions/decision-engine.md]]: the owner's decisions.
