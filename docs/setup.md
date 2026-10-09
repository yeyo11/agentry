---
created_at: 2026-10-08T21:00:00Z
updated_at: 2026-10-09T16:00:00Z
tags:
    - setup
    - security
    - providers
    - code-hosts
    - trackers
    - docker
    - tailscale
---
# The first setup, from the app

Steps 2, 5 and 7 of [the in-app setup plan](plans/in-app-setup.md): the secret vault, the child
environments, the sign-ins and the setup state, with their routes (Core and API), the setup
assistant and the sign-in panel that use them (Web), and the sign-in of the image's own Tailscale.
The CLIs and the key in the image are the Docker step's
([deploy.md](deploy.md#what-the-image-contains)); how the secrets are kept, and what the vendors'
CLIs keep in plain text, is in [security-model.md](security-model.md). This document is the
reference for what is built; the plan keeps the reasoning and the owner's decisions.

## The secret vault

`packages/core/src/secret-vault.ts`. One document, `<dataDir>/secrets.json`, mode 0600, written
through a temp file created at 0600 (`writeAtomic`), keyed by tool and variable:

```json
{ "gemini": { "GEMINI_API_KEY": "enc:v1:…" }, "youtrack": { "YOUTRACK_HOST": "…", "YOUTRACK_TOKEN": "enc:v1:…" } }
```

It keeps only what a CLI reads from its **environment**: Claude Code's token or key, Gemini's key,
Copilot's token (`COPILOT_GITHUB_TOKEN`), OpenCode's upstream keys, YouTrack's address and token. A
CLI with a login command of its own (Codex, gh, glab) stores its credential itself, where it always
does (decision 4). Copilot has one, but it cannot keep a token without a system keychain unless a
terminal answers it (see [Copilot in a container](#copilot-in-a-container)), so its token is kept here.

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
instead of signed out. Copilot's manifest also sets `credentialEnvSignsIn`, so its token reads as
signed in (see below). The ACP driver lays the vault over the server's own environment, so a Copilot
chat also inherits `GH_CONFIG_DIR` (set image-wide in Docker) and the `PATH` that finds `gh`: its gh
fallback works at run time, not only in detection.

## Methods per tool

`packages/core/src/setup/methods.ts`, a static table written from the vendors' documentation
(the plan's "What each vendor allows"), served in `GET /setup` as `methods`:

| Tool | Key | Device code | Sign-out |
| --- | --- | --- | --- |
| `claude-code` | vault, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, one at a time | none | vault cleared, then `claude auth logout` |
| `codex` | `codex login --with-api-key`, stdin | `codex login --device-auth` | `codex logout` |
| `gemini` | vault, `GEMINI_API_KEY` | none | vault cleared |
| `copilot` | vault, `COPILOT_GITHUB_TOKEN` (a classic `ghp_` token is refused) | gh's, on github.com or Copilot's GitHub host (`deviceVia`) | vault cleared (`signOutKeyOnly`) |
| `opencode` | vault, one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | none | vault cleared |
| `gh` | `gh auth login --with-token --hostname H`, stdin | `gh auth login --web --hostname H` | `gh auth logout --hostname H` |
| `glab` | `glab auth login --hostname H --stdin` | `glab auth login --device --hostname H` | `glab auth logout --hostname H` |
| `youtrack` | vault, `YOUTRACK_HOST` (the `host` field) and `YOUTRACK_TOKEN` | none | vault cleared |
| `tailscale` | `tailscale up --reset --hostname=N --auth-key=file:P` (`key: 'file'`) | `tailscale up --reset --hostname=N`: a login URL, no code | tunnel closed, then `tailscale logout` |

OpenCode's four variables are the ones models.dev lists for those providers, which OpenCode loads
its providers from (https://opencode.ai/docs/providers/); any other variable is refused.

Two fields shape the panel beyond key and device. `deviceVia` names the tool whose device sign-in a
tool uses: only Copilot's, `{ tool: 'gh', host: 'github.com' }`. `signOutKeyOnly` marks a tool whose
sign-out only forgets the kept key (Gemini, OpenCode, Copilot); its row offers Sign out only while a
key is kept.

## Copilot in a container

Decided by the owner on 2026-10-08, after a bug found in the Docker image. Copilot CLI 1.0.93's own
`copilot login --device-code`, with no TTY and no system keychain, prints the code, waits for the
approval, then writes on stderr `Login succeeded, but the token was not saved. Install a system
keychain or rerun login and accept plaintext storage.` and exits 1. The plain-text question can only
be answered on a real terminal (stdin `/dev/null` and a pipe with `y` both give the same message),
and `copilot login --with-token` reaches the same step. Nothing is written under `COPILOT_HOME`, and
Agentry showed `cli-refused`. Driving a terminal to answer it would break the one rule.

GitHub's documentation for containers and non-interactive use
(https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
names the way instead. Copilot looks for credentials in this order: `COPILOT_GITHUB_TOKEN`,
`GH_TOKEN`, `GITHUB_TOKEN`, an OAuth token in the system keychain, then the GitHub CLI's
(`gh auth token`). It takes fine-grained tokens with the Copilot Requests permission and OAuth tokens
of the Copilot and gh apps, and not classic `ghp_` tokens. So:

- **Key.** The fine-grained token is sealed in the vault and handed to Copilot's own processes as
  `COPILOT_GITHUB_TOKEN`, like Gemini's key, never in argv. A `ghp_` token is refused with `400` and
  a reason, and the panel says so before sending it. Sign out forgets it.
- **Code.** Copilot no longer runs its own `--device-code`. `POST /setup/logins` with
  `{ tool: 'copilot', method: 'device' }` starts gh's device sign-in to Copilot's GitHub host
  (github.com unless the environment names another, see **GitHub Enterprise** below), the same session
  the GitHub row would start (one live sign-in per tool and host), and answers it, `tool: 'gh'`. The
  panel says "Copilot uses your GitHub sign-in (gh)". When it succeeds, Copilot's readiness is read
  again with gh's.
- **Detection.** Copilot reads `ready` when its state file lists an account (a keychain-backed
  `copilot login`, as on a desktop), when one of its three variables is in its environment, vault
  included, or when `gh auth token --hostname <host>` succeeds with something printed. That last
  check runs the `gh` on the PATH Copilot gets, through `hosts/exec.ts` (gh's environment, a process
  group, the probe timeout, no retry), and reads only the exit code and whether the output is empty:
  the token is never kept or logged (`providers/gh-fallback.ts`). A sign-in or sign-out of gh on that
  host from Agentry refreshes Copilot at once; one made in a terminal is seen at the next detection
  (`PROVIDERS_TTL_MS`).
- **Account.** When Copilot works through gh, its row names gh's account on that host: the `user:`
  gh writes for each host in `hosts.yml`, in its config directory (`GH_CONFIG_DIR`, else
  `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`, as `gh help environment` orders them;
  `/data/provider-homes/gh` in the image). Reading the file the CLI writes costs no network call;
  `gh auth status --json hosts` would test every account's token online, so it is not used here. Only
  that one field of the host's block is read, never the token gh may keep beside it. A host other than
  github.com is named `login@host`, like a Copilot account off github.com. No account is named when
  the file or the host is missing, or when `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` answers
  for an Enterprise host instead of the stored sign-in. The row says nothing about the account coming
  from gh: the setup has no place that names a credential's source, and the account is the same one.
- **GitHub Enterprise.** `copilot help environment` (1.0.93) documents `COPILOT_GH_HOST` ("GitHub
  hostname used only by Copilot CLI for authentication and API requests, overriding GH_HOST") and
  `GH_HOST` (default `github.com`; set it to a GitHub Enterprise Cloud with data residency host such
  as `mycompany.ghe.com`), and GitHub's page tells an Enterprise Cloud user of the gh fallback to
  "verify the correct hostname is authenticated" with `gh auth status --hostname`. So the host Copilot
  asks gh about is `COPILOT_GH_HOST`, else `GH_HOST`, else `github.com`, read from the environment
  Copilot's processes get (a URL such as `https://acme.ghe.com`, the form `copilot login --host`
  takes, is read as its host). Detection runs `gh auth token --hostname` for that host, and Copilot's
  Code signs gh in to it (`deviceVia.host` in `GET /setup`). A variable that names no host leaves
  Copilot with no gh sign-in to read, and its Code is refused with `400`. Copilot's own
  `copilot login --host` on a desktop keeps working as before, through its state file.
- **Outside Docker** the same rules hold and change nothing: a keychain-backed `copilot login` still
  counts first.

Verified in the image on 2026-10-08: gh signed in to github.com by device code (`gho_…`, kept in
`/data/provider-homes/gh/hosts.yml` because `GH_CONFIG_DIR` is set image-wide), Copilot never signed
in, and `copilot -p "Reply with the single word OK" --allow-all-tools </dev/null` answered.

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
- **Sign-out** as the table says. Copilot's forgets only the token Agentry keeps: neither a
  `copilot login` of the machine's own nor gh's sign-in is touched.

The device patterns were first written from the documented formats; they now follow the
recordings of the real commands, made with no TTY in the image
(`packages/core/test/fixtures/logins/`, see its `README.md`), and the session tests replay those
recordings. Codex prints the URL and the code each alone on a coloured line, glab's code has eight
characters and no dash, and gh's `--web` runs without a terminal, so gh keeps its device method.
Copilot's own `--device-code` was recorded too, and dropped (see above).

A secret never goes into argv, a log, an event or an answer: the tests assert the spawned argv and
what the fake CLI read on stdin, and that no event or answer carries the key.

## Tailscale

Added 2026-10-08 (the plan's decision 6). Remote access goes through Tailscale, and in the Docker
image Agentry runs the daemon itself ([deploy.md](deploy.md#the-tunnel-in-docker)), so a person with
no shell on the machine signs it in here. Recorded on 1.102.4 against a throwaway userspace daemon
(`packages/core/test/fixtures/logins/README.md`, `tailscale-up.*`).

- **Only where Agentry runs the daemon.** `CoreConfig.tailscaleManaged` comes from
  `AGENTRY_TAILSCALE_MANAGED`, which the image's entrypoint sets once it started `tailscaled`.
  Anywhere else, and with `AGENTRY_TUNNEL=off`, `POST /setup/logins` and `DELETE
  /setup/credentials/tailscale` answer `409` (`LoginRefusedError`): a machine's own Tailscale is the
  person's, and the UI shows its state and what to run.
- **Login URL** (the `device` method, offered as **Link**). `tailscale up --reset --hostname=agentry`
  with no TTY prints, on stderr, `To authenticate, visit:` and the URL alone on a line
  (`https://login.tailscale.com/a/<id>`), then waits until the node is `Running`. There is no code: a
  device pattern's `code` may be null, the session is `waiting-for-person` once the URL is read, and
  `LoginSession.code` stays null. `--reset` because `up` refuses flags that differ from what the
  daemon kept unless every one is named again, and Agentry is the daemon's only user. Nothing else
  is passed: no routes, no exit node, no DNS change beyond Tailscale's defaults.
- **Auth key.** `tailscale up` takes a key only in argv or as `--auth-key=file:<path>` (1.102 `up
  --help`; a bad key answers `backend error: invalid key: API key does not exist`). The key goes into
  a file of mode 0600 inside a fresh 0700 folder under the system temp directory, the command gets
  the path, and the folder is removed when the command ended, whatever happened. tailscaled keeps
  the node key it gets, so the auth key is used once and kept nowhere (decision 4).
- **Success** is `tailscale status --json` read again through the tunnel (`TunnelManager.refresh`):
  any state past `NeedsLogin` counts as signed in; MagicDNS or HTTPS being off is the tailnet's
  setting, said by the tunnel's own reasons.
- **Sign-out** closes the tunnel first (its Serve rule is taken away while the daemon can still do it),
  then runs `tailscale logout`, which expires the node key and takes the node off the tailnet.
- **The node's name** is `AGENTRY_TAILSCALE_HOSTNAME`, `agentry` by default, checked as a DNS label at
  startup.
- **`GET /setup`** carries `tailscale: { enabled, managed, state, host }`, read through the tunnel
  (so a source install's state is the machine's own).
- **Web.** The assistant's Access step lists Tailscale under the access card (`TailscaleRow`, a
  `.prov-row` like the other tools; a Sheet on a phone), when the tunnel is offered and there is a
  Tailscale: Sign in or Sign out where it is managed, the state and a sentence otherwise. The Done
  step lists it, pointing at Settings → Remote access. In Settings → Remote access a managed node
  that is signed out shows **Sign in to Tailscale**, which opens the shared panel inside the card
  (`layout="card" closable`; it never asks for a link before the person presses it), and a signed-in
  one shows Sign out beside its name. The panel offers **Link / Key**; a waiting link is drawn by
  `DeviceCode` with the URL and Copy in the code's place, still the screen's one live surface.

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
  `claude setup-token` inside the sentence, with no copy button. Copilot's Code says "Copilot uses
  your GitHub sign-in (gh)" and asks GitHub for the code (`deviceVia`); its Key field takes a
  `github_pat_…` and refuses a `ghp_` one inline before sending it (`refusedKey`).
- **Sign out** (`SignOutButton`) asks first, as a destructive action, and calls
  `DELETE /setup/credentials/:tool` (per host for `gh` and `glab`). It is offered where the tool works,
  or keeps only a key Agentry holds. Where it only forgets that key (`signOutKeyOnly`: Gemini,
  OpenCode, Copilot) it is offered only while one is kept, and the confirmation says the tool stops
  working only if it has no other sign-in.
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
[[layered-settings.md]] · [[container-state.md]] · [[deploy.md]] · [[tunnel.md]] · [[security-model.md]]
