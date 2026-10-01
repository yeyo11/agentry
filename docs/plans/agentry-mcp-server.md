---
created_at: 2026-09-28T23:59:00Z
updated_at: 2026-10-01T19:20:00Z
tags:
    - plan
    - spec
    - assistant
    - mcp
    - chats
    - api
    - proposed
---
# Spec: Agentry's own MCP server, with read tools (CW-6)

Status: **built** (see Outcome). Story CW-6 of the epic CW-12, "The Agentry assistant". It builds the
"The MCP server" bullet of [agentry-assistant.md](agentry-assistant.md), and only its read tools.
The plan's decisions of 2026-09-28 are not reopened here:

> Agentry ships **its own MCP server**, handed to the chat with `--mcp-config` and
> `--strict-mcp-config`. It talks to the REST API of the wrapper that spawned the chat
> (`AGENTRY_API_URL`) […] Agentry still reaches Claude Code only through its CLI, and the CLI reaches
> Agentry through a tool Agentry configured.

The stories after this one build on it: CW-18 (the entry and the chat,
[agentry-assistant-entry.md](agentry-assistant-entry.md)), CW-17 (write tools,
[assistant-write-tools.md](assistant-write-tools.md)) and CW-10 (the chat's own token,
[chat-api-token.md](chat-api-token.md)). They all assume the server is called **`agentry`**, so its tools
reach the CLI as `mcp__agentry__<tool>`. This spec fixes that name.

## What and why

A chat that should answer "how is AGN-12 going?" or "why did the verification of orchestration 7
fail?" needs to look things up in the wrapper that runs it. `curl` through `Bash` was rejected,
because no `Bash` rule can tell a read from a write. A snapshot in the prompt was rejected too,
because it goes stale. So the answer is an MCP server that Agentry ships. The CLI starts it, and it
calls the wrapper's REST API.

CW-6 delivers four things:

- the server;
- its read tools;
- the core helper that hands the server to a chat;
- the tests that prove a confined chat can use it.

It adds **no screen and no route**.

## The one rule

- The CLI starts the server from the file Agentry passes with `--mcp-config`. Agentry never talks to
  the server itself, and the server never talks to the CLI outside the MCP stdio protocol.
- The server makes HTTP calls **only** to `AGENTRY_API_URL`. It never calls Anthropic, and it adds
  no `@anthropic-ai/*` package and no Claude Agent SDK.
- **The MCP protocol is written by hand.** JSON-RPC 2.0 over stdio, one message per line. The server
  needs only `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`, which
  is a few hundred lines with no dependency. Adding `@modelcontextprotocol/sdk` would not break the
  rule, because it is not Anthropic's SDK. It would still make every reader ask whether it does, and
  it pulls zod and more into the desktop bundle. If the architect prefers the library, they record
  that as a decision in `docs/decisions/`, before building.

## Where it lives

| Piece | Where |
|---|---|
| The server: protocol loop, tool catalogue, HTTP client | a new package **`packages/mcp`** (`@agentry/mcp`), entry `src/main.ts`. It depends on `@agentry/shared` for types only, and never on `@agentry/core`, so its bundle stays small and it cannot reach the store directly |
| The bundle | `apps/api/scripts/bundle.mjs`: a third esbuild entry that writes `apps/api/dist/mcp.mjs` next to `server.mjs` and `api.mjs` |
| The desktop package | `apps/desktop/electron-builder.yml`: the `extraResources` filter for `../api/dist` also takes `mcp.mjs`. `apps/desktop/src/resources.ts` resolves its path, as it does for `serverEntry` |
| Handing it to a chat | `packages/core`: a helper, for example `agentryMcp(chatId)` in a new `packages/core/src/agentry-mcp.ts` (name indicative). It returns the path of the `--mcp-config` file, the read-tool names for `--allowedTools`, and the confinement. The file is written through the same code as `ChatTools.writeConfig` (`packages/core/src/chat-tools.ts`): it goes in `<dataDir>/mcp/`, with mode 0700 on the directory and 0600 on the file. Extract a shared writer rather than copying it |
| The tool names, shared | an exported constant, for example `AGENTRY_MCP_READ_TOOLS`, which lists the `mcp__agentry__…` names. CW-17 and CW-18 import it, and it keeps the catalogue and the allow list the same. Put it in `packages/shared` if the web needs it; otherwise put it in `packages/mcp` |
| The fake CLI | `packages/core/test/fixtures/fake-claude.mjs`: a new keyword that makes an MCP call (see Tests) |
| Docs | a new `docs/agentry-mcp-server.md` (feature doc: tools, env, how it starts, how to try it); `docs/chat-environment.md` (who reads the variables); this plan's status; a line in `docs/plans/agentry-assistant.md` |

**How the server is started (the `command` in the config file).** It has to work in each of the three
ways Agentry runs:

1. **From source** (`pnpm dev`): Node with the `tsx` loader, on `packages/mcp/src/main.ts`.
2. **The API bundle** (`pnpm build`, the container): `process.execPath` on `apps/api/dist/mcp.mjs`.
3. **The desktop app**: `process.execPath` (Electron) on `<resources>/server/mcp.mjs`, with
   `ELECTRON_RUN_AS_NODE=1` in the server's `env`. This is how `apps/desktop/src/server-process.ts`
   already runs `server.mjs`.

The core cannot guess which of the three it is in. The runtime therefore gets the entry from whoever
starts it:

- the desktop passes it next to `serverEntry`;
- the API bundle resolves `mcp.mjs` from its own `import.meta.url`;
- from source, the entry is the source file with `tsx`.

**Decision (m1): an env variable, `AGENTRY_MCP_ENTRY`, holding the absolute path of the bundled
`mcp.mjs`.** The desktop resolves it with `resolveResources().mcpEntry` (`apps/desktop/src/resources.ts`)
and the API bundle sets it from its own `import.meta.url`; that wiring, and the core helper that reads it
(with `tsx` on `packages/mcp/src/main.ts` as the from-source fallback), belong to the core task, not to
`packages/mcp`. It is one string that works in all three runtimes and needs no new runtime field.
`packages/mcp` exports the names only (`src/names.ts`: `AGENTRY_MCP_SERVER`, `AGENTRY_MCP_READ_TOOLS`);
the server reads `AGENTRY_VERSION` for its `serverInfo.version`, so the helper must put it in the
server's `env`. `get_orchestration` needs one route only: the orchestration view already carries the
tasks, the verification and the final result.

**Decision (m2): how the helper starts it and what the file holds.** `packages/core/src/agentry-mcp.ts`
exports `agentryMcp({ dataDir, apiUrl, version })` (also `Core.agentryMcp()`), which returns what a
caller spreads into `runtime.start`: `mcp: { servers: ['agentry'], config }`, `allowedTools`,
`confine: { tools: [], settingSources: [] }` and `permissionMode: 'dontAsk'`. Its command is
`mcpCommand`: when `AGENTRY_MCP_ENTRY` names an existing file, `process.execPath` on it; otherwise, from
source, `process.execPath --import <tsx loader> packages/mcp/src/main.ts` (tsx resolved from the mcp
package, because the chat's directory is not where it lives); otherwise it throws. `startServer`
(`apps/api/src/server.ts`) sets `AGENTRY_MCP_ENTRY` to the `mcp.mjs` beside its own bundle when that file
exists, which covers the API bundle and the desktop app (it sits beside `server.mjs`) with no change in
`apps/desktop`. Under Electron the helper adds `ELECTRON_RUN_AS_NODE=1` to the server's `env`.

**Checked with the real CLI (2.1.286):** it passes its whole environment to a stdio server, it expands
`${NAME}` in a config file's `env` from that environment, and `--tools=` (empty) does **not** hide the
tools of `--mcp-config`: a tool named in `--allowedTools` is called under `dontAsk`. So the MCP names do
not go into `--tools`. Because the chat id and the token are only known when a process spawns (the token
is minted per process), and the file is the same for every chat, it holds `AGENTRY_API_URL` and
`AGENTRY_VERSION` as literals and `AGENTRY_CHAT_ID` and `AGENTRY_API_TOKEN` as `${…}` references: the
secret never reaches the file.

The architect picks the exact mechanism, for example a `runtime.mcpEntry` field or an env variable
such as `AGENTRY_MCP_ENTRY`. When no entry can be resolved, the helper throws a clear error. It never
writes a config the CLI cannot start.

## Behaviour

### Environment

- **`AGENTRY_API_URL` is required.** When it is unset, empty, or not an `http(s)` URL, the server
  does not start its protocol loop. It writes one line to stderr and exits with code 1. The line is
  `agentry-mcp: AGENTRY_API_URL is not set; this server only talks to the Agentry that started the
  chat`. There is **no default URL and no port literal** anywhere in `packages/mcp`.
- `AGENTRY_API_TOKEN`: when it is set, every request sends `Authorization: Bearer <token>`. CW-10
  mints it. Until CW-10 ships, the variable is absent and the API in `mode: none` answers without it.
- `AGENTRY_CHAT_ID`: when it is set, every request sends it as an `X-Agentry-Chat` header. It is
  informational only and grants nothing. It is there so a later audit can attribute calls.
- **The variables are written into the config file's `env`, not left to inheritance.** It is not
  guaranteed that the CLI passes its whole environment to a stdio MCP server; MCP clients commonly
  pass only a safe subset. The helper therefore writes `AGENTRY_API_URL`, `AGENTRY_CHAT_ID` and, once
  CW-10 lands, `AGENTRY_API_TOKEN` into the server's `env` in the config file. That file is per chat
  and has mode 0600. The value of `AGENTRY_API_URL` is the runtime's `apiUrl`, which is the bound
  address set in `apps/api/src/server.ts` ([chat-environment.md](../chat-environment.md)). When
  `apiUrl` is null (the API is not listening), the helper throws. It never writes a config without
  the URL.
- The developer checks with the real CLI whether it passes the environment through, and records the
  answer in `docs/agentry-mcp-server.md`, either way.

### Protocol

- The `initialize` reply carries `serverInfo: { name: 'agentry', version: <the app version> }` and
  `capabilities: { tools: {} }`.
- It answers with the `protocolVersion` the client asked for when the server supports it. Otherwise
  it answers with the newest version it supports.
- Unknown methods get JSON-RPC error `-32601`. Malformed lines get `-32700`. Neither ends the process.
- The server exits when stdin closes. Nothing it logs goes to stdout except protocol messages; logs
  go to stderr.

### The read tools

**Every tool is a GET on a route that already exists. No route is added, and no route is changed.** The
HTTP client of this package **refuses any method other than GET**, so this slice is read-only by
construction. CW-17 adds a separate writer.

| Tool (`mcp__agentry__…`) | Route(s) | Input |
|---|---|---|
| `list_projects` | `GET /projects` | none |
| `get_overview` | `GET /overview` | none. Returns the dashboard in one call, which is the usual first look |
| `get_board` | `GET /projects/:id/work-items/board`, or `GET /work-items/board` when there is no project | `projectId?`, `doneLimit?` (≤ 50), and the filters the route takes |
| `get_work_item` | `GET /work-items/by-key/:key` (or `GET /work-items/:itemId`), then `GET /work-items/:itemId/links` and `GET /work-items/:itemId/runs` | `item`, a key such as `AGN-12` (any case) or an id. The result merges the item (children, comments, history), its links and its flow runs, so "how is AGN-12 going?" takes **one** call |
| `list_orchestrations` | `GET /orchestrations` | `limit?` |
| `get_orchestration` | `GET /orchestrations/:id` | `orchestrationId`. Returns the tasks with their state, results and cost, the verification and the final report. If the route does not carry the verification or the report, the tool also calls the route that does. The architect confirms which one |
| `get_team` | `GET /projects/:id/team` | `projectId` |
| `list_flow_runs` | `GET /projects/:id/flow/runs` | `projectId`, and optionally `agent`, `role`, `status`, `itemId`, `before`, `limit` (≤ 50) |
| `get_journal` | `GET /projects/:id/journal` | `projectId`, `limit?` (≤ 50), `before?` |
| `list_documents` | `GET /projects/:id/documents` | `projectId` |
| `read_document` | `GET /projects/:id/documents/file?path=` | `projectId`, `path` |
| `list_chats` | `GET /chats` | `project?`, `state?`, `origin?`, `limit?` (≤ 50). `state` covers the chats that are waiting |
| `get_chat` | `GET /chats/:id?limit=20`, and `GET /chats/:id/permissions` when the chat uses host prompts | `chatId`. Returns the chat's metadata and summary, its last 20 transcript entries, and what it is waiting on. It is **never** the export or the stream |
| `get_usage` | `GET /usage?from=&to=` and `GET /usage/breakdown?from=&to=` | `from?`, `to?` (`YYYY-MM-DD`). The default is today |
| `list_accounts` | `GET /accounts` (**without** `refresh=1`, because a refresh polls `claude-swap`) | none. Returns each account with its usage per window, which answers "limits" |

The architect may merge or split tools, but three things must stay covered: every group the card names
(projects, work items, orchestrations, flow runs and team, journal and documents, chats, usage and
limits, accounts), the one-call `get_work_item`, and the rules below. Paths are relative to
`AGENTRY_API_URL`, which already ends in `/api`.

Rules for every tool:

- **Input schema:** strict JSON Schema, `additionalProperties: false`. It has the same limits the route
  validates, and ids and keys are strings. An input that fails the schema is answered as an MCP tool
  error (`isError: true`), without calling the API.
- **Description:** one sentence saying what the tool returns and when to use it. The model picks
  tools from these sentences. For example: "One work item by key (AGN-12) or id, with its history,
  links and flow runs. Use it for 'how is X going'."
- **Output:** one `text` content holding compact JSON. Transcripts, descriptions and document bodies
  are the only large fields. The whole result is capped at **50 000 characters**. When it is cut, it
  ends with `"truncated": true` and a hint to narrow the call (`limit`, a `path`, one id). Put the cap
  in a named constant.
- **Errors:** when the route answers 4xx or 5xx, the tool returns `isError: true` with the status and
  the route's `error` text. It does not retry. `401` gets an explicit sentence: "Agentry's API is
  guarded and this chat has no token (CW-10)". A network error names the URL it tried, so a wrong
  wrapper is visible.
- **Timeout:** 15 seconds per request, in a named constant.

### Handing it to a chat

The helper gives a caller (the tests here; the assistant entry in CW-18) everything a confined chat
needs. **CW-6 does not add the assistant entry, its route or its greeting.** Those are CW-18.

| Flag | Value |
|---|---|
| `--mcp-config=<file>` + `--strict-mcp-config` | a file with **only** the `agentry` server |
| `--tools=` | empty: no built-in tool (the `ChatConfinement` of `packages/core/src/chats.ts`, with `tools: []`) |
| `--setting-sources=` | empty: no user, project or local settings, rules, hooks or servers |
| `--allowedTools=` | the read tools by name, `mcp__agentry__list_projects,…`, and nothing else |
| `--permission-mode` | `dontAsk`: anything not allowed is denied, not prompted. CW-17 changes this for writes |
| no `--add-dir` | no uploads directory |

Before the flags are fixed, the developer checks with the real CLI that `--tools=` (empty) hides the
built-in tools but **not** the MCP tools. In other words, the tools of `--mcp-config` are still
callable when they are named in `--allowedTools`. If `--tools` also filters MCP tools, the MCP names
go into `--tools` as well. The card says "`--tools` limited to those tools", and either way the
result must be the same: the chat can call the Agentry read tools and nothing else. The finding is
recorded in `docs/agentry-mcp-server.md`.

## Tests

- **Server, in process** (`packages/mcp/test`). The HTTP client takes an injectable `fetch`. The
  tests back it with the real API's `app.inject`: `buildApp(core)` on a temporary data dir, as in
  `apps/api/test/api.test.ts`, seeded with a project whose key prefix is `AGN`, the item `AGN-12`
  with a history entry, an orchestration and a flow run. The tests check that:
  - `tools/list` returns exactly the catalogue, and every tool has a description and an input schema
    with `additionalProperties: false`;
  - **every tool is called once** and returns `isError: false` with the seeded data. For example,
    `get_work_item {item:"agn-12"}` has the item's title, status, history, links and runs;
  - an unknown id or key gives an error result that carries the `404` text;
  - an input that fails the schema gives an error result, and no request is made;
  - a result over the cap is cut and says `truncated`;
  - `AGENTRY_API_TOKEN` set → the `Authorization` header is sent, and unset → no header;
  - the client refuses a non-GET method.
- **Server, over stdio.** A test spawns the server as a child process against an API listening on
  port 0 (`app.listen({ port: 0, host: '127.0.0.1' })`, as `api.test.ts` already does). It sends
  `initialize`, `tools/list` and one `tools/call`, and checks the replies line by line. It also checks
  that a malformed line gets `-32700` and the process keeps running, and that the process exits when
  stdin closes.
- **Missing URL.** The server spawned without `AGENTRY_API_URL`, with it empty, and with it set to
  `not-a-url` exits with code 1 and the stderr line above, and writes nothing to stdout. A test also
  asserts that `packages/mcp/src` contains no `localhost:` or `127.0.0.1:` literal and no default
  port.
- **Helper** (`packages/core/test`, modelled on `chat-tools.test.ts`, which reads the file named by
  `--mcp-config=` from the recorded argv). The tests check that:
  - the config holds only `agentry`, with `command`, `args` and an `env` carrying `AGENTRY_API_URL`
    and `AGENTRY_CHAT_ID`;
  - the file has mode 0600;
  - the argv carries `--strict-mcp-config`, an empty `--tools=` (or the MCP names, per the check
    above), `--setting-sources=`, `--allowedTools=` with exactly the read tools, and
    `--permission-mode dontAsk`, and no `--add-dir`;
  - the helper throws when `apiUrl` is null or no server entry resolves.
- **A chat answers "how is AGN-12 going?" with the fake CLI** (core or API level). This covers the
  card's criterion 3.
  - `fake-claude.mjs` learns one keyword, for example
    `FAKE-MCP-CALL <server> <tool> <json-args>`. It reads the file named by `--mcp-config=`, and
    refuses the call unless `mcp__<server>__<tool>` is in `--allowedTools`, which mimics `dontAsk`.
    It spawns the server with the file's `command`, `args` and `env`, and runs `initialize` and
    `tools/call`. It emits the stream-json events a real CLI emits: an assistant `tool_use` named
    `mcp__agentry__get_work_item`, the user `tool_result`, and a `result` whose text quotes the tool's
    output. A second keyword, or a flag on the same one, makes it call a tool that is **not** allowed
    and emit a denial, for the negative case.
  - The test runs a real API on port 0, so the server child can reach it. It seeds `AGN-12` and
    starts a chat through the helper with the prompt
    `FAKE-MCP-CALL agentry get_work_item {"item":"AGN-12"} how is AGN-12 going?`.
  - It asserts that the transcript holds the `mcp__agentry__get_work_item` tool call and a result
    carrying AGN-12's title and status, and that the chat ends `done`.
  - The negative case asserts that a call to a tool outside the allow list, such as a built-in
    `Bash`, is denied.
- **Bundle and package** (`apps/api/test/packaging.test.ts` or next to it). The tests check that
  `pnpm --filter @agentry/api build` writes `dist/mcp.mjs`, that the bundle imports nothing outside
  `node:` built-ins, and that `electron-builder.yml` ships it next to `server.mjs`.

The e2e suite is not required: no screen changes.

## Acceptance criteria and how each is checked

The card's five criteria stay. The criteria added by this refinement make each of them checkable.
The last card criterion, the owner's A/B/C, is **the owner's to record**. It does not block building
the read tools, but it must be written in [agentry-assistant.md](agentry-assistant.md), "Confirming
writes", before the item is closed. The answer takes the form "Decided on <date>: option <X>".

## Outcome

Built on 2026-10-01 in three tasks (m1 the server, m2 the helper, m3 the docs). The feature doc is
[../agentry-mcp-server.md](../agentry-mcp-server.md). Each criterion, and how it was checked:

| Criterion | How it was checked |
|---|---|
| The server `agentry` exists with the 15 read tools, strict schemas, a 50 000-character cap, a 15 s timeout, and errors that carry the route's text | `packages/mcp/test/tools.test.ts`: the catalogue equals the names, every tool is called once against the real API through `app.inject`, 404, schema failure, truncation and the 401 sentence. Ran green (12 tests with the stdio file) |
| It is read-only by construction | `tools.test.ts`: the client refuses any method but GET before a request. Every tool maps to an existing GET, and no route was added or changed |
| It speaks MCP over stdio, exits on a missing `AGENTRY_API_URL`, and has no default URL | `packages/mcp/test/stdio.test.ts`: a child process against an API on port 0 (`initialize`, `tools/list`, a call, `-32700` on a bad line, exit on stdin close; exit 1 with the stderr line for unset, empty and `not-a-url`); a test greps `src` for URL and port literals |
| The token and the chat id are forwarded when present | `tools.test.ts`: `Authorization` and `X-Agentry-Chat` are sent when set and absent otherwise |
| The helper hands it to a chat with the confinement, a 0600 file and an error when it cannot start | `packages/core/test/agentry-mcp.test.ts`: only `agentry` in the file, `--strict-mcp-config`, empty `--tools=` and `--setting-sources=`, exact `--allowedTools`, `dontAsk`, no `--add-dir`, mode 0600, throws on a null `apiUrl` or no entry. 18 core tests green with `chat-tools.test.ts` |
| A confined chat answers "how is AGN-12 going?" and cannot use anything else | `apps/api/test/agentry-mcp-chat.test.ts`, through the fake CLI's `FAKE-MCP-CALL`: the transcript holds `mcp__agentry__get_work_item` and a result with AGN-12's title and status, the chat ends `done`, and `Bash` is denied |
| It works from source, the API bundle and the desktop app | Source: the stdio and chat tests run it with tsx. Bundle and package: `apps/api/test/packaging.test.ts` builds `dist/mcp.mjs`, checks it imports only `node:` built-ins and that `electron-builder.yml` ships it beside `server.mjs` (14 API tests green with the chat test). The desktop app itself was not launched: it shares the rule of the bundle, `AGENTRY_MCP_ENTRY` beside `server.mjs` |
| The real CLI starts it | Checked by hand with CLI 2.1.286, as the Environment section asked: the CLI passes its whole environment, expands `${NAME}` in the file's `env`, and does not hide MCP tools with `--tools=` |
| The owner records A, B or C in [agentry-assistant.md](agentry-assistant.md) | **Open.** It does not block these read tools, and CW-17 waits for it |

Decisions taken, besides the ones written above: the file is the same for every chat, with the chat id and
the token as `${…}` references, which refines "written into the file's `env`" so the token never reaches
the disk.

Done when the branch was verified: `docker/Dockerfile` copies `packages/mcp/package.json`, because the
core depends on `@agentry/mcp`, and `packages/mcp` is in `release-please-config.json` at the repository's
version, so a release does not leave it behind. Left for others: the chat-level plumbing (a route,
`chats.create` accepting the helper's output) is CW-18's.

## Out of scope

- Write tools and how writes are confirmed (CW-17).
- The assistant's entry, route, greeting, system prompt and default model (CW-18).
- The chat's API token (CW-10). This story only forwards `AGENTRY_API_TOKEN` when it is present.
- `Read`/`Grep`/`Glob` over project files.
- Listing the `agentry` server in the person's MCP settings (`GET /config/mcp`). It is internal and
  handed only to the chats Agentry confines.

## Related

[[plans/agentry-assistant.md]] · [[plans/agentry-assistant-entry.md]] · [[plans/assistant-write-tools.md]] · [[plans/chat-api-token.md]] · [[chat-environment.md]] · [[assistant.md]] · [[desktop.md]]
