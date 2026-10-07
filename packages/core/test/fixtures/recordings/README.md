# Provider recordings

Scrubbed copies of what the Codex, GitHub Copilot, Gemini and OpenCode CLIs sent and answered when
they were run on 2026-10-01 to write `docs/plans/multi-provider.md`, "Phase 3". The fakes in
`packages/core/test/fixtures/` replay these shapes and invent no event. The `gh` and `glab`
folders beside these belong to the code hosts and have their own notes, and `youtrack-app` to the
YouTrack tracker, with its own `NOTES.md`.

Every run used a sandbox: `env -i`, an empty `HOME`, `CODEX_HOME`, `COPILOT_HOME`,
`GEMINI_CLI_HOME` and `XDG_*` inside it, and `timeout` on every call. `*.jsonl` files hold one
line per JSON-RPC message, `{"t": <ms offset>, "dir": "in"|"out", "line": <message>}`, where `in` is
what was sent to the CLI. `*.script.json` is the script that produced the capture.

| Folder | CLI and version | Command | What is in it |
|---|---|---|---|
| `codex/0.159.3` | `codex-cli 0.159.3` (`@openai/codex`) | `codex app-server` (stdio JSON-RPC) | the handshake (`initialize`, `account/read`, `model/list`, rate limits, `config/read`, `thread/start`, `thread/list`, `permissionProfile/list`, an unknown method); a signed-out turn; `turn/interrupt` and a failed turn (401); `login status` signed out; help; the `generate-ts` subset the driver uses (`ts/`, with the types they import) |
| `copilot/1.0.65` | GitHub Copilot CLI 1.0.65 | `copilot --acp` | `initialize`, `session/new`, `session/list`; help |
| `copilot/1.0.90` | GitHub Copilot CLI 1.0.90 | `copilot --acp` | one `session/prompt` turn that ran by accident on the owner's account, in plan mode. Event shapes, ids, enums and token counts are kept; every string the model produced is replaced by `<text>` |
| `copilot/1.0.91` | GitHub Copilot CLI 1.0.91 | `copilot --acp` | recorded 2026-10-03 on the owner's machine, signed in, with no prompt sent: `initialize`, `session/new` (now with `models` and a `model` config option; this account offers only `auto`, listed three times), `session/close`; the shape of the state file `config.json` that lists the accounts that signed in (logins replaced, other keys dropped); help on config and login, and the variables of `copilot help environment` that Agentry reads (the rest dropped: its examples look like credentials) |
| `gemini/0.62.0` | Gemini CLI 0.62.0 | `gemini --acp` | `initialize`, `session/new` refused with `-32000` (key missing), `session/list` not found; help |
| `opencode/1.18.34` | OpenCode 1.18.34 | `opencode acp` | `initialize`, `session/new` (free models offered signed out), `session/list`; `schema.sql` and `migrations.txt` of `opencode.db`; paths; help |

Scrubbing: home and recording paths are `<home>`, the machine name is `<host>`, the installation id
is all zeros, and nothing carries an account name, an e-mail address or a token.
`provider-recordings.test.ts` fails if a file brings any of them back.
