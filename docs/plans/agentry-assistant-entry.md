---
created_at: 2026-09-28T23:30:00Z
updated_at: 2026-09-28T23:30:00Z
tags:
    - plan
    - spec
    - assistant
    - mcp
    - chats
    - design-system
    - proposed
---
# Spec: a global entry for the Agentry assistant (CW-18)

This spec covers story CW-18 of the epic CW-12, "The Agentry assistant". Status: **refined, not built**.
It builds the "The chat" bullet of [agentry-assistant.md](agentry-assistant.md), which records the
owner's decisions of 2026-09-28. Those decisions are not reopened here: Agentry ships its own MCP server, passed with
`--mcp-config` and `--strict-mcp-config`, and the assistant can write.

## What and why

Today the only assistant is the **project** assistant ([assistant.md](../assistant.md)). You need
a project to use it, it runs one structured turn, and a person who continues its chat by hand gets an
ordinary chat. The owner wants an assistant that knows Agentry, which you can open from anywhere,
with or without a project. It should greet the person and say what it can do, and then behave like
any other chat.

CW-18 is **the entry and the chat**: where the person opens it, how the chat starts and stays
confined, and the first message. The MCP server and its read tools are CW-6, and the write tools are CW-17.

## The one rule

The assistant is a CLI chat. It reaches Agentry only through the Agentry MCP server, which the CLI
starts because Agentry wrote it into the `--mcp-config` file. It uses no SDK and makes no HTTP call
to Anthropic, and the greeting is not produced by a model call (see [The greeting](#the-greeting)).

## Depends on

| Dependency | Why | Status |
|---|---|---|
| **CW-6**, the Agentry MCP server and its read tools (`packages/core` or `packages/mcp`), assumed to be named `agentry` so its tools reach the CLI as `mcp__agentry__<name>`, as [assistant-write-tools.md](assistant-write-tools.md) assumes too | the chat is confined to its tools. Without it the chat has nothing to do | not built (`packages/` has only `shared` and `core`) |
| **CW-17**, the write tools and how each write is confirmed ([assistant-write-tools.md](assistant-write-tools.md)) | it sets the chat's permission mode and prompts. CW-18 does not wait for it: it ships with the read tools | proposed, waiting for the owner's A/B/C |
| CW-10, a per-chat API token ([chat-api-token.md](chat-api-token.md)) | the MCP server calls `AGENTRY_API_URL`. In `token` mode (the desktop app with the tunnel) it gets `401` without `AGENTRY_API_TOKEN` | proposed |
| The design reference for the entry, desktop and phone | a new primary surface counts against the gradient budget | to draw (criterion 1) |
| The owner's answers (see [Questions for the owner](#questions-for-the-owner)) | the default model, the project assistant page, and the greeting | open |

A developer can build and test the core and the API with the fake CLI and a stub MCP config before
the server lands. The e2e and the release need the server, and the web needs the design reference.

## Behaviour

### Opening it

- **With no project.** The entry is always there, whatever the project scope is, including "All
  projects" and a fresh install with no projects.
- **With a project in scope.** The selected project is **context, not a requirement**. It is named in
  the system prompt (id, name, key prefix, path), and the entry screen shows it ("Con pagos-api como
  contexto"). The person can clear it on that screen before sending, so the chat starts with no
  project.
- **Working directory.** The chat runs in the project's path when a project is in scope and its
  directory exists. Otherwise it runs in the wrapper workspace, which is the default `cwd` of
  `NewChatRequest`. The chat has no file tools (see the next section), so the directory only decides
  which project the chat is listed under in Chats.

### The chat is confined, and stays confined

The chat is started **by the core**, never from options the web sends, so a request cannot widen it.
It uses the same mechanism as the project assistant's `ChatConfinement` (`packages/core/src/chats.ts`):

| Flag | Value |
|---|---|
| `--tools` | empty: no built-in tool at all. No `Read`/`Grep`/`Glob` in this story (see [Out of scope](#out-of-scope)) |
| `--mcp-config=<file>` + `--strict-mcp-config` | a file holding only the Agentry MCP server, with `AGENTRY_API_URL`, `AGENTRY_CHAT_ID` and, once CW-10 lands, `AGENTRY_API_TOKEN` in its environment |
| `--setting-sources=` | no user, project or local settings, so none of their rules, hooks or servers apply |
| no `--add-dir` | no uploads directory (`uploads: false`) |
| no `--allow-dangerously-skip-permissions` | the chat can never be switched to `bypassPermissions` |
| `--allowedTools` | the MCP server's read tools, by name (`mcp__agentry__…`) |
| permission mode / `permissionPrompts` | until CW-17 ships: `dontAsk`, so anything that is not a read tool is denied. CW-17 then changes this in the same place (option A: `default` + `permissionPrompts: 'host'`). CW-18 builds the argv in **one function** that CW-17 extends, not in two |
| `--append-system-prompt` | the Agentry guide (concepts: projects, work items and columns, team and flow, orchestrations, verification, accounts and limits), the project in scope if any, and "answer in <language>" |
| `--model` | the owner's default (see [Questions for the owner](#questions-for-the-owner)) |

Once started, it behaves like **a normal chat**:

- it is listed in Chats by its first prompt;
- it counts in Usage and in the status bar's "today";
- it has a transcript and can be exported;
- it keeps a live process between turns (`keepAlive`), unlike a one-turn project assistant run.

**It remembers what it is.** The stored chat record (the `chats` row's JSON) carries an assistant
marker, for example `agentryAssistant: { projectId: string | null, language: 'en' | 'es' }`. The
shared chat type exposes it so the web can tell. This is a change to `packages/shared/src/types.ts`.

**Continuing does not widen it.** Resume (`POST /chats/:id/resume`), a new turn, a fork
(`POST /chats/:id/fork`) and a restart that picks the chat up again all apply the same flags again,
and the same appended prompt. This is the opposite of the project assistant, whose chat becomes
ordinary when a person continues it by hand. The core ignores any `allowedTools`, `disallowedTools`,
`toolPreset`, `mcp`, `permissionMode` or `appendSystemPrompt` in the request. The model may change on a resume, as on any chat. A fork of an assistant chat is an
assistant chat.

### The greeting

**Recommendation (to confirm, see [Questions for the owner](#questions-for-the-owner)):** the greeting
is **drawn by the web, from i18n**. It is not a model turn.

- It is instant and costs nothing. No turn runs until the person asks something.
- It is the same every time, so a test can check it, and it is in the person's language by
  construction: `en`/`es` with parity.
- The chat's title stays **the person's first prompt**, as the design system requires. A greeting
  turn would have to start the chat with a prompt the person never wrote, and that prompt would
  become the title.

What it shows:

- a greeting with the assistant's mark (`AssistantMark`, never the gradient);
- "What can I do for you?";
- what the assistant can do, as a short list that follows what the MCP server offers. For example:
  - the state of projects and the board ("¿Cómo va AGN-12?");
  - orchestrations and why one failed;
  - flow runs and the team;
  - usage and limits ("¿Cuánto he gastado hoy?");
  - and the writes, only once they ship.
- Each item is a **starter**, a suggestion chip that fills the composer, so the person can pick one
  or type.

The greeting is the **first message of the chat view** of every assistant chat. It shows on the
entry screen before the chat exists, and at the top of `/chats/:id` for an assistant chat, including
one reopened later from Chats.

**Language.** The web sends `Accept-Language` (as the project assistant does), and the core stores it
on the chat marker. The appended prompt tells the model to answer in that language, and a restart
reads it from the marker, not from a later request.

### Where it lives: for the designer

The designer draws this before anything is built (criterion 1). The constraints, from
[design-system.md](../design-system.md):

- **The gradient budget.** The top bar's "Nuevo chat" split button is shell and is not counted. A
  screen has at most two gradient surfaces on top of it. The assistant's sparkle (`.ai-mark`) is
  **never the gradient**. So an entry drawn as a ghost button or a nav item with the sparkle costs
  nothing. An entry drawn with the gradient uses up a slot on **every** screen, and the design review
  already refused that for the project assistant (decision 3: a ghost "Asistente").
- **Candidates**, for the designer to pick from or to replace:
  1. a sidebar item "Asistente" with the sparkle in the Work group, under Inicio. On a phone, the same
     item goes in the Más sheet, because the tab bar has four tabs and they stay four;
  2. a ghost sparkle icon button in the top bar, before the bell. On a phone, the same icon in the
     top bar (44 px);
  3. an entry "Asistente de Agentry" inside "Nuevo chat ▾" (`startEntries` in `App.tsx`). On a phone
     that list is in the Más sheet.
- **The screen itself.** The entry screen is either `/assistant` or a panel, and its phone version
  either has `phoneHeader: 'page'` or does not. It is **not** an `Empty` illustration screen,
  because the greeting is content. The working composer carries the one energy border, as on any
  chat.
- **Deliverables.** `DesktopAsistenteAgentry.html` and `MobileAsistenteAgentry.html` (names
  indicative) in `docs/design-system/reference/`, with dark and light screenshots, and an entry in
  `reference/index.html`. Any new class goes in `agentry-ds.css` and `design-system.md` with its
  mapping.

### The palette

- A new action is **always present**, with or without a selected project: "Asistente de Agentry" /
  "Agentry assistant", with the icon `Sparkle`. Its hint is "Con <project> como contexto" when a
  project is selected, or "Pregunta por proyectos, tareas, orquestaciones o uso" when none is.
  Keywords: `assistant agentry ask help mcp asistente`.
- The existing "Asistente del proyecto" and "<project> — asistente" entries stay as they are until the
  owner answers the mode question. The two entries must be told apart by title.

## Routes and types

- **A new route**, proposed as `POST /assistant/chats`. The architect may rename it, but it must
  not collide with the project assistant's `/assistant/runs`.
  - Body: `{ prompt: string, projectId?: string | null, model?: string }`.
  - It answers what `POST /chats` answers.
  - It returns `404` for an unknown `projectId` and `400` for an empty prompt. No other start option
    is accepted.
- **Shared type**: the chat's assistant marker, and the request type.
- **Web API client**: `api.startAgentryAssistant` (name indicative) in `apps/web/src/api`.

## Files it touches

| Piece | Where |
|---|---|
| Starting and re-applying the confinement, the marker, the appended prompt | `packages/core/src/index.ts` (next to `launchAssistantRun`), `packages/core/src/chats.ts` (`ChatConfinement`, resume/fork paths), the chat store in `packages/core/src/db.ts` (JSON field, no new table) |
| The Agentry guide for the system prompt | a new `packages/core/src/agentry-assistant-prompt.ts` (name indicative) |
| The route | a new file or `apps/api/src/routes/assistant.ts`; `apps/api/src/openapi/routes.ts` (summary + tag); the README's [Assistant](../../README.md#assistant) table |
| Types | `packages/shared/src/types.ts`, then `pnpm --filter @agentry/api openapi:schemas` |
| The entry | `apps/web/src/App.tsx` (sidebar groups / `startEntries` / `TabBar` `more`) or `components/shell/TopBar.tsx`, as the design reference says |
| The palette | `apps/web/src/components/CommandPalette.tsx` |
| The entry screen and the greeting | a new `apps/web/src/pages/agentry-assistant/` (name indicative), and the chat view's first message for a marked chat (`pages/ChatView` or its components) |
| Copy | `apps/web/src/i18n` `en` + `es`, following `GLOSSARY.md` |
| Docs | `docs/assistant.md` (a section, or a new `docs/agentry-assistant.md`), `docs/design-system.md`, this plan's status |

## Questions for the owner

Record the answers in [agentry-assistant.md](agentry-assistant.md) before building (criterion 4):

1. **The default model.** `sonnet`, like the project assistant (`DEFAULT_ASSISTANT_MODEL`), or the
   person's default model? *Suggested: `sonnet`.* It reads and acts through tools and does not build,
   and the person can switch the model on a resume, as on any chat.
2. **The project assistant's page.** Should it become a mode of this assistant, or stay as it is?
   *Suggested: it stays as it is in CW-18.* The entry sits beside it, and folding the two together is
   its own story.
3. **The greeting.** Should it be drawn by the web (recommended above), or be a real first turn of
   the model? The second option costs a turn every time the assistant opens, and the chat's title
   would not be the person's first prompt.

## Out of scope

- The MCP server and its read tools (CW-6), and the write tools with their confirmation (CW-17).
- `Read`/`Grep`/`Glob` over project files and read access to `docs/`: add them later, deliberately.
- Changing the project assistant, the wizard, "Sugerir tareas" or the resources with AI.

## Related

[[plans/agentry-assistant.md]] · [[plans/assistant-write-tools.md]] · [[assistant.md]] · [[chat-environment.md]] · [[plans/chat-api-token.md]] · [[design-system.md]] · [[phone-layout.md]]
