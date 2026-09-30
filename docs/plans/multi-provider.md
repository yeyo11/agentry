---
created_at: 2026-09-30T12:43:36.708551256Z
updated_at: 2026-09-30T18:00:00Z
tags:
    - plan
    - providers
    - detection
    - onboarding
    - architecture
    - planned
---
# Multiple agent providers

Status: **phase 1 built** on `feat/multi-provider` (2026-09-30); phase 2 planned as a task graph
("Phase 2: orchestrations and task graph"); phases 3 and 4 planned. The owner answered the open questions the same day; see "Decisions"
at the end, and "Outcome of phase 1".

On 2026-09-30 the owner decided that Agentry is no longer a wrapper around Claude Code: it has grown
into an orchestrator of its own, and it should drive other coding agents too. On a clean install it
must find the agents on the machine on its own, say which of them are ready, and why the others are
not.

## Principles

What the design holds to:

1. **One provider object.** Identity, detection, auth, versions, sessions and usage of an agent live
   in one place, under one id, not spread over modules that each keep their own list.
2. **Open ids.** A provider is added by adding a folder; nothing else in core names it.
3. **Capabilities are declared, then confirmed.** Never inferred from which methods a driver happens
   to implement.
4. **Readiness is a state, not a boolean.** "Found on PATH" is not "ready": signed in, compatible
   and answering are part of it, and each gap has a reason and a remedy.
5. **Versions have a range.** Every driver states the versions it is tested against.
6. **A health check proves it.** A handshake, not just a binary on disk.
7. **Nobody presses Refresh.** Installing or signing in in a terminal shows up on its own.
8. **No scraping.** No typing into hidden terminals and parsing the screen, no undocumented
   endpoints (section 8).
9. **Programs, not terminals.** An agent that only has an interactive terminal interface cannot run
   an orchestration stage with nobody watching, so it is not a provider.

Detection techniques the design uses:

- **A PATH that matches the person's terminal:** run the login shell once (`$SHELL -ilc`) with
  delimiters around the output, a timeout, a fast-path marker for rc files and a typed failure reason
  (`no-shell | timeout | spawn-error | empty-path`).
- **No `which` per probe:** resolve commands against PATH with `fs` (honouring `X_OK`), because
  security software can gate every spawn.
- **Install directories as a fallback:** volta, asdf, mise, `~/.local/bin`, pnpm, bun and nvm,
  ordering nvm by its `default` alias.
- **Probe semantics:** aliases, commands that require another one, unsupported platforms, and
  "absent" kept apart from "could not check".

## What Agentry has today

Agentry already speaks the Claude Code CLI's control protocol, which is what the Agent SDK wraps:
`packages/core/src/chats.ts` runs `claude -p --input-format stream-json --output-format stream-json`
and exchanges `control_request` / `control_response` for `can_use_tool`, `interrupt`,
`set_permission_mode` and `set_model`. So the SDK would add types, not capabilities (see Decision 2).

The coupling to Claude is deep but concentrated:

- **Thin adapters, easy to move:** `cli.ts` (detection, `auth status --json`, version),
  `cli-version.ts`, `models.ts`, `connectors.ts`, `plugins.ts`, `config/mcp.ts`, `credentials.ts`,
  `processes.ts`, `toControlDecision` in `permissions.ts`, and `apps/desktop/src/shell-path.ts`.
- **Deeply Claude-specific:** `chats.ts` (`buildArgs`, `handleLine`), the transcript stack
  (`sessions.ts`, `packages/shared/src/normalize.ts`, `usage.ts`, `agents.ts`, `workflows.ts`),
  accounts through claude-swap (5 h / 7 d windows), `~/.claude` editing (`config/*`, `memory.ts`),
  Team (Claude agent files run with `--agent`), and the orchestrator's Workflow-tool engine.
- **Claude vocabulary in neutral code:** the tool rules (`Bash(git log:*)`) in `flow.ts`,
  `assistant.ts`, `supervisor.ts` and `orchestrator.ts`; model aliases (`haiku`, `sonnet`, `opus`)
  as defaults; `PermissionMode`, `MODEL_ALIASES` and raw stream-json names in `RunEvent`.
- **Already provider-shaped:** the decision engine's `DecisionProvider` (`cli`, `jev`), and the
  domain model in `packages/shared/src/types.ts` (`Chat`, `Execution`, `ChatState`, work items).

## Design

### 1. One provider manifest, open ids

Each provider is one module in `packages/core/src/providers/<id>/`, exporting a **manifest**
(data) and a **driver** (code). The registry is keyed by string, not a closed union: a provider is
added by adding a folder, and nothing else in core names it.

The manifest declares:

- `id`, `label`, `vendor`, `homepage`, and an icon from the illustration set;
- `commands`: the binary and its aliases, `requires` (other commands), `unsupportedPlatforms`;
- `configHomes`: where it keeps state, and the variable that moves it (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, …), which also tells whether it was **used before** on this machine;
- `versions`: the range Agentry's driver is tested against (`>=2.1 <3`), and how to read the
  version;
- `install`: the vendor's install page, and the command that verifies an install;
- `auth`: how to tell whether the provider is signed in (a subcommand with `--json`, a credentials
  file, a variable) and how to sign in;
- `transport`: `stream-json` (Claude), `json-rpc` (Codex's `app-server`), `acp` (Agent Client
  Protocol);
- `capabilities`: a **declared** set, not inferred. See 3.

### 2. Readiness is a state, with a reason and a remedy

Detection produces, per provider and per host (local now, SSH and containers later):

| State | Meaning | Remedy offered |
|---|---|---|
| `ready` | Installed, compatible version, signed in, handshake passed | — |
| `degraded` | Works, with a warning (version outside the tested range, limit near) | Update, or keep going |
| `signed-out` | Installed and compatible, no credentials | Sign in, from Agentry |
| `incompatible` | Installed, version too old or too new for the driver | Update or pin |
| `used-before` | Its config home exists but the binary is not found | Install, or point to the binary |
| `not-installed` | No trace of it | Install |
| `unknown` | The check could not run (timeout, permissions) | Retry, with the reason |

Each non-ready state carries a typed reason code, the same taxonomy everywhere: `missing-credentials`, `stale-token`, `version-below-range`, `probe-timeout`,
`spawn-denied`, …. The UI never shows a raw error string as the state.

### 3. Capabilities are declared, then confirmed

The manifest declares what the driver can do. The handshake confirms it for the installed version
(the Codex `initialize` reply, Claude's `system/init`). Every feature in Agentry that needs one
asks the registry, and the UI hides or explains what a provider lacks instead of failing:

`interactivePermissions`, `structuredOutput`, `resume`, `fork`, `interrupt`, `setModel`,
`subagents`, `mcp`, `worktreeFlag`, `budgetLimit`, `effort`, `costReport`, `rateLimitWindows`,
`multiAccount`, `transcriptFiles`, `workflowTool`.

### 4. The driver interface

A driver implements a small required core and optional parts gated by the capabilities above:

- **Detection:** `probeVersion`, `probeAuth`, `handshake`.
- **Sessions:** `start`, `resume`, `send`, `interrupt`, `answerPermission`, `setOption`, `stop`;
  events come out already mapped to the neutral `RunEvent` and `TranscriptEntry`.
- **Catalog:** `models()`, with display names; no alias list in shared types.
- **Transcripts:** a `TranscriptStore` per provider (Claude's JSONL today, Codex rollouts next).
- **Usage and accounts:** optional; Claude keeps claude-swap behind this.

The decision engine's `DecisionProvider` is the template. A message sent whose delivery cannot be
confirmed is reported as unknown and never retried on its own.

### 5. Tool policy in Agentry's words

Flow stages, the assistant, the supervisor and the planner stop writing Claude rules. They state a
`ToolPolicy`: read files, edit files, run commands (with an allowlist of prefixes), network,
`git push` denied. Each driver translates it (Claude to `--allowedTools` / `--disallowedTools`,
Codex to its sandbox and approval settings). A provider that cannot enforce a policy a stage needs
is not offered for that stage.

### 6. Detection that runs by itself

`ProviderDetector` in core, shared by the server, the desktop app and the Docker image:

1. **PATH.** Move `apps/desktop/src/shell-path.ts` into core and extend it: login-shell
   hydration with delimiters, timeout, fast-path marker and typed failure; then `fs` lookup; then
   the install directories (nvm with its `default` alias, volta, asdf, mise, bun, pnpm,
   `~/.local/bin`, npm-global, Homebrew, nix, snap).
2. **Traces.** Config homes present without a binary give `used-before`. On this machine today:
   `~/.codex`, `~/.gemini` and `~/.config/opencode` exist, and only `claude` and `copilot` are on
   PATH.
3. **Version, auth, handshake.** Each with its own timeout, run in parallel across providers.
4. **Refresh without a button.** Watch the PATH directories and the config homes, and re-detect when
   they change, so installing or signing in in a terminal shows up on its own. The Refresh button
   stays for the case the watcher misses.
5. **One cache.** One TTL and one invalidation path for every result, and one server-sent event
   (`providers.changed`) that every page listens to.

### 7. First run

A clean install opens on a **Providers** step, before anything else:

- the providers found, grouped by state, with their version and account;
- one primary action per state: **Sign in** runs the provider's own login from Agentry;
  **Install** opens the provider's install page (decision 3), and detection picks the binary up on
  its own once it lands on PATH;
- the default provider is the first `ready` one, in the order the person can reorder later in
  Settings;
- nothing found: the `Empty` state with the install choices, never a dead end.

The same view lives on in Settings → Providers, and the status bar's "CLI" dot becomes one dot per
enabled provider.

### 8. The rule, rewritten

The one rule (CLAUDE.md, CONTRIBUTING.md) was about Claude Code. What made it good still holds, and
it is where Agentry stays strict. Proposed wording:

> Agentry reaches each agent **only through the interface its vendor ships for programs**: CLI
> flags, the vendor's official SDK, a documented stream or RPC protocol, the files the CLI writes.
> No terminal scraping, no undocumented HTTP endpoints, no second login of our own.

The decision engine's exception for Jev stays as it is.

## Providers, in order

1. **Claude Code**, on its CLI's stream-json control protocol (decision 2), moved behind the driver
   interface with the behaviour Agentry has today. This is the proof the interface is right.
2. **Every other provider, in parallel** (decision 4), each in its own PR once the interface exists:
   - **Codex:** `codex app-server` (JSON-RPC over JSONL, with an `initialize` handshake), and
     `CODEX_HOME` for accounts.
   - **Agent Client Protocol (ACP):** one driver for every agent that speaks it (Gemini CLI among
     them). Which agents do, and how stable their support is, is checked first.
   - **GitHub Copilot CLI:** installed on the owner's machine; `copilot --help` lists `--acp`, so
     it goes through the ACP driver.
   - **OpenCode** (owner, 2026-09-30, the fifth provider): `opencode acp` is an ACP server over
     stdin/stdout, so it goes through the ACP driver too. Sign-in is read from the `auth.json` its
     login writes in its data directory.
     - **Its transcripts are in SQLite, not files** (owner: "important", 2026-09-30). OpenCode keeps
       sessions, messages, parts and todos as tables (`session`, `message`, `part`, `todo`, …) of
       one database in its data directory: `opencode.db`, or `opencode-<channel>.db` on channels
       other than latest, beta and prod, or the path in `OPENCODE_DB`; it runs in WAL mode (source:
       `packages/core/src/database/database.ts` and `packages/core/src/session/sql.ts` in
       github.com/anomalyco/opencode). So its `TranscriptStore` and its usage read that database,
       not JSONL:
       - open it **read-only** and never write, lock or checkpoint it: OpenCode is writing to it;
       - read through the WAL (a read-only connection that still sees the `-wal` file), and treat a
         busy or locked read as "try again", never as an empty session;
       - find the file the same way OpenCode does (the variable, then the channel name), and pin
         the schema version the store understands: a table or column it does not know makes the
         transcript `unknown`, not wrong;
       - watch the database and its `-wal` file to learn that a session changed, as the Claude
         store watches the projects directory.
       This is reading "the files the CLI writes", inside the rule; a write would not be.

Agents that only have a terminal interface are not providers. A later "terminal" tab could host
them, but they cannot run orchestration stages.

## Phases, one PR each

1. **Detection and first run.** Manifests for every provider above (detection needs no driver),
   registry, `ProviderDetector`, readiness states, `GET /api/providers`, the `providers.changed`
   event, the Providers step and settings page. Visible on its own: a clean install lists every
   provider on the machine and says why each one is or is not ready. The same PR rewrites the one
   rule in `CLAUDE.md` and `CONTRIBUTING.md` (decision 1).
2. **Driver interface, with Claude behind it.** `provider` column on chats; `ToolPolicy`; neutral
   `RunEvent`; shared types without Claude aliases; a **conformance suite** every driver must pass,
   with a fake for each.
3. **Codex, ACP and Copilot drivers**, in parallel, each with its fake for e2e.
4. **Rotation between providers**, and claude-swap retired (see "Rotation moves to providers").

Each phase keeps `pnpm typecheck`, `pnpm test` and `pnpm e2e` green, regenerates the OpenAPI schemas
and adds its README rows.

## Phase 1: orchestrations and task graph

Phase 1 is one delivery on one feature branch, **`feat/multi-provider`**, cut from `main` at
`4735d556` and squash-merged once. It is split into three orchestrations, each landing on that
branch. Every code-writing worker runs on `claude-sonnet-5-5` (the exact id, never the `sonnet`
alias). Every task runs `pnpm typecheck` and the tests of the packages it touches; no worker runs
`pnpm e2e`. The full `pnpm test`, `pnpm build` and `pnpm e2e` run once, at the end, on the branch.

Scope limits of phase 1:

- **Detection only.** No provider other than Claude Code starts a chat. Chats, flows and
  orchestrations keep running exactly as today.
- **Sign in:** Claude Code's action opens the account flow Agentry already has (Settings →
  Account). Every other provider links to its vendor's sign-in page; signing in from Agentry comes
  with its driver.
- **Handshakes spend nothing.** A handshake that would cost tokens or quota is not run; the
  provider's readiness then rests on version and auth.
- **Facts about other vendors' CLIs are checked, not guessed.** Each manifest cites where its
  command names, config homes, version flag and auth probe come from (the vendor's docs or `--help`
  output). What cannot be confirmed is left out and its readiness says `unknown` with the reason
  `no-probe`, never a made-up command.

### P0 · `providers-prototypes` (design; gates P2)

- `p1`: the first-run **Providers** step and **Settings → Providers**, dark and light, desktop and
  phone.
  - One row per provider: icon, name, version, account, and the readiness state as a status colour
    **with** a word; the one primary action per state (Sign in, Install page, Update, Retry,
    Choose binary); the reason in plain words under it.
  - The states of section 2 each shown once: a machine with Claude `ready`, Copilot `signed-out`,
    Codex and Gemini `used-before`, and one `not-installed`; plus the nothing-found `Empty` state
    and a `checking…` state.
  - Default provider and order (drag handle on desktop, a `Sheet` on phone), enable/disable, and the
    binary override.
  - Files: `docs/design-system/reference/DesktopProveedores.html`, `MobileProveedores.html`,
    `DesktopPrimerArranque.html`, `MobilePrimerArranque.html`, their screenshots, and the reference
    index. A new variant, if any, goes into `docs/design-system.md` and `agentry-ds.css`.
- `p2`: the status bar with one dot per enabled provider, and the Home setup rows that today say
  "Claude Code CLI not detected", both states. Files: the Home references (`Main.html`, `MobileInicio.html`) and `StatusBar.html`,
  updated.
- Check: the prototype tools pass, and **the owner validates** before P2 starts.

### P1 · `providers-core` (runs beside P0)

- `c1` (shared types), dependsOn none.
  - `ProviderId` (a string), `ProviderTransport`, `ProviderCapability`, `ProviderReadinessState`
    (the seven of section 2), `ProviderReasonCode`, `ProviderStatus` (id, label, state, reason,
    version, compatible range, binary path, config home, account, capabilities, checkedAt),
    `ProvidersSettings` (enabled, order, default, binary override per provider), and the
    `providers.changed` event (`AgentryEventBase`, like `system.release`).
  - Files: `packages/shared/src/types.ts`, `apps/api/src/openapi/schemas*` (regenerated).
  - Checks: shared tests, `pnpm --filter @agentry/api openapi:schemas` with no drift.
- `c2` (the user's PATH), dependsOn none.
  - Move `apps/desktop/src/shell-path.ts` into `packages/core/src/providers/path.ts` and extend it:
    login-shell PATH with sentinels, a timeout and a typed failure
    (`no-shell | timeout | spawn-error | empty-path`), a fast-path marker in the environment
    (`AGENTRY_SHELL_PATH_PROBE=1`) that rc files can test; resolving a command with `fs` (`X_OK`,
    no `which` spawn); the install-directory fallback (nvm ordered by its `default` alias, volta,
    asdf, mise, bun, pnpm, npm-global, `~/.local/bin`, `~/.claude/local`, Homebrew, nix, snap).
    The desktop app imports it from core. The server uses it at start, so a server started from a
    desktop session or a service finds what the person's terminal finds.
  - Files: `packages/core/src/providers/path.ts` and tests, `apps/desktop/src/main.ts`,
    `apps/desktop/src/shell-path.ts` (removed), `docs/desktop.md` ("The CLI is not detected").
  - Check: core and desktop tests.
- `c3` (manifests and registry), dependsOn c1.
  - `packages/core/src/providers/registry.ts`, and one folder per provider with its
    `manifest.ts`: `claude-code`, `codex`, `gemini`, `copilot`, and `opencode` (added by the owner
    after P1). Each declares commands and aliases,
    required commands, unsupported platforms, config homes and the variable that moves them,
    version flag and tested range, auth probe, install and sign-in pages, transport, and
    capabilities (none for providers without a driver yet), each fact with its source in a comment.
  - Check: core tests, including one that fails when two manifests share a command or an id.
- `c4` (detector), dependsOn c1, c2, c3.
  - `packages/core/src/providers/detector.ts`: runs every enabled manifest's probes in parallel,
    each with its own timeout; resolves the binary (override, then PATH, then install
    directories); reads the version and compares it with the range; runs the auth probe;
    recognises `used-before` from config homes; produces a `ProviderStatus` per provider with the
    state and reason code of section 2.
  - One cache with one TTL, invalidated by a refresh, by a settings change, and by watchers on the
    PATH directories and config homes (debounced), which re-detect and emit `providers.changed`
    only when a status actually changed.
  - Claude Code's probes reuse `detectCli` and `getAuthStatus` from `packages/core/src/cli.ts`;
    `/health` keeps its shape (`cli`, `loggedIn`), now read from the Claude provider's status.
  - Files: `detector.ts`, `packages/core/src/index.ts` wiring, tests with fake binaries on a
    temporary PATH and fake config homes.
  - Check: core tests.
- `c5` (settings and API), dependsOn c4.
  - `providers.json` in the data directory for `ProvidersSettings` (a settings-shaped document, like
    `decisions.json`).
  - Routes: `GET /providers` (every status, from the cache), `GET /providers/:id`,
    `POST /providers/refresh` (re-detects now), `GET /providers/settings`,
    `PUT /providers/settings`. Chat tokens get `403` on the writes.
  - Files: `apps/api/src/routes/providers.ts`, `apps/api/src/app.ts`,
    `apps/api/src/openapi/routes.ts` (summary and tag per route), `apps/api/src/security.ts`,
    `README.md` REST tables, API tests.
  - Check: API tests, the summary-and-tag test included.
- `c6` (the rule and the docs), dependsOn none.
  - Rewrite the one rule in `CLAUDE.md` and `CONTRIBUTING.md` as section 8 says, keeping the decision
    engine's exception; fix every other document that quotes the old wording as a rule in force.
  - Write `docs/providers.md`: what a provider is, the readiness states and reason codes, how
    detection finds a binary, and how to add a provider.
  - Check: the docs read on GitHub; no code changes.

### P2 · `providers-web`, dependsOn P0 (validated) and P1

- `u1`: the first-run Providers step: shown when no provider is `ready` or on the first start after
  install, and skippable; uses `GET /providers` and `providers.changed`; `Empty` with an
  illustration when nothing is found.
- `u2`: Settings → Providers, from the validated prototype: the list, actions per state, default
  and order, enable/disable, binary override (`PUT /providers/settings`), and **Refresh**.
- `u3`: the status bar's dot per enabled provider, and Home's setup rows reading provider statuses;
  the `cli-missing` illustration stops naming `claude`.
- Every string through i18n with `en`/`es` parity and the glossary; phone layout, both themes and
  motion levels per the design system. e2e specs for the step and the settings page, using the fake
  CLI for Claude and fake binaries for the others (written by the tasks, run once at the end).
- Files: `apps/web/src/pages/config/ProvidersTab.tsx`, `settingsTabs.ts`, the first-run component,
  `components/shell/StatusBar.tsx`, `pages/dashboard/widgets/live.tsx`, locales, `e2e/`.
- Check: web tests, including the tokens test.

When P2 is merged into the branch: the full checks, the plan's Outcome, `docs/status.md`, then one
pull request to `main`.

## Outcome of phase 1

Built on `feat/multi-provider` on 2026-09-30, in three orchestrations launched on the owner's
desktop app, every code-writing worker on `claude-sonnet-5-5`:

| Orchestration | Tasks | Cost | Result |
|---|---|---|---|
| P0 `providers-prototypes` | p1, p2 | 5.21 USD | Validated by the owner. Its check ran `lint.py` on every screen, and `main` already had 312 findings; the 16 new screens lint clean and pass `check.mjs` |
| P1 `providers-core` | c1–c6 | ~4 USD | Every check passed |
| P2 `providers-web` | u0–u4 | 7.24 USD | Every check passed; its e2e spec had never run |

Added by hand after P1: **OpenCode as the fifth provider** (owner, 2026-09-30), with a `file` auth
probe that reads the `auth.json` its login writes, `~/.opencode/bin` among the install directories,
and a note that its transcripts live in SQLite (under "Providers, in order").

Running the providers e2e spec, which no worker ran, found four real bugs, fixed on the branch:

1. **A refresh during a detection got the old answer.** A settings change or **Refresh** that
   arrived while a detection ran was answered by it, though it had read the settings and the files
   before the change. Requests in the same tick still share one detection; later ones share one
   follow-up that starts after it.
2. **A reading of Claude Code alone threw away a full detection.** Core re-reads Claude Code when
   it reads the system info, with a newer sequence number, and a full detection that ended after it
   was dropped whole. Readings are now compared per provider.
3. **The first-run step hid Settings.** With no provider ready it stood in for every page, including
   the one where a provider gets fixed. Once seen, it leaves `/settings` alone; Home and the status
   bar still say nothing is ready.
4. **The step had no main landmark** (axe).

The spec itself was fixed to count five providers, to name GitHub Copilot as the app does, and to
open the app before setting the theme. One unit test, the shiki one in `highlight.test.ts`, fails
only when the whole suite runs at once: it measures a per-line time budget, and this branch does
not touch it.

## Phase 2: orchestrations and task graph

Phase 2 is one delivery on one feature branch, **`feat/multi-provider-2`**, cut from `main` plus phase
1 at `2313937d` and squash-merged once. It puts Claude Code behind a driver interface **with no
change in behaviour**: every chat, flow run, orchestration, assistant run and supervisor question
starts the same `claude` process with the same flags (as sets), reads the same stream and answers
the same control requests. It is split into four orchestrations, M0 to M3,, each landing on that branch. Every
code-writing worker runs on `claude-sonnet-5-5` (the exact id, never the `sonnet` alias). Every task
runs `pnpm typecheck` and the tests of the packages it touches; no worker runs `pnpm e2e`. The full
`pnpm test`, `pnpm build` and `pnpm e2e` run once, at the end, on the branch.

### What phase 2 builds

- **A driver interface** (section 4), with Claude Code behind it in `packages/core/src/providers/claude-code/`.
  `ChatManager` keeps what is Agentry's (chats, executions, queueing, tokens, persistence, rotation
  requests) and asks the chat's driver for everything that is the CLI's (flags, environment, the
  stream, the control protocol, claude-swap).
- **A `provider` on every chat:** the runtime, the stored record (a column of `chats`), the shared
  `Chat` type and the API. It defaults to the first provider in the person's order that has a
  session driver; in phase 2 that is always `claude-code`.
- **`ToolPolicy`** (section 5) in Agentry's words, translated by the Claude driver into
  `--allowedTools` / `--disallowedTools` (and `--tools` for a confined run). Flow stages, the
  assistant, the orchestrator's own runs and the shipped presets state a policy instead of rules.
- **A neutral `RunEvent`:** the driver maps stream-json onto it; `type`, `subtype` and raw `data`
  leave the shared type, and stream-json names stay inside the Claude driver.
- **Models from the driver's catalog:** `MODEL_ALIASES` leaves `packages/shared`; the list the
  picker offers comes from the chat's provider.
- **Capabilities confirmed by the handshake:** Claude's `system/init` confirms what its manifest
  declares, for the installed version, and features that need a capability ask for it.
- **A conformance suite** every driver must pass, run against the Claude driver with the fake CLI.

### Out of scope

Each of these stays exactly as it is, and is named here so no worker "finishes" it:

- **claude-swap and accounts.** `accounts.ts`, `account-config.ts`, `cswap-install.ts`,
  `cswap-pin.ts`, `rotateAndResume`, `FlowService.awaitsRotation` and the Accounts page keep
  working unchanged. `cswap run <account> --share-history --` wrapping moves into the Claude
  driver's launch plan, byte for byte. Retired only in phase 4.
- **Permission modes.** `PermissionMode` and `PERMISSION_MODES` stay the CLI's list in shared types.
  A neutral mode comes with the second driver (phase 3), when there is a second vocabulary to map.
  Flow stages keep choosing `dontAsk` / `acceptEdits` beside their policy.
- **Transcripts.** `sessions.ts`, `normalize.ts`, `usage.ts`, `agents.ts`, `workflows.ts` and the
  external-session listing in `chat-service.ts` stay Claude's JSONL readers. The per-provider
  `TranscriptStore` is phase 3. `TranscriptEntry` is already neutral; tool names inside it stay the
  provider's own (a neutral tool vocabulary for the health signals is phase 3).
- **Team agent files** (`--agent`, `--agents`, `--system-prompt-snapshot`) and the orchestrator's
  Workflow-tool engine: Claude capabilities (`subagents`, `workflowTool`), passed through untouched.
- **Model defaults written as Claude aliases** (`DEFAULT_SUPERVISOR.model`, the decision engine's
  `cli.model`, `DEFAULT_ASSISTANT_MODEL`, project templates, the web's `AddMember` defaults,
  `decisions/resolve.ts` families, the `orchestration.model` options): they are the Claude
  provider's defaults and become tiers with phase 4's model mapping. Stored settings are never
  rewritten.
- **Person-typed rules** (`ChatStartOptions.allowedTools` / `disallowedTools`, custom presets,
  `Orchestration.allowedTools`): they are native rules of the provider they were written for, pass
  through as today, and are not parsed into a policy.
- **Any screen.** No prototype is needed; see decision 3 below. The only web change is where the
  model picker's fallback list comes from, with no visible difference.
- **Other drivers.** No provider other than Claude Code starts a chat. A request that names one gets
  `400` with "this provider cannot run chats yet".

### The driver interface

`packages/core/src/providers/driver.ts`. A driver is the code half of a provider; the manifest is
the data half (phase 1). The registry (`providers/registry.ts`) gains `driverFor(id)`, which
returns `null` for a provider that has a manifest and no driver yet.

```ts
export interface ProviderDriver {
  readonly manifest: ProviderManifest;

  /** Agentry's policy in the provider's own terms, and what it cannot enforce */
  translatePolicy(policy: ToolPolicy): PolicyTranslation;
  /** What the picker offers for this provider, each with its tier when it has one */
  models(): ProviderModel[];

  /** How one process of a session starts: binary, argv and environment (claude-swap included) */
  launch(spec: SessionLaunch): LaunchPlan;
  /** Speaks the protocol to one process; events come out already neutral */
  attach(io: SessionIO, sink: (event: DriverEvent) => void, branches: BranchTracker): DriverSession;
  /** Per chat, across its processes: background tasks, subagents, workflows */
  createBranches(): BranchTracker;
  /** OS processes holding a session, for "it is still running elsewhere" and restore's leftovers */
  sessionHolders(sessionId: string): number[];
  liveSessions(): Array<{ pid: number; sessionId: string }>;

  /** What a session's first event confirms for the installed version */
  confirm(init: SessionInit): CapabilityConfirmation;

  /** Optional parts, present only when the manifest declares the capability */
  readonly accounts?: AccountSupport; // multiAccount: claude-swap for Claude, phase 2 only
}

export interface DriverSession {
  send(turn: UserTurn): void; // text and attachments
  interrupt(): Promise<void>;
  setOption(option: { permissionMode: PermissionMode } | { model: string }): Promise<void>;
  answerPermission(requestId: string, decision: PermissionDecision): void;
  readLine(line: string): void; // stdout
  readError(line: string): void; // stderr
  endInput(): void; // closes stdin: keepAlive false, idle timeout
  dispose(reason: string): void; // rejects pending control requests
}
```

- `SessionLaunch` is what `LiveChat.opts` holds today, minus Agentry-only fields: session id,
  resume or fork source, name, model, effort, permission mode, native tool rules, the confinement,
  MCP config, worktree, budget, `permissionPrompts`, schema, internal, uploads directory, agent
  and agents file, account. `LaunchPlan` is `{ bin, args, env, unsetEnv }`; `ChatManager` adds
  `AGENTRY_CHAT_ID`, `AGENTRY_API_URL` and the minted `AGENTRY_API_TOKEN` itself, as today.
- `DriverEvent` is internal to core, richer than `RunEvent`, and neutral: `init` (session id,
  model, cwd, mode, `EffectiveEnvironment`), `mode-changed`, `message` (a `TranscriptEntry` and
  its stop reason), `block-started` / `delta` / `structured-delta` / `block-stopped`, `heartbeat`,
  `command-started` / `command-ended` (what `trackCommands` records, without naming `Bash`),
  `task`, `rate-limit`, `rate-limited` (the wording `RATE_LIMIT_RE` matches), `permission-request`,
  `permission-withdrawn`, `result` (outcome, cost, per-model cost and context window), `stderr`,
  `unreadable` (a stdout line that is not the protocol). `ChatManager` folds them into `LiveChat`
  exactly as `handleLine` does today, and pushes `RunEvent`s.
- `DecisionProvider` of the decision engine stays separate: it answers typed questions, it does not
  run sessions. Its `cli` provider starts chats through `ChatManager`, so it gets the driver for free.

The Claude driver's files:

| File | What it holds (from where) |
|---|---|
| `providers/claude-code/driver.ts` | `claudeCodeDriver`, assembling the parts below |
| `providers/claude-code/args.ts` | `buildArgs` and `command` (the cswap wrapping) from `chats.ts` |
| `providers/claude-code/stream.ts` | `handleLine`'s parsing, `toEnvironment`, `reportedMode`, `RATE_LIMIT_RE`, `BUDGET_SUBTYPE`, `IGNORED_SUBTYPES`, `STRUCTURED_OUTPUT_TOOL`, `SUBAGENT_TOOLS` |
| `providers/claude-code/control.ts` | `control`, `write`, `handleControlRequest`, `toControlDecision` (the `can_use_tool`, `interrupt`, `set_permission_mode`, `set_model` requests) |
| `providers/claude-code/branches.ts` | `trackTask`, `startAgentTask`, `updateAgentTask`, `updateWorkflow`, `trackSubagents` |
| `providers/claude-code/policy.ts` | the `ToolPolicy` translation below, with `editRules` and `commandRules` from `flow.ts` |
| `providers/claude-code/models.ts` | `models.ts` (the `.claude.json` cache, `ModelAliasIds`, `modelDisplayName`) and the alias list |
| `providers/claude-code/handshake.ts` | `confirm`: what `system/init` confirms |
| `providers/claude-code/manifest.ts` | unchanged from phase 1 |

`packages/core/src/chats.ts` keeps `ChatManager`, and `packages/core/src/live-chat.ts` takes
`LiveChat` and the chat-facing types. Both keep re-exporting every name `chats.ts` exports today
(`ChatManager`, `ChatRefusal`, `RunResult`, `NewChat`, `ChatConfinement`, `ChatRuntime`,
`STRUCTURED_OUTPUT_TOOL`, …), so no import elsewhere changes. `models.ts` stays as a re-export of
the Claude module for the same reason.

### `ToolPolicy`

In `packages/shared/src/types.ts`, since a preset carries one over the API:

```ts
/** A shell command a policy allows or denies, in Agentry's words */
export type CommandRule =
  | { command: string; args: 'none' }   // exactly this command, no arguments
  | { command: string; args: 'some' }   // this command followed by arguments
  | { command: string; args: 'prefix' } // anything starting with these words
  | { pattern: string };                // a command line with `*` wildcards (a member's `commands`)

export interface ToolPolicy {
  read: { allow: boolean; denyPaths?: string[] };             // path globs never read
  edit: { allow: 'none' | 'any' | string[]; deny?: boolean }; // paths relative to the project
  commands: { allow: 'none' | 'any' | CommandRule[]; deny?: 'all' | CommandRule[] };
  network: 'allow' | 'omit' | 'deny';                        // web fetch and search tools
  delegate?: 'deny';                                          // subagents
  workflow?: 'allow';                                         // the orchestrator's workflow engine
  gitPush: 'deny' | 'omit';
  /** Nothing outside the policy exists for the session: no person's settings, hooks or servers */
  exclusive?: boolean;
}
```

`allow` lists what is granted; `deny` is denial outright, for a session whose mode would otherwise
ask. `translatePolicy` returns `{ rules: { allowedTools, disallowedTools, tools? }, unsupported }`,
and `packages/core/src/tool-policy.ts` has the one neutral entry point,
`rulesFor(provider, policy, native?)`: it looks up the driver, appends the person's native rules,
and throws `PolicyUnsupportedError` when the driver lists a part as unsupported. A driver that
cannot enforce `gitPush: 'deny'` is never offered for a flow stage.

The Claude translation:

| Policy part | Claude rules |
|---|---|
| `read.allow` | allow `Read`, `Glob`, `Grep` |
| `read.denyPaths: [p]` | deny `Read(p)` |
| `edit.allow: 'any'` | allow `Edit`, `Write`, `NotebookEdit` |
| `edit.allow: [p]` | allow `Edit(p)`, `Edit(p/**)`, `Write(…)`, `NotebookEdit(…)` (a glob `p` alone); a path with `,`, `(`, `)`, whitespace, a leading `/` or `..` is dropped, as `editRules` does |
| `edit.deny` | deny `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| `commands.allow: 'any'` / `deny: 'all'` | allow / deny `Bash` |
| `{ command, args: 'none' }` | `Bash(command)` |
| `{ command, args: 'some' }` | `Bash(command *)` |
| `{ command, args: 'prefix' }` | `Bash(command:*)` |
| `{ pattern }` | `Bash(pattern)`, dropped unless `isTeamCommandPattern` accepts it |
| `network: 'allow'` / `'deny'` | allow / deny `WebFetch`, `WebSearch` |
| `delegate: 'deny'` | deny `Task`, `Agent` |
| `workflow: 'allow'` | allow `Workflow` |
| `gitPush: 'deny'` | deny `Bash(git push)`, `Bash(git push *)` |
| `exclusive` | `tools` = the allowed built-in tool names; the driver then passes `--restricted --tools=… --setting-sources=` as `ChatConfinement` does today |

The current rule lists, old rule → policy:

| Where | Today | Policy |
|---|---|---|
| `flow.ts` refine | `dontAsk`; allow `READ_TOOLS` + edits under documents; deny `DENIED_TOOLS` | read; edit `[documentsPath]`; `gitPush: 'deny'` |
| `flow.ts` verify | `dontAsk`; allow read + `GIT_READS` + check commands + document edits; deny push + `GIT_OUTPUT_DENIED` | read; commands allow `git status/diff/log/show` as `none` and `some`, each `CheckCommand` as `none` (`alone`) and `some` (`withArgs`); commands deny `{ pattern: 'git diff *--output*' }` (and `log`, `show`); edit `[documentsPath]`; `gitPush: 'deny'` |
| `flow.ts` work, no `writes`, no `commands` | `acceptEdits`; allow read, `Bash`, `WEB_TOOLS`, `WRITE_TOOLS`; deny push | read; commands `any`; network `allow`; edit `any`; `gitPush: 'deny'` |
| `flow.ts` work, `writes` or `commands` | `dontAsk`; allow read, `Bash(<pattern>)` or `Bash`, web, edits for `writes` + documents or `WRITE_TOOLS`; deny push | read; commands `[{ pattern }]` or `any`; network `allow`; edit `[...writes, documentsPath]` or `any`; `gitPush: 'deny'` |
| `assistant.ts` | `dontAsk`; `--tools` and allow `READ_ONLY_TOOLS`; deny `DENIED_TOOLS` (Bash, edits, Task, Agent, web, `DENIED_READS`) | read with `denyPaths` = today's `DENIED_READS` paths; edit `none`, `deny`; commands deny `all`; network `deny`; delegate `deny`; `gitPush: 'omit'`; `exclusive` |
| `orchestrator.ts` planner | allow `Read`, `Glob`, `Grep` | read |
| `orchestrator.ts` integration | `orch.allowedTools` + `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash(git:*)` | read; edit `any`; commands `[{ command: 'git', args: 'prefix' }]`; native `orch.allowedTools` |
| `orchestrator.ts` verification | `orch.allowedTools` + read, edits, `Bash` | read; edit `any`; commands `any`; native `orch.allowedTools` |
| `orchestrator.ts` workflow | `orch.allowedTools` + `Workflow` | `workflow: 'allow'`; native `orch.allowedTools` |
| `orchestrator.ts` task worker | `orch.allowedTools` | native only (unchanged) |
| `chat-tools.ts` `read-only` | allow read + `Bash(git status:*)`, `diff`, `log`, `show`; deny `Edit`, `Write`, `NotebookEdit` | read; commands those four as `prefix`; edit `none`, `deny` |
| `chat-tools.ts` `no-network` | allow read, edits, `Bash`; deny web, `Bash(curl:*)`, `Bash(wget:*)` | read; edit `any`; commands `any`, deny `curl` and `wget` as `prefix`; network `deny` |
| `chat-tools.ts` `everything` | allow read, edits, `Bash`, web | read; edit `any`; commands `any`; network `allow` |
| supervisor | the stored `read-only` preset | unchanged: it reads the preset, whose shipped version now comes from the policy |
| `verifyAuth` | `allowedTools: []` | unchanged (no tools is not a policy) |

"No change in behaviour" for rules means: the same permission mode and the same **set** of allowed
and disallowed rules per call site; order inside a flag's list carries no meaning to the CLI. Two
deltas, both no looser, are accepted and pinned by the golden test:

1. The orchestrator's integration and verification runs gain `NotebookEdit`: they already `Write`
   any file.
2. The shipped `read-only` preset denies `MultiEdit` too. Stored presets are not rewritten; the
   shipped definition reaches an install only through **Restore shipped presets** or a fresh one.

`ToolPreset` gains an optional `policy`; a shipped preset has one and its `allowedTools` /
`disallowedTools` are derived from it when seeded, so the API, the preset editor and
`tool-presets.json` keep their shape. A custom preset has no policy: its rules are native.
`FlowLaunch` and `AssistantLaunch` keep `allowedTools` and `disallowedTools` (computed through
`rulesFor` for the run's provider) and gain `policy`, so `ChatManager` and the chat's stored `tools`
are untouched.

### Neutral `RunEvent`

```ts
export type RunEventKind = 'message' | 'partial' | 'status' | 'init' | 'result' | 'task' | 'stderr' | 'notice' | 'other';

export interface RunEvent {
  seq: number;
  ts: string;
  kind: RunEventKind;
  entry?: TranscriptEntry;      // message
  status?: RunStatus;           // status
  text?: string;                // partial, result, stderr, notice, other
  block?: 'text' | 'thinking';  // partial
  init?: RunInit;               // init
  outcome?: RunOutcome;         // result
  task?: RunTaskChange;         // task
  data?: Record<string, unknown>; // notice only: Agentry's own words
}
```

- `RunInit`: `sessionId`, `model`, `cwd`, `permissionMode`, `tools`, `mcpServers` (`name`, `status`).
- `RunOutcome`: `isError`, `turns`, `durationMs`, `costUsd`, `structuredOutput`,
  `permissionDenials` (`toolName`, `toolUseId`), `cause` and `stopReason` as `RunResult` has them.
- `RunTaskChange`: `taskId` (absent for a change of the whole list), `change`
  (`started | updated | progress | ended | listed`), `taskKind` (`command | agent | workflow | other`),
  `status`, `description`, `summary`.
- `type`, `subtype` and the raw `data` go. `other` carries only the text of a stdout line the driver
  could not read; a protocol event Agentry does not use is no longer buffered as `other`. Nothing
  reads those today: the web reads `kind`, `entry`, `status`, `text` and `block` only
  (`apps/web/src/lib/chats.ts`), and no test reads `type`, `subtype` or `data`.

### Models from the catalog

- `MODEL_ALIASES` leaves `packages/shared`. It lives in `providers/claude-code/models.ts`.
- `ModelOption` gains `tier?: 'fast' | 'balanced' | 'strong'` (for Claude: `haiku`, `sonnet`,
  `opus`; `fable` has none), which phase 4's model mapping builds on.
- `SystemInfo.models` stays, filled from the default provider's catalog. A new
  `GET /providers/:id/models` serves any provider's catalog (`404` for no driver).
- The web's `MODEL_OPTIONS` fallback (`apps/web/src/components/ui.tsx`) stops listing the aliases:
  it uses the served list, which already starts with them.

### Capabilities, declared then confirmed

`ProviderStatus` gains `confirmed: { at: string; version: string; capabilities: ProviderCapability[] } | null`.
The Claude handshake is the `system/init` of a session Agentry was starting anyway, since a
handshake of its own would spend tokens (phase 1's rule). From it, `confirm` takes the version
(`claude_code_version`, checked against the manifest's range) and confirms `subagents` (`Task` or
`Agent` among `tools`), `workflowTool` (`Workflow`), `mcp` (`mcp_servers` present) and
`structuredOutput` (on a run given a schema); the rest stay declared until a run exercises them.
A declared capability the init contradicts makes the provider `degraded` with the reason
`capability-missing`. Before any session, the declared set applies, as today.

Features ask the registry (`capabilities(provider)`) before they start, and refuse with `400` and
the capability's name: a schema needs `structuredOutput`, an interrupt `interrupt`, a model switch
`setModel`, a pinned account `multiAccount`, a worktree `worktreeFlag`, a budget `budgetLimit`,
host prompts `interactivePermissions`, a fork `fork`. Claude declares all of them, so nothing
refuses in phase 2; the conformance suite tests each gate with a driver double that lacks one.

### The migration

The `chats` table stores each chat as a JSON document. One migration appended to `MIGRATIONS` in
`packages/core/src/db.ts`:

```sql
ALTER TABLE chats ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude-code';
CREATE INDEX chats_provider ON chats (provider, created_at DESC);
```

- Every existing row reads `claude-code`, since every chat so far is a Claude Code session.
- `saveChats` writes the column from `ChatRecord.provider`, and `loadChats` reads it back into the
  record: the column is the truth, the JSON copy follows it.
- `ChatRecord.provider` is optional in the type for records written before the migration; the
  loader always fills it.
- `LEGACY_PROVIDER = 'claude-code'` in `chat-records.ts` and the migration are the only places
  outside `providers/claude-code/` that name the provider.
- Two processes share the data dir: the migration runs under the existing one-transaction-per-step
  guard in `migrate`, and a process on the old schema never writes the column (SQLite fills its
  default).
- A test opens a database at the previous `user_version` with chats in it (the
  `db-opener.ts` fixture), migrates, and finds every chat on `claude-code`.

### How `chats.ts` is split so tasks do not collide

`chats.ts` is 2,128 lines, and three things need to change inside it: the driver, the events and
the provider. So:

1. **One mechanical task goes first (`g1`).** It moves code without changing it, into the files the
   driver will own: `live-chat.ts`, and `args.ts`, `stream.ts`, `control.ts` and `branches.ts` under
   `providers/claude-code/`. Methods become functions that take a narrow `ChatHost` interface (the
   manager's `db`, `modelIds`, `environments`, `permissions`, `emit`, `persist`). It adds no
   interface and renames nothing exported. Reviewed with `git diff --color-moved`.
2. **One task owns the driver seam (`d1`)** and is the only task in its orchestration that edits
   `chats.ts`, `live-chat.ts` or `stream.ts`.
3. **After it, each task owns its files.** The neutral events task (`n2`) is the only later task
   that edits `stream.ts` and `live-chat.ts`. The policy task (`n1`) does not touch `chats.ts` at
   all, because the lists still travel as `allowedTools` / `disallowedTools`.
4. **Shared types are added first (`g2`), additively,** so later tasks only change their own hunk of
   `types.ts` (the `RunEvent` block, the `MODEL_ALIASES` line, `Chat.provider`).
5. **Regenerated schemas are never merged by hand.** On a conflict in
   `apps/api/src/openapi/schemas*`, the integration takes either side and runs
   `pnpm --filter @agentry/api openapi:schemas` again.

### How each task proves there is no drift

- **Argv golden test (`g1`, written first).** `packages/core/test/claude-args.test.ts` pins
  `buildArgs` and `command` over a matrix: new, resume, fork, confined, worktree, budget, schema,
  host prompts, MCP, agent, internal, and a pinned claude-swap account with and without its own
  config dir. It is committed and green on the unsplit code before anything moves, and must stay
  green, unedited, through `d1`.
- **Stream golden test (`g1`, written first).** `packages/core/test/stream-golden.test.ts` replays
  the stream-json fixtures (`fixtures/agent-session`, `fixtures/workflow-session`, and new ones for
  a permission prompt, an interrupt, a rate limit, a budget stop and a structured result) through
  `ChatManager` with the fake's `REPLAY`. It snapshots `summary()` and the event buffer, without
  `seq` and `ts`, into `fixtures/golden/*.json`. `d1` keeps them byte-identical. `n2` changes them
  only by the mapping in "Neutral `RunEvent`", and the reviewer checks the diff is that and nothing
  else.
- **Policy golden test (`t1`, `n1`).** `packages/core/test/fixtures/legacy-tool-rules.ts` is a
  verbatim copy of today's `stageRules`, `checkCommandRules`, `commandRules`, `editRules`, the
  assistant's lists, the orchestrator's additions and `DEFAULT_TOOL_PRESETS`, taken at `2313937d`.
  `packages/core/test/tool-policy-golden.test.ts` compares mode, allowed set and denied set for
  every call site over a matrix of `writes`, `commands`, check commands and documents paths. The
  two deltas above are the only expected differences.
- **Existing tests stay unedited**, except where a type moves: a test that imported
  `MODEL_ALIASES` from shared, or that builds a `RunEvent` with `type`. Each such edit is listed in
  the task's summary. `chats.test.ts`, `restore.test.ts`, `permissions.test.ts`,
  `workflow-engine.test.ts`, `flow-cli.test.ts`, `assistant-cli.test.ts`, `chat-tools.test.ts`,
  `flow.test.ts`, `pull-requests.test.ts` and `account-config.test.ts` are the drift net. Between
  them they drive the fake CLI through every path, and `account-config` and `flow-cli` cover the
  cswap wrapping.
- **The fakes do not change behaviour.** `fake-claude.mjs`, `fake-claude-control.mjs` and
  `e2e/fake-cli/claude` may only gain commands. New behaviours come as `REPLAY` fixture files where
  possible, and `node --test e2e/fake-cli/claude.test.mjs` stays green.
- **The e2e run at the end** is the drift proof for the web, with every spec unchanged.

### M0 · `driver-groundwork`

- `g1` (split `chats.ts`, mechanical), dependsOn none.
  - First commit: the argv and stream golden tests, green on the unsplit code. Then the move.
  - Files: `packages/core/src/chats.ts`, `packages/core/src/live-chat.ts` (new),
    `packages/core/src/providers/claude-code/{args,stream,control,branches}.ts` (new),
    `packages/core/test/claude-args.test.ts`, `packages/core/test/stream-golden.test.ts`,
    `packages/core/test/fixtures/golden/*.json`, new `REPLAY` fixtures under
    `packages/core/test/fixtures/`.
  - Checks: `pnpm typecheck`; `pnpm --filter @agentry/core test`; `pnpm --filter @agentry/api test`;
    `git diff --stat 2313937d -- packages/*/test apps/*/test` shows only new files.
- `g2` (shared types, additive), dependsOn none.
  - Adds `ToolPolicy`, `CommandRule`, `PolicyTranslation`, `ModelTier`, `ModelOption.tier`,
    `RunInit`, `RunOutcome`, `RunTaskChange`, and optional fields: `Chat.provider`,
    `ChatStartOptions.provider`, `ToolPreset.policy` and `ProviderStatus.confirmed`. Also
    `ProviderReasonCode` `capability-missing`. Removes nothing.
  - Files: `packages/shared/src/types.ts`, `apps/api/src/openapi/schemas*` (regenerated),
    `packages/shared/test/*` for any new validator.
  - Checks: `pnpm --filter @agentry/shared test`; `openapi:schemas` with no drift; `pnpm typecheck`.
- `g3` (the `provider` column), dependsOn none.
  - Files: `packages/core/src/db.ts` (the migration, `saveChats`, `loadChats`),
    `packages/core/src/chat-records.ts` (`provider?`, `LEGACY_PROVIDER`), `packages/core/test/db.test.ts`.
  - Checks: `pnpm --filter @agentry/core test`, with the migration test over a database at the
    previous `user_version`.

### M1 · `claude-driver`, dependsOn M0

- `d1` (the driver seam), dependsOn g1, g2, g3.
  - `providers/driver.ts` (the interface above). `providers/claude-code/driver.ts` assembles the
    moved modules. `registry.ts` gains `driverFor` and `defaultSessionProvider(settings)`.
  - `ChatManager` spawns through `driver.launch` and parses through `driver.attach`, folding
    `DriverEvent`s. `LiveChat` and `ChatRuntime` gain `provider`, and `record()` writes it.
    `ChatManager.accounts` stays a property Core sets, now forwarded to the Claude driver's
    `accounts`. `admit` asks the driver's `accounts` instead of claude-swap directly.
  - `processes.ts` is called only from the Claude driver's `sessionHolders` and `liveSessions`.
  - `RunEvent` keeps its current shape in this task; `n2` changes it.
  - Files: `packages/core/src/chats.ts`, `live-chat.ts`, `providers/driver.ts`,
    `providers/registry.ts`, `providers/claude-code/{driver,args,stream,control,branches}.ts`,
    `packages/core/src/index.ts` (wiring only), `packages/core/test/provider-registry.test.ts`.
  - Checks: `pnpm typecheck`; `pnpm --filter @agentry/core test` with the goldens untouched;
    `pnpm --filter @agentry/api test`; `grep -n "stream_event\|control_request\|can_use_tool\|cswap" packages/core/src/chats.ts packages/core/src/live-chat.ts`
    finds nothing.
- `t1` (the Claude policy translation, pure), dependsOn g2.
  - `providers/claude-code/policy.ts`, the table above. `editRules` and `commandRules` are copied
    in here; `n1` removes them from `flow.ts`. The legacy fixture and the golden test compare the
    translation against every row of the "old rule → policy" table.
  - Files: `packages/core/src/providers/claude-code/policy.ts`,
    `packages/core/test/fixtures/legacy-tool-rules.ts`, `packages/core/test/tool-policy-golden.test.ts`.
  - Check: `pnpm --filter @agentry/core test`.

### M2 · `provider-neutral`, dependsOn M1

- `n1` (policy at the call sites), dependsOn d1, t1.
  - `packages/core/src/tool-policy.ts` (`rulesFor`, `PolicyUnsupportedError`), and `claudeCodeDriver.translatePolicy` wired to `t1`'s module.
  - `flow.ts`: `stagePolicy(stage, writes, { documentsPath, checks, commands })` returns
    `{ permissionMode, policy }`. `stageRules` and `checkCommandRules` stay exported with the same
    signatures, re-implemented through the Claude translation (`stageRules`' `testCommands`
    strings pass through as native rules), so their tests stay unedited.
    `FlowLaunch` gains `policy`.
  - `assistant.ts`: `assistantPolicy()`. `READ_ONLY_TOOLS`, `DENIED_TOOLS` and `DENIED_READS` stay
    exported, derived from it, for their tests. `AssistantLaunch` gains `policy`. `index.ts`
    `launchAssistantRun` builds `ChatConfinement` from the translation's `tools`.
  - `orchestrator.ts`: planner, integration, verification and workflow runs state policies merged
    with the native `orch.allowedTools`.
  - `chat-tools.ts`: shipped presets defined by policy, their lists derived when seeded.
    `supervisor.ts`: `DEFAULT_SUPERVISOR_PRESET` follows.
  - Files: `tool-policy.ts`, `flow.ts`, `assistant.ts`, `orchestrator.ts`, `chat-tools.ts`,
    `supervisor.ts`, `providers/claude-code/driver.ts` (one line), `index.ts` (`launchAssistantRun`
    only), tests.
  - Checks: `pnpm --filter @agentry/core test` (the policy golden with its two deltas); the API's
    `tool-presets` tests; `grep -n "'Bash\|'Edit'\|'Read'\|WebFetch" packages/core/src/{flow,assistant,orchestrator,chat-tools}.ts`
    finds only comments.
- `n2` (neutral `RunEvent`), dependsOn d1.
  - Shared `RunEvent` as above. The Claude driver's events carry `init`, `outcome` and `task`.
    `live-chat.ts` stops writing `type`. The goldens are updated by the mapping only.
  - Files: `packages/shared/src/types.ts` (the `RunEvent` block), `providers/claude-code/stream.ts`,
    `live-chat.ts`, `chats.ts` (the `push` calls for notices and restore),
    `apps/api/src/openapi/schemas*` (regenerated), `packages/core/test/fixtures/golden/*.json`, any
    test that built a `RunEvent` with `type`.
  - Checks: `pnpm typecheck`; core, API and web tests; `openapi:schemas` with no drift.
- `n3` (models from the catalog), dependsOn d1.
  - `models.ts` moves to `providers/claude-code/models.ts` (re-exported from `models.ts`), and
    `driver.models()` adds tiers. `MODEL_ALIASES` leaves shared. `Core.system()` reads the default
    provider's catalog. There is a new route, `GET /providers/:id/models`, and the web fallback
    changes in `ui.tsx`.
  - Files: `packages/shared/src/types.ts` (the aliases line, `ModelOption.tier` doc),
    `packages/core/src/models.ts`, `providers/claude-code/models.ts`, `providers/claude-code/driver.ts`,
    `packages/core/src/index.ts` (`system()` only), `apps/api/src/routes/providers.ts`,
    `apps/api/src/openapi/routes.ts`, `README.md` (REST row), `apps/web/src/components/ui.tsx`,
    `models.test.ts`, API tests.
  - Checks: core, API (summary-and-tag included) and web tests; `openapi:schemas`.
- `n4` (the provider through the API), dependsOn d1.
  - `ChatService` resolves `provider` (request, else `defaultSessionProvider`). It answers `400` for
    a provider with no session driver, and runs the capability gates of "Capabilities, declared
    then confirmed". `Chat.provider` becomes required: a chat Agentry runs takes its runtime's,
    and a chat read from Claude's transcripts takes the Claude driver's id.
  - Files: `packages/shared/src/types.ts` (the `Chat.provider` line), `packages/core/src/chat-service.ts`,
    `apps/api/src/routes/chats.ts`, `apps/api/src/openapi/schemas*`, API tests (a chat on
    `codex` is refused, and a listed chat has `provider`).
  - Checks: core and API tests; `openapi:schemas`.
- `n5` (confirming capabilities), dependsOn d1.
  - `providers/claude-code/handshake.ts` (`confirm`). `ChatManager` emits `chat-init` with the
    `SessionInit`, and Core hands it to the detector, which records `confirmed` and emits
    `providers.changed` only when that changes. The registry's `capabilities(provider)` goes
    through the same path.
  - Files: `providers/claude-code/handshake.ts`, `providers/detector.ts`, `providers/registry.ts`
    (`capabilities` only), `packages/core/src/index.ts` (the `chat-init` listener only),
    `provider-detector.test.ts`.
  - Check: core tests.

### M3 · `driver-conformance`, dependsOn M2

- `k1` (the conformance suite), dependsOn n1–n5.
  - `packages/core/test/conformance/suite.ts` exports
    `driverConformance(name, harness)`. The harness gives a driver, an environment with the
    provider's fake on `PATH`, and how to script a turn. Each case is skipped, with its reason, when
    the driver does not declare the capability it needs:
    1. A start gives one `init` with the session id Agentry chose, and confirmed capabilities
       within the declared ones.
    2. A turn gives assistant `message`s and then one `result`, with statuses
       `starting → busy → idle`; with `keepAlive: false` the process exits and the chat is
       `completed`.
    3. `resume` keeps the id, and `fork` makes a new one that records its source.
    4. `interrupt` ends the turn with cause `stopped` and keeps the process. A pending permission
       request is withdrawn.
    5. `setModel` and the permission mode switch a live process.
    6. With `interactivePermissions`, allow and deny both reach the agent, and an unexpected request
       from it is answered, never left pending.
    7. `structuredOutput` returns the object and streams it as it is written.
    8. `budgetLimit` ends with cause `budget`, and a rate limit ends with cause `rate-limit` and
       sets `rateLimited`.
    9. `stderr` lines are `stderr` events, and a non-protocol stdout line is `other`.
    10. Every event validates against the neutral `RunEvent`, with no key outside it.
    11. `translatePolicy` enforces or lists as unsupported every part of a fixed set of policies,
        and a driver that cannot enforce `gitPush: 'deny'` fails.
    12. `models()` is not empty, and every tier the driver claims resolves.
    13. `stop` leaves no process behind.
    14. With a driver double that lacks one capability, each gate refuses.
  - `packages/core/test/conformance-claude-code.test.ts` runs it against the Claude driver with
    `fake-claude-control.mjs` and `fake-claude.mjs`, and new `REPLAY` fixtures only.
  - `docs/providers.md`: "How to add a provider" names the suite, the driver interface and the
    policy table; the phase-2 status line is updated.
  - Files: `packages/core/test/conformance/*`, `packages/core/test/conformance-claude-code.test.ts`,
    `packages/core/test/fixtures/*.jsonl`, `docs/providers.md`.
  - Check: `pnpm --filter @agentry/core test`.

When M3 is merged into the branch: the full `pnpm typecheck`, `pnpm test`, `pnpm build` and
`pnpm e2e` (every spec unchanged), `git diff 2313937d -- e2e/specs` empty, the plan's "Outcome of
phase 2", `docs/status.md`, then one pull request to `main`.

### Risks

| Risk | Where | What holds it |
|---|---|---|
| Behaviour drift in the stream fold (a status, a partial, a stop reason, a task closed at the wrong moment) | `d1`, `n2` | The stream goldens, written before the move; the existing `ChatManager` tests on the fake CLI; one task at a time edits `stream.ts` |
| A flag lost or reordered in a way that matters | `g1`, `d1` | The argv golden over the option matrix, unedited from `g1` on |
| The cswap wrapping changes (`--share-history`, an account with its own config dir, the active account spawning plain `claude`, `authFreeEnv`) | `d1` | Rows of the argv golden for each case; `account-config.test.ts` and `flow-cli.test.ts` unedited |
| A rule set drifts silently | `n1` | The policy golden against a frozen copy of today's builders; two named deltas only |
| The fakes drift from the real CLI, or change under existing tests | `g1`, `k1` | Fakes only gain commands; new behaviour arrives as `REPLAY` fixtures recorded from the real CLI's shape; `claude.test.mjs` green |
| Parallel edits to `types.ts` and regenerated schemas collide | `n2`, `n3`, `n4` | Additive types first (`g2`); one hunk per task; schemas regenerated at integration, never merged by hand |
| A process on the old schema beside one on the new | `g3` | `ALTER TABLE … DEFAULT`, so old writers still produce valid rows; the migration test |
| Leftover-process detection breaks on restart | `d1` | `restore.test.ts` unedited; `liveSessions` is `streamJsonProcesses` behind the driver |

### Decisions for the owner

1. **Shipped tool presets.**
   - (a, recommended) The shipped presets are defined by a `ToolPolicy`, and custom presets stay
     native rules, as planned above. The preset editor is unchanged.
   - (b) Every preset stays as native rules in phase 2, and policies only replace Agentry's own
     lists. The deltas drop to one.
   - (c) Every preset becomes a policy, with an "advanced: native rules" field. This needs a
     prototype of the preset editor.
2. **The `RunEvent` change on the chat stream.**
   - (a, recommended) Drop `type`, `subtype` and raw `data` now, as planned above.
   - (b) Keep `type` and `subtype`, marked deprecated, for one release, then drop them.
   - (c) Keep the raw event under a `native` field for diagnosis, read by nothing in Agentry.
3. **Showing the provider on the chat page.**
   - (a, recommended) Not in phase 2: the API carries it, and the page shows it in phase 3, when a
     second provider can run. No screen changes now.
   - (b) A small mono label ("Claude Code") in the chat's details panel now, with no prototype.
   - (c) A provider facet in the chat list's filters now.

## Decisions (owner, 2026-09-30)

1. **The one rule is generalised** as in section 8. Rejected: relaxing it to allow internal
   endpoints and terminal scraping; and dropping it.
2. **The Claude driver stays on the CLI, without the Agent SDK** (owner, 2026-09-30, reversing the
   first answer the same day). The first answer chose the SDK. Checking its terms before building,
   as this decision required, found that the SDK's documentation says: *"Unless previously approved,
   Anthropic does not allow third party developers to offer claude.ai login or rate limits for their
   products, including agents built on the Claude Agent SDK. Use the API key authentication methods
   described in the Quickstart instead"*, and that its branding guidelines do not permit calling an
   integrating product "Claude Code". On the SDK, a person with a Pro or Max subscription could not
   use Claude in Agentry without an approval, and the UI would lose the name. The same page points
   to running the CLI as a subprocess with `-p` as the way to drive the agent from another program,
   which is what Agentry does, and the control protocol it already speaks (`control_request` for
   `can_use_tool`, `interrupt`, `set_permission_mode`, `set_model`) gives what the SDK would. So the
   Claude driver is `chats.ts`'s protocol, moved behind the driver interface. Rejected: the SDK with
   API keys only; the SDK while asking Anthropic for an approval. The generalised rule keeps "the
   vendor's official SDK" for other vendors, whose terms are read before one is used.
3. **Install is a link to the vendor's page.** Rejected: running the install from
   Agentry, and showing the command. Detection's watchers make up for it: the person does not press
   Refresh after installing.
4. **All providers after Claude, in parallel:** Codex, ACP and Copilot. Rejected: one at a time.
5. **Still open:** which CLIs the Docker image ships (Claude Code only today).

## Rotation moves to providers (owner, 2026-09-30)

Agentry used to rotate between several Claude Code accounts through claude-swap (`cswap auto`,
`rotateAndResume` in `packages/core/src/index.ts`, `FlowService.awaitsRotation`) so work went on
when one account ran out. That ends. Rotation now happens **between providers**: each vendor sees
one account used normally, which keeps Agentry within every vendor's terms, and the person's work
goes on in another agent instead of stopping.

6. **One account per provider.** Agentry uses the account the person signed in with in each
   provider's CLI. claude-swap, managed accounts and automatic account switching are retired:
   `accounts.ts`, `account-config.ts`, `cswap-install.ts`, `cswap-pin.ts`, the claude-swap parts of
   `chats.ts` and the Accounts page. Rejected: several accounts without rotation; keeping
   claude-swap as an advanced option.
7. **What happens at a limit is the person's choice**, because models differ between providers and
   a model may have no counterpart in another one. Settings, global with a per-project override:
   - **on limit**: continue on the next ready provider, with a handoff (what was asked, what was
     done, what is left, from the transcript) in the same worktree; restart the task on the next
     provider from its original prompt, in the same worktree; or wait for the provider's reset;
   - **model mapping**: which model of each provider stands in for a model of another (for example,
     a Claude model to a Codex model). A run whose model has no mapping for the next provider waits
     for the reset instead of switching, and says why;
   - a chat or task that moves keeps a link to every execution it ran on, on each provider.
8. **Order: global and per project.** The global order of Settings → Providers (phase 1), which a
   project can override. Rejected: an order per role or stage; a single global order.

9. **The decision engine decides within the person's settings** (owner, 2026-09-30). Rotation is
   made of the small typed judgments the [decision engine](../decision-engine.md) exists for, so
   phase 4 adds these points to its catalogue (`packages/core/src/decisions/points.ts`), each
   shipping `off`, with consent and a state preview like every other point:
   - `provider.on-limit` (act, project): continue with a handoff, restart, or wait, for the run that
     hit a limit. State: the task's kind and stage, how far it got (checklist, files changed), the
     model and whether it has a mapping, and the other providers' readiness and headroom. Outcome
     for shadow accuracy: whether the moved work passed its checks, and what it cost.
   - `provider.pick` (act, project): which ready provider runs a new task or stage, among the ones
     the project's order allows. It sits beside `orchestration.model`, which already suggests a model per task.
   - `provider.model-map` (suggest, global): proposes a counterpart when a model has none on the
     next provider; a person accepts it into the mapping.

   The person's settings bound every answer: a point only chooses among the options the person
   allowed, never a provider outside the order, and never a model without a mapping. With the point
   `off`, or unavailable, the setting decides, as today. The `cli` decision provider stops meaning
   "Claude Code": it runs on the first ready provider that declares `structuredOutput`.

This lands after the drivers: rotation needs at least two providers that can run work. It is its
own phase, after phase 3, and it retires claude-swap in the same pull request, so there is never a
release with neither kind of rotation.

## Related

[[decisions/decision-engine.md]] · [[providers.md]] · [[plans/managed-claude-swap.md]] · [[desktop.md]] · [[deploy.md]] · [[plans/agentry-assistant.md]]