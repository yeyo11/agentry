---
created_at: 2026-09-28T20:30:00Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - plan
    - assistant
    - mcp
    - chats
    - proposed
---
# Plan: the Agentry assistant, a chat that knows Agentry

Status: **proposed, next after the ecosystem**, which merged into main in #118 on 2026-09-28. Decided
with the owner on 2026-09-28.

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
  tools are specified in [agentry-mcp-server.md](agentry-mcp-server.md) (CW-6), which proposes
  `packages/mcp` and fixes the server name `agentry`:
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

**Owner's choice: pending.** The spec [assistant-write-tools.md](assistant-write-tools.md) is written
for option A, the recommended one, but CW-17 is not built until the owner picks A, B or C here, with
the date. Once they have answered, replace this paragraph with: "Decided on <date>: option <X>".

## Open questions

- Where the entry lives in the design system (a new primary surface needs the designer; the gradient
  budget allows two per screen).
- The model by default (`sonnet` like the project assistant, or the person's default).
- Whether the project assistant's page becomes a mode of this assistant or stays as it is.
- Which write tools ship first (suggested: work items and comments, retry of a failed run or task).

## Related

[[assistant.md]] · [[plans/agentry-mcp-server.md]] · [[plans/assistant-write-tools.md]] · [[plans/agentry-assistant-entry.md]] · [[plans/chat-api-token.md]] · [[chat-environment.md]] · [[plans/project-ecosystem.md]] · [[plans/orchestration-speed.md]] · [[decisions/decision-engine.md]]
