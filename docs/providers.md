---
created_at: 2026-09-30T14:00:00Z
updated_at: 2026-09-30T14:49:40Z
tags:
    - providers
    - detection
    - architecture
    - convention
---
# Providers

A **provider** is a coding agent Agentry can drive: Claude Code today, then Codex, agents that speak
the Agent Client Protocol (Gemini CLI, GitHub Copilot CLI and OpenCode among them). This document is the
reference for what a provider is, how Agentry decides whether one is ready, how it finds the binary,
and how to add one. The reasons and the order of work are in
[plans/multi-provider.md](plans/multi-provider.md).

Status: phase 1 (detection only) is being built on `feat/multi-provider`. Until phase 2, no provider
other than Claude Code starts a chat; the others are detected and reported, nothing more. The type
names below are the ones phase 1 defines in `packages/shared/src/types.ts`; if they differ from the
code, the code wins and this document is stale.

## The rule a provider lives under

Agentry reaches each agent **only through the interface its vendor ships for programs**: CLI flags,
the vendor's official SDK, a documented stream or RPC protocol, the files the CLI writes. No terminal
scraping, no undocumented HTTP endpoints, no second login of our own. The rule is stated in
[CLAUDE.md](../CLAUDE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md); the decision engine's bounded
exception for typed decision services is unchanged ([decision-engine.md](decision-engine.md)).

A consequence: an agent that only has an interactive terminal interface is **not a provider**. It
cannot run an orchestration stage with nobody watching.

## What a provider is

One module in `packages/core/src/providers/<id>/`, made of:

- a **manifest**: data, declared once, read by the registry and the detector;
- a **driver**: code, which arrives in phase 2 and implements detection probes, sessions, the model
  catalog and transcripts behind one interface.

The registry is keyed by a string id, not a closed union. Nothing else in core names a provider:
adding one is adding a folder.

The manifest declares:

| Field | What it holds |
|---|---|
| `id`, `label`, `vendor`, `homepage`, icon | Identity, and an icon from the illustration set |
| `commands` | The binary and its aliases, `requires` (other commands that must exist), `unsupportedPlatforms` |
| `configHomes` | Where the provider keeps state and the variable that moves it (for example `CLAUDE_CONFIG_DIR`); its presence also tells the provider was **used before** |
| `versions` | The range the driver is tested against (`>=2.1 <3`) and how to read the version |
| `install` | The vendor's install page; a command that verifies an install |
| `auth` | How to tell whether it is signed in (a subcommand with `--json`, a credentials file, a variable) and where to sign in |
| `transport` | `stream-json`, `json-rpc` or `acp` |
| `capabilities` | A **declared** set: `interactivePermissions`, `structuredOutput`, `resume`, `fork`, `interrupt`, `setModel`, `subagents`, `mcp`, `worktreeFlag`, `budgetLimit`, `effort`, `costReport`, `rateLimitWindows`, `multiAccount`, `transcriptFiles`, `workflowTool` |

Capabilities are declared, then confirmed by the handshake for the installed version, and never
inferred from which methods a driver happens to implement. A provider without a driver declares none.

**Every fact about another vendor's CLI is checked, not guessed.** Each manifest cites, in a comment,
where its command names, config homes, version flag and auth probe come from: the vendor's docs or
its `--help` output. A fact that cannot be confirmed is left out, and the provider's readiness says
`unknown` with the reason `no-probe`.

## Readiness

Readiness is a state, not a boolean: "found on PATH" is not "ready". Detection produces one
`ProviderStatus` per provider and host, with the state, a reason code, the version, the compatible
range, the binary path, the config home, the account, the capabilities and when it was checked.

| State | Meaning | Remedy offered |
|---|---|---|
| `ready` | Installed, compatible version, signed in, handshake passed | — |
| `degraded` | Works, with a warning (version outside the tested range, a limit near) | Update, or keep going |
| `signed-out` | Installed and compatible, no credentials | Sign in |
| `incompatible` | Installed, version too old or too new for the driver | Update or pin |
| `used-before` | Its config home exists but the binary is not found | Install, or point to the binary |
| `not-installed` | No trace of it | Install |
| `unknown` | The check could not run | Retry, with the reason |

Every state but `ready` carries a **typed reason code**, the same taxonomy everywhere. The codes the
design names are `missing-credentials`, `stale-token`, `version-below-range`, `probe-timeout`,
`spawn-denied` and `no-probe`; the full list is `ProviderReasonCode` in shared types. The UI shows the
state and a sentence written for the reason, never a raw error string.

Scope of phase 1:

- **Handshakes spend nothing.** One that would cost tokens or quota is not run; readiness then rests
  on version and auth.
- **Sign in:** Claude Code's action opens the account flow Agentry already has (Settings → Account).
  Every other provider links to its vendor's sign-in page.
- **Install is a link** to the vendor's page. Agentry does not run installers or show commands; the
  watchers below pick the binary up once it lands on PATH.

## How detection finds a binary

`ProviderDetector` in core is shared by the server, the desktop app and the Docker image. For each
enabled manifest it resolves the binary, in this order:

1. **The override** the person set in Settings → Providers.
2. **The person's PATH.** The login shell is run once (`$SHELL -ilc`) with sentinels around the
   output, a timeout, and a fast-path marker in the environment (`AGENTRY_SHELL_PATH_PROBE=1`) that rc
   files can test to skip slow setup. Failure is typed: `no-shell`, `timeout`, `spawn-error` or
   `empty-path`. So a server started from a desktop session or a service finds what the terminal finds.
3. **Install directories**, when the PATH has nothing: nvm (ordered by its `default` alias), volta,
   asdf, mise, bun, pnpm, npm-global, `~/.local/bin`, `~/.claude/local`, `~/.opencode/bin`,
   Homebrew, nix and snap.

Commands are resolved against PATH with `fs`, honouring `X_OK`, and never by spawning `which`:
security software can gate every spawn. Aliases, `requires` and unsupported platforms are part of
the lookup, and "absent" is kept apart from "could not check".

With a binary, the detector reads the version and compares it with the range, runs the auth probe
(a subcommand that answers in JSON or with its exit code, or, for a CLI that prints its login state
only for people, the credentials file its login writes, as OpenCode's `auth.json`),
and runs the handshake when the manifest has one that spends nothing. Each probe has its own
timeout and all providers run in parallel. Without a binary, a config home that exists gives
`used-before`; otherwise `not-installed`.

**Nobody presses Refresh.** One cache with one TTL is invalidated by a refresh, by a settings change
and by debounced watchers on the PATH directories and the config homes. A re-detect emits the
`providers.changed` event only when a status actually changed. The Refresh button stays for what the
watchers miss.

Claude Code's probes reuse `detectCli` and `getAuthStatus` in `packages/core/src/cli.ts`, and
`/health` keeps its shape (`cli`, `loggedIn`), read from the Claude provider's status.

## The API and the settings

`GET /providers`, `GET /providers/:id`, `POST /providers/refresh`, `GET /providers/settings` and
`PUT /providers/settings`; chat tokens get `403` on the writes. Settings live in `providers.json` in
the data directory: enabled, order, default and binary override per provider. The default is the
first `ready` provider in the person's order.

## Where transcripts live

Not every provider writes its transcripts as files. Claude Code writes JSONL under its projects
directory; OpenCode keeps sessions, messages and parts as tables of one SQLite database in its data
directory (`opencode.db`, WAL mode). A provider's `TranscriptStore` reads whatever its CLI writes,
always read-only: it never writes, locks or checkpoints another program's database, and a busy
read is retried, never taken for an empty session. See the plan's note under OpenCode.

## How to add a provider

1. **Check the interface.** The vendor must ship one for programs (rule above). Terminal-only agents
   are not providers.
2. **Search the knowledge base** for a document that already covers the agent, then collect the
   facts from the vendor's docs or `--help`: command and aliases, config home and its variable,
   version flag, auth probe, install and sign-in pages, transport.
3. **Add `packages/core/src/providers/<id>/manifest.ts`**, each fact with its source in a comment.
   Leave out what you cannot confirm. Register it in the registry; nothing else in core names it.
4. **Test it.** The registry test fails when two manifests share an id or a command. Add detector
   tests with a fake binary on a temporary PATH and a fake config home for each state that applies.
5. **Ship a fake for e2e**, a small binary the e2e suite puts on PATH. The suite never depends on
   the real agent.
6. **Update the docs** in the same PR: the table in this document if a field or state changed, and
   [status.md](status.md).
7. The driver, its conformance suite and its capabilities are a separate PR (phase 2 onwards).

## The first-run step

`apps/web/src/components/ProvidersStep.tsx` stands in for the whole app, with no shell, and lists what
the detector found grouped by state (ready, signed out, needs attention, used before, not installed).
It is shown when `providersStepSeen` in the app settings is off (the first start), and on every start
where no provider is usable, so a wrapper that cannot run a chat says why first. Once seen, it never
stands in front of Settings (`/settings`), which is where a provider gets fixed; Home and the status
bar still say nothing is ready. The primary action is
"Continue with" the first ready provider; "Skip for now" is always there and, like Continue, records
the step as seen (`PUT /settings/app`, or `AGENTRY_PROVIDERS_STEP_SEEN=on` from the environment).
Skipping while nothing is ready hides it for that page load only. When every provider is missing the
page is an `Empty` state with the install link for Claude Code and the others as chips. "Check again"
calls `POST /providers/refresh`, and an install or sign-in made in a terminal arrives through
`providers.changed`.

## Related

[[plans/multi-provider.md]] · [[status.md]] · [[decision-engine.md]] · [[desktop.md]] · [[deploy.md]] · [[knowledge-base.md]]
