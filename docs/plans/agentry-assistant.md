---
created_at: 2026-09-28T20:30:00Z
updated_at: 2026-10-03T10:00:00Z
tags:
    - plan
    - assistant
    - mcp
    - chats
    - proposed
---
# Plan: the Agentry assistant, a chat that knows Agentry

Status: **in progress** (umbrella CW-30, GitHub issue #189). Decided with the owner on 2026-09-28,
open questions answered on 2026-10-02. Built: the MCP server with its read tools (CW-6, #171) and the
per-chat API token (CW-10). Specified, not built: the global entry and chat (CW-18) and the write
tools (CW-17). See [Delivery](#delivery-the-umbrella-cw-30).

## What the owner asked for

The project assistant ([assistant.md](../assistant.md)) proposes a team, resources and tasks for one
project, and is read-only. The owner wants more: **an assistant with weight in the app, an agent
expert in Agentry**, that does not need a project picked first, that greets the person when a chat
opens ("what can I do for you?"), and that answers questions about the state of things ("how is
AGN-12 going?", "why did the verification of orchestration 7 fail?", "how much did I spend today?")
and can act on them.

## Decisions (2026-09-28)

1. **When:** a feature of its own, after the ecosystem PR (#118, merged on 2026-09-28). It did not
   delay that PR.
2. **How it reaches Agentry:** Agentry ships **its own MCP server**, handed to the chat with
   `--mcp-config` and `--strict-mcp-config`. It talks to the REST API of the wrapper that spawned the
   chat (`AGENTRY_API_URL`, see [chat-environment.md](../chat-environment.md)). This keeps the one
   rule: Agentry still reaches Claude Code only through its CLI, and the CLI reaches Agentry through
   a tool Agentry configured. Rejected: `curl` through `Bash` (no `Bash` rule can be told apart from
   a write, see assistant.md "It can only read"), and a snapshot of the state in the prompt (stale,
   and it cannot look up details).
3. **It can write too**, not only read (the owner's answer to option A, which offered writes as
   proposals).

## Shape (to refine in the plan of its orchestration)

- **The MCP server** (`packages/core` or a small `packages/mcp`), stdio, started by the CLI. Its read
  tools are specified in [agentry-mcp-server.md](agentry-mcp-server.md) (CW-6), which built
  `packages/mcp` (feature doc: [../agentry-mcp-server.md](../agentry-mcp-server.md)) and fixed the
  server name `agentry`:
  - read tools: projects, work items (board, one item with its history, links and runs),
    orchestrations (list, one with tasks, verification and final report), flow runs and team,
    journal and documents, chats (list, summary, waiting), usage and limits, accounts;
  - write tools: create/update/move a work item, comment, start/stop/retry a flow run or an
    orchestration task, start a chat, accept/discard an assistant proposal.
- **The chat:** a global entry (sidebar or top bar, the palette, and "Asistente" wherever it is now)
  that opens an assistant chat with no project required; the project in scope, if any, is context,
  not a requirement. Its first message greets and offers what it can do. It is a normal chat: it
  counts in Usage, it has a transcript, it can be continued.
- **Confinement:** `--tools` limited to the Agentry MCP tools (plus `Read`/`Grep`/`Glob` if it should
  read project files), `--setting-sources=` so no user settings add rules, no shell, no editor.
- **Writes are the person's call.** Open question for the plan, pick one:
  - A. every write tool goes through the CLI's permission prompt, which Agentry already shows as a
    host permission prompt in the chat (`permissionPrompts: 'host'`): the person allows or denies each
    one (recommended: it reuses what exists and the person sees exactly what will change);
  - B. writes are allowed outright and listed in the chat as they happen, with undo where possible;
  - C. writes become proposals accepted one by one, like the project assistant's.
- **Expert in Agentry:** its system prompt carries a short guide to Agentry's concepts (projects,
  work items and columns, team and flow, orchestrations, verification, accounts and limits) and the
  README's REST tables are the reference for the tools; the knowledge base (`docs/`) can be offered
  read-only.

## Confirming writes (CW-17)

Decided on 2026-10-02: option A (the owner said to follow the recommendations). Writes are confirmed with the CLI's own permission prompt that Agentry already shows. The spec [assistant-write-tools.md](assistant-write-tools.md) is written for it.

## Open questions

- Where the entry lives in the design system (a new primary surface needs the designer; the gradient
  budget allows two per screen). Still open: criterion 1 of CW-18 draws it.
- ~~The model by default~~: `sonnet` (2026-10-02, see [agentry-assistant-entry.md](agentry-assistant-entry.md)).
- ~~Whether the project assistant's page becomes a mode~~: it stays as it is in CW-18; folding the
  two is a follow-up (2026-10-02).
- ~~Which write tools ship first~~: the nine of [assistant-write-tools.md](assistant-write-tools.md).

## Delivery: the umbrella CW-30

CW-30 (from GitHub issue #189) is the umbrella of this plan on the board. It replaces the earlier epic
key CW-12, which the story specs still name. It ships no code of its own: it is done when its stories
are built and the whole journey below works on `main`.

| Story | Spec | State (2026-10-03) |
|---|---|---|
| CW-6, MCP server and read tools | [agentry-mcp-server.md](agentry-mcp-server.md) | built (#171), feature doc [../agentry-mcp-server.md](../agentry-mcp-server.md) |
| CW-10, per-chat API token | [chat-api-token.md](chat-api-token.md) | built |
| CW-18, global entry, confined chat, greeting, `POST /assistant/chats` | [agentry-assistant-entry.md](agentry-assistant-entry.md) | refined, owner's questions answered; the design reference is not drawn yet |
| CW-17, write tools confirmed by the CLI's permission prompt (option A) | [assistant-write-tools.md](assistant-write-tools.md) | refined, option A decided |

**Order.** CW-18 first, then CW-17. CW-18 builds the assistant chat's argv in one function, with the
read tools under `dontAsk`; CW-17 extends that same function (`default` + `permissionPrompts: 'host'`)
and adds the write tools, so it cannot land first. Inside CW-18, the design reference (its criterion 1)
comes before the web work; the core and the API can be built in parallel with the fake CLI.

**The journey that closes the umbrella.** With no project in the store, a person opens the assistant
from its entry, sees the greeting, asks "how is CW-x going?" and gets an answer from a read tool with
no prompt. They ask it to create a work item, see the host permission prompt titled in their
language, allow it, and the item exists with an agent actor of role `assistant` and a chat cause; the
same request denied changes nothing. The chat is listed in Chats by its first prompt, counts in Usage,
and keeps its confinement when resumed, forked or picked up after a restart.

**Not in the umbrella** (each becomes its own card when the owner wants it):

- stop tools for a flow run or an orchestration task, `rerun`, `skip`, `retry-clean`, deleting a work
  item, and moving a card to Done (CW-17's open questions);
- `Read`/`Grep`/`Glob` over project files and read access to `docs/`;
- the project assistant's page as a mode of this assistant;
- live figures in the greeting, if CW-18 leaves them out;
- the decision-engine point for the assistant's tool choice ([decision-engine.md](decision-engine.md)).

## Related

[[assistant.md]] · [[plans/agentry-mcp-server.md]] · [[plans/assistant-write-tools.md]] · [[plans/agentry-assistant-entry.md]] · [[plans/chat-api-token.md]] · [[chat-environment.md]] · [[plans/project-ecosystem.md]] · [[plans/orchestration-speed.md]] · [[decisions/decision-engine.md]]
