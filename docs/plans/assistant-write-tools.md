---
created_at: 2026-09-28T22:00:00Z
updated_at: 2026-10-07T16:00:00Z
tags:
    - plan
    - spec
    - assistant
    - mcp
    - permissions
    - work-items
    - built
---
# Spec: write tools for the Agentry assistant, each confirmed by the person (CW-17)

Status: **built** on `feat/assistant-entry` (2026-10-07), not merged to `main` yet; see [Outcome](#outcome). Story CW-17 of epic CW-12, "The Agentry assistant". It builds on
[agentry-assistant.md](agentry-assistant.md) and depends on two earlier stories:

- **CW-6**: Agentry's own MCP server, with its read tools.
- **CW-10**: the chat's own API token ([chat-api-token.md](chat-api-token.md)).

Decision 3 of the plan says the assistant writes and does not only read. That decision is not
reopened here.

## Gate: the owner picks how writes are confirmed

The plan leaves one question open: how a write is confirmed. **Nothing in this spec is built until
the owner answers.** The answer goes in the plan's "Confirming writes" section (see
[agentry-assistant.md](agentry-assistant.md)) with its date.

The options, as the plan lists them:

- **A (recommended, and what this spec is written for).** Every write tool goes through the CLI's
  permission prompt. Agentry already shows that prompt in the chat as a host prompt
  (`permissionPrompts: 'host'`), and the person allows or denies each call.
- **B.** Writes run straight away. The chat lists them as they happen, with undo where possible.
- **C.** Writes become proposals that the person accepts one by one, like the project assistant's.

If the owner picks B or C, the sections "Confirmation" and "Tests" have to be written again before
work starts. The tool list, the REST mapping and the attribution rules still apply.

## The one rule

Everything here goes through the CLI:

- the MCP server is started by the CLI with `--mcp-config` and `--strict-mcp-config`;
- the confirmation is the CLI's own `can_use_tool` control request, sent with
  `--permission-prompt-tool stdio`, which `ChatRunner` already answers from the `PermissionBroker`
  (`packages/core/src/chats.ts`, `packages/core/src/permissions.ts`);
- the MCP server calls Agentry's REST API at `AGENTRY_API_URL`, never Anthropic.

No SDK is used.

## The tools

The tools live in the MCP server that CW-6 builds. This spec assumes the server is named `agentry`,
so each tool reaches the CLI as `mcp__agentry__<name>`. If CW-6 chose another name, use that one.

Every tool calls one REST route that already exists. **No route is added.**

| Tool | Route | Input |
|---|---|---|
| `create_work_item` | `POST /api/projects/:id/work-items` | `projectId`, then the body the route accepts (type, title, description, priority, labels, criteria…) |
| `update_work_item` | `PATCH /api/work-items/:itemId` | `item` (an id or a key such as `CW-17`), then the fields to change |
| `move_work_item` | `POST /api/work-items/:itemId/move` | `item`, `status`, and optionally a position |
| `comment_work_item` | `POST /api/work-items/:itemId/comments` | `item`, `body` |
| `retry_flow_run` | `POST /api/flow-runs/:runId/retry` | `runId` |
| `retry_orchestration_task` | `POST /api/orchestrations/:id/tasks/:taskId/retry` | `orchestrationId`, `taskId` |
| `start_chat` | `POST /api/chats` | `prompt`, and optionally `projectId`, `model`, `agent` |
| `accept_assistant_proposal` | `POST /api/assistant/proposals/:proposalId/accept` | `proposalId` |
| `discard_assistant_proposal` | `POST /api/assistant/proposals/:proposalId/discard` | `proposalId` |

Rules that apply to every tool:

- **Input schemas.** Each input schema is a strict JSON Schema, with `additionalProperties: false`
  and the same limits the route validates. A key is resolved to its id with
  `GET /api/work-items/by-key/:key`.
- **Credentials.** Every request sends `Authorization: Bearer $AGENTRY_API_TOKEN` when that variable
  is set. It uses `AGENTRY_API_URL` and never a guessed port.
- **Errors.** When the route answers 4xx or 5xx, the tool returns an MCP error result that carries
  the status and the route's `error` text, so the model can explain or adapt. It does not retry.
- **Success.** The tool returns the route's JSON, trimmed to what identifies the result: the key,
  the id, the new status, and the chat or run id.
- **Descriptions.** Each tool's description says what it changes, in one sentence. For
  `move_work_item`, it adds that a column with the flow on can start a team member.

Rules for particular tools:

- **`start_chat` cannot widen what a chat may do.** Its input has no `permissionMode`,
  `allowedTools`, `disallowedTools`, `toolPreset`, `mcp`, `account`, `confine` or
  `permissionPrompts`. The new chat starts with the app's defaults, including the default tool
  preset. Without this rule, one confirmed call could start an unconfined chat
  (`bypassPermissions`) with a prompt the model wrote.
- **`move_work_item` refuses `done`.** The tool answers with an error that tells the person to move
  the card to Done themselves. This follows the team rule "only a person moves an item to Done"
  ([team-and-flow.md](../team-and-flow.md)). If the owner wants otherwise, see the open questions.
- **Out of scope:** deleting a work item, stopping a flow run or a task, `retry-clean`, `rerun`,
  `skip`, and restoring a proposal. The plan lists stop as a write, but this card does not include
  it.

## Confirmation (option A)

The assistant chat is started with:

- `permissionPrompts: 'host'`;
- `permissionMode` set to `default`, never `acceptEdits`, `auto` or `bypassPermissions`;
- `--setting-sources=` (empty), so that no user or project settings add allow rules.

These settings, the read tools and the write tools apply as follows:

1. **Reads never prompt.** The read tools of CW-6 go into `--allowedTools`.
2. **Writes are never pre-allowed.** No write tool appears in `--allowedTools` or in any tool preset
   the chat uses. A test asserts that the argv of an assistant chat names no write tool in an allow
   flag. Every write therefore reaches `ChatRunner` as a `can_use_tool` request, and the broker shows
   it as a host prompt in the chat.
3. **Allow once, every time.** When the request is for an Agentry write tool (`mcp__agentry__*`
   minus the read tools), `ChatRunner` drops the CLI's `permission_suggestions` before it hands the
   request to the broker. When the prompt is answered, it also ignores any `updatedPermissions` in
   the decision. So no "always allow" can turn later writes into silent ones.
4. **A write that is not confirmed does nothing.** Denying, the 10-minute timeout of the broker
   (which denies), an interrupt, and "no host listening" (the existing `deny` in `chats.ts`) all end
   the same way. The CLI never invokes the tool, the MCP server sends no request, and nothing
   changes: no row, no history entry, no audit row, no event. The deny message reaches the model,
   so that it can tell the person the change was not made.
5. **Editing before allowing.** If the prompt lets the person change the input before allowing it
   (`updatedInput`), the edited input is what runs, and it is validated again by the route.

### The prompt in the chat

`apps/web/src/components/PermissionPrompts.tsx` shows `request.toolName` as it is. For
`mcp__agentry__*` write tools, it shows instead:

- a readable title through i18n, one key per tool in `en` and `es` (for example "Create a work
  item" and "Crear una tarea", following `apps/web/src/i18n/GLOSSARY.md`);
- the `Plug` icon that `icons.tsx` already gives to `mcp__` tools;
- the input, as today, in `.permission-input`.

The Allow and Deny buttons, the reason field and the classes stay as they are, and the e2e specs
select those classes. No "allow and always" button appears, because there are no suggestions to
offer.

The reference screens are `docs/design-system/reference/DesktopChat.html` and `MobileChat.html`,
which show the permission prompt in a chat.

## Attribution

The first two points come from CW-10.

- **The actor.** A request made with the chat's token has `req.actor = chat:<chatId>`. The existing
  `onResponse` hook writes that actor to the audit log (`GET /api/audit`) for every write route above.
- **Open mode.** CW-10 keeps the actor `local` under `mode: none`, even when a chat presents its
  token. That would lose attribution on a machine with the guard off. **This spec amends CW-10:**
  under `mode: none`, a chat token that is presented and valid still sets `req.actor = chat:<chatId>`,
  and it is used only as a label. A missing, invalid or expired token leaves `local`. It never
  answers `401`, and it never grants anything, because open mode grants everything already. A note
  pointing here is added to [chat-api-token.md](chat-api-token.md).
- **The item's history.** The work-item routes (`apps/api/src/routes/work-items.ts`) and the
  proposal accept route (`apps/api/src/routes/assistant.ts`) pass a `WorkItemContext` when the actor
  is `chat:<id>`:
  - `actor: { kind: 'agent', role }`, where `role` is `'assistant'` when the chat is an Agentry
    assistant chat and null for any other chat;
  - `cause: { kind: 'chat', chatId, orchestrationId: null, taskId: null, event: 'chat.api-write' }`;
  - for a comment, the same `source`.

  Today these routes pass no context, so every REST write is recorded as the person. A request from
  the person (owner token, OIDC or `local`) still records `{ kind: 'person' }` with no cause, as
  before.
- **Items made from a proposal.** Items created by accepting a proposal carry the same actor and
  cause in their `created` history entry.
- **The UI.** The item's history in the UI already draws an agent actor with a chat cause. The entry
  links to the assistant's chat. No new UI is needed there, only the check that it renders.

`WorkItemActor`, `WorkItemCause` and `AuditEntry` keep their shape. Only the new cause code
`chat.api-write` is added, with en/es copy where the history translates cause codes. If a shared
type changes after all, regenerate the OpenAPI schemas.

## Where it lives

| Piece | File |
|---|---|
| Write tools | the CW-6 MCP server (`packages/core` or `packages/mcp`), next to the read tools |
| Assistant chat argv (allowed tools, setting sources, permission mode) | where CW-6 / the assistant entry builds the chat's options |
| Dropping suggestions for write tools | `packages/core/src/chats.ts`, the `can_use_tool` branch |
| Chat token as a label under `mode: none` | `apps/api/src/security.ts`, `onRequest` |
| History context for chat actors | `apps/api/src/routes/work-items.ts`, `apps/api/src/routes/assistant.ts` |
| Prompt title for write tools | `apps/web/src/components/PermissionPrompts.tsx`, `apps/web/src/i18n/locales/{en,es}/*.json` |
| Docs | `docs/assistant.md` (or the assistant's own doc from CW-6), `docs/chat-environment.md`, `docs/work-items.md`, this plan |

## Tests

- **MCP server** (unit, with a fake HTTP server standing in for the API). For each of the nine
  tools:
  - the method, path and body it sends;
  - the `Authorization` header;
  - key resolution;
  - an input the schema rejects;
  - a 4xx from the route turned into an error result.

  Also: `start_chat` sends none of the refused fields, and `move_work_item` refuses `done` without
  calling the API.
- **Core** (`packages/core/test/chats.test.ts`, with the fake CLI):
  - A `can_use_tool` for a write tool reaches the broker with no suggestions.
  - Allowed: the CLI receives `allow`.
  - Denied: the CLI receives `deny` with the message.
  - Timed out: the CLI receives `deny`.
  - An `updatedPermissions` in an allow is not forwarded.
  - The assistant chat's argv carries `--permission-prompts host`, `--setting-sources=` and no write
    tool in `--allowedTools`.
- **Confirmed and denied end to end** (core or API level, with the fake CLI and the real API in
  `inject`):
  - One confirmed `create_work_item` creates the item. Its `created` history entry has
    `actor.kind = 'agent'`, `role = 'assistant'` and `cause.chatId` set to the chat. The audit row's
    actor is `chat:<id>`.
  - One denied `create_work_item` leaves the item count, the history and the audit log unchanged.
- **API** (`apps/api/test`):
  - With a chat token, `PATCH`, `move`, a comment and a proposal accept record the agent actor and
    the chat cause (and the source, for the comment).
  - With the owner's token they record the person, as before.
  - Under `mode: none`, a valid chat token gives the audit actor `chat:<id>`, and an invalid one
    gives `local` with a 2xx.
- **Web** (`apps/web`, unit): a write-tool prompt shows its translated title in `en` and `es`, and
  offers no "always allow".

The e2e suite is not required, but the existing `a11y` and `motion` specs must stay green.

## Open questions for the owner

- Should `move_work_item` be allowed to move a card to Done once the person has confirmed it? This
  spec says no.
- Should stopping a flow run or a task join this set? The plan lists it; this card does not.

## Outcome

Built on `feat/assistant-entry` after CW-18, with option A (every write through the CLI's permission
prompt, shown as a host prompt). Feature doc: [agentry-assistant.md](../agentry-assistant.md);
tools: [agentry-mcp-server.md](../agentry-mcp-server.md#write-tools).

- Nine tools in `packages/mcp/src/write-tools.ts`; `move_work_item` refuses `done`.
- The chat's permission mode is the CLI's default (`manual` in Agentry) with host prompts; no write
  tool is allowed ahead of time. A write's prompt has no suggestions and an allow carries no rules.
- A chat token labels the actor `chat:<id>` under `mode: none`; the history records an agent of role
  `assistant` with the cause `chat.api-write`.
- **Departures:** the permission branch is in `chat-fold.ts`, not `chats.ts`; `assistant.ts` and the
  guide prompt changed too; `start_chat` has no `agent` input.
- **Left open:** a title per tool in the permission prompt and the cause's copy in the history
  (web), an end-to-end confirmed and denied write through the real CLI, and the work-item proposal
  accept path with a real proposal.

## Related

[[agentry-assistant.md]] · [[plans/agentry-assistant.md]] · [[plans/chat-api-token.md]] · [[plans/flow-start-and-chat-token.md]] · [[assistant.md]] · [[chat-environment.md]] · [[work-items.md]] · [[team-and-flow.md]]
