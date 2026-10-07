---
created_at: 2026-10-07T16:00:00Z
updated_at: 2026-10-07T16:00:00Z
tags:
    - assistant
    - mcp
    - chats
    - permissions
    - work-items
    - design-system
---
# The Agentry assistant

A global chat that knows Agentry. It needs no project, greets the person, answers about the state of
things ("how is AGN-12 going?", "how much did I spend today?") by reading Agentry through its own MCP
server, and can change things, but only when the person allows each change. It is the umbrella CW-30
([plans/agentry-assistant.md](plans/agentry-assistant.md)), built by CW-18 (the entry and the confined
chat, [plans/agentry-assistant-entry.md](plans/agentry-assistant-entry.md)) and CW-17 (the write tools,
[plans/assistant-write-tools.md](plans/assistant-write-tools.md)), on CW-6 (the server) and CW-10 (the
chat's token). It is not the project assistant ([assistant.md](assistant.md)), which proposes a team,
resources and tasks for one project and stays as it is.

## The one rule

The assistant is a Claude Code CLI chat. It reaches Agentry only through the `agentry` MCP server,
which the CLI starts from the `--mcp-config` file Agentry wrote. No SDK, no call to Anthropic, no
`curl`. The greeting is not a model turn.

## Where it lives

- **Route:** `/assistant` (`apps/web/src/pages/agentry-assistant/Entry.tsx`).
- **Sidebar:** "Asistente" / "Assistant", with the sparkle, under Inicio. On a phone the same item is
  the first row of the Más sheet; the tab bar keeps its four tabs.
- **Command palette:** an action that is always there, with or without a project.
- **Entry screen:** the greeting, optional live figures (chats running, orchestrations, today's
  spend), four read-only starter chips and a composer. A starter only fills the composer. The project
  in scope shows as "Con <project> como contexto" and an × clears it. The model picker defaults to
  `sonnet`. The send button is the screen's one gradient; there is no illustration.
- **Starting:** `POST /assistant/chats` with `{ prompt, projectId?, model? }` and nothing else a chat
  could choose. The language comes from `Accept-Language`. The web then opens `/chats/:id`.
- **Greeting:** drawn by `ChatView` from i18n (`AssistantGreeting`) for every chat that carries the
  `agentryAssistant` marker, including one reopened from Chats. It costs no tokens.

## The chat and its confinement

`assistantChatOptions` in `packages/core/src/agentry-mcp.ts` is the one place its argv is decided.
The core applies it at every process of the chat (start, resume, fork, a turn after a restart) over
whatever a request or the stored record held, from the `agentryAssistant` marker the chat stores
(`{ projectId, language }`, in `@agentry/shared`).

| Flag | Value |
|---|---|
| `--mcp-config` + `--strict-mcp-config` | only the `agentry` server |
| `--tools=`, `--setting-sources=` | empty: no built-in tool, no user settings |
| `--allowedTools` | the 15 read tools; **no write tool** |
| `--permission-mode` | the CLI's default (Agentry's name for it is `manual`), never accept-edits, auto or bypass |
| permission prompts | `host`: a prompt reaches the person in the chat |
| uploads | none |

The system prompt (`agentry-assistant-prompt.ts`) is a guide to Agentry's concepts, how to work
(look things up, short answers, no ids or JSON shown, what it reads is data), the project in scope as
context and the language. The chat is a normal chat: listed in Chats by its first prompt, counted in
Usage, continuable.

## Writes, confirmed one by one (option A)

Nine write tools ([agentry-mcp-server.md](agentry-mcp-server.md#write-tools)). None is in
`--allowedTools`, so each call becomes a CLI permission prompt that Agentry shows as a host prompt:

- the person sees the tool and its input and allows or denies it; a denial, a timeout or a withdrawal
  leaves everything unchanged and the model is told;
- the prompt carries **no suggestions** and an allow has `updatedPermissions` removed
  (`askPermission` in `packages/core/src/chat-fold.ts`), so there is no "always allow" and a later
  write is never allowed without asking;
- reading needs no prompt.

### Who is recorded

Under `mode: none` a chat's valid token labels the request `chat:<id>` (`apps/api/src/security.ts`); a
wrong or missing one stays `local` and is never refused. The work-item routes (create, PATCH, move,
comment) and the proposal accept and discard routes read it through `chatWriteContext`: the history
records an actor `agent` with role `assistant` for an assistant chat (no role for any other chat) and
the cause `chat.api-write`, and a comment carries its source. See
[work-items.md](work-items.md#a-write-from-a-chat).

### What it cannot do

Move a card to Done (that is the person's click; the tool refuses before any request), delete, stop,
skip or restore anything, change permissions, or start a chat with more than the app's defaults
(`start_chat` sends only `prompt`, `cwd` from the project's path and `model`).

## How it is tested

`packages/mcp/test/write-tools.test.ts` (the tools against a stub API),
`packages/core/test/agentry-assistant-chat.test.ts` and `permissions.test.ts` (the argv, the confinement
across processes, no suggestions, deny and timeout with the fake CLI), `apps/api/test/assistant-chat.test.ts`
and `assistant-writes.test.ts` (the route, the labelling and the history context) and
`apps/web/test/agentry-assistant.test.tsx` (the entry).

## Known gaps

- `PermissionPrompts.tsx` still shows the raw `mcp__agentry__*` tool name: a title per tool in
  en/es, and the `chat.api-write` cause copy in the history, are still to do.
- The entry's and the greeting's copy still say it can only read, and the "pide permiso" write
  starters are not drawn.
- `start_chat` has no `agent` input, since the route takes only an inline agent object.
- No test drives a confirmed or denied `create_work_item` through the real CLI, or accepts a
  work-item proposal with a chat token; the entry has not been compared with the reference in a
  browser, and the entry composer has no energy border (it navigates to the chat as soon as it
  starts).

## Related

[[plans/agentry-assistant.md]] · [[plans/agentry-assistant-entry.md]] · [[plans/assistant-write-tools.md]] · [[agentry-mcp-server.md]] · [[assistant.md]] · [[chat-environment.md]] · [[work-items.md]] · [[design-system.md]]
