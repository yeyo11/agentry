---
created_at: 2026-09-30T19:00:00Z
updated_at: 2026-09-30T19:00:00Z
tags:
    - decision
    - decision-engine
    - jev
    - shadow
    - metrics
---
# Decision: keep every point in shadow; Jev has not shown a benefit yet

The first day of Jev in shadow (2026-09-30, 10:49 to 18:00, 735 requests, all `jev` in `shadow`)
was reviewed from `GET /decisions` and `/decisions/stats`.

## What the data says

- **Nothing acted.** `acted` is 0 in every row, no Claude run was saved, `costUsd` is null in all
  rows (the SDK reports none), and 807k input tokens were sent.
- **Latency is as planned.** Median 432 ms, p90 1.1 s, p99 1.5 s.
- **Timeouts are an episode, not a trend.** 158 requests (21 %) hit the 1.5 s deadline, 89 of them
  between 16:50 and 17:40 (70 % of the requests of that window); outside it the rate is 11 %. Every
  one fell back to today's behaviour. `unavailable` rows carry no token count, so a timeout cannot be
  read against request size.
- **Little of it is scored.** 159 of 735 rows have an outcome and one has feedback. Two resolvers
  were weak:
  - `notification.urgency` counted a push nobody tapped as "normal was right". Most pushes are
    ignored, so 76 of 104 "agreed" mostly measured the share of `normal` answers. It now scores
    only a push opened within the hour (see [decision-engine.md](../decision-engine.md#shadow-accuracy)).
  - `changes.unexplained-hunk` (49 of 52 answers "unexplained") and `health.semantic-loop` have
    almost no resolved rows: their signal (QA on the card, a supervisor hint) rarely follows.
- **Confidence is informative where it was scored.** `notification.urgency` with confidence >= 0.85
  agreed 42 of 42, below 0.6 only 12 of 37 (before the resolver change, so read it as a hint).
- **Weak points.** `run.continuation` agreed 6 of 23 and its confidence did not help (2 of 13 at
  >= 0.85); `team.assign` always said `developer` and agreed 0 of 5. Small samples.
- **The points that would save Claude runs have no data:** `flow.refine-needed` 2 requests,
  `flow.bounce` 0, `orchestration.retry` 0.

## Decision

No point moves to `active`. Re-run this review with one to two weeks of rows, the real Jev cost,
and, for `run.continuation` and `team.assign`, the `cli` provider as a comparison.

## Related

- [[decision-engine.md]]
- [[plans/decision-engine.md]]
