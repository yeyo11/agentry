---
created_at: 2026-09-29T18:00:00Z
updated_at: 2026-09-29T18:00:00Z
tags:
    - decision
    - orchestration
    - performance
    - persistence
---
# Decision: an orchestration's timings are computed on read, and its chats are linked by their records

Taken while building CW-13 ([orchestration-timings.md](../orchestration-timings.md)).

## Computed on read, not stored

`GET /orchestrations/:id/timings` is worked out on every request from the stored graph and the
executions of its chats. Nothing new is stored for it and there is no cache.

- The figures are derived: storing them would be a second copy that drifts from the executions it
  came from, and a definition that improves (it did twice while this was built) would leave every
  stored figure behind.
- What the route needs is only a handful of new raw facts, and those are stored where they belong:
  phase start and end on the graph's JSON document, and a history of runs and fixes on
  `VerificationState`. They are small, bounded per graph, and part of the graph's own document, so
  they stay in it rather than becoming SQLite rows.
- The cost is one pass over a graph's chats per request, and the page reads it only when the graph
  changes phase.

## Linked by the chat records

`ChatService.chatOrchestrations()` now builds its map from each chat record's `orchestrationId` and
`orchestrationTaskId`, which every chat Agentry starts for a graph has always carried, instead of
from the graph's current session ids. The graph's ids stay as a fallback for chats without a record.

- The graph only remembers a task's current chat, so a chat a clean retry replaced, the integrator
  and the fixer were unlinked, and the usage report left their cost out of the orchestration.
- The record is written when the chat starts, by the code that knows why it started, so the link
  cannot go stale.
- The role is derived from the pseudo-task id, so no migration is needed: every older chat gets its
  role on the next read.

## Related

[[orchestration-timings.md]] · [[plans/orchestration-timings.md]] · [[plans/orchestration-speed.md]]
