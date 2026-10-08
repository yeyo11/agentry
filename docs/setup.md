---
created_at: 2026-10-08T21:00:00Z
updated_at: 2026-10-08T23:30:00Z
tags:
    - setup
    - security
    - providers
    - code-hosts
    - trackers
    - docker
---
# The first setup, from the app

Steps 2 and 5 of [the in-app setup plan](plans/in-app-setup.md): the secret vault, the child
environments, the sign-ins and the setup state, with their routes (Core and API), and the setup
assistant and the sign-in panel that use them (Web). The CLIs and the key in the image are the
Docker step's. This document is the reference for what is built; the plan keeps the reasoning and the
owner's decisions.

## The secret vault

`packages/core/src/secret-vault.ts`. One document, `<dataDir>/secrets.json`, mode 0600, written
through a temp file created at 0600 (`writeAtomic`), keyed by tool and variable:

```json
{ "gemini": { "GEMINI_API_KEY": "enc:v1:…" }, "youtrack": { "YOUTRACK_HOST": "…", "YOUTRACK_TOKEN": "enc:v1:…" } }
```

It keeps only what a CLI reads from its **environment**: Claude Code's token or key, Gemini's key,
OpenCode's upstream keys, YouTrack's address and token. A CLI with a login command of its own
(Codex, Copilot, gh, glab) stores its credential itself, where it always does (decision 4).

**The key**, in this order:

1. `AGENTRY_SECRET_KEY` (32 bytes as hex): the desktop app's, or one an operator passes. The server
   drops it from `process.env` once read.
2. `<dataDir>/secret.key`, when it already exists, wherever the install runs.
3. In the Docker image only (`AGENTRY_DISTRIBUTION=docker`), a new `secret.key`, 32 random bytes as
   hex, mode 0600, made on the first write (`wx`, so two servers on one volume never seal with two
   keys).
4. Otherwise none: a desktop app without a keyring or a source install keeps plain values at 0600,
   as before the vault.

`sealed` says whether values are encrypted; `keyBeside` whether the key sits in the data directory
beside them, where it protects a copy of the files (a backup, a file sent by mistake) but not the
volume. Both are in `GET /setup` as `secrets`, for Settings → Security to say so; passing the key
in the environment is the recommended setup. A value this key cannot open reads as absent.

The file is read again before every write, so two stores on one data directory never undo each
other. Every value kept is added to the redaction of Agentry's own secrets (`recognizeSecrets`).

**Migration.** The Claude store (`credentials.ts`) read `credentials.json` and the YouTrack store
(`trackers/youtrack/credentials.ts`) read `youtrack-credentials.json`. Each now reads its old file
once at start, moves it into the vault synchronously and removes it. A YouTrack token sealed under a
key this start does not have is left in its old file, so a later start with the key moves it. Their
routes, `/auth/credentials` and `/trackers/youtrack/credentials`, answer as before.

## Child environments

`packages/core/src/child-env.ts`: `childEnv(tool, base = process.env)` copies `base` and lays the
vault's variables for that tool over it. A value in the vault wins over the container's; clearing
it lets the container's show through again, because nothing is written to `process.env` any more
(the Claude store used to, so every child inherited the token). For Claude Code a credential in the
vault also hides the container's other one, since the CLI would otherwise pick between them.

Core sets the vault once (`useVaultForChildren`) before anything spawns. Every spawn goes through it:

| Where | Tool |
| --- | --- |
| `cli.ts` `execCli` (version, `auth status`, `agents`, `logs`, `stop`, plugins, MCP, connectors) and the token source | `claude-code` |
| `providers/claude-code/driver.ts` `launch`: every Claude Code process the runtime starts (chats, runs, orchestration tasks, flow runs, the assistant, `/auth/verify`) | `claude-code` |
| `providers/codex/driver.ts` `launch`, `providers/codex/transcripts.ts` reader | `codex` |
| `providers/acp/driver.ts` `launch` (Gemini, Copilot, OpenCode) | the manifest's id |
| `providers/detector.ts` probes and handshakes | the provider's id |
| `hosts/env.ts` `buildHostEnv`, so `hosts/exec.ts` and every gh, glab and youtrack-app call | `gh`, `glab`, `youtrack` |
| `setup/logins.ts` sign-in commands | the tool |

OpenCode's manifest lists the upstream keys as `credentialEnv`, so a stored key reads as `no-probe`
instead of signed out.

## Methods per tool

`packages/core/src/setup/methods.ts`, a static table written from the vendors' documentation
(the plan's "What each vendor allows"), served in `GET /setup` as `methods`:

| Tool | Key | Device code | Sign-out |
| --- | --- | --- | --- |
| `claude-code` | vault, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, one at a time | none | vault cleared, then `claude auth logout` |
| `codex` | `codex login --with-api-key`, stdin | `codex login --device-auth` | `codex logout` |
| `gemini` | vault, `GEMINI_API_KEY` | none | vault cleared |
| `copilot` | `copilot login --with-token`, stdin | `copilot login --device-code` | none documented: `unsupported` |
| `opencode` | vault, one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | none | vault cleared |
| `gh` | `gh auth login --with-token --hostname H`, stdin | `gh auth login --web --hostname H` | `gh auth logout --hostname H` |
| `glab` | `glab auth login --hostname H --stdin` | `glab auth login --device --hostname H` | `glab auth logout --hostname H` |
| `youtrack` | vault, `YOUTRACK_HOST` (the `host` field) and `YOUTRACK_TOKEN` | none | vault cleared |

OpenCode's four variables are the ones models.dev lists for those providers, which OpenCode loads
its providers from (https://opencode.ai/docs/providers/); any other variable is refused.

## Sign-ins

`packages/core/src/setup/logins.ts`, `LoginService`. Sessions are kept in memory by id, ended ones
for an hour; one live session per tool and host, and a new one cancels the one still waiting.

- **Key.** The key is trimmed and must be one token with no spaces, at most 4096 characters. An env
  tool's key goes into the vault; a stdin tool's goes once to its login command on stdin (`gh` and
  `glab` through `hosts/exec.ts`'s `runHostCall`, an agent through the binary its detector resolved,
  `binaryPath` override included). The answer comes when it ended: `succeeded`, or `failed` with
  `cli-refused`, `not-signed-in`, `cli-missing` or `timeout`.
- **Device.** The vendor's command runs with stdin closed, no TTY, in a process group of its own.
  Each line of stdout and stderr is read for the URL and the code only, with the patterns of
  `setup/device-patterns.ts` (one row per tool, a URL regex and a code regex); once both are seen the
  session is `waiting-for-person`. The command's exit ends it: non-zero is `failed` (`no-code` if it
  never showed one, `cli-refused` otherwise); zero re-reads the tool's readiness, and only a
  signed-in reading is `succeeded`. After 15 minutes it is `expired`; cancelling is `cancelled`; both
  kill the group.
- **Success is the readiness probe**, never the output: the provider detector refreshed for that
  provider (Claude Code with Core's system read taken again), the code hosts' detector refreshed and
  the host's `signedIn`, or YouTrack's tracker detection.
- **Sign-out** as the table says. Copilot answers `signedOut: false`, reason `unsupported`.

The device patterns were written from the documented formats, and the tests run them against fake
output (`packages/core/test/fixtures/logins/*-fake.txt`). The recordings of the real commands, made
with no TTY in the image, replace those fakes and decide whether a row keeps its device method; gh's
row is flagged `deviceNeedsRecording` until its recording shows `--web` works without a terminal.

A secret never goes into argv, a log, an event or an answer: the tests assert the spawned argv and
what the fake CLI read on stdin, and that no event or answer carries the key.

## Events

`login.updated` on `/api/events`, carrying `login`: `{ id, tool, method, host, state, url, code,
startedAt, expiresAt, endedAt, error, ready }`. States: `starting`, `waiting-for-person`,
`succeeded`, `failed`, `expired`, `cancelled`. `error` is a code, never what the CLI printed. The
web marks the setup state stale when a sign-in ends.

## Setup state and `setupSeen`

`GET /setup` (`Core.setupState`) answers the access mode, each enabled provider's readiness (and
whether the vault keeps a key for it), each code host's CLI with its hosts, whether YouTrack is
configured, the methods table, the vault's `secrets`, and `seen`.

`setupSeen` replaces `providersStepSeen` in the layered app settings
([layered-settings.md](layered-settings.md)). `AGENTRY_SETUP_SEEN` sets it from the environment;
the old `AGENTRY_PROVIDERS_STEP_SEEN` still counts when the new one is not set, and a
`providersStepSeen` stored in `app-settings.json` reads as `setupSeen`, so an install that saw the
old step is not walked through the assistant again. `POST /setup/seen` records it, and answers 409
when the environment sets it off.

## Routes

| Route | What it does |
| --- | --- |
| `GET /setup` | The setup state |
| `POST /setup/seen` | Records `setupSeen` |
| `POST /setup/logins` | `{ tool, method, host?, secret?, variable? }`; 201 with the session |
| `GET /setup/logins/:id` | One session |
| `DELETE /setup/logins/:id` | Cancels it |
| `DELETE /setup/credentials/:tool?host=` | Signs out |

Every write is refused in read-only mode (405), and every route but `GET /setup` to a chat's token
(403), since reading a session would hand it the person's device code. Types are in
`packages/shared/src/types.ts` (`SetupState`, `StartLoginRequest`, `LoginSession`, `SignOutResult`,
`SetupToolMethods`, `SecretStorageStatus`), the client in `apps/web/src/api.ts`.

## The web

`apps/web/src/components/setup/`, styled by `styles/setup.css`, with the copy in the `setup`
namespace; the pure logic (methods per tool, failures, steps, summary) is `lib/setup.ts`, tested in
`apps/web/test/setup.test.tsx`. Design: [design-system.md](design-system.md#setup-the-assistant-the-sign-in-panel-and-the-secrets-line).

- **The sign-in panel** (`SignInPanel`, `SignInSheet`) serves every tool but YouTrack, which keeps its
  address-and-token form (`YoutrackAccess`). It reads the tool's row of `GET /setup`'s `methods`: the
  Code / Key choice where there is a device code (code first), a second choice where the key may go
  in several variables (Claude Code's token or API key, OpenCode's four providers), the host field for
  `gh` and `glab`. The key field is write-only and cleared once sent. Opening an agent's panel on Code
  asks for a code at once; a host CLI asks for its host first. A device session moves with
  `login.updated` events (`useLogin`), read with `GET /setup/logins/:id` every 3 s only while the event
  stream is down; succeeded closes the panel and reads every readiness list again, cancelled closes it,
  failed and expired say why by code with the one action (Retry, Use a key, See install, Get another
  code). Closing a panel whose code still waits cancels the session. Claude Code's panel names
  `claude setup-token` inside the sentence, with no copy button.
- **Sign out** (`SignOutButton`) asks first, as a destructive action, and calls
  `DELETE /setup/credentials/:tool` (per host for `gh` and `glab`). It is offered where the tool works,
  or keeps only a key Agentry holds, and its vendor documents a way out: never for Copilot.
- **Where the panel is.** Settings → Providers (each signed-out row's Sign in, a ready row's Sign out;
  `useProviderSignIn`), Settings → Integrations (a signed-out CLI's Sign in, Add another host on a
  ready one, and Sign in or Sign out at the end of each known host's line; the rows moved to
  `pages/config/integrations/rows.tsx` so the assistant lists the same ones), Settings → Account (the
  panel as the card that replaced the old credential form; the status card and Verify stay), and the
  assistant.
- **Settings → Security** starts with the Secrets card (`SecretsCard`), from `GET /setup`'s
  `secrets`: encrypted or not, a warning when the key sits beside the data or when there is none,
  with the link to how to pass `AGENTRY_SECRET_KEY`.
- **The assistant** (`SetupAssistant`, lazy) replaces the first-run Providers step, which is gone.
  `lib/first-run.ts`'s `useSetupGate` shows it while `GET /setup` says `seen: false`; a failed read
  hides it. Steps: Access (None or Token, from the same pieces as Settings → Security's token card,
  `pages/config/security/token.tsx`; turning Token on makes a token first when this browser holds
  none, so it cannot lock the person out), Agents (the providers switched on, or the install page when
  none is found), Code and work items (GitHub, GitLab, YouTrack), Done (a summary with where each
  thing is changed). Back, Skip and Continue move between steps and remember what was skipped; Start
  on Done, "Skip setup" in the header or a summary link records `POST /setup/seen`, and the assistant
  never comes back. A server that cannot record it (read-only, or the environment owns `setupSeen`)
  only hides it until the page reloads.
- **e2e.** `e2e/specs/setup.spec.mjs` walks the assistant and signs Codex in with a device code
  through the fake `codex` (`login --device-auth` prints the recording and waits for the spec's
  approval file), then signs it out from Settings; `providers.spec.mjs` covers the Agents step.

## Related

[[plans/in-app-setup.md]] · [[providers.md]] · [[code-hosts.md]] · [[trackers.md]] ·
[[layered-settings.md]] · [[container-state.md]] · [[deploy.md]]
