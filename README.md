<div align="center">

<img src="apps/web/public/favicon.svg" width="76" alt="">

# Agentry

**Run Claude Code as a service.**

A REST API, a web UI and multi-agent orchestration around the Claude Code CLI, in one container.

[![CI](https://github.com/yeyo11/agentry/actions/workflows/ci.yml/badge.svg)](https://github.com/yeyo11/agentry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/yeyo11/agentry?style=flat&logo=github&color=8b5cf6)](https://github.com/yeyo11/agentry/stargazers)
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
docker run -p 8787:8787 -v agentry:/data ghcr.io/yeyo11/agentry
```

### What you get

- **Every conversation, from anywhere** — start a run from the UI or the API, stream the tokens,
  answer follow-up turns, and pick up any session the CLI has ever written on that machine.
- **Orchestration** — a DAG of tasks, each with its own Claude worker, run in parallel with
  dependency context and a synthesis step. An auto-planner drafts the graph for you.
- **Multi-account rotation** — usage per window, proactive switching before an account runs out,
  and a run that hits its limit is rotated and resumed on the next account.
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
docker run -d --init -p 8787:8787 \
  -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-... \
  -v agentry-config:/home/node/.claude \
  -v agentry-data:/data \
  -v agentry-accounts:/home/node/.local/share/claude-swap \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/yeyo11/agentry
```

The UI and the API reference are on <http://localhost:8787> — the panel at `/`, the interactive
OpenAPI docs at `/docs`. Everything else is configured from the UI.

<details>
<summary>Building it yourself instead</summary>

```bash
git clone https://github.com/yeyo11/agentry
cd agentry
cp .env.example .env        # paste the token into CLAUDE_CODE_OAUTH_TOKEN
docker compose up --build
```

`docker-compose.yml` pins the CLI version through `CLAUDE_CODE_VERSION` if you need a specific one.

</details>

Open <http://localhost:8787> for the UI; the API lives under `/api`.

Volumes:

| Mount | Purpose |
| --- | --- |
| `claude-config` → `/home/node/.claude` | The whole account setup: `settings.json`, `.claude.json` (MCP servers), `CLAUDE.md`, agents, skills, commands and session transcripts |
| `./workspace` → `/workspace` | Projects Claude works on (default `cwd` for runs) |
| `wrapper-data` → `/data` | Wrapper state (orchestrations, auto-rotation settings) |
| `claude-swap` → `/home/node/.local/share/claude-swap` | Credentials of every registered account |

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
palette and the sessions screen; `E2E_LIVE=1 pnpm e2e chat` additionally holds a real
conversation with Claude (streamed reply, follow-up turn, stop) using your login.

## Monorepo layout

```
packages/shared   Types and the message normalizer shared by every package (the API contract)
packages/core     CLI communication: detection, auth, run manager, session store,
                  orchestrator, accounts (claude-swap), config managers
apps/api          Fastify REST API + SSE; serves the built UI in production
apps/web          React + Vite UI
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
| GET | `/active` | Live CLI sessions (`claude agents --json`) |

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

Rotation happens two ways:

- **Proactive** — with `enabled`, the wrapper supervises a `cswap auto --json` process that
  switches when the active account's binding window reaches `threshold` (default 90 %), reusing
  claude-swap's cooldown, hysteresis and quarantine of dead refresh tokens.
- **Reactive** — with `rotateOnLimit` (default on), a run that dies against its rate limit
  (`rate_limit_event` rejection, a 429 result or a matching stderr line) triggers a rotation to
  the account with the most headroom, and the turn is replayed on the same session with
  `--resume`. Once per run: a second failure is reported as a real one.

A run can also be pinned to one account with `RunOptions.account`, which spawns
`cswap run <account> --share-history -- …` instead of `claude`. Pinned runs keep writing their
transcript to the shared config dir, so sessions and history behave as usual.

### Projects and sessions

| Method | Route | Description |
| --- | --- | --- |
| GET | `/projects` | Workspace directories plus every directory with Claude Code history, with active run counts |
| POST | `/projects` | `{ name, gitUrl? }` — create an empty project in the workspace or clone a repository into it |
| GET | `/projects/:id/sessions` | Sessions of one project |
| GET | `/sessions?limit=N` | All sessions, newest first, flagged when live |
| GET | `/sessions/:id?sidechains=1` | Full transcript (optionally with subagent messages) |
| DELETE | `/sessions/:id` | Delete a transcript (refused while the session is live) |

### Runs

A run is a live conversation backed by a `claude -p` process.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/runs` | All runs |
| POST | `/runs` | Start a run. Body: `RunOptions` (`prompt` required; `cwd`, `model`, `permissionMode`, `resumeSessionId`, `name`, `effort`, `appendSystemPrompt`, `allowedTools`, `keepAlive`, `jsonSchema`) |
| GET | `/runs/:id` | Run summary + buffered events |
| GET | `/runs/:id/stream?since=SEQ` | Server-Sent Events, one `RunEvent` per message (honours `Last-Event-ID`). Includes ephemeral `partial` events with the text generated so far (token streaming); they are never replayed |
| POST | `/runs/:id/messages` | `{ text }` — send another turn (resumes the session if the process ended) |
| POST | `/runs/:id/stop` | Stop the process; the conversation is kept |
| DELETE | `/runs/:id` | Forget an ended run |
| GET | `/environments?cwd=` | What Claude actually loaded (tools, MCP status, agents, skills, plugins, commands, memory paths) per directory, from the latest run there |
| GET | `/tasks` | Background tasks across runs |
| GET | `/subagents` | Subagents across runs |

```bash
curl -X POST localhost:8787/api/runs -H 'content-type: application/json' \
  -d '{"prompt":"Summarize this repo","cwd":"/workspace/my-project","model":"sonnet"}'
curl -N localhost:8787/api/runs/<id>/stream
```

### Orchestration

An orchestration is a DAG of tasks; each task runs in its own Claude worker. Independent
tasks run in parallel (up to `concurrency`), results of dependencies are passed to dependent
tasks, and an optional final worker synthesizes a report.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/orchestrations` | List |
| POST | `/orchestrations` | Launch. Body: `OrchestrationSpec` |
| POST | `/orchestrations/plan` | `{ objective, cwd?, model?, maxTasks? }` → draft `OrchestrationSpec` produced by a planner agent |
| GET | `/orchestrations/:id` | State of every task, results, cost |
| POST | `/orchestrations/:id/stop` | Stop all workers |

```json
{
  "name": "audit",
  "objective": "Audit the project and propose fixes",
  "cwd": "/workspace/my-project",
  "concurrency": 3,
  "synthesize": true,
  "tasks": [
    { "id": "deps", "name": "Dependencies", "prompt": "Review outdated dependencies…" },
    { "id": "tests", "name": "Tests", "prompt": "Assess test coverage…" },
    { "id": "plan", "name": "Fix plan", "prompt": "Write a prioritized fix plan.", "dependsOn": ["deps", "tests"] }
  ]
}
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
| GET | `/config/resources/:kind?project=` | `kind` = `agents` \| `skills` \| `commands` \| `output-styles` \| `rules` |
| GET / PUT / DELETE | `/config/resources/:kind/:name?project=` | Markdown content — body `{ content }` |

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
| GET | `/memory` | Projects with their memory file counts |
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
| Dashboard | CLI detection, auth status, subscription usage limits, live runs, recent sessions |
| Agents | Runs in progress, their subagents, and every live CLI session on the machine |
| Run view | Live chat over SSE: messages, thinking, tool calls/results, background tasks, subagents, what Claude loaded |
| Sessions | Full history across projects, transcripts (with subagent sidechains), resume into a run, delete |
| Background tasks | Tasks started by any run, with status and duration |
| Projects | Workspace directories and directories with history; create or clone a project |
| Orchestration | Auto-planned or manual task DAG, live board by stage, per-task results, synthesis |
| Accounts | Registered accounts with 5h/7d (and per-model) usage, manual switch, add/remove, enable/disable, auto-rotation settings and the rotation log |
| Memory | Claude Code's per-project memory files and the `MEMORY.md` index |
| Plugins | Installed plugins (enable/disable/uninstall/details), marketplace search and install, marketplaces |
| Config | Scope selector (user or any project) over: Account, Instructions, Settings (guided editor + raw JSON), MCP servers (guided form, scopes, connection checks), Agents, Skills, Commands, Output styles, Rules, and a file explorer for everything else (hook scripts, skill files, keybindings…) |

Across the app:

- **Command palette** (`Ctrl/⌘ K`): fuzzy search over pages, config sections, projects, live runs,
  recent sessions and actions (new run, theme, API reference…), with recents and full keyboard control.
- **Themes**: light, dark or system, switchable from the top bar or the palette, applied before first paint.
- **Live chat**: responses stream token by token; thinking, tool calls and results render as they arrive.
- **Editors**: CodeMirror (JSON, Markdown, YAML, JS/TS) with `Ctrl/⌘ S`, unsaved-change guards
  (tabs, scope switches, sidebar navigation, reload), confirmation dialogs for destructive actions
  and toasts for every mutation.
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
  restart, but live-only details (background task and subagent lists, stderr) are not.
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
