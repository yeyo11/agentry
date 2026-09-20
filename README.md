<div align="center">

<img src="apps/web/public/favicon.svg" width="76" alt="">

# Agentry

**Run Claude Code as a service.**

A REST API, a web UI and multi-agent orchestration around the Claude Code CLI, in one container.

[![CI](https://github.com/yeyo11/agentry/actions/workflows/ci.yml/badge.svg)](https://github.com/yeyo11/agentry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/yeyo11/agentry?style=flat&logo=github&color=d97757)](https://github.com/yeyo11/agentry/stargazers)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-5fa04e?logo=node.js&logoColor=white)](package.json)
[![Image](https://img.shields.io/badge/ghcr.io-agentry-2496ed?logo=docker&logoColor=white)](https://github.com/yeyo11/agentry/pkgs/container/agentry)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-6ba539?logo=openapiinitiative&logoColor=white)](#rest-api)
[![Buy me a coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/yeyo11)

<img src="docs/media/tour.gif" alt="A tour of Agentry: dashboard, command palette, session transcripts, orchestration and account rotation" width="100%">

</div>

Claude Code lives in your terminal. One machine, one session at a time, and nothing to look at
once you close the tab.

Agentry puts it behind a REST API and a web UI: start and watch conversations from anywhere, run a
graph of agents in parallel, browse every transcript the CLI has ever written, and rotate between
accounts when one runs out of quota — without giving up a single thing the CLI can do, because
Agentry drives it through the CLI and nothing else.

```bash
docker run -p 127.0.0.1:8787:8787 -v agentry-data:/data ghcr.io/yeyo11/agentry
```

### What you get

- **Every conversation, from anywhere** — start a run from the UI or the API, stream the tokens,
  answer follow-up turns, and pick up any session the CLI has ever written on that machine.
- **Answer what Claude asks, as it asks** — a headless run has nobody to ask, so it is normally
  denied anything that needs permission. Agentry speaks the CLI's control protocol
  (`--permission-prompt-tool stdio`) and routes every prompt to the panel: tool calls with the exact
  command (allow, allow always, or deny with a reason the model reads), questions from
  `AskUserQuestion` with their options, and plans to approve or send back. From the same screen you
  interrupt a turn without losing the session and switch the permission mode or the model mid-run.
- **Orchestration** — a DAG of tasks, each with its own Claude worker, run in parallel with
  dependency context and a synthesis step. Every worker can get its own git worktree and branch,
  so parallel agents never write over each other. An auto-planner drafts the graph; plans are kept,
  so one lost to a closed tab is reloaded instead of paid for twice, and a graph interrupted by a
  restart goes on where it stopped.
- **Multi-account rotation** — usage per window, proactive switching before an account runs out,
  and a run that hits its limit is rotated and resumed on the next account. Every rotation is
  recorded, so "why did my account change" has an answer that survives a restart.
- **Spending limits** — cap any run with a budget the CLI enforces from inside.
- **The whole configuration surface** — settings, instructions, MCP servers, agents, skills,
  commands, output styles, memory, plugins and marketplaces, per user and per project.
- **One container, one volume** — non-root, the CLI baked in, everything else on a data volume.

> [!IMPORTANT]
> **Run it on localhost for now.** API authentication is the next thing being built; until it
> lands, anyone who reaches the port can start a run on your account and read every transcript on
> the machine. [SECURITY.md](SECURITY.md) spells out exactly what is and is not protected.

### Several accounts, rotated before they run out

<img src="docs/media/accounts.png" alt="The accounts page: usage per window for each account, and the auto-rotation policy" width="100%">

## How it talks to Claude

The wrapper drives Claude **only through the CLI** — no SDK, no terminal scraping:

| Need | CLI surface used |
| --- | --- |
| Detect installation | `claude --version` |
| Auth status | `claude auth status --json` |
| Run / continue a conversation | `claude -p --input-format stream-json --output-format stream-json` (one long-lived process per run, multi-turn over stdin; `--resume` when the process is gone) |
| Background tasks & subagents | `system/task_*` events and `Task` tool calls in the stream |
| Live CLI sessions | `claude agents --json` |
| Session history & projects | transcripts in `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl` |
| MCP servers | `claude mcp add-json` / `claude mcp remove` (user scope) |
| Orchestration planner | `--json-schema` structured output |
| Multiple accounts | [claude-swap](https://github.com/realiti4/claude-swap): `cswap list / switch / auto --json`, and `cswap run` for a run pinned to one account |

## Quick start

On a machine where you are already logged in to Claude Code, mint a long-lived token:

```bash
claude setup-token
```

Then run the published image, pasting that token in:

```bash
docker run -d --init -p 127.0.0.1:8787:8787 \
  -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-... \
  -v agentry-config:/home/node/.claude \
  -v agentry-data:/data \
  -v agentry-accounts:/home/node/.local/share/claude-swap \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/yeyo11/agentry
```

The UI and the API reference are on <http://localhost:8787> — the panel at `/`, the interactive
OpenAPI docs at `/docs`. Everything else is configured from the UI.

The port is published on `127.0.0.1` only: the API has no authentication yet (see
[SECURITY.md](SECURITY.md)), so do not drop that prefix unless you put real access control in front.

<details>
<summary>Building it yourself instead</summary>

```bash
git clone https://github.com/yeyo11/agentry
cd agentry
cp .env.example .env        # paste the token into CLAUDE_CODE_OAUTH_TOKEN
docker compose up --build
```

`docker-compose.yml` pins the CLI version through `CLAUDE_CODE_VERSION` if you need a specific one,
and publishes the port on `127.0.0.1` like the command above.

</details>

Open <http://localhost:8787> for the UI; the API lives under `/api`.

Volumes:

| Volume (`docker run` / compose) | Mount | Purpose |
| --- | --- | --- |
| `agentry-config` / `claude-config` | `/home/node/.claude` | The whole account setup: `settings.json`, `.claude.json` (MCP servers), `CLAUDE.md`, agents, skills, commands and session transcripts |
| `./workspace` | `/workspace` | Projects Claude works on (default `cwd` for runs) |
| `agentry-data` / `wrapper-data` | `/data` | Wrapper state: the SQLite store (`wrapper.db`: chats and their executions, orchestrations, plans, rotation log), `accounts.json` (auto-rotation settings), `credentials.json` (the runtime credential, mode 600) and `uploads/` (attachments) |
| `agentry-accounts` / `claude-swap` | `/home/node/.local/share/claude-swap` | Credentials of every registered account |

The compose file keeps its original volume names so an existing setup keeps its data; `docker compose`
prefixes them with the project name (`agentry_wrapper-data`…).

## Desktop app (Linux)

Prefer a window to a container? Every [release](https://github.com/yeyo11/agentry/releases) also
carries an AppImage and a `.deb`:

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/agentry/main/scripts/install.sh | bash
```

The `.deb` through apt on Debian and Ubuntu, the AppImage under `~/.local` everywhere else. To
install by hand, download either file from the release.

It runs on your machine with your own Claude Code CLI and `~/.claude` login, so nothing is
sandboxed and runs default to `acceptEdits` instead of `bypassPermissions`. Requirements, data
locations, CLI detection and building from source are in [docs/desktop.md](docs/desktop.md).

## Local development

Requires Node 22+, pnpm 10 and a logged-in `claude` CLI in your `PATH`.

```bash
pnpm install
pnpm dev          # API on :8787, UI on :5173 (proxies /api)
pnpm typecheck
pnpm test         # core unit tests + API integration tests (node:test)
pnpm build && pnpm e2e   # browser suite: isolated wrapper + headless Chrome, never touches ~/.claude
E2E_LIVE=1 pnpm e2e chat # specs that talk to Claude (logged-in CLI, costs a few tokens)
```

Locally the wrapper uses your real `~/.claude`. Point `CLAUDE_CONFIG_DIR` somewhere else to
experiment with config writes safely.

The browser suite boots its own wrapper on port 8799 with temporary config, workspace and data
directories, seeds whatever each spec needs and drives headless Chrome over the DevTools
protocol (no Playwright, no dependencies). It covers every page in both themes and at phone
width, the config editors and their save/delete flows, the unsaved-changes guard, the command
palette and the chats list; `E2E_LIVE=1 pnpm e2e chat` additionally holds a real
conversation with Claude (streamed reply, follow-up turn, stop) using your login.

## Monorepo layout

```
packages/shared   Types and the message normalizer shared by every package (the API contract)
packages/core     CLI communication: detection, auth, chat manager, transcript store,
                  orchestrator, accounts (claude-swap), config managers
apps/api          Fastify REST API + SSE; serves the built UI in production
apps/web          React + Vite UI
apps/desktop      Electron shell: runs the API as a child process, packaged as AppImage and .deb
e2e/              Browser suite (headless Chrome over CDP, no dependencies)
docker/           Dockerfile
```

Packages export TypeScript sources directly and the API runs through `tsx`, so there is no
build step except for the UI.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | – | Subscription token from `claude setup-token` |
| `ANTHROPIC_API_KEY` | – | Alternative: API key billing |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | API listen address |
| `CLAUDE_BIN` | `claude` | CLI binary to use |
| `CSWAP_BIN` | `cswap` | claude-swap binary. With accounts registered it owns the credential, and the token above is ignored |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude config dir (`/home/node/.claude` in the image) |
| `AGENTRY_WORKSPACE_DIR` | `./workspace` | Default working directory for runs |
| `AGENTRY_DATA_DIR` | `./data` | Wrapper state |
| `AGENTRY_DEFAULT_PERMISSION_MODE` | `acceptEdits` (`bypassPermissions` in the image) | Mode for runs that do not set one |
| `AGENTRY_MAX_CONCURRENT_RUNS` | `8` | Max simultaneous `claude` processes |
| `AGENTRY_CORS_ORIGIN` | – (CORS off) | Comma-separated origins (or `*`) for external browser clients. The bundled UI never needs it: in dev it uses the Vite `/api` proxy, in production it is same-origin |
| `VITE_API_TARGET` | `http://localhost:8787` | Where the Vite dev server proxies `/api` |
| `AGENTRY_IDLE_TIMEOUT_MS` | `600000` | Idle runs are closed after this (they resume transparently) |
| `AGENTRY_WEB_DIST` | `apps/web/dist` | Built UI the API serves (the desktop app points it at its bundled copy) |
| `LOG_LEVEL` | `info` | Fastify/pino log level (`trace` … `fatal`, or `silent`) |

## REST API

**Interactive reference: <http://localhost:8787/docs>** (Scalar) · OpenAPI 3.1 document at
`/openapi.json`. Component schemas are generated from the shared TypeScript types
(`pnpm --filter @agentry/api openapi:schemas` after changing `packages/shared/src/types.ts`), route
docs live in [`apps/api/src/openapi/routes.ts`](apps/api/src/openapi/routes.ts), and a test fails
when a route is added without documentation. The reference is self-hosted: Scalar's cloud
features and telemetry are disabled.

All routes are under `/api` and speak JSON. Errors are `{ "error": "…" }` with a 4xx status.
Types live in [`packages/shared/src/types.ts`](packages/shared/src/types.ts).

### System

| Method | Route | Description |
| --- | --- | --- |
| GET | `/health` | `{ ok, cli, loggedIn }` |
| GET | `/system?refresh=1` | CLI detection, auth status, paths |
| GET | `/overview` | Everything the dashboard needs in one call |

### Account credentials

The account can be configured at runtime instead of (or on top of) the container environment.
The credential is stored in the data volume (`credentials.json`, mode 600), applied to every
new `claude` process, and never returned by any endpoint.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/auth` | Fresh auth status, including where the credential comes from |
| PUT | `/auth/credentials` | `{ oauthToken }` or `{ apiKey }` (exactly one) |
| DELETE | `/auth/credentials` | Remove the stored credential; falls back to the container environment |
| POST | `/auth/verify` | Sends a minimal real request. `claude auth status` only reports what is configured, it does not validate the token |

### Accounts (multi-account)

Several Claude accounts through [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`),
which owns the credential file, polls each account's 5h/7d/per-model usage and swaps accounts
under Claude Code's own locks. Without it installed every route answers
`{"cswap": {"installed": false}, "accounts": []}` and the wrapper stays single-account.

Register each account with a token from `claude setup-token` (there is no interactive login in a
container). **From the first registered account on, claude-swap owns authentication:** the wrapper
stops injecting `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, because the CLI reads the
environment before the credential file.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/accounts?refresh=1` | Accounts with usage per window, the active one, auto-rotation settings and the rotation log |
| POST | `/accounts/switch` | `{ target?, strategy? }` — a slot number, email or alias; without a target it rotates (`best` \| `next-available`) |
| POST | `/accounts/token` | `{ token, slot?, email? }` — register an account. The token goes to `cswap add-token` over stdin and is never returned |
| DELETE | `/accounts/:number` | Remove an account |
| POST | `/accounts/:number/enable` · `/disable` | Return to / hold out of the rotation |
| PUT | `/accounts/:number/alias` | `{ alias }` (`null` unsets) |
| GET / PUT | `/accounts/autoswitch` | `{ enabled, threshold, strategy, models, intervalSec, rotateOnLimit }` |
| GET | `/accounts/events?limit=&since=` | Rotation history — every poll, switch and failure — persisted across restarts |

Rotation happens two ways:

- **Proactive** — with `enabled`, the wrapper supervises a `cswap auto --json` process that
  switches when the active account's binding window reaches `threshold` (default 90 %), reusing
  claude-swap's cooldown, hysteresis and quarantine of dead refresh tokens.
- **Reactive** — with `rotateOnLimit` (default on), a chat that dies against its rate limit
  (`rate_limit_event` rejection, a 429 result or a matching stderr line) triggers a rotation to
  the account with the most headroom, and the turn is replayed on the same session with
  `--resume`. Once per chat: a second failure is reported as a real one.

A chat can also be pinned to one account with `account` (on `NewChatRequest`, `ResumeChatRequest` or
`ForkChatRequest`), which spawns `cswap run <account> --share-history -- …` instead of `claude`.
Pinned chats keep writing their transcript to the shared config dir, so history behaves as usual.

### Projects

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects` | The projects you imported, each with its worktrees and the number of chats under it |
| GET | `/projects/candidates` | Directories chats have run in that are not projects yet, the busiest first: what a first start offers to import |
| POST | `/projects/import` | `{ path, name? }` — import a directory; every chat under it is adopted, retroactively. A git worktree is refused |
| POST | `/projects` | `{ name, gitUrl? }` — create an empty project in the workspace or clone a repository into it, and import it |
| PATCH | `/projects/:id` | `{ name }` — rename a project |
| DELETE | `/projects/:id` | Remove a project from Agentry. Harmless: nothing on disk changes |
| DELETE | `/projects/:id/state` | Purge everything Claude Code keeps about a project (`claude project purge`). Irreversible, and separate from removing the project |

### Events

One Server-Sent Events stream for the whole app, so a client never has to poll.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/events?since=ID` | Every change as an `AgentryEvent` (`id:`, `event: <type>`, `data: <json>`): runs created, updated, ended and removed; prompts waiting for a person (`run.waiting`, `permission.requested`/`resolved`); rate limits and account rotation; background tasks, subagents and workflows starting and ending; orchestration, task and merge-conflict changes; `sessions.changed`. Opens with `stream.hello`; honours `Last-Event-ID` against a bounded in-memory buffer and sends `stream.resync` when that id is gone (refetch everything). A `: ping` comment every 15 s |

```bash
curl -N localhost:8787/api/events
```

### Chats

A chat is one Claude Code conversation, and its id is the session id: however many times it is
resumed, and whoever started it, it is one chat. Each time Agentry has a `claude -p` process working
on it, that is an **execution** of the chat, with its own outcome, cost and turns. `state` says what
is happening (`working`, `waiting` for a person, `idle`) and `control` what can be done with the chat
now: `interactive` (Agentry has a live execution), `resumable` (nothing holds it), or `readOnly` with
the reason and the way forward (`fork`, or `hint` for a task an orchestration is still running).

| Method | Route | Description |
| --- | --- | --- |
| GET | `/chats?project=&loose=1&origin=&state=&limit=` | Chats, newest first. Workers of an orchestration and housekeeping chats are left out unless `origin` (comma-separated: `agentry`, `external`, `orchestration`, `internal`) asks for them; `loose=1` lists those under no project |
| GET | `/usage?from=&to=` | What the chats spent, per day, per project and per orchestration (`from`/`to` are days, `YYYY-MM-DD`, inclusive). Tokens come from the transcripts, per model; the cost is what the CLI reported, so it is `null` for chats started from a terminal and `chatsWithoutCost` says how many a total leaves out |
| POST | `/chats` | Start a chat. Body: `NewChatRequest` (`prompt` required; `cwd`, `model`, `permissionMode`, `effort`, `appendSystemPrompt`, `allowedTools`, `jsonSchema`, `maxBudgetUsd`, `worktree`, `permissionPrompts`, `account`, `attachments`) |
| GET | `/chats/:id` | The chat with its branches and environment, and a window of its transcript: the newest 200 entries, or `?limit=` of them, with `from` and `total`; `?before=` the `from` of a page reads the one before it (`?sidechains=1` adds subagent messages) |
| GET | `/chats/:id/search?q=&sidechains=1` | Search the whole transcript, pages not loaded included: the matching entries' indices (the space of `from`/`total`) with a snippet each, case-insensitive; at most 500, the newest, with `truncated` |
| GET | `/chats/:id/stream?since=SEQ` | Server-Sent Events, one `RunEvent` per message (honours `Last-Event-ID`). Includes ephemeral `partial` events with the text generated so far (token streaming); they are never replayed |
| POST | `/chats/:id/resume` | Body: `ResumeChatRequest` (`prompt`, same options as a new chat). Adds an execution to the same chat, which keeps its id. Decided on the server at this moment from the CLI's own session list and the process table: a chat born in a terminal that nothing holds is adopted and stays `external`; one a terminal holds, or that belongs to an orchestration, is refused with `409` and the reason |
| POST | `/chats/:id/fork` | Body: `ForkChatRequest`. Continues in a copy: a new chat with the same history that records `derivedFrom` and leaves the original untouched. Allowed on any chat |
| POST | `/chats/:id/messages` | `{ text, attachments? }` — another turn for a chat with a live execution (`409` otherwise: resume it). `attachments` are upload ids from `POST /uploads` |
| POST | `/chats/:id/stop` | Stop what is working on it: the execution Agentry runs, or a background session the CLI holds (`claude stop`). The conversation is kept |
| POST | `/chats/:id/interrupt` | End the turn in progress and keep the process, which waits for the next message |
| PATCH | `/chats/:id` | `{ permissionMode?, model? }` — a live process switches at once; an ended one on its next execution |
| DELETE | `/chats/:id` | Delete the transcript, its sidecar files and Agentry's record (`409` while something is running on it) |
| GET | `/chats/:id/logs` | A background session's recent terminal output (`claude logs`) |
| GET | `/chats/:id/permissions` | What the chat is waiting on: tool calls, questions (`AskUserQuestion`) and plans (`ExitPlanMode`). Only for chats started with `permissionPrompts: "host"` |
| POST | `/chats/:id/permissions/:requestId` | `{ behavior: "allow" \| "deny", message?, updatedInput?, updatedPermissions? }` — answer one. A question is answered by allowing it with `updatedInput.answers` (question → chosen labels); `updatedPermissions` takes the request's `suggestions` to remember them. Unanswered requests are denied after ten minutes |
| GET | `/chats/:id/subagents` | Subagents of the chat: branches of it, whose messages live in its transcript |
| GET | `/chats/:id/subagents/:agentId` | One subagent: prompt, outcome, token usage and full transcript (`?after=` to append) |
| GET | `/chats/:id/tasks` | Commands the chat sent to the background, with `ownerId` for those a subagent launched |
| GET | `/chats/:id/tasks/:taskId/output` | What one of them printed: the last 64 KiB, or with `?offset=` only what came after that byte |
| GET | `/chats/:id/workflows` | Workflow runs (the Workflow tool) of the chat, with the progress of every agent they launched |
| GET | `/chats/:id/workflows/:workflowId/agents/:agentId` | The same as a subagent's, for an agent a workflow launched |
| GET | `/environments?cwd=` | What Claude actually loaded (tools, MCP status, agents, skills, plugins, commands, memory paths) per directory, from the latest chat started there |
| GET | `/tasks` | Commands sent to the background (monitors and remote agents too), each with the chat that sent it, from Agentry's chats and from terminal ones live or ended in the last day. The inbox sees a hung command wherever it is. Survives a restart |
| GET | `/subagents` | Subagents of every chat, foreground or background, each with its chat. Survives a restart |
| GET | `/workflows` | Workflow runs of every chat, each with its chat |
| GET | `/workflows/saved?cwd=` | Saved workflows in the project's `.claude/workflows/` and the user's |
| POST | `/workflows/saved/run` | `{ name, cwd?, args?, model? }` — start a chat that runs a saved workflow |

```bash
curl -X POST localhost:8787/api/chats -H 'content-type: application/json' \
  -d '{"prompt":"Summarize this repo","cwd":"/workspace/my-project","model":"sonnet"}'
curl -N localhost:8787/api/chats/<id>/stream
```

### Orchestration

An orchestration is a DAG of tasks; each task runs in its own Claude worker. Independent
tasks run in parallel (up to `concurrency`), results of dependencies are passed to dependent
tasks, and an optional final worker synthesizes a report.

A worker runs with nobody at the keyboard, so set how it gets permission: `permissionPrompts:
"host"` sends its prompts to the run page for you to answer, `allowedTools` pre-authorises tools.
With neither, anything that would prompt is denied. `worktree: true` gives every task its own git
worktree and branch through `claude --worktree`.

A worktree graph delivers one branch: when it finishes, every completed task's branch is merged, in
dependency order, into `agentry/<name>-<id>` from the commit the graph started on. A merge conflict
is handed to an integrator agent in that branch's worktree, and its result is checked rather than
trusted. Nothing is pushed until you ask for a pull request.

The same graph runs on one of two engines (`engine`). `graph`, the default, is the one above: a
process per task. `workflow` runs every task as a subagent of a single Claude Code session, through
a workflow script (Claude Code's Workflow tool) Agentry generates from the graph — the same prompts, dependencies,
concurrency and synthesis. It is cheaper, and a resume replays the tasks that had finished from the
CLI's cache, but every task works in the project directory, so it cannot take `worktree`. The
planner picks it only when no task changes the repository (analysis, review, research), and only
when the CLI has the Workflow tool; the draft shows why it chose either, and you can switch.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/orchestrations` | List |
| POST | `/orchestrations` | Launch. Body: `OrchestrationSpec` |
| POST | `/orchestrations/plan/start` | `{ objective, cwd?, model?, maxTasks? }` → the planner chat (housekeeping), returned at once so it can be streamed at `/chats/:id/stream` |
| GET | `/orchestrations/plans` | Plans generated but not launched; each is kept when its planner finishes |
| GET | `/orchestrations/plans/:runId` | The draft `OrchestrationSpec` a planner chat produced (`:runId` is the planner chat's id) |
| POST | `/orchestrations/plan` | Same as `plan/start` but waits for the draft — holds the request open for minutes |
| GET | `/orchestrations/:id` | State of every task, results, cost |
| POST | `/orchestrations/:id/stop` | Stop all workers |
| POST | `/orchestrations/:id/resume` | Run again every task that did not complete (each in its own chat, as a new execution), keeping the results of those that did. Optional body `{ worktree?, permissionPrompts?, allowedTools?, permissionMode? }` corrects the settings the graph failed with |
| POST | `/orchestrations/:id/tasks/:taskId/retry` | Run a task that failed for good again, in its own chat and worktree, told what went wrong; the tasks blocked behind it go back to waiting for their turn |
| POST | `/orchestrations/:id/tasks/:taskId/retry-clean` | Start a failed task over: a new chat, its worktree rebuilt from the base commit |
| POST | `/orchestrations/:id/tasks/:taskId/skip` | Give a failed or blocked task up, with every task that depends on it, so the graph can finish without them |
| POST | `/orchestrations/:id/tasks/:taskId/hint` | `{ text }` — a nudge for a worker whose task is still running; a finished task takes none (fork its chat) |
| DELETE | `/orchestrations/:id` | Delete a graph that is not running, with its worktrees; refused while a worktree holds uncommitted work |
| POST | `/orchestrations/:id/integrate` | Merge the task branches into the integration branch again: after resolving by hand, or for a graph that predates integration |
| POST | `/orchestrations/:id/pull-request` | Push the integration branch and open a pull request with `gh` → `{ branch, url, detail }` |
| GET | `/orchestrations/:id/workflow` | The graph as a workflow script → `{ path, script }` |
| POST | `/orchestrations/:id/workflow/save` | `{ name?, overwrite? }` — copy that script into the project's `.claude/workflows/` |
| POST | `/orchestrations/:id/worktrees/prune` | `{ force? }` — remove the graph's worktrees; branches are always kept |

```json
{
  "name": "audit",
  "objective": "Audit the project and propose fixes",
  "cwd": "/workspace/my-project",
  "concurrency": 3,
  "synthesize": true,
  "worktree": true,
  "permissionPrompts": "host",
  "tasks": [
    { "id": "deps", "name": "Dependencies", "prompt": "Review outdated dependencies…" },
    { "id": "tests", "name": "Tests", "prompt": "Assess test coverage…" },
    { "id": "plan", "name": "Fix plan", "prompt": "Write a prioritized fix plan.", "dependsOn": ["deps", "tests"] }
  ]
}
```

### Uploads

Files attached to a chat's first message (`NewChatRequest.attachments`) or to a later turn. The file is
the request body as is, not multipart. Images are capped at 5 MB, PDFs at 32 MB, anything else at
50 MB, and the files live in `uploads/` under the data directory.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/uploads?name=` | Body: the raw file, `Content-Type: application/octet-stream` → `201` with the `Attachment` (`id`, `name`, `mediaType`, `kind`, `sizeBytes`…) |
| GET | `/uploads/:id` | The `Attachment` metadata |
| GET | `/uploads/:id/content` | The bytes. Images and PDFs are served inline, everything else as a download |

```bash
id=$(curl -s -X POST 'localhost:8787/api/uploads?name=diagram.png' \
  -H 'content-type: application/octet-stream' --data-binary @diagram.png | jq -r .id)
curl -X POST localhost:8787/api/chats -H 'content-type: application/json' \
  -d "{\"prompt\":\"Explain this diagram\",\"attachments\":[\"$id\"]}"
```

### Configuration (user and project scope)

Every `/config` route accepts `?project=<projectId>` (the `id` from `GET /projects`). Without it
the **user scope** is used (the Claude config dir); with it, that **project's** own files. Only
projects known to the wrapper are accepted, so the API cannot be pointed at arbitrary paths.
Claude Code precedence is local > project > user.

| Method | Route | Description |
| --- | --- | --- |
| GET / PUT | `/config/settings?project=&variant=shared\|local` | `settings.json`, or `settings.local.json` with `variant=local` (project only) — body `{ settings }` |
| GET / PUT | `/config/instructions?project=&variant=shared\|local` | `CLAUDE.md` / `CLAUDE.local.md` — body `{ content }` |
| GET | `/config/mcp?project=` | MCP servers tagged by scope. Project scope returns `local` + `project` (`.mcp.json`) + inherited `user` servers |
| PUT | `/config/mcp/:name?project=` | Create or replace — body `{ config, scope? }`, e.g. `{"type":"http","url":"…"}` or `{"command":"npx","args":["-y","pkg"],"env":{}}` |
| DELETE | `/config/mcp/:name?project=&scope=` | Remove |
| GET | `/config/mcp/health?project=` | Real connection checks (`claude mcp list`); slow, call on demand |
| GET | `/config/resources/:kind?project=` | `kind` = `agents` \| `skills` \| `commands` \| `output-styles` \| `rules` \| `workflows` |
| GET / PUT / DELETE | `/config/resources/:kind/:name?project=` | Markdown content (a script for `workflows`, whose `format` is `javascript`) — body `{ content }` |

### Config file explorer

Generic editor for everything else under a scope's Claude dir (`~/.claude` or
`<project>/.claude`): hook scripts, extra skill files, keybindings, memory… `root` is `user` or a
project id. Paths are confined to the root (symlinks included); CLI runtime state and secrets
(`.credentials.json`, `.claude.json`, transcripts, caches) are hidden and refused. Text files up to 1 MB.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/config/files/roots` | Available roots |
| GET | `/config/files/tree?root=` | Nested tree |
| GET | `/config/files/content?root=&path=` | Read a file |
| PUT | `/config/files/content` | Create or overwrite — body `{ root, path, content, executable? }` |
| DELETE | `/config/files/content?root=&path=` | Delete a file or directory |

### Memory

Claude Code's persistent memory is local: markdown files in
`<configDir>/projects/<projectId>/memory/`, one fact per file plus the `MEMORY.md` index that is
loaded into every session of that project.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/memory` | Imported projects with their memory file counts |
| GET | `/memory/:project` | Memory files of a project (index first), with parsed `description` and `type` |
| PUT | `/memory/:project/:name` | Create or overwrite `name.md` — body `{ content }` |
| DELETE | `/memory/:project/:name` | Delete a memory file |

### Plugins

Delegated to `claude plugin`; actions return the CLI output as `{ ok, output }` and can take a while.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/plugins` | Installed plugins and configured marketplaces |
| GET | `/plugins/available?q=` | Search the marketplaces (max 100 results) |
| GET | `/plugins/details?plugin=` | Component inventory of a plugin |
| POST | `/plugins/install` · `/uninstall` · `/enable` · `/disable` | Body `{ plugin, scope? }` (`name@marketplace`) |
| POST | `/plugins/marketplaces` | Add — body `{ source }` (GitHub `owner/repo`, URL or path) |
| POST | `/plugins/marketplaces/update` | Body `{ name? }` — all when omitted |
| DELETE | `/plugins/marketplaces/:name` | Remove |

## UI

| Page | What it covers |
| --- | --- |
| Home | The selected project's page. **Activity** is an inbox: what waits for a person first (chats stopped for a permission or a question, blocked orchestration tasks, merge conflicts, a command running for long, a missing CLI or credential), each with its action, then what runs now with its context and cost, what the day has cost per model, subscription usage limits and the chats to pick up again — the first block is absent when nothing waits. With a project selected it also has **Settings**, **Memory**, **Resources** (agents, skills, commands, output styles, rules and saved workflows, each workflow with a **Run** button) and **Worktrees** tabs; with All projects only Activity remains |
| Chats | Every conversation in one list, whoever started it: its state (working, waiting for you, idle), whether Agentry can continue it or only read it, where it came from, and how full its context is. Workers of an orchestration and housekeeping chats are hidden unless asked for |
| Chat | One conversation, live over SSE: messages, thinking, tool calls and results, the context and cost card, its executions, and the branches it launched (subagents, background tasks, workflows) with a side panel each: prompt, status, duration, tokens, transcript and result, updating while it runs (`?detail=…`). What it can do follows its control: send, interrupt, resume, or continue in a copy |
| Projects | The management screen: import a directory by hand, create or clone one in the workspace, rename, remove (harmless) or purge what Claude Code keeps about it (irreversible). On a first start with none imported it offers the directories holding the most chats |
| Orchestration | Auto-planned or manual task DAG, live board by stage, per-task results, synthesis |
| Accounts | Registered accounts with 5h/7d (and per-model) usage, manual switch, add/remove, enable/disable, auto-rotation settings and the rotation log |
| Settings | User scope only, as tabs: Account, Instructions, Settings (guided editor + raw JSON), MCP servers (guided form, scopes, connection checks), Agents, Skills, Commands, Output styles, Rules, a file explorer for everything else (hook scripts, skill files, keybindings…), Memory (where each project's memory is) and Plugins (installed plugins, marketplace search and install, marketplaces). Everything that belongs to one project lives on its page instead |

Across the app:

- **Project selector** (top bar, beside the palette): scopes Home, Chats and Orchestrations to one project
  or All projects. The choice is remembered, and a `?project=<id>` in the address overrides it, so a link
  to a project's page works from anywhere. Notifications ignore it: a chat waiting in another project
  is still worth knowing about.
- **Command palette** (`Ctrl/⌘ K`): fuzzy search over pages, settings tabs, projects and their tabs,
  working and recent chats and actions (new chat, run a saved workflow, theme, API reference…), with
  recents and full keyboard control.
- **Themes**: light, dark or system, switchable from the top bar or the palette, applied before first paint.
- **Live chat**: responses stream token by token; thinking, tool calls and results render as they arrive.
- **Live updates**: one Server-Sent Events connection (`GET /api/events`) keeps every page current —
  runs, prompts waiting for you, background tasks, subagents, workflows, orchestrations, account
  rotation — instead of each screen polling. If the stream drops, the sidebar status says so and the
  pages fall back to a slow poll until it returns.
- **Notifications**: a bell in the top bar collects what needs you or is worth knowing — a run waiting
  for a permission, a question or a plan (always first, with a link to it, and settled once you
  answer), a run or orchestration that finished or failed, an integration conflict, a rate limit or an
  account rotation, and finished background tasks, subagents and workflows. All but those last
  ones also pop up as a toast (questions stay until you act); browser notifications are
  opt-in, ask for permission only when you turn them on, and appear only while the tab is hidden.
  The list, read state and preferences are kept per browser. A finished task or subagent links straight
  to its side panel.
- **Execution detail**: a subagent, a background task or a workflow agent opens in a side panel — prompt,
  type, status, duration, tokens, the full transcript, the result and, for a subagent, the tasks it
  launched — from the chat that holds it, a workflow's agents and the inbox. It
  follows the agent or the command's output while it runs, and it is part of the URL (`?detail=…`), so a
  reload or a link brings it back.
- **Editors**: CodeMirror (JSON, Markdown, YAML, JS/TS) with `Ctrl/⌘ S`, unsaved-change guards
  (tabs, sidebar navigation, reload), confirmation dialogs for destructive actions
  and toasts for every mutation.
- **Form controls**: selects, suggestion lists, switches, checkboxes, sliders, number steppers,
  tooltips and collapsible sections are built on Radix primitives and styled with the app's theme
  tokens, so no control falls back to the operating system's look; all of them work from the keyboard.
- **Motion**: page transitions, staggered lists, sliding tab indicators and animated status, all
  disabled under `prefers-reduced-motion`. Fonts (Inter, JetBrains Mono) and icons are bundled —
  the container needs no network access to render.

### What is not reachable

claude.ai cloud data (web artifacts, claude.ai chat memory and projects) has no public API and
no CLI command, so the wrapper does not expose it. What Claude Code itself can reach from a
session — claude.ai connectors such as Docs, Gmail or Calendar, shown under MCP servers and in
the effective environment — is available to any run.

## Known limitations

- No API authentication, no TLS, no per-user isolation (by design for now).
- Run metadata is persisted and conversations are rebuilt from the session transcripts after a
  restart, and so are background tasks and subagents, which are read back from the files the CLI
  writes. What exists only in a run's live stream is lost: its stderr, and the rate-limit notice.
  Workers do not survive a restart either: a task caught by one is `interrupted` (not `stopped`,
  which is someone's decision), and its chat goes on in a new execution once the wrapper is back,
  while the task has attempts left. A stopped task is never continued on its own, and a workflow
  or a graph caught while integrating waits for `resume`.
- A background task's output lives in the CLI's temp dir, which a reboot clears. Its command,
  status and summary stay in the transcript.
- Running the API with a file watcher (`pnpm dev`) while an orchestration edits this same repo
  restarts it mid-flight. Use `worktree: true`, or serve with `pnpm start`.
- Secrets inside MCP `env`/headers are returned as-is by `GET /config/mcp`.
- A subscription token is meant for your own individual use; use an API key for anything
  shared or multi-user.
- Switching accounts rewrites the shared credential file: runs already in flight keep the account
  they started with, and only a run that failed against its limit is replayed on the new one.

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the
setup, the checks CI runs and the one architectural rule worth knowing before you write code:
Agentry reaches Claude Code only through its CLI.

Vulnerabilities go through [private advisories](SECURITY.md), not public issues.

## Support

If Agentry saves you time, you can [buy me a coffee](https://buymeacoffee.com/yeyo11). Starring the
repo helps just as much.

## License

[MIT](LICENSE) © Jose Antonio Garrido

Agentry is an independent project. It drives the Claude Code CLI and is not affiliated with,
endorsed by or sponsored by Anthropic.
