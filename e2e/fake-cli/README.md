# The fake `claude`

An executable named `claude` that speaks just enough of the Claude Code CLI to give the wrapper a
live process: the e2e sandbox has no login and must not spend tokens, and some features (the health
actions: cancel a command, send a hint, interrupt a turn) only exist while a process is working.
It calls no model and no network. Its own test: `node --test e2e/fake-cli/claude.test.mjs`.

## Using it

- **In a spec:** `export const fakeCli = true;`. `e2e/run.mjs` runs those specs after every other
  one, on a server restarted with `e2e/fake-cli` first on `PATH` (and `CLAUDE_BIN` unset), the
  sandbox's config directory and `AGENTRY_HEALTH_INTERVAL_MS=500`. The spec's context gains
  `fakeCli: { bin, log }`, and `dirs.configDir` is always the sandbox's. Specs without the marker
  keep the real CLI.
- **Elsewhere** (a recorder, a demo instance): put this directory first on `PATH` of the wrapper, or
  set `CLAUDE_BIN` to `e2e/fake-cli/claude`.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTRY_FAKE_CLI_LOG` | none | A file the fake appends JSON lines to (see below) |
| `AGENTRY_FAKE_CLI_HEARTBEAT_MS` | `30000` (the CLI's own pace) | How often a running command sends `tool_progress`; `0` sends none. The sandbox sets `500` |
| `AGENTRY_FAKE_CLI_ELAPSED_S` | `0` | Seconds added to every heartbeat's `elapsed_time_seconds` |
| `AGENTRY_FAKE_CLI_TURN_COST_USD` | `0` | Added to `total_cost_usd` per turn (the CLI's total is per process) |

## Subcommands

| Invocation | Output |
| --- | --- |
| `--version`, `-v` | `2.1.0-fake (Claude Code)` |
| `auth status [--json]` | `{"loggedIn":true,"authMethod":"fake","apiProvider":"firstParty"}` |
| `agents [--json]` | `[]` |
| `mcp list` | `No MCP servers configured. …` |
| `plugin list --json`, `plugin marketplace list --json` | `[]` |
| anything else without `-p` | exit 1, `fake claude: … is not part of the fake` on stderr |

## A chat: `-p --input-format stream-json --output-format stream-json`

Other flags are accepted and ignored, except `--session-id` / `--resume` (the `session_id` of every
event), `--model` (`sonnet` → `claude-sonnet-5`; a full name is kept) and `--permission-mode`.

**On start:** `{"type":"system","subtype":"init", cwd, model, permissionMode, tools:["Bash"], mcp_servers:[], claude_code_version, …}`.
No transcript is written to the config directory.

**A user message** (`{"type":"user","message":{"content": string | blocks}}`) starts a turn when none
is running. Its text is read line by line:

- `run: <command>` — one Bash call per line, in order. Each emits an `assistant` event with a
  `tool_use` block (`name: "Bash"`, `input: { command, description }`), runs `sh -c <command>` as a
  direct child of the fake in its working directory (so the command's processes are a tree under
  the CLI's pid, as the wrapper expects), sends `tool_progress` every heartbeat (`tool_use_id`,
  `tool_name`, `elapsed_time_seconds`), and ends with a `user` event holding the `tool_result`:
  the output (or `Exit code N` / the signal), `is_error` when it did not exit 0.
- `elapsed: <seconds>` — sets the heartbeat offset for this process from now on: a command then
  reports it has run that long, which is how a spec makes `hung-command` fire at once.
- A turn with `run:` lines starts with the text `Running N commands.` and ends with `All done.`;
  one with none answers `Heard: <its first line>`. Either ends with a `result` event
  (`subtype: "success"`, `is_error: false`, `num_turns: 1`, `total_cost_usd`, `result`).

**A message that arrives during a turn** is logged at once, and answered at the turn's next step
(300 ms after a command ends) with one assistant text `Heard: <first line>` per message, before
the next `run:` command starts. What is still waiting when the turn ends starts a turn of its own.

**Control requests** (`{"type":"control_request","request_id","request":{subtype}}`) are answered
with a `control_response`:

- `interrupt` — the running command's tree gets SIGTERM, its `tool_result` is
  `The user interrupted this command.` (`is_error: true`), and the turn ends with a `result` of
  `subtype: "error_during_execution"`, `is_error: true`. The process stays up for the next message.
- `set_permission_mode` (also emits `system`/`status` with the mode) and `set_model` — success.
- anything else — `subtype: "error"`, never silence.

**stdin closing** ends a running turn (its command is killed, a `result` with `is_error: true` is
emitted) and exits 0. SIGTERM, SIGINT and SIGHUP kill the running command's tree and exit 0.

## The log

With `AGENTRY_FAKE_CLI_LOG` set, one JSON object per line, each with `at`, `pid` (the fake's) and
`event`:

| `event` | Fields |
| --- | --- |
| `started` | `argv`, `cwd` |
| `stdin` | `text` — every user message, as it arrives |
| `turn` | `text`, `commands` |
| `command` | `toolUseId`, `command`, `commandPid` — logged before the `tool_use` is emitted |
| `command-ended` | `toolUseId`, `command`, `code`, `signal`, `interrupted` |
| `control` | `subtype` |
| `result` | `error`, `turns` |
| `exit` | — |
