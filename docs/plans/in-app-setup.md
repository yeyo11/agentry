---
created_at: 2026-10-08T19:00:00Z
updated_at: 2026-10-09T16:00:00Z
tags:
    - plan
    - setup
    - providers
    - code-hosts
    - trackers
    - security
    - docker
    - design-system
    - built
---
# Plan: set up a fresh Agentry from Agentry

Status: **landed** in #228, released in v0.37.0 (proposed 2026-10-08, every step done 2026-10-09,
built on branch `fix/adjustments`; see [Outcome](#outcome)). The owner chose the options recorded under [Decisions](#decisions).

## Goal

A person who starts a fresh Agentry (above all the Docker image, where they have no terminal on the
machine) does every piece of the first setup in the app: who may open it, every agent's sign-in,
GitHub and GitLab, YouTrack. Nothing asks them to open a shell on the server. Everything the setup
writes stays editable in Settings afterwards.

## What exists, and what is missing

Measured on `fix/adjustments` (see the chat of 2026-10-08 and [container-state.md](../container-state.md)):

- Claude Code takes a pasted OAuth token or API key in Settings → Account
  (`packages/core/src/credentials.ts`, `PUT /auth/credentials`). It is stored plain, mode 0600.
- YouTrack takes an address and a token (`YoutrackAccess.tsx`, `trackers/youtrack/credentials.ts`),
  sealed with `SecretBox` when a key exists.
- Every other agent and both code hosts offer only a link to the vendor's page. There is no field
  for a key, nothing that passes one to a CLI, and nothing that runs a sign-in command.
- The first-run screen covers providers only (`FirstRunGate`, `ProvidersStep.tsx`).
- The image has no `gh`, `glab` or `youtrack-app`, and no `AGENTRY_SECRET_KEY`, so every secret in a
  container is a plain file.

## What each vendor allows (the one rule)

Only what the vendor ships for programs. Sources and what was confirmed on the pinned versions are in
the research of 2026-10-08; the table is the result.

| Tool | Key or token, how it reaches the CLI | Device code (the person opens a URL on their own device and types a code) |
|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` (made with `claude setup-token` on the person's own machine) or `ANTHROPIC_API_KEY`, env | none: `auth login` needs a local callback or a pasted code on a terminal |
| Codex | `codex login --with-api-key`, stdin; the CLI stores it in `CODEX_HOME` | `codex login --device-auth` (beta; the person may have to turn device login on in ChatGPT first) |
| Gemini CLI | `GEMINI_API_KEY`, env | none: Google sign-in lives in its TUI |
| Copilot CLI | `COPILOT_GITHUB_TOKEN`, env (fine-grained PAT with Copilot Requests; decision 7) | gh's device code: Copilot falls back to `gh auth token` (decision 7) |
| OpenCode | the upstream provider's key, env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) | none usable: subscriptions go through a TUI menu |
| gh | `gh auth login --with-token -h <host>`, stdin | `gh auth login --web -h <host>` prints a one-time code, and works with no TTY (recorded 2026-10-08) |
| glab | `glab auth login --hostname <host> --stdin` | `glab auth login --device --hostname <host>` (GitLab 17.9 or later) |
| YouTrack | address and permanent token, env (`YOUTRACK_HOST`, `YOUTRACK_TOKEN`); exists | none |

Not done, on purpose: driving `claude auth login`'s paste-code prompt, Gemini's or OpenCode's TUI
sign-ins, or any OAuth client of our own. Those stay links, with the reason said.

## Decisions

1. **Key and device code** (owner, 2026-10-08). A key or token field for all eight tools, and the
   device-code flow where the vendor documents one: Codex, Copilot, glab, and gh once a recording shows
   `--web` works with no terminal. (Copilot's became gh's: decision 7.)
2. **A setup assistant on first start** (owner). The first-run screen grows into steps: Access →
   Agents → Code and work items → Done. Every step can be skipped, and every step is the same panel
   Settings shows.
3. **gh, glab and youtrack-app in the image, and secrets sealed in Docker** (owner). The CLIs pinned
   like the agents, their config homes under `/data`. With no `AGENTRY_SECRET_KEY` in the
   environment, the server makes one and keeps it in the data directory, mode 0600, and says in
   Settings → Security that a key beside the data it seals protects a copy of the files, not the
   volume; passing the key through the environment is the recommended setup.
4. **The CLI owns its credential when it has a command for it.** A key for Codex, Copilot, gh or glab
   goes to that CLI's own login command on stdin and is stored where the CLI stores it (under `/data`
   in the image). Agentry keeps only what a CLI reads from its environment: Claude Code, Gemini,
   OpenCode's upstream keys, YouTrack. Those are sealed and given to the child process only.
   (Copilot moved to the vault side: decision 7.)
5. **A secret never goes in argv, a log, an event or an answer.** Write-only fields, stdin or env only.
6. **Tailscale runs inside the image, and is signed in from the app** (owner, 2026-10-08). Remote
   access could not be set up in a container: the image had no `tailscale` and the tunnel was off
   there. The image now carries Tailscale's static build, and its entrypoint starts `tailscaled
   --tun=userspace-networking` (no root, no `NET_ADMIN`, no `/dev/net/tun`) with its state in
   `/data/tailscale/`; the tunnel is on by default in the image, and `AGENTRY_TUNNEL=off` starts no
   daemon. Tailscale joins the setup's tools with two methods, a login URL (`tailscale up` with no
   TTY, no code) and an auth key passed as `--auth-key=file:<0600 file>` (the only way its CLI takes a
   key outside argv, so decision 5 holds), and signs out with `tailscale logout`. Only that daemon is
   Agentry's to sign in (`AGENTRY_TAILSCALE_MANAGED`); a machine's own Tailscale stays the person's.
   Tailnet only, never Funnel.
7. **Copilot signs in through its environment and gh, not its own login** (owner, 2026-10-08).
   In the image, `copilot login --device-code` (1.0.93) took the approval and then exited 1 with
   `Login succeeded, but the token was not saved. Install a system keychain or rerun login and accept
   plaintext storage.`: with no keychain, only a real terminal can accept plain-text storage, and
   `--with-token` stops at the same step. GitHub documents environment tokens for containers and the
   GitHub CLI's sign-in as Copilot's last credential source, and a Copilot that never signed in
   answered a prompt on gh's token alone. So Copilot's key goes into the vault as
   `COPILOT_GITHUB_TOKEN` (decision 4 no longer applies to it; a classic `ghp_` token is refused),
   its Code signs gh in to github.com with gh's device flow, and its readiness counts the variables
   and `gh auth token --hostname github.com` beside its state file. Sign-out forgets the kept token.
   Details in [[setup.md]], "Copilot in a container".

## Design

### Core

- **`SecretVault`** (`packages/core/src/secret-vault.ts`): one sealed JSON document,
  `<dataDir>/secrets.json` (mode 0600), keyed by tool and variable: `{ "gemini": { "GEMINI_API_KEY":
  "enc:v1:…" } }`. It reads the key from `AGENTRY_SECRET_KEY` or, failing that, from
  `<dataDir>/secret.key`, made on first use. The Claude credential store and the YouTrack store move
  onto it, reading their old files once and removing them.
- **Child environments.** Every place that spawns a provider, a host CLI or `youtrack-app` takes the
  vault's variables for that tool on top of the inherited environment. Nothing goes into
  `process.env` any more (today the Claude store writes there).
- **`LoginService`** (`packages/core/src/setup/logins.ts`): runs one documented sign-in at a time per
  tool and host.
  - `key`: runs the CLI's stdin command, or writes the vault for an env tool; then re-reads the
    tool's readiness and answers with it.
  - `device`: spawns the documented command with no TTY, reads its output line by line, and matches
    the verification URL and the code with patterns written from recorded output (fixtures under
    `packages/core/test/fixtures/logins/`). It publishes `login.updated` on `/api/events` (state
    `starting | waiting-for-person | succeeded | failed | expired | cancelled`, the URL and the code,
    never anything else the CLI printed), ends on exit, and decides success by re-running the tool's
    readiness probe, not by reading the output. A session expires after the code's lifetime or 15
    minutes; cancelling kills the process group.
  - Sign-out runs the documented command (`codex logout`, `gh auth logout -h`, `glab auth logout
    --hostname`, `claude auth logout` plus clearing the vault) or clears the vault. Copilot's clears
    the token the vault keeps (decision 7).
- **Setup state** (`GET /setup`): what is done and what is not, for the assistant and for a "finish
  setting up" card: access mode, each enabled agent's readiness, each host, YouTrack, and whether the
  assistant was finished or skipped (`setupSeen`, which replaces `providersStepSeen` and honours its
  variable).

### API

`GET /setup`, `POST /setup/seen`; `POST /setup/logins` (`{ tool, method: 'key' | 'device', host?,
secret? }`), `GET /setup/logins/:id`, `DELETE /setup/logins/:id`; `DELETE /setup/credentials/:tool`
(sign out). Types in `packages/shared/src/types.ts`, OpenAPI summaries and tags, README rows, schema
regeneration. The existing `/auth/credentials` and `/trackers/youtrack/credentials` keep working
and use the vault.

### Web

- **The assistant** replaces the first-run screen while setup is not seen: **Access** (the auth mode
  and a token, the panel of Settings → Security), **Agents** (each provider's row with Sign in), **Code
  and work items** (GitHub, GitLab, YouTrack), **Done** (what is ready, what was skipped, where to find
  it). A step bar, Back, Skip, Continue. On a phone each step is a full screen.
- **Sign in** opens a panel under the row (`.prov-bin`, as YouTrack's access already does) with the
  methods the tool has: a write-only key field with the vendor's link to make one, and, where there
  is one, **Sign in with a code**: the URL as a link, the code large in Geist Mono with a copy
  button, a braille spinner next to "Waiting for you to approve", and Cancel. Success closes the panel
  and the row turns `ok`. The Claude panel explains `claude setup-token` on the person's own machine,
  since no other way exists.
- Settings → Providers and Settings → Integrations show the same panels, so nothing is assistant-only.
- **Design system.** New reference screens (desktop and phone): the assistant at each step, a key
  panel, a device-code panel waiting, succeeded and failed. Generated like the others under
  `docs/design-system/reference/tools/`, documented in `design-system.md`, any new variant in
  `agentry-ds.css`. Tokens only, both themes, every string in `en` and `es`. The code is the one live
  thing on the screen while waiting.

### Docker

- `gh`, `glab` and `youtrack-app` installed, pinned, checked by checksum where the vendor publishes
  one. `GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` under `/data/provider-homes`.
- The secret key made on first start when the environment brings none (decision 3).

## Work, in order

1. **Recordings** (done 2026-10-08, `packages/core/test/fixtures/logins/README.md`: all four run
   with no TTY; Codex and glab store a bad key with exit 0). Run each device-code command in the image with no TTY and keep its output as a
   fixture: `codex login --device-auth`, `copilot login --device-code`, `glab auth login --device
   --hostname gitlab.com`, `gh auth login --web -h github.com`. Stop each once the code is shown; no
   account is signed in. Also record whether Copilot, with no keychain, asks before storing in plain
   text and whether that question can be answered without a terminal. Whatever cannot run without a
   terminal drops its device method and says why. Settled with a real account on 2026-10-08: it asks,
   and only a terminal can answer, so Copilot dropped its own device method (decision 7).
2. **Core and API** (done; built 2026-10-08, closed 2026-10-09, [setup.md](../setup.md)): vault
   and migration, child environments, `LoginService`, sign-out, setup state,
   routes, types, OpenAPI, README, tests (fake CLIs that print the recorded output).
3. **Docker** (done; built 2026-10-08, closed 2026-10-09,
   [deploy.md](../deploy.md#what-the-image-contains)): the three CLIs, their homes, the key.
4. **Design** (done 2026-10-08): the reference screens, generated by
   `docs/design-system/reference/tools/setup.py` (`DesktopConfiguracion*`, `MobileConfiguracion*`,
   `DesktopAjustesSeguridad`, `MobileAjustesSeguridad`, `DSConfiguracion`), and the "Setup" section of
   [design-system.md](../design-system.md), which records how `claude setup-token` is presented.
5. **Web** (done 2026-10-08, [setup.md](../setup.md#the-web)): the shared sign-in panel and sign-out in
   Settings → Providers, Integrations and Account, the Secrets card in Settings → Security, the setup
   assistant in place of the first-run step (which is removed), i18n, unit tests and
   `e2e/specs/setup.spec.mjs` with a device-code sign-in through the fake `codex`.
6. **Docs** (done 2026-10-09): `docs/setup.md` (the feature), updates to providers.md, code-hosts.md,
   trackers.md, deploy.md and tunnel.md, the security notes in
   [security-model.md](../security-model.md), and this plan's Outcome.
7. **Tailscale in the image** (done 2026-10-08, decision 6): the static build and
   `docker/entrypoint.sh`, the `tailscale` tool in `LoginService` (login URL and auth key, recorded in
   `fixtures/logins/tailscale-up.*`), `GET /setup`'s `tailscale` and the tunnel's `managed`, the row
   in the assistant's Access step and the sign-in in Settings → Remote access
   ([setup.md](../setup.md#tailscale), [deploy.md](../deploy.md#the-tunnel-in-docker)).

## What "done" means

- On a fresh container started with the three named volumes and nothing else, a person signs in to
  Claude Code (token), Codex (device code or key), Gemini (key), Copilot (device code or token),
  OpenCode (a key), GitHub and GitLab (token, and device code where it works) and YouTrack, without a
  shell on the machine; each shows `ok` in Settings.
- Replacing the container keeps every sign-in.
- No secret appears in argv (`/proc/<pid>/cmdline`), the logs, `/api/events` or any answer.
- The assistant appears once, can be skipped at each step, and never again once finished or skipped.
- Typecheck, the unit suites and the e2e suite pass; the reference screens match in both themes.

## Outcome

Built on `fix/adjustments`, 2026-10-08 and 2026-10-09, and merged into `main` in #228 (v0.37.0). A fresh Agentry, the Docker image above all,
is set up from the browser: no step asks for a shell on the server.

**What was built.**

- **Core and API.** The sealed secret vault (`secrets.json`, with the key from `AGENTRY_SECRET_KEY`,
  an existing `secret.key`, or one the image makes beside the data) and the move of the Claude and
  YouTrack stores onto it; `childEnv`, so each secret reaches only the processes of the CLI that reads
  it; `LoginService` with a key and a device code per tool, read from recordings of the real commands
  with no TTY; sign-out per tool and host; `GET /setup` and the five setup routes, with types,
  OpenAPI and README rows. Reference: [setup.md](../setup.md).
- **Docker.** gh 2.102.0, glab 1.120.0 (pinned, checked against the vendors' published digests) and
  youtrack-app 1.0.3 in the image, with `GH_CONFIG_DIR` and `GLAB_CONFIG_DIR` under
  `/data/provider-homes`; the key made on first write; Tailscale's static build and a `tailscaled` of
  its own ([deploy.md](../deploy.md#what-the-image-contains),
  [deploy.md](../deploy.md#the-tunnel-in-docker)).
- **Web.** The setup assistant (Access → Agents → Code and work items → Done) in place of the
  first-run Providers step, one sign-in panel for every tool (Code / Key, write-only key field, the
  device code large with a copy button), Sign out in Settings, and the Secrets card in Settings →
  Security; reference screens in both themes, desktop and phone, and `e2e/specs/setup.spec.mjs`.
- **Docs.** [setup.md](../setup.md), [security-model.md](../security-model.md), and the updates to
  [providers.md](../providers.md), [code-hosts.md](../code-hosts.md#signing-in-from-agentry),
  [trackers.md](../trackers.md), [deploy.md](../deploy.md) and [tunnel.md](../tunnel.md).

**Decisions taken on the way.** Two were added by the owner on 2026-10-08, after the first build met
the real image:

- **Decision 6, Tailscale in the image.** Remote access could not be set up in a container at all, so
  the image runs `tailscaled` in userspace networking with its state in `/data/tailscale/`, and the
  app signs it in with a login URL or an auth key (`--auth-key=file:`, so no key in argv). Only the
  daemon Agentry runs is Agentry's to sign in.
- **Decision 7, Copilot through its environment and gh.** Copilot's own `login` cannot store a token
  without a keychain unless a terminal answers it, so its key became `COPILOT_GITHUB_TOKEN` in the
  vault and its Code became gh's github.com device sign-in, the fallback GitHub documents.

**Verified by hand** in a fresh container of the branch's image on 2026-10-08, beyond the unit and
e2e suites:

- GitHub signed in by device code from the app (gh's `--web`, the code approved on another device),
  kept in `/data/provider-homes/gh`.
- Tailscale, run by the image, signed in from the app.
- Copilot, never signed in on its own, working through gh's sign-in: readiness `ready`, and a prompt
  answered.
- The sign-ins surviving a container replacement: the container removed and started again on the
  same named volumes, everything still signed in.

**Closed after the release** (2026-10-09, [setup.md](../setup.md#copilot-in-a-container)):

- **Copilot's account name** when it works only through gh: the row names gh's account on that host,
  the `user:` gh writes in its `hosts.yml`, read with no network call and never the token beside it.
- **GitHub Enterprise for the gh fallback.** `copilot help environment` documents `COPILOT_GH_HOST`
  and `GH_HOST` as the host Copilot authenticates against (GitHub Enterprise Cloud with data
  residency). Copilot's readiness asks gh about that host, and its Code signs gh in to it.

**Left open.**
- **Claude Code's sign-in.** `claude auth login` cannot be driven without a terminal (a local
  callback, or a code pasted at its prompt), so Claude Code takes the token `claude setup-token` makes
  on the person's own machine, or an API key; there is no device code for it.
- The Helm chart has no Secret-backed field for `AGENTRY_SECRET_KEY` (its `env:` takes a plain
  value), and a key beside the data protects a copy of the files, not the volume
  ([security-model.md](../security-model.md#known-limits)).

## Related

[[container-state.md]] · [[providers.md]] · [[code-hosts.md]] · [[trackers.md]] · [[deploy.md]] ·
[[design-system.md]] · [[plans/multi-provider.md]] · [[tunnel.md]] · [[setup.md]] ·
[[security-model.md]]
