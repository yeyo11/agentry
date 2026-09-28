---
created_at: 2026-09-28T19:20:00Z
updated_at: 2026-09-28T19:20:00Z
tags:
    - plan
    - flow
    - team
    - security
    - chats
    - proposed
---
# Plan: starting the cards already on the board, and a token for the chats Agentry starts

Status: **proposed**, decided with the owner on 2026-09-28, right after the project ecosystem
(#118) was merged. Two small changes found on the first real use of the flow.

## 1. Switching the flow on offers to start the cards already waiting

**What happened.** The owner accepted 8 tasks from the project assistant into Backlog (18:55:56 to
18:56:03 UTC), then switched the flow on (18:58:44). No run started. That is the rule as built
([team-and-flow.md, "What starts a run"](../team-and-flow.md#what-starts-a-run)): a run starts when a
card *enters* a column (a person's move, a new card, the flow's own move), and switching the flow on
is none of them. The rule keeps the flow from spending quota on its own, but a person who has just
filled the board and turned the flow on expects it to start.

**Decision (option A).** When the flow is switched on (the `enabled` change saved from the Flow
screen) and there are cards waiting in columns that have a responsible role with a member playing it
(epics and Done excluded), the screen asks:

- "N tarjetas esperan en columnas con responsable" with **"Ponerlas en marcha"** and **"Sólo las
  nuevas"**;
- "Ponerlas en marcha" queues one run per card as if it had entered its column, oldest rank first,
  through the same queue (`maxParallel`, one queued run per item, a backlog card costs one refine
  run), and says how many will start now and how many wait;
- "Sólo las nuevas" keeps today's behaviour.

Rejected: B, starting them always (spends without asking), and C, a per-card or per-column "start"
action only (still leaves the surprise). A per-card "Poner en marcha" can still come later.

**Shape.** Core: a count of the waiting cards per column for a project with the flow on, and a
`POST /projects/:id/flow/start-waiting` (or a flag on the flow's PUT) that queues them with a person
as the actor. Web: the prompt on the Flow screen after saving `enabled: true`, in the design system's
dialog, en/es. Tests: core (queued in order, caps respected, epics and Done left out), web, and an
e2e step in `team-gaps` or `team.spec`.

## 2. A chat Agentry starts gets its own API token

**What happened.** Every chat gets `AGENTRY_API_URL` ([chat-environment.md](../chat-environment.md))
so it calls the wrapper that started it. With the API in token mode (the owner's desktop app, set up
for the tunnel), the chat has no credential: every call answers 401, so the variable is useless
exactly where it matters. Diagnosing the case above, the chat had to read `wrapper.db` read-only
instead.

**Decision (option A).** Agentry mints a **token per chat run**, handed as `AGENTRY_API_TOKEN` next to
`AGENTRY_API_URL`:

- short-lived and revoked when the chat's process ends;
- accepted only from loopback;
- stored hashed, like the owner's token (`auth.json` keeps only a hash);
- audited as the chat (`AGENTRY_CHAT_ID`), so a write says which chat made it;
- honoured in token mode and ignored (not needed) when the API is open.

Rejected: B, loopback without a token (any local process would get full access), and C, waiting for
the Agentry assistant's MCP server ([agentry-assistant.md](agentry-assistant.md)), which will itself
need this credential to call the API.

**Shape.** Core/API: a chat-token store in the security layer, minted in the chat runtime when it
spawns the CLI, checked by the guard next to the owner's token, revoked on exit and on restart. Docs:
`chat-environment.md` and the security doc. Tests: a chat's token opens the API from loopback, fails
from elsewhere and after the chat ends.

## Related

[[team-and-flow.md]] · [[chat-environment.md]] · [[plans/agentry-assistant.md]] · [[plans/project-ecosystem.md]]
