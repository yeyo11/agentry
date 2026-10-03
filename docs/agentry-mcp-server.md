---
created_at: 2026-10-01T12:00:00Z
updated_at: 2026-10-01T12:00:00Z
tags:
    - mcp
    - assistant
    - chats
    - api
    - desktop
---
# Agentry's own MCP server

Agentry ships a small MCP server, named **`agentry`**, so a chat can look things up in the wrapper that
runs it: "how is AGN-12 going?", "why did the verification of orchestration 7 fail?". The CLI starts it
from a config file Agentry hands over with `--mcp-config`, and it calls the REST API at
`AGENTRY_API_URL`. Its tools reach the CLI as `mcp__agentry__<tool>`. This slice has read tools only;
the spec is [plans/agentry-mcp-server.md](plans/agentry-mcp-server.md) (CW-6, epic
[plans/agentry-assistant.md](plans/agentry-assistant.md)).

It adds no screen and no route. Nothing in the UI hands it to a chat yet: the assistant's entry
(CW-18) will, through the helper below.

## The one rule

Agentry reaches Claude Code only through its CLI, and the CLI reaches Agentry through a tool Agentry
configured. The server makes HTTP calls only to `AGENTRY_API_URL`, never to Anthropic, and uses no
Anthropic package. The MCP protocol (JSON-RPC 2.0 over stdio, one message per line: `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call`) is written by hand in
`packages/mcp`, which has no runtime dependency apart from the types of `@agentry/shared`.

## The tools

Every tool is a `GET` on a route that already exists. The package's HTTP client refuses any other
method, so the server cannot write by construction.

| Tool | Returns |
|---|---|
| `list_projects` | the projects |
| `get_overview` | the dashboard in one call, the usual first look |
| `get_board` | the work-item board, of a project or global; filters by status, type, priority, labels, assignee |
| `get_work_item` | one item by key (`AGN-12`, any case) or id, with its children, comments, history, links and flow runs, in one call |
| `list_orchestrations` | the orchestrations, newest first |
| `get_orchestration` | one orchestration with its tasks, verification and final report |
| `get_team` | a project's team |
| `list_flow_runs` | a project's flow runs, filtered by agent, role, status, item |
| `get_journal` | a project's journal |
| `list_documents`, `read_document` | a project's documents, and one file |
| `list_chats` | the chats, filtered by project, state, origin |
| `get_chat` | a chat's metadata, its last 20 transcript entries and what it waits on; never the export or the stream |
| `get_usage` | usage and its breakdown for a date range (today by default) |
| `list_providers` | the agent providers with their readiness, account and usage limit per window, as last detected (claude-swap's accounts are gone since providers phase 4) |

The names live in `packages/mcp/src/names.ts` (`AGENTRY_MCP_SERVER`, `AGENTRY_MCP_READ_TOOLS`); a test
keeps the catalogue in `tools.ts` equal to that list, and the allow list is built from it.

Rules for every tool:

- The input schema is strict (`additionalProperties: false`). An input that fails it is answered as a
  tool error (`isError: true`) and no request is made.
- The result is one `text` content of compact JSON, capped at `RESULT_MAX_CHARS` (50 000). A cut result
  ends with `"truncated": true` and a hint to narrow the call.
- A 4xx or 5xx is an error result with the status and the route's `error` text; there is no retry. A
  `401` says that the API is guarded and the chat has no token. A network error names the URL tried.
- Each request times out after `REQUEST_TIMEOUT_MS` (15 s).

## Environment

The server needs `AGENTRY_API_URL`. When it is unset, empty or not an `http(s)` URL it writes
`agentry-mcp: AGENTRY_API_URL is not set; this server only talks to the Agentry that started the chat`
to stderr and exits with 1, before it reads anything. There is no default URL and no port in the
package; a test checks it.

- `AGENTRY_API_TOKEN`, when set, goes out as `Authorization: Bearer …`: it is the chat's own token
  ([chat-environment.md](chat-environment.md)).
- `AGENTRY_CHAT_ID`, when set, goes out as `X-Agentry-Chat`. It is informational and grants nothing.
- `AGENTRY_VERSION` is the `serverInfo.version`.

**What the config file holds.** The same file serves every chat. It has `AGENTRY_API_URL` and
`AGENTRY_VERSION` as literals and `AGENTRY_CHAT_ID` and `AGENTRY_API_TOKEN` as `${…}` references,
because the chat id and the per-process token only exist when a process spawns. The CLI expands them
from the chat's environment, so the secret never reaches the file. The file is written to
`<dataDir>/mcp/` (directory 0700, file 0600) by the same writer as the MCP servers a person picks
(`writeMcpConfig` in `packages/core/src/chat-tools.ts`).

## How it starts, in the three runtimes

The helper `agentryMcp({ dataDir, apiUrl, version })` (`packages/core/src/agentry-mcp.ts`, also
`Core.agentryMcp()`) builds the `command` of the file. **The choice is one environment variable,
`AGENTRY_MCP_ENTRY`**, the absolute path of a bundled `mcp.mjs`:

| Runtime | What runs |
|---|---|
| Source (`pnpm dev`) | no variable: `node --import <tsx loader> packages/mcp/src/main.ts`, with tsx resolved from the mcp package because a chat's directory is not where tsx lives |
| API bundle, container | `startServer` (`apps/api/src/server.ts`) sets `AGENTRY_MCP_ENTRY` to the `mcp.mjs` beside its own bundle; the helper runs `process.execPath` on it. `pnpm build` writes `apps/api/dist/mcp.mjs` as a third esbuild entry |
| Desktop app | `electron-builder.yml` ships `mcp.mjs` next to `server.mjs`, so the same rule finds it; under Electron the helper adds `ELECTRON_RUN_AS_NODE=1` to the server's `env`, as `server-process.ts` does for `server.mjs` |

It was picked over a runtime field because it is a single string that works everywhere and needs no
change in `apps/desktop`. When `apiUrl` is null (the API is not listening) or no entry resolves, the
helper throws and writes no file: it never hands over a config the CLI cannot start.

## What a confined chat gets

The helper returns what a caller spreads into `runtime.start`:

| Flag | Value |
|---|---|
| `--mcp-config` + `--strict-mcp-config` | a file with only the `agentry` server |
| `--tools=` | empty: no built-in tool |
| `--setting-sources=` | empty: no user, project or local settings, rules, hooks or servers |
| `--allowedTools` | the read tools by name, and nothing else |
| `--permission-mode` | `dontAsk`: what is not allowed is denied, not prompted |
| `--add-dir` | none |

**Checked with the real CLI (2.1.286):**

- It passes its whole environment to a stdio MCP server, and it expands `${NAME}` in the `env` of a
  config file from that environment.
- `--tools=` (empty) hides the built-in tools but **not** the tools of `--mcp-config`: a tool named in
  `--allowedTools` is called under `dontAsk`. So the MCP names stay out of `--tools`.

## How to try it

- Tests: `pnpm --filter @agentry/mcp test` (the server, in process and over stdio),
  `packages/core/test/agentry-mcp.test.ts` (the helper) and `apps/api/test/agentry-mcp-chat.test.ts` (a
  confined chat that asks about AGN-12, through the fake CLI's `FAKE-MCP-CALL <server> <tool> <json>`
  keyword).
- By hand, against a running wrapper:

  ```bash
  AGENTRY_API_URL=http://127.0.0.1:8787/api pnpm --filter @agentry/mcp exec tsx src/main.ts   # or, after pnpm build: node apps/api/dist/mcp.mjs
  ```

  then type `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` and press Enter.

## Not here

Write tools and how writes are confirmed (CW-17, [plans/assistant-write-tools.md](plans/assistant-write-tools.md)),
the assistant's entry, route and prompt (CW-18), and listing `agentry` in the person's MCP settings: it
is internal and given only to chats Agentry confines.

Related: [[plans/agentry-mcp-server.md]], [[plans/agentry-assistant.md]], [[chat-environment.md]], [[assistant.md]], [[desktop.md]]
