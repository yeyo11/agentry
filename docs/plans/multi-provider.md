---
created_at: 2026-09-30T12:43:36.708551256Z
updated_at: 2026-10-02T17:00:00Z
tags:
    - plan
    - providers
    - detection
    - onboarding
    - architecture
    - codex
    - acp
    - opencode
    - rotation
    - planned
---
# Multiple agent providers

Status: **phases 1, 2 and 3 landed** (#150, #155, #167): detection and the first-run step, Claude
Code behind the driver interface, then the Codex and ACP drivers, OpenCode's SQLite transcripts and
the provider on the chat page. **Phase 4 is planned** as a task graph ("Phase 4: rotation between
providers", 2026-10-01): limits per provider, moving work between providers at a limit, three
decision points, and claude-swap retired. Four of its decisions are open for the owner. The owner
answered phase 1's open questions on 2026-09-30; see "Decisions" at the end, and "Outcome of
phase 1".

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
3. **Codex and ACP drivers** (Copilot, Gemini and OpenCode on one ACP driver), OpenCode's SQLite
   transcripts and the provider on the chat page, each driver with its fake for core and e2e. See
   "Phase 3: orchestrations and task graph".
4. **Rotation between providers**, and claude-swap retired (see "Rotation moves to providers" and
   "Phase 4: rotation between providers").

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

### Decisions taken for phase 2 (owner, 2026-09-30)

All three as recommended:

1. **Shipped tool presets are defined by a `ToolPolicy`**; custom presets stay the native rules
   people typed, and the preset editor is unchanged. Rejected: every preset stays native rules in
   phase 2; every preset becomes a policy with an advanced rules field.
2. **`RunEvent` drops `type`, `subtype` and raw `data` now.** Rejected: keeping them deprecated for
   one release; keeping the raw event under a `native` field.
3. **The chat page shows the provider in phase 3**, when a second provider can run chats; the API
   carries it from phase 2. Rejected: a label in the details panel now; a provider filter now.

## Phase 3: orchestrations and task graph

Phase 3 is one delivery on one feature branch, **`feat/multi-provider-3`**, cut from `main` after
phase 2 (#155) and the web split (#156), and squash-merged once. It adds the second and third
drivers: **Codex** on `codex app-server`, and **one ACP driver** for GitHub Copilot CLI, Gemini CLI
and OpenCode. It also adds OpenCode's SQLite transcripts, and shows the chat's provider on the chat
page. It is split into four orchestrations (P0, G, D, W). Every code-writing worker runs on
`claude-sonnet-5-5` (the exact id, never the `sonnet` alias). Every task runs `pnpm typecheck` and
the tests of the packages it touches. No worker runs `pnpm e2e`: the full `pnpm test`, `pnpm build`
and `pnpm e2e` run once, at the end, on the branch.

### What phase 3 builds

- **A Codex driver** in `packages/core/src/providers/codex/`: one `codex app-server` process per chat
  execution, speaking JSON-RPC over JSONL. It covers turns, approvals, interrupt, resume, fork, model
  and effort switches, structured output, token usage and rate-limit windows. Codex's account is the
  one signed in for the `CODEX_HOME` in effect.
- **One ACP driver** in `packages/core/src/providers/acp/`, used by three manifests (`copilot`,
  `gemini`, `opencode`). Each manifest names its command, arguments, environment and capabilities;
  the protocol code is shared. What differs per agent is data, not code paths.
- **Agentry's policy enforced on agents that do not take Claude's rules.** `PolicyTranslation` gains
  provider settings and host enforcement. A **policy judge** in core answers an agent's permission
  requests from the run's `ToolPolicy` before anything reaches a person. `git push` stays denied on
  every provider that runs a flow stage.
- **Native session ids.** Codex and the ACP agents choose their own session ids, unlike Claude, where
  Agentry imposes one. A chat keeps its Agentry id and records its provider's id beside it.
- **A `TranscriptStore` per provider**, with ChatService routing by the chat's provider: Claude's
  JSONL (today's `SessionStore`, behind the interface), Codex through `app-server` (decision P3-3),
  OpenCode's SQLite database read-only, and the stream Agentry recorded for Copilot and Gemini
  (decision P3-2).
- **Fakes that speak each protocol,** built from the recordings below, for the core conformance suite
  and for e2e. The suite is generalised so it no longer assumes Claude's session id or rule lists.
- **The chat page shows the provider** (phase 2 decision 3). New chat lets a person choose the
  provider, and its controls follow that provider's capabilities. Every UI string that names Claude
  where it means "the chat's agent" names the chat's provider instead.

### Out of scope

These are named so that no worker "finishes" them:

- **Rotation between providers and retiring claude-swap** stay in phase 4. A rate-limited Codex
  chat ends with cause `rate-limit` and `rateLimited`, as a Claude chat does. Nothing moves the work
  to another provider yet.
- **Team agent files and the Workflow-tool engine** stay Claude capabilities (`subagents`,
  `workflowTool`). An orchestration whose engine is `workflow` runs on Claude only, and a graph task
  may run on any provider that can enforce the task's policy.
- **Budgets.** No new driver declares `budgetLimit`. Codex reports `sessionBudgetExceeded`, but no way
  to set a budget was recorded. A budget on a non-Claude chat is refused with the capability's name,
  as phase 2's gates already do.
- **Structured output on ACP.** ACP has no schema-constrained answer, so Copilot, Gemini and OpenCode
  do not declare `structuredOutput`. Flow verify stages, the decision engine's `cli` provider and the
  planner need a schema. On these three providers such runs are refused, and the provider is not
  offered for them.
- **Signing in from Agentry.** Sign-in stays a link to the vendor's page (decision 3). ACP's
  `authenticate` method and Codex's `account/login/start` are not called.
- **Reading another vendor's credentials.** Agentry never reads `auth.json` contents beyond "a JSON
  object with at least one key" (phase 1's probe). It never reads OpenCode's `account`,
  `control_account` or `credential` tables, and never touches a keyring.
- **The Docker image** keeps shipping Claude Code only (decision 5 is still open).

### Recorded facts, per CLI

**Rule of this phase:** every fact below was observed by running the CLI on 2026-10-01, or read from
the CLI's own generated schema or help. Where a fact comes from documentation or from strings in a
binary, the row says so. What needs an account is listed under "To record with an account", with
the safe default the drivers use meanwhile.

**How the facts were recorded.** The CLIs were installed user-local with
`npm install --prefix ~/.local/share/agent-clis/<name>`; npm checked each tarball's sha512
integrity against the registry. Each was run through a sandbox: `env -i`, an empty `HOME` under the
recordings folder, `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME` and `XDG_*` inside it, and
`timeout` on every call. A small recorder spoke JSON-RPC over JSONL and logged every line both ways
with timestamps. The raw captures live outside the repository, in
`~/.local/share/provider-recordings/` (see its `INDEX.md`). Task `g6` commits scrubbed copies as test
fixtures.

| CLI | Package (npm) | Version recorded | Protocol entry | Signed in? |
|---|---|---|---|---|
| Codex | `@openai/codex` 0.159.3 (`@openai/codex-linux-x64` native binary) | `codex-cli 0.159.3` | `codex app-server` (stdio by default, `[experimental]` in help) | No |
| GitHub Copilot CLI | owner's install, `~/.local/bin/copilot` | 1.0.65, then 1.0.90 after it **updated itself** (see the incident below) | `copilot --acp` | **Yes, unintentionally** |
| Gemini CLI | `@google/gemini-cli` 0.62.0 | `0.62.0` | `gemini --acp` (`--experimental-acp` is listed as deprecated) | No |
| OpenCode | `opencode-ai` 1.18.34 (maintainer `thdxr`; platform binaries as optional packages) | `1.18.34` | `opencode acp` | No |

#### Codex 0.159.3 (`codex app-server`)

| Fact | Recorded |
|---|---|
| Protocol source | `codex app-server generate-json-schema --out <dir>` and `generate-ts --out <dir>` write the whole protocol: 104 client request methods, 10 server requests, 83 server notifications, 1 client notification (`initialized`). **The driver's types are generated from this output and pinned per recorded version**, not written by hand |
| Process | `codex app-server` speaks over stdio. With a `CODEX_HOME` that does not exist it warns ("could not create PATH aliases") and goes on; under `/tmp` it refuses to create its helper binaries and goes on. It exits 0 shortly after stdin closes, even with a turn active |
| Wire | Requests carry `"jsonrpc":"2.0"`. Responses and notifications from the server **omit `jsonrpc`**, and notifications add `emittedAtMs`. Errors: unknown method `-32600` "Invalid request: unknown variant …" (with the full method list), signed-out rate limits `-32600` "codex account authentication required to read rate limits". The reader must not require `jsonrpc` on what it reads |
| `initialize` | Params: `{ clientInfo: { name, title, version }, capabilities: { experimentalApi, requestAttestation, optOutNotificationMethods? } }`. Reply: `{ userAgent: "agentry_recorder/0.159.3 (Ubuntu 24.4.0; x86_64) dumb (…)", codexHome, platformFamily: "unix", platformOs: "linux" }`. Then `remoteControl/status/changed` (`disabled`). **The version is in `userAgent`.** `clientInfo.name` becomes the thread's `originator` |
| Signed out | `account/read` → `{ account: null, requiresOpenaiAuth: true }`. `codex login status` exits 1 with "Not logged in" on stderr. `model/list` **works signed out**. `thread/start` works signed out and pre-connects a websocket that fails 401 on stderr, without spending anything |
| Models | `model/list` → 8 models, each `{ id, displayName, description, hidden, isDefault, defaultReasoningEffort, supportedReasoningEfforts[], inputModalities, serviceTiers, … }`. On 2026-10-01: `gpt-6.1-sol` (default), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`; efforts `low/medium/high/xhigh/max/ultra` (a subset on some) |
| `thread/start` | `{ cwd, approvalPolicy, sandbox, model?, config?, developerInstructions?, ephemeral? }`. **There is no client-chosen id**: the server answers `thread.id` (UUIDv7, `sessionId` equal to it), `thread.path` (the rollout file), `model`, `approvalPolicy`, `sandbox` (as a policy object), `reasoningEffort`, then sends `thread/started`. The rollout file `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` is created at the first turn, not at `thread/start` |
| Approval and sandbox values | `AskForApproval` = `untrusted` \| `on-request` \| `never` \| `{ granular: {…} }`. `--help` lists only `on-request` and `never`, and the vendor's docs call `untrusted` **retired** ("causes startup failures"), so the driver never sends it. `SandboxMode` = `read-only` \| `workspace-write` \| `danger-full-access`. `permissionProfile/list` → `:read-only`, `:workspace`, `:danger-full-access` |
| Turn lifecycle | `turn/start { threadId, input: [{ type: "text", text, text_elements: [] }], model?, effort?, outputSchema?, approvalPolicy?, sandboxPolicy?, cwd? }` → `{ turn: { id, status: "inProgress" } }`, then `thread/status/changed` (`active`), `turn/started`, `item/started` / `item/completed` per item, and finally `turn/completed { turn: { status: "completed" \| "interrupted" \| "failed", error, durationMs } }` and `thread/status/changed` (`idle`) |
| Interrupt | `turn/interrupt { threadId, turnId }` → `{}`, then at once `turn/completed` with `status: "interrupted"`, `error: null`. The rollout gets a `turn_aborted` event |
| Errors during a turn | `error { error: { message, codexErrorInfo, additionalDetails }, willRetry, threadId, turnId }`. Signed out: 5 websocket retries (`responseStreamDisconnected { httpStatusCode: 401 }`), a `warning` falling back to HTTPS, 5 more, then a turn `failed` with the error. `CodexErrorInfo` includes `usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`, `contextWindowExceeded`, `unauthorized`, `serverOverloaded` |
| Model switch | A `turn/start` with another `model` first ran a `contextCompaction` item (a remote compaction) before the user message. Switching models costs a compaction |
| Approvals (schema) | Server requests `item/commandExecution/requestApproval` (`command`, `cwd`, `reason`, `proposedExecpolicyAmendment`, `proposedNetworkPolicyAmendments`), answered with `{ decision: "accept" \| "acceptForSession" \| "decline" \| "cancel" \| … }`; `item/fileChange/requestApproval` (`reason`, `grantRoot`), answered with `accept` / `acceptForSession` / `decline` / `cancel`; `item/permissions/requestApproval`; `item/tool/requestUserInput`; `mcpServer/elicitation/request` |
| Items and deltas (schema) | `ThreadItem` types `userMessage`, `agentMessage`, `reasoning`, `plan`, `commandExecution` (`command`, `exitCode`, `aggregatedOutput`, `durationMs`), `fileChange` (`changes`), `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `contextCompaction`, …; deltas `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `turn/diff/updated`, `turn/plan/updated` |
| Usage (schema) | `thread/tokenUsage/updated { tokenUsage: { total, last: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens }, modelContextWindow } }`. No cost field |
| Limits (schema) | `account/rateLimits/read` → `rateLimits: { primary, secondary: { usedPercent, windowDurationMins, resetsAt } }` plus `rateLimitsByLimitId`; the `account/rateLimits/updated` notification |
| History (schema and recorded) | `thread/list` (paginated, filters by `cwd`, `modelProviders`, `sourceKinds`), `thread/read`, `thread/turns/list`, `thread/items/list`. `thread/read { includeTurns: true }` answers with a `deprecationNotice` that full hydration is deprecated for paginated threads |
| Side effects | `CODEX_HOME` gets `config.toml` (the cwd marked `trust_level = "trusted"`), `state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, `queue_1.sqlite` (all WAL), `skills/.system/`, `installation_id`, and a plugin repository clone under `.tmp/` (network at start) |

#### GitHub Copilot CLI (`copilot --acp`)

| Fact | Recorded |
|---|---|
| `initialize` (1.0.65) | `{ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http, sse }, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { list: {} } }, agentInfo: { name: "Copilot", version: "1.0.65" }, authMethods: [{ id: "copilot-login", _meta: { "terminal-auth": { command: "<binary>", args: ["login"] } } }] }` |
| `initialize` (1.0.90) | The same, with `sessionCapabilities: { close: {}, list: {} }` and `version: "1.0.90"`. **The capability set changed between two patch releases**, so the handshake, not the manifest, confirms it |
| `authMethods` | **Offered even while signed in**: they say how to sign in, not whether one is, so they are not an auth probe |
| `session/new` | `{ cwd, mcpServers: [] }` → `{ sessionId: <UUID>, modes: { availableModes, currentModeId }, configOptions: [mode (agent / plan / autopilot, ids are `https://agentclientprotocol.com/protocol/session-modes#…` URLs), allow_all (on / off)] }`. **No model option**. Then `available_commands_update` (slash commands, including `model`) |
| Modes and options | `session/set_mode` → `current_mode_update` and `config_option_update`, then `{}`. `session/set_config_option { configId: "allow_all", value: "off" }` → the full `configOptions` |
| A turn (account) | `session/prompt` → `session_info_update` (title), `usage_update { used, size: 128000 }`, `agent_thought_chunk` ×83, `tool_call { kind: "other" \| "edit", status: "pending", rawInput, locations?, content? }`, `tool_call_update { status: "completed", content: [content \| diff { path, oldText, newText }], rawOutput }`, `plan { entries }`, `agent_message_chunk` ×13; reply `{ stopReason: "end_turn", usage: { inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens, cachedWriteTokens } }`. No `session/request_permission` came: plan-mode writes went to its own session folder |
| Other | `session/list` → `{ sessions: [] }`. An unknown method → `-32601` with `data.method`. stdin EOF: "Received EOF on stdin, shutting down", exit 0 |
| Files | `COPILOT_HOME/session-state/<id>/events.jsonl` (`session.start`, `user.message`, `assistant.message`, `tool.execution_start`/`_complete`, `assistant.turn_end`, `session.usage_checkpoint`, `session.shutdown`, …), `workspace.yaml`, `plan.md`, `session.db`; `COPILOT_HOME/session-store.db` (WAL); `logs/` |
| Flags (help) | `--allow-tool` / `--deny-tool` with `shell(cmd)`, `shell(cmd:*)`, `write`, `<mcp-server>(tool)`, `url(domain)`; "Denial rules always take precedence over allow rules, even `--allow-all-tools`"; `--available-tools` / `--excluded-tools` filter what the model sees; `--model <id>` (or `auto`); `--add-dir`; `--disallow-temp-dir`; `--no-custom-instructions`; `--no-auto-update` |
| Environment (help) | `COPILOT_AUTO_UPDATE=false` disables downloading new versions (default on, off when `CI` is set); `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` override stored credentials; `COPILOT_HOME` moves state; `COPILOT_MODEL`; `COPILOT_OFFLINE` |

**Incident during the recording (2026-10-01).** The sandbox did not isolate Copilot. With `env -i`
and an empty `COPILOT_HOME`, it still found the owner's GitHub credentials outside `HOME` (its log
names the account and fetches managed settings for it). The `session/prompt "Say hi"` meant to record
a signed-out failure therefore **ran one real turn on the owner's Copilot account** (31,395 tokens,
plan mode). It wrote only inside the sandbox `COPILOT_HOME`. Its first `--acp` start also
**auto-updated the owner's `~/.local/bin/copilot` in place, from 1.0.65 to 1.0.90**. What this means
for the design:

- every Copilot process Agentry starts gets `COPILOT_AUTO_UPDATE=false` and `--no-auto-update`, so a
  run never replaces the person's binary or leaves the tested version on its own;
- an empty `COPILOT_HOME` does not mean signed out, so readiness keeps `no-probe` until a session
  answers;
- recording "signed out" behaviour for Copilot needs a machine with no GitHub credential at all, and
  is moved to "To record with an account".

#### Gemini CLI 0.62.0 (`gemini --acp`)

| Fact | Recorded |
|---|---|
| `initialize` | `{ protocolVersion: 1, authMethods: [oauth-personal "Log in with Google", gemini-api-key (`_meta.api-key.provider: "google"`), vertex-ai, gateway], agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: "0.62.0" }, agentCapabilities: { loadSession: true, promptCapabilities: { image, audio, embeddedContext: true }, mcpCapabilities: { http, sse } } }`. No `sessionCapabilities` |
| Signed out | `session/new` → error `-32000` "Gemini API key is missing or not configured." (`-32000` is ACP's "authentication required") |
| Not supported | `session/list` → `-32601` |
| stderr | "Skipping project agents due to untrusted folder", "Project hooks disabled because the folder is not trusted", "Ripgrep is not available. Falling back to GrepTool", and every failed request echoed |
| Agent methods (bundle source of 0.62.0, not observed on the wire) | `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `unstable_setSessionModel`; `session/new` answers `models { availableModels, currentModelId }` and modes `default`, `auto_edit`, `yolo`, `plan`; permission options `allow_once`, `allow_always`, `reject_once`, `reject_always` |
| Flags (help) | `--approval-mode default\|auto_edit\|yolo\|plan`, `--policy <files>` (policy engine), `--admin-policy`, `--allowed-mcp-server-names`, `--include-directories`, `--skip-trust`, `-m/--model`, `--session-id` (non-ACP), `-w/--worktree`. `--allowed-tools` is deprecated in favour of the policy engine |
| Policy engine (docs: geminicli.com/docs/reference/policy-engine) | TOML rules `{ toolName, commandPrefix \| commandRegex, argsPattern, decision: allow \| deny \| ask_user, priority, modes, interactive }`, tiers Default < Extension < Workspace < User < Admin; `ask_user` in non-interactive mode is `deny` |
| Dependency | Ships `@github/keytar`: Google sign-in credentials can live in the OS keyring, so Agentry does not read them |

#### OpenCode 1.18.34 (`opencode acp`)

| Fact | Recorded |
|---|---|
| `initialize` | `{ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http, sse }, promptCapabilities: { embeddedContext: true, image: true }, sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} } }, authMethods: [{ id: "opencode-login", description: "Run \`opencode auth login\` in the terminal" }], agentInfo: { name: "OpenCode", version: "1.18.34" } }` |
| `session/new` signed out | **Succeeds**: `{ sessionId: "ses_…" (not a UUID), configOptions: [model (category `model`, 8 options, all "OpenCode Zen/… Free" or `opencode/big-pickle`, current `opencode/big-pickle`), mode (build, plan)] }`. **OpenCode runs free hosted models with no sign-in**, so no prompt was sent (see decision P3-4) |
| Commands it loads | `available_commands_update` listed **Claude Code skills found in an ancestor directory** of the session's cwd (the owner's `~/.claude/skills`), not under the sandbox `HOME`. The binary has `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` and `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` (strings in the binary, not documented on the pages read) |
| `session/list` | `{ sessions: [{ sessionId, cwd, title: "New session - <iso>", updatedAt }] }` |
| Locating the database | `opencode db path` → `$XDG_DATA_HOME/opencode/opencode.db`. `OPENCODE_DB=/x/y.db opencode db path` fails with "unable to open database file", so the variable is honoured and **`db path` opens (and creates and migrates) the database**: it is not a side-effect-free probe. `opencode debug paths` prints `data`, `config`, `cache`, `state`, `log`, `bin`, `repos` and `tmp` (`/tmp/opencode`) |
| Created without sign-in | Any command creates `opencode.db` (WAL, with `-wal` and `-shm`), `log/opencode.log`, `repos/`, `state/opencode/locks/` |
| Schema pin | `PRAGMA user_version` is **0**. The version lives in OpenCode's own `migration` table: **38 rows, the last `20260622202450_simplify_session_input`**. The store pins that set |
| Tables | `session` (`id`, `project_id`, `workspace_id`, `parent_id`, `slug`, `directory`, `path`, `title`, `version`, `summary_*`, `metadata`, `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `revert`, `permission`, `agent`, `model` (JSON `{ id, providerID }`), `time_created`, `time_updated`, `time_compacting`, `time_archived`), `message` (`id`, `session_id`, `time_created`, `time_updated`, `data` JSON), `part` (`id`, `message_id`, `session_id`, times, `data` JSON), `session_message` (`session_id`, `type`, `seq`, `data`), `session_input`, `session_context_epoch`, `event` / `event_sequence` (event-sourced: `session.created.1` with `data`), `todo`, `project`, `project_directory`, `workspace`, `permission`, `session_share` (with `secret`), and **`account`, `control_account`, `credential` holding access and refresh tokens** |
| After one ACP `session/new` | `session` 1 row (`project_id: "global"`, `agent: "build"`, `version: "1.18.34"`); `event` 1 row; `message`, `part`, `session_message` empty |
| Config (docs: opencode.ai/docs/config) | Merged, later wins: remote, global `~/.config/opencode/opencode.json`, `OPENCODE_CONFIG`, project `opencode.json`, `.opencode/`, **inline `OPENCODE_CONFIG_CONTENT`**, managed. `autoupdate: false` disables updates |
| Permissions (docs: opencode.ai/docs/permissions) | Keys `read`, `edit`, `glob`, `grep`, `bash`, `task`, `skill`, `lsp`, `question`, `webfetch`, `websearch`, `external_directory`, `doom_loop`; values `allow` / `ask` / `deny`; bash patterns with `*`; "the last matching rule wins" |

#### ACP itself (agentclientprotocol.com)

`session/prompt` ends with a `stopReason` of `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or
`cancelled`. `session/cancel` is a notification: the agent "SHOULD stop … as soon as possible" and
answers the pending prompt with `cancelled`. A pending `session/request_permission` must then be
answered `{ outcome: { outcome: "cancelled" } }`. Permission options have kinds `allow_once`,
`allow_always`, `reject_once` and `reject_always`. Tool call kinds are `read`, `edit`, `delete`,
`move`, `search`, `execute`, `think`, `fetch`, `switch_mode` and `other`; statuses are `pending`,
`in_progress`, `completed` and `failed`. The `sessionUpdate` variants are `agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `user_message_chunk`,
`available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update` and
`usage_update`. All four CLIs (the three ACP agents and Codex) exit 0 on stdin EOF (recorded).

#### To record with an account

Each of these has a safe default in the drivers until a recording replaces it. They are recorded in
task `r1`, on the owner's machine and with the owner present, using throwaway prompts in a scratch
repository:

| What | Safe default meanwhile |
|---|---|
| Codex: a completed turn (`agentMessage` deltas, `commandExecution`, `fileChange`, `thread/tokenUsage/updated`, `account/rateLimits/updated`) | Fake built from the generated schema; the conformance suite checks the driver against the schema's types |
| Codex: an approval round trip (`item/commandExecution/requestApproval` for a network escalation under `workspace-write`), and whether `on-request` asks before `git push` | `git push` is held off by the sandbox (network off) **and** by the judge; a network escalation for anything else asks the person, or is denied without one |
| Codex: `outputSchema` streaming as `agentMessage` deltas | `structuredOutput` declared, confirmed only by the first real run (phase 2's `confirm`) |
| Codex: `usageLimitExceeded` / `rateLimitExceeded` turn shape | Mapped to cause `rate-limit` by `codexErrorInfo` alone, never by message text |
| Copilot signed out (needs a machine with no GitHub credential) | `no-probe`; an auth error on the first `session/new` or `session/prompt` makes the provider `signed-out` |
| Copilot `session/request_permission` (an `execute` tool), and whether `--deny-tool 'shell(git push)'` holds under `--acp` | The flag is passed **and** the judge denies a `git push` request; a Copilot flow stage stays off until the recording confirms the flag (risk table) |
| Copilot model catalog | `auto` plus the model the person types; `setModel` not declared |
| Gemini signed in: `session/new` `models` and modes, `session/set_model`, a permission request, `--policy` under `--acp` | Capabilities from the bundle source are declared only after this recording (until then Gemini declares `interactivePermissions`, `resume` and `interrupt`) |
| OpenCode: a turn (which of `message`/`part` or `session_message` gets the rows, `part.data` shapes, `cost` and `tokens_*` filled) | The store reads both layouts by the pinned schema, and an unknown `data` type becomes an `other` block, never a dropped entry |
| OpenCode: `OPENCODE_CONFIG_CONTENT` with `permission` honoured under `acp` | The judge denies a `git push` request as well |

### The driver interface, extended

These are additive changes to `packages/core/src/providers/driver.ts`. The Claude driver keeps
today's behaviour, and the phase 2 goldens stay byte-identical.

```ts
export interface ProviderDriver {
  // …phase 2 members unchanged…
  /** Who names the session: Agentry (`imposed`, Claude) or the agent (`assigned`, Codex and ACP) */
  readonly sessionIds: 'imposed' | 'assigned';
  /** The permission modes this provider can honour, each with its native value; the picker offers only these */
  permissionModes(): Array<{ mode: PermissionMode; native: string }>;
  /** Reads what the provider wrote; null when it keeps nothing Agentry can read */
  readonly transcripts: TranscriptStore | null;
  /** A handshake that spends nothing, for detection: version, account, models, confirmed capabilities */
  handshake?(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<HandshakeResult>;
}

export interface SessionLaunch {
  // …phase 2 members unchanged…
  /** The agent's own id once it has named the session; null before the first process confirms it */
  nativeId: string | null;
  /** Agentry's policy for this run; the driver applies the settings part, the judge the host part */
  policy: ToolPolicy | null;
}
```

- `DriverEvent` `init` gains `nativeSessionId`. `ChatManager` records it on the chat the first time,
  and a later process that reports another id is a protocol error (`failed`, never silently
  rebound). For `imposed` drivers it equals the chat id, as today.
- `send` stays synchronous. A protocol driver **queues the turn** until its handshake (`initialize`,
  then `thread/start|resume|fork` or `session/new|load`) has answered, and writes it then. A
  handshake that fails ends the execution `failed` with the reason (`auth-required`, `protocol`,
  `version`), never `completed`.
- **Process ownership without argv.** Claude's `liveSessions` reads the session from argv; Codex and
  ACP processes carry no session id in argv. `processes.ts` gains `agentryChildren()`: on Linux it
  reads `AGENTRY_CHAT_ID` from `/proc/<pid>/environ` of the same user's processes (ChatManager
  already sets it on every spawn). It returns `[]` elsewhere. `sessionHolders` and `liveSessions` of
  both new drivers use it, plus the pids they spawned in this process. Leftovers from a dead wrapper
  end on their own: every one of the four CLIs exits on stdin EOF (recorded).
- **The manifest selects the command and the protocol.** `ProviderManifest` gains
  `launch: { args: string[]; env: Record<string, string>; unsetEnv: string[] }`, data like the rest:

  | Manifest | `transport` | `launch.args` | `launch.env` |
  |---|---|---|---|
  | `codex` | `json-rpc` | `app-server` | — (`CODEX_HOME` passes through untouched) |
  | `copilot` | `acp` | `--acp`, `--no-auto-update`, `--no-remote` | `COPILOT_AUTO_UPDATE=false` |
  | `gemini` | `acp` | `--acp` | — |
  | `opencode` | `acp` | `acp` (whether to add `--pure`, which drops external plugins, is settled by `r1`) | `autoupdate: false` in `OPENCODE_CONFIG_CONTENT` (documented); `OPENCODE_DISABLE_AUTOUPDATE=1` too (a string in the binary, undocumented) |

  The registry maps `transport` to a driver class: `json-rpc` → `CodexDriver`, `acp` →
  `AcpDriver(manifest)`. Adding a fourth ACP agent is a manifest, a fake profile and a conformance
  test file.

### `ToolPolicy` on providers that do not take Claude's rules

`PolicyTranslation` (shared) grows from "rules or unsupported" to "how each part is enforced":

```ts
export type PolicyPart = 'read' | 'edit' | 'commands' | 'network' | 'delegate' | 'workflow' | 'gitPush' | 'exclusive';

export interface PolicyTranslation {
  /** Native rule strings (Claude's tools, Copilot's --allow-tool / --deny-tool) */
  rules: { allowedTools: string[]; disallowedTools: string[]; tools?: string[] };
  /** Native settings the launch applies, each with the part it enforces (a sandbox mode, inline config, a policy file) */
  settings?: Array<{ part: PolicyPart; key: string; value: unknown }>;
  /** Parts Agentry enforces by answering the agent's permission requests through the judge */
  host?: PolicyPart[];
  unsupported: string[];
}
```

- **The judge.** `packages/core/src/policy-judge.ts` is pure:
  `judge(policy, request: NeutralRequest): 'allow' | 'deny' | 'ask'`, where `NeutralRequest` is
  `{ kind: 'command' | 'edit' | 'read' | 'fetch' | 'delegate' | 'other'; command?: string; paths?: string[]; url?: string }`.
  It reuses the `CommandRule` matching that phase 2 wrote for Claude (`none` / `some` / `prefix` /
  `pattern`), and `git push` in any form (`git push`, `git -C x push`, `git … push`) is always `deny`
  when `gitPush: 'deny'`.
- **Where it runs.** On a `permission-request` from a driver whose translation lists the request's
  part in `host`, `ChatManager` asks the judge first. `allow` and `deny` are answered at once and
  recorded as a notice; `ask` goes to the broker when `permissionPrompts` is `host`, and is denied
  otherwise. Claude's translation has no `host` part, so its path is unchanged.
- **Each driver maps requests to `NeutralRequest`:** Codex `commandExecution` → `command`,
  `fileChange` → `edit` with the changed paths, `permissions` (network) → `fetch`; ACP tool call
  `execute` → `command` (from `rawInput.command`), `edit` / `delete` / `move` → `edit` (from
  `locations`), `read` / `search` → `read`, `fetch` → `fetch`, anything else → `other` (`ask`).

The translations:

| Policy part | Codex | Copilot (`--acp`) | Gemini (`--acp`) | OpenCode (`acp`) |
|---|---|---|---|---|
| `read.allow` | always (every sandbox reads) | always | always | `permission.read: allow` |
| `read.denyPaths` | unsupported | unsupported | policy rule `deny` on `read_file` with `argsPattern` | `permission.read` pattern `deny` |
| `edit.allow: 'none'` | sandbox `read-only` | `--deny-tool write` | `--approval-mode plan` | `permission.edit: deny` |
| `edit.allow: 'any'` | sandbox `workspace-write` | `--allow-tool write` | rule `allow` on edit tools | `permission.edit: allow` |
| `edit.allow: [paths]` | `workspace-write` + host: `fileChange` judged by path | host (`edit` judged by `locations`) | host | `permission.edit: ask` + host |
| `commands.allow: 'any'` | `on-request`; commands inside the sandbox run | `--allow-tool shell` | rule `allow` `run_shell_command` | `permission.bash: allow` |
| `commands.allow: [rules]` | host (escalations judged); inside-sandbox commands cannot be limited → **unsupported** unless `edit.allow` is `none` | `--allow-tool 'shell(cmd)'` / `shell(cmd:*)` | rules with `commandPrefix` | `permission.bash` patterns |
| `commands.deny` | host | `--deny-tool 'shell(cmd:*)'` | rules `deny` | `permission.bash` patterns `deny` |
| `network: 'allow'` / `'deny'` | `config.web_search` `live` / `disabled` (shell network stays off) | `--allow-all-urls` / `--deny-url '*'` | rules on `web_fetch`, `google_web_search` | `webfetch` / `websearch` `allow` / `deny` |
| `delegate: 'deny'` | unsupported (collab agents) → listed | unsupported | unsupported | `permission.task: deny` |
| `workflow` | unsupported | unsupported | unsupported | unsupported |
| `gitPush: 'deny'` | **sandbox network off** (a push to a remote cannot connect) + **host** (a network escalation for `git push` is declined) | `--deny-tool 'shell(git push)'` (precedence over every allow) + host | rule `deny` `commandPrefix = "git push"` at User tier + host | `permission.bash."git push*": deny` (last rule) + host |
| `exclusive` | `config` with no MCP servers + `developerInstructions` only | `--available-tools` + `--no-custom-instructions` | `--allowed-mcp-server-names` empty | `OPENCODE_CONFIG_CONTENT` with `mcp: {}`; unsupported for the person's global config (merged) → **listed** |

Gemini's rules go into a temporary policy TOML in the data directory, written per launch and passed
with `--policy`. OpenCode's go into `OPENCODE_CONFIG_CONTENT`. Codex's go into the `thread/start`
params (`sandbox`, `approvalPolicy: "on-request"`, `config`). Copilot's go into argv, as Claude's do.
A part listed as `unsupported` keeps phase 2's rule: a run that needs it is refused on that
provider, and a provider that cannot enforce `gitPush: 'deny'` is never offered for a flow stage.
`tool-policy.ts`'s `TRANSLATIONS` record becomes a lookup by driver (`registry.translationFor(id)`),
so it stops naming `claude-code`.

### Permission modes

Phase 2 kept `PermissionMode` as Claude's list and deferred a neutral mode to "the second driver".
The proposal (decision P3-1) keeps the list as Agentry's vocabulary and lets each driver declare the
subset it honours:

| `PermissionMode` | Codex | Copilot | Gemini | OpenCode |
|---|---|---|---|---|
| `manual` (ask) | `on-request` + `workspace-write`, every request to the judge, then the person | mode `agent`, `allow_all: off` | `default` | `build` |
| `acceptEdits` | `on-request` + `workspace-write` | `agent` + `--allow-tool write` | `auto_edit` | `build` + `edit: allow` |
| `plan` | `read-only` sandbox | `plan` | `plan` | `plan` |
| `dontAsk` | `on-request`; the judge answers, nothing reaches a person | `agent`; judge only | `default`; judge only | `build`; judge only |
| `bypassPermissions` | `danger-full-access` + `never`, only when the person picked it | `allow_all: on` | `yolo` | `build` + every permission `allow` |
| `auto` | not offered | not offered | not offered | not offered |

`setOption({ permissionMode })` becomes `thread/settings/update` or the next `turn/start`'s
`approvalPolicy`/`sandboxPolicy` for Codex, and `session/set_mode` (plus `set_config_option` for
Copilot's `allow_all`) for ACP. A mode a driver does not list is refused with `400` before it
reaches the process.

### The Codex driver

Files under `packages/core/src/providers/codex/`:

| File | What it holds |
|---|---|
| `manifest.ts` | phase 1's, plus `capabilities`, `versions.range` `>=0.159.3 <0.160.0`, `launch` |
| `protocol/` | types generated from `codex app-server generate-ts` 0.159.3, the subset the driver uses, with a header naming the version and the command. Never edited by hand |
| `rpc.ts` | JSON-RPC over JSONL: ids, pending requests with timeouts, server requests, notifications; tolerant of a missing `jsonrpc` |
| `driver.ts` | `CodexDriver`: `launch`, `attach`, `models`, `permissionModes`, `confirm`, `handshake`, `sessionHolders`, `liveSessions` |
| `session.ts` | the per-process state machine below |
| `events.ts` | notifications → `DriverEvent` |
| `approvals.ts` | server requests → `NeutralRequest` → judge / broker → the reply |
| `policy.ts` | the `ToolPolicy` translation |
| `transcripts.ts` | the `TranscriptStore` (decision P3-3) |

**Lifecycle.** `launch` returns `{ bin: codex, args: ['app-server'], env }`, with `CODEX_HOME`
taken from the person's environment and never set by Agentry. `attach` then runs, in order:
`initialize` (clientInfo `agentry`, `experimentalApi: false`), then `initialized`, then

- `thread/start` for a new chat, with `cwd`, `sandbox`, `approvalPolicy`, `model`, `config` and
  `developerInstructions` (the append-system-prompt);
- `thread/resume { threadId: nativeId }` when `created`;
- `thread/fork { threadId: source's nativeId }` for a fork.

Then the queued turn goes out as `turn/start`. One process per chat execution, as Claude: idle and
`keepAlive: false` close stdin, and the process exits 0 (recorded).

**Mapping onto the driver interface:**

| Driver | Codex |
|---|---|
| `send(turn)` | `turn/start { threadId, input: [text, localImage for image uploads by path], model?, effort?, outputSchema? }`; a turn sent while one runs is queued by `ChatManager` as today (Codex's `turn/steer` is not used) |
| `interrupt()` | `turn/interrupt { threadId, turnId }`; resolves on `turn/completed` `interrupted`; pending approvals are answered `cancel` |
| `setOption({ model })` | the next `turn/start` carries `model` (Codex compacts on a switch, recorded); the chat shows the new model at once |
| `setOption({ permissionMode })` | `thread/settings/update` (sandbox and approval) |
| `answerPermission` | the server request's reply: `accept` / `acceptForSession` (from a person's "allow always" for this chat) / `decline` |
| `endInput` / `dispose` | stdin end; pending requests rejected with the reason |

**Events → `DriverEvent`:**

| Codex | `DriverEvent` |
|---|---|
| `thread/start` reply / `thread/started` | `init` (nativeSessionId = `thread.id`, model, cwd, mode from approval + sandbox, environment from `instructionSources`) |
| `turn/started` | status `busy` |
| `item/agentMessage/delta` | `block-started` (text) once, `delta`; with `outputSchema`, `structured-delta` |
| `item/reasoning/textDelta` / `summaryTextDelta` | `delta` (thinking) |
| `item/completed` `agentMessage` / `reasoning` / `plan` | `message` with a `TranscriptEntry` (text, thinking, plan as text) |
| `item/started` `commandExecution` | `command-started` (toolUseId = item id, command) and a `tool_use` block |
| `item/completed` `commandExecution` | `command-ended` (`isError` = non-zero `exitCode`) and a `tool_result` with `aggregatedOutput` |
| `item/completed` `fileChange` | `message` with an edit `tool_use` per change, so the changes review sees edits with their "why" |
| `item/completed` `mcpToolCall` / `dynamicToolCall` | `tool_use` + `tool_result` blocks |
| `collabAgentToolCall` | `task` (agent) |
| `thread/tokenUsage/updated` | kept for the `result`'s usage and context window |
| `account/rateLimits/updated` | `rate-limit` (`RateLimitInfo` from `primary` / `secondary`) |
| `error` with `willRetry: true` | a notice (no status change) |
| `turn/completed` | `result`: `isError` for `failed`; cause `stopped` for `interrupted`; `rateLimited` and cause `rate-limit` when `codexErrorInfo` is `usageLimitExceeded` or `rateLimitExceeded`; `structuredOutput` parsed from the last `agentMessage` when a schema was given; no `costUsd` |
| stderr | `stderr` (Codex logs `ERROR …` lines there; not parsed) |
| a stdout line that is not JSON | `unreadable` |

**Account and readiness.** The detector's handshake for Codex runs `codex app-server` once per
binary version (not every TTL), with `initialize`, `account/read` and `model/list`. That spends
nothing (recorded). From it:

- the version comes from `userAgent`;
- `account: null` with `requiresOpenaiAuth: true` is `signed-out`;
- `{ type: "chatgpt", planType }` or `{ type: "apiKey" }` is the account (the email is shown only
  where the person's own account is shown today);
- the models are cached in `provider-catalogs.json` in the data directory (a settings-shaped cache,
  rewritten whole).

`codex login status` stays the cheap probe between handshakes.

**Capabilities declared:** `interactivePermissions`, `structuredOutput`, `resume`, `fork`,
`interrupt`, `setModel`, `effort`, `mcp`, `rateLimitWindows`. Not declared: `budgetLimit`,
`costReport`, `multiAccount`, `worktreeFlag`, `subagents`, `workflowTool`, `transcriptFiles`.

### The ACP driver

Files under `packages/core/src/providers/acp/`: `rpc.ts` (shared JSON-RPC, also used by Codex if the
two converge in review), `driver.ts` (`AcpDriver(manifest, profile)`), `session.ts`, `updates.ts`
(`session/update` → `DriverEvent`), `permissions.ts`, and one `policy-<agent>.ts` per agent.

**Lifecycle.** `launch` returns the manifest's command and `launch.args`/`env`, plus the policy
translation's flags (Copilot), `--policy <file>` (Gemini) or `OPENCODE_CONFIG_CONTENT` (OpenCode),
and `--model` for Copilot. `attach` runs `initialize` with
`{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }`.
The agent works on the disk itself; Agentry offers no file system or terminal. Then:

- `session/new { cwd, mcpServers }` for a new chat, with the chat's MCP servers translated to ACP's
  `stdio`/`http`/`sse` entries;
- for a resume: `session/load` when `loadSession`, or `session/resume` when
  `sessionCapabilities.resume` is listed (OpenCode). The replayed `session/update`s during a load
  are dropped from the live feed, since the transcript already has them;
- for a fork: `session/fork` (OpenCode only).

Then the queued turn goes out as `session/prompt`.

| Driver | ACP |
|---|---|
| `send(turn)` | `session/prompt { sessionId, prompt: [text, image (inline base64, when `promptCapabilities.image`), resource_link for other uploads] }` |
| `interrupt()` | `session/cancel` (notification); answers every pending `session/request_permission` with `cancelled`; resolves on the prompt's reply `stopReason: "cancelled"` |
| `setOption({ model })` | OpenCode: `session/set_config_option { configId: "model" }`; Gemini: `session/set_model` (after `r1`); Copilot: refused (`setModel` not declared) |
| `setOption({ permissionMode })` | `session/set_mode` with the mapped id (Copilot's `https://agentclientprotocol.com/protocol/session-modes#…` ids, Gemini's and OpenCode's names), plus `allow_all` for Copilot |
| `answerPermission` | `{ outcome: { outcome: "selected", optionId } }`: the option whose `kind` matches (`allow_once`, or `allow_always` when the person chose "always for this chat"; `reject_once`) |

| `session/update` | `DriverEvent` |
|---|---|
| `agent_message_chunk` | `block-started` (text) + `delta` |
| `agent_thought_chunk` | `delta` (thinking) |
| `tool_call` | a `tool_use` block (name = title, `kind` kept), `command-started` for `execute` |
| `tool_call_update` | `tool_result` (content and `diff`; a `diff` becomes an edit the changes review shows), `command-ended` |
| `plan` | `task` (`listed`, the plan's entries) |
| `usage_update` | context window (`used` / `size`) |
| `current_mode_update` | `mode-changed` (mapped back) |
| `session_info_update` | the chat's title, when the chat still has its default one |
| `available_commands_update`, `config_option_update` | kept on the session (models, modes); not in the feed |
| prompt reply | `result`: `end_turn` completed; `cancelled` cause `stopped`; `max_tokens` / `max_turn_requests` / `refusal` `isError` with the reason; `usage` for tokens; no cost (OpenCode's cost comes from its database, see below) |
| error `-32000` on `session/new` or `session/prompt` | execution `failed` with reason `auth-required`; the detector marks the provider `signed-out` (reason `missing-credentials`) |

**Capabilities per agent:** declared in the manifest, and confirmed by `initialize`
(`loadSession`, `sessionCapabilities`, `promptCapabilities`) through `confirm`:

| Capability | Copilot | Gemini | OpenCode | Confirmed by |
|---|---|---|---|---|
| `interactivePermissions` | yes | yes | yes | — |
| `resume` | yes | yes | yes | `loadSession` or `sessionCapabilities.resume` |
| `fork` | no | no | yes | `sessionCapabilities.fork` |
| `interrupt` | yes | yes | yes | — |
| `setModel` | no | after `r1` | yes | a `model` config option or `models` in `session/new` |
| `mcp` | yes | yes | yes | `mcpCapabilities` |
| `structuredOutput`, `budgetLimit`, `costReport`, `rateLimitWindows`, `effort`, `worktreeFlag`, `subagents`, `workflowTool`, `multiAccount` | no | no | no | — |

Version ranges: Copilot `>=1.0.65 <1.1.0`, Gemini `>=0.62.0 <0.63.0`, OpenCode
`>=1.18.34 <1.19.0`. Above the range is `degraded` (`version-above-range`), as phase 1 defines.

### OpenCode's SQLite `TranscriptStore`

`packages/core/src/providers/opencode/transcripts.ts`, implementing the `TranscriptStore` interface
(`list(projectPath?)`, `summary(nativeId)`, `page(nativeId, { before, limit })`, `search`, `watch`).
It is read-only by construction:

1. **Finding the file**, the way OpenCode does: `OPENCODE_DB` when set (honoured, recorded), else
   `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/opencode.db`, recorded
   with `db path`). The channel-named variant `opencode-<channel>.db` is used when the manifest's
   detected channel is not latest, beta or prod (source, phase 1). Agentry never runs `opencode db
   path` to find it, because that command creates and migrates the database (recorded).
2. **Opening it:** `new DatabaseSync(path, { readOnly: true })` from `node:sqlite` (no new
   dependency), then `PRAGMA query_only = 1` and `PRAGMA busy_timeout = 250`. Never `immutable=1`,
   which would ignore the WAL, and never a `wal_checkpoint`, `VACUUM` or write of any kind.
3. **Short reads.** One read transaction per call, closed at once. A long-open read transaction would
   stop OpenCode's checkpoints and grow its `-wal`. The connection is opened per call (cheap), and
   never pooled across an idle period.
4. **Busy is "try again".** `SQLITE_BUSY` / `SQLITE_LOCKED` is retried three times with backoff
   (50, 150, 400 ms). After that the read answers `unknown` (`busy`), and the UI says "OpenCode is
   writing; try again" and never shows an empty session.
5. **The schema pin.** The store reads `SELECT id FROM migration ORDER BY id`. If the recorded set of
   38 ids ending in `20260622202450_simplify_session_input` is a prefix of what it finds, the store
   reads; if not, or if a column it selects is missing, it answers `unknown` with
   `schema-untested`. Newer migrations beyond the prefix read as `degraded`. A recording task adds
   each new version's set.
6. **Only these tables:** `session`, `message`, `part`, `session_message`, `project`, `todo`. A test
   parses every SQL string in the module and fails on any other table, so `account`,
   `control_account`, `credential` and `session_share` are never selected.
7. **Mapping:** a session row → `TranscriptSummary` (title, `directory` as project path, `time_*`,
   `model`, `cost`, `tokens_*` as usage). Rows of `message` + `part` (or `session_message`, the
   layout `r1` records as used) → `TranscriptEntry` blocks: text, reasoning (thinking), tool parts
   (tool_use + tool_result with state), patches (edits), step-finish (usage). An unknown part type
   becomes an `other` block that shows its type. Nothing is dropped.
8. **Watching:** `fs.watch` on the database and its `-wal`, debounced 500 ms, invalidates the
   summaries and emits the same "session changed" signal the Claude store emits for its projects
   directory.

The same store gives OpenCode's **cost**: the `session` row's `cost` and `tokens_*` are what the usage
page reads for an OpenCode chat, since ACP reports no cost.

### Transcripts for the other providers

- **Claude Code:** `SessionStore`, unchanged, adapted to `TranscriptStore` by a thin wrapper.
- **Codex** (decision P3-3, recommended): through `app-server` itself. A reader process is started
  on demand, with `initialize`, then `thread/list` filtered by `cwd`, then `thread/turns/list` and
  `thread/items/list`. It is reused for 60 s, then stdin is closed. Items map as in the live
  table. The rollout JSONL files are not parsed: their format is internal (`session_meta`,
  `response_item`, `event_msg`, `world_state`, … as recorded), and the API is the vendor's
  documented, versioned surface for it.
- **Copilot and Gemini** (decision P3-2, recommended): Agentry records the stream it received, as
  rows, in a new table `chat_entries` (`chat_id`, `seq`, `entry` JSON, `at`; primary key
  `(chat_id, seq)`). That is a stream, so it goes in SQLite (CONTRIBUTING). The table is written for
  every non-Claude chat, and is the transcript for providers whose `transcripts` is null. Their
  sessions started in a terminal are not listed in phase 3.

`ChatService` resolves a chat's store by its provider and native id, so `detail`, `export`,
`search`, `resume` and `delete` (delete removes only Agentry's rows; it never deletes another
vendor's history) work the same for every provider.

### Fakes and the conformance suite

**Core fakes** (`packages/core/test/fixtures/`), built from the committed recordings (`g6`). They
replay recorded shapes and invent no event:

- `fake-codex-app-server.mjs`: answers `initialize`, `account/read`, `model/list`, `thread/start`,
  `thread/resume`, `thread/fork`, `turn/start`, `turn/interrupt`, `thread/settings/update`, the list
  and read methods, and sends approvals. The prompt text scripts it, as the Claude fake's does:
  `TURN`, `ASK <kind>`, `ODD` (a server request the driver does not know), `STRUCTURED`, `RATE`,
  `NOISY`, `DELEGATE`, `AUTH` (401 turn), `GITPUSH` (an approval for `git push`). It omits
  `jsonrpc` on what it sends, as the real one does.
- `fake-acp-agent.mjs --profile copilot|gemini|opencode`: one script; the profile chooses the
  recorded `initialize` reply, the session id format, the config options, which methods answer
  `-32601`, and whether `session/new` needs a credential (`FAKE_ACP_SIGNED_OUT=1` gives `-32000`).
  Scripts as above, plus `CANCEL-WAIT` (holds a permission request until `session/cancel`).
- `opencode-db.ts`: builds a fixture `opencode.db` from the recorded `schema.sql` and migration ids,
  in WAL mode. `opencode-writer.mjs` is a child process that holds a write transaction for a given
  time, so the busy and retry path runs for real.

**The conformance suite** (phase 2's `suite.ts`) is generalised in `g5`. Each change keeps the Claude
harness passing:

1. Case 1 asserts the session id by `sessionIds`: `imposed` → the chat id, as today; `assigned` → a
   non-empty native id recorded on the chat, and the same id in every later `init` (case 3).
2. Case 11 counts a part as enforced when it is in `rules`, in `settings` or in `host`. For
   `gitPush: 'deny'` it requires `settings` or `rules` **and**, for a driver with a `host` part, case
   16.
3. New 15: a turn sent before the handshake completes is delivered once, after it.
4. New 16: with a policy whose `host` covers commands, an agent request to run `git push` is denied
   by the judge without reaching the broker, and the agent receives the denial.
5. New 17: `interrupt` with a pending permission request answers it (`cancelled` for ACP, `cancel`
   for Codex) before the turn ends.
6. New 18: an authentication failure at session start ends the execution `failed` with reason
   `auth-required`, and the chat is not left `starting`.
7. New 19: the driver's `transcripts` (when not null) lists the session the conformance turn
   created, with its entries, by native id.

Test files: `conformance-codex.test.ts`, `conformance-copilot.test.ts`,
`conformance-gemini.test.ts`, `conformance-opencode.test.ts`. Each is a harness of a few lines, like
`conformance-claude-code.test.ts`.

**e2e fakes.** `e2e/fake-providers/agent` (sh) keeps answering `--version` and `login status`, and
hands `app-server`, `--acp` and `acp` to `e2e/fake-providers/protocol.mjs`. That file reuses the core
fakes' logic, copied, not imported, so that e2e never depends on core's test tree. The spec
`e2e/specs/providers-chat.spec.mjs`, written by `u2` and run once at the end:

- start a chat on the fake Codex, then see the provider on the chat page and its messages;
- answer a fake Copilot permission request from the chat;
- find the model picker disabled on Copilot, with its reason;
- open an OpenCode chat whose history comes from a fixture database.

### The chat page, and the copy review

**What changes on screen** (P0 prototypes first; the owner validates):

- **Chat page:** the provider beside the model in the header, as a chip with the provider's icon and
  label (`ChatBadges`, a `ProviderBadge`). The native session id, when it differs from the chat id,
  goes in the details panel in mono, secondary.
- **Chats list:** the provider's icon on each row, in both desktop and phone layouts. There is no
  filter (phase 2 decision 3 still stands).
- **New chat:** a provider picker, listing the ready providers that have a session driver, in the
  person's order, with the default first. The model list follows the provider
  (`GET /providers/:id/models`), and so do the permission modes (`permissionModes()`). Controls the
  provider lacks are hidden (budget, schema) or shown disabled with the reason (model switch on
  Copilot: "Copilot picks the model when the chat starts").
- **Composer:** the working line names the chat's agent ("Codex is working…").

**The copy rule.** A string about a chat, a run or an edit names the chat's agent through
`{{agent}}`, interpolated with the provider's label (or "the agent" where no chat is in context). A
string about a Claude-only feature keeps "Claude Code", and the feature is shown only for Claude
chats or in Claude's settings. `ChatUiConfig.agentName` (chat-ui) becomes
`agentNameFor(chat: ChatSummary): string`, injected by the web app from the provider labels, so
`@agentry/chat-ui` still names no vendor (its boundaries test).

| Where | Keys that become `{{agent}}` | Keys that stay Claude's (feature shown for Claude only) |
|---|---|---|
| `packages/chat-ui/src/locales/*/chat.json` | `sendNowHint`, `external` ("Started in a terminal with {{agent}}"), `costNotReported`, `environmentEmpty`, `lead`, `agentIsAsking`, `attachHint`, `working`, `loadedByClaude` → `loadedByAgent` | `serversHint`, `strictNote` (claude.ai connectors: Claude chats only) |
| `packages/ui/src/locales/*/primitives.json` | `claudeIsWorking` → `agentIsWorking` | — |
| `apps/web/…/changes.json` | `legendLive`, `live`, `pendingPatch`, `count_*`, `countShort_*`, `intentLabel`, `noIntent` | — |
| `apps/web/…/components.json` | `newChatHint`, `unexplained` | `installCli` (`CLAUDE_BIN`), `empty` (environment panel: Claude's `system/init`) |
| `apps/web/…/chats.json` | `emptyBody`, `subtitle`, `promptPlaceholder` | `accountHint` (claude-swap), workflow keys |
| `apps/web/…/observe.json`, `schedules.json`, `home.json` (`placeholder`), `usage.json` (`note`, `saved_*`), `workItem.json` (`chat-failed`), `suggestion.json` (`chats`) | each listed key | `home.json` memory and `CLAUDE.md` keys |
| `config.json`, `accountsConfig.json`, `team.json`, `projects.json`, `connectors.json`, `server.json` | — | all (Claude's own configuration, claude-swap, agent files) |

Every changed key keeps `en`/`es` parity. The Spanish follows the glossary, which gains "el agente"
for `{{agent}}` when no chat is in context. A web test fails when a chat-scoped key in the files of
the first six rows contains "Claude".

### Persistence and API

- **`chats` table:** one migration appended to `MIGRATIONS` in `packages/core/src/db.ts`:

  ```sql
  ALTER TABLE chats ADD COLUMN native_session_id TEXT;
  CREATE INDEX chats_native_session ON chats (provider, native_session_id);
  CREATE TABLE chat_entries (
    chat_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    entry TEXT NOT NULL,
    PRIMARY KEY (chat_id, seq)
  );
  ```

  `native_session_id` is null for Claude chats (their id is the native one). `chat_entries` is
  appended by the process that runs the chat, with `INSERT … ON CONFLICT DO NOTHING`, so a second
  process replaying the same entries cannot duplicate them. The migration runs under the existing
  one-transaction-per-step guard, and a process on the old schema neither reads nor writes the new
  column or table.
- **JSON files in the data directory:** `provider-catalogs.json` (models per provider and version,
  from handshakes; a cache rewritten whole) and `policies/<chat-id>.toml` (Gemini's per-launch
  policy file, removed when the process exits).
- **`ChatToolConfig.policy?`** (inside the chat's JSON document): the policy a chat was started with,
  so a resume enforces the same one.
- **Shared types** (`packages/shared/src/types.ts`): `PolicyPart`; `PolicyTranslation.settings?` and
  `host?`; `Chat.providerSessionId: string | null`; `ChatToolConfig.policy?`;
  `ProviderReasonCode` `auth-required`, `schema-untested`, `busy`;
  `ProviderStatus.permissionModes?: PermissionMode[]`. They are additive, then
  `pnpm --filter @agentry/api openapi:schemas`.
- **Routes:** no new route. `POST /chats` already takes `provider`. `GET /providers/:id/models`
  already exists, and now answers from the catalog cache for Codex and from the session's config
  options for ACP. `GET /providers` gains `permissionModes`. `README.md`: the `/providers` rows
  mention the permission modes, the chats section names `provider` and `providerSessionId`, and
  "How it talks to Claude" gains Codex's and ACP's rows (the methods above).
- **Flow, orchestrations and the assistant** choose a provider through `registry.capabilities` and
  the translation: a stage whose policy a provider cannot enforce, or that needs `structuredOutput`,
  is not offered on it. The person-only move to Done, `maxParallel`, bounces and budgets are
  untouched.

### Orchestrations and tasks

#### P0 · `providers3-prototypes` (design; gates W)

- `p1`: the chat page and the chats list with the provider: `DesktopChat.html`, `MobileChat.html`,
  `DesktopChats.html`, `MobileChats.html`, dark and light, with a Claude, a Codex and a Copilot chat,
  and the native id in the details panel.
- `p2`: New chat with the provider picker: `DesktopNuevoChat.html`, `MobileNuevoChat.html` (a
  `Sheet` on phone). Show the model list following the provider, the mode list following it, a
  disabled model picker with its reason (Copilot), and the "no provider can run chats" state.
- A new variant (`ProviderBadge`) goes into `docs/design-system.md` and `agentry-ds.css`.
- Check: the prototype tools pass (`lint.py`, `check.mjs`), and **the owner validates** before W
  starts.

#### G · `providers3-groundwork` (runs beside P0)

- `g1` (shared types, additive), dependsOn none.
  - What "Persistence and API" lists for shared types; nothing is removed.
  - Files: `packages/shared/src/types.ts`, `apps/api/src/openapi/schemas*` (regenerated),
    `packages/shared/test/*`.
  - Checks: shared tests; `openapi:schemas` with no drift; `pnpm typecheck`.
- `g2` (the interface and the native id), dependsOn g1, g4.
  - `driver.ts` additions; `ProviderManifest.launch`; `ChatManager` records `nativeSessionId`,
    passes `nativeId` and `policy` in `launchSpec`, queues nothing itself (drivers do), and asks the
    judge for a `host` part; `ClaudeCodeDriver` declares `sessionIds: 'imposed'`,
    `permissionModes()` (all of today's list), `transcripts` (the `SessionStore` adapter) and no
    `host`.
  - `processes.ts` `agentryChildren()`.
  - Files: `providers/driver.ts`, `providers/manifest.ts`, `providers/registry.ts`
    (`translationFor`, `transport` → driver class map, empty for now), `chats.ts`, `live-chat.ts`,
    `chat-records.ts`, `processes.ts`, `tool-policy.ts`, `providers/claude-code/driver.ts`.
  - Checks: `pnpm typecheck`; core tests with the phase 2 goldens untouched; API tests.
- `g3` (the migration), dependsOn g1.
  - Files: `packages/core/src/db.ts` (migration, `saveChats`/`loadChats` for the column,
    `appendChatEntries`/`chatEntries`), `packages/core/test/db.test.ts`.
  - Check: core tests, including a migration test from the previous `user_version` with chats.
- `g4` (pure modules), dependsOn g1.
  - `policy-judge.ts` with its tests (the `git push` forms, every `CommandRule` kind, paths), and
    `providers/transcripts.ts` (the `TranscriptStore` interface and the `SessionStore` adapter).
  - Files: those two and their tests only.
  - Check: core tests.
- `g5` (the suite generalised), dependsOn g2.
  - The changes and new cases in "Fakes and the conformance suite". `conformance-claude-code.test.ts`
    passes; cases that need a judge or a native id are skipped for Claude, with the reason.
  - Files: `packages/core/test/conformance/*`, `conformance-claude-code.test.ts`.
  - Check: core tests.
- `g6` (the recordings as fixtures), dependsOn none.
  - Copies the captures into `packages/core/test/fixtures/recordings/{codex/0.159.3,copilot/1.0.65,copilot/1.0.90,gemini/0.62.0,opencode/1.18.34}/`.
    Paths are scrubbed to `<home>`, the account name and email are removed, and the accidental
    Copilot turn keeps its event shapes with the text replaced. Also copied: the Codex
    `generate-ts` subset the driver uses, OpenCode's `schema.sql` and migration ids, and a
    `README.md` stating version, date, command and sandbox for each.
  - Files: `packages/core/test/fixtures/recordings/**` only.
  - Check: a test that fails if any fixture contains an email address, a `/home/` path or a string
    shaped like a token (`gh[opsu]_`, `sk-`, `eyJ`).

When G is merged into the branch, D starts.

#### D · `providers3-drivers`, dependsOn G

- `c1` (fake Codex), dependsOn g6.
  - Files: `packages/core/test/fixtures/fake-codex-app-server.mjs`, its scripts.
  - Check: `node --test` on its own self-test (answers each recorded request with the recorded
    reply shape).
- `c2` (Codex driver), dependsOn c1.
  - Files: `packages/core/src/providers/codex/**` (manifest included), `providers/registry.ts`
    (one line in the transport map), `packages/core/test/conformance-codex.test.ts`,
    `packages/core/test/codex-*.test.ts`.
  - Checks: `pnpm typecheck`; core tests, the Codex conformance file with every declared case
    passing.
- `a1` (fake ACP agent), dependsOn g6.
  - Files: `packages/core/test/fixtures/fake-acp-agent.mjs`, profiles.
  - Check: its self-test, one per profile.
- `a2` (ACP driver), dependsOn a1.
  - Files: `packages/core/src/providers/acp/**`, the `copilot`, `gemini` and `opencode` manifests
    (capabilities, ranges, `launch`), `providers/registry.ts` (one line),
    `conformance-{copilot,gemini,opencode}.test.ts`, `acp-*.test.ts`.
  - Checks: `pnpm typecheck`; core tests.
- `o1` (OpenCode store), dependsOn g4.
  - Files: `packages/core/src/providers/opencode/transcripts.ts`, `opencode-db.ts`,
    `opencode-writer.mjs`, `opencode-transcripts.test.ts` (read, busy retry against the writer, the
    schema pin, a newer migration, the allowed-tables check, and that the file's bytes and the
    `-wal` size do not change across reads).
  - Check: core tests.
- `t1` (transcript routing), dependsOn c2, a2, o1, g3.
  - `ChatService` resolves a chat's store by provider. The Codex store goes into `codex/transcripts.ts`
    (written here so `c2` stays the live path). `chat_entries` is written for non-Claude chats and
    read as their store. `index.ts` wiring.
  - Files: `chat-service.ts`, `providers/codex/transcripts.ts`, `packages/core/src/index.ts`
    (wiring only), `chat-service` tests, API chats tests.
  - Checks: core and API tests.
- `x1` (detection, API, e2e fakes, docs), dependsOn c2, a2.
  - The detector runs the Codex handshake per version and the ACP `initialize` (spends nothing),
    and fills `confirmed` and `permissionModes`. `provider-catalogs.json`. The fake protocols for
    e2e. README rows. `docs/providers.md` (driver status, the judge, the transcript stores, how to
    add an ACP agent).
  - Files: `providers/detector.ts`, `provider-detector.test.ts`, `e2e/fake-providers/**`,
    `e2e/run.mjs` (seeding only), `README.md`, `docs/providers.md`.
  - Checks: core and API tests; `node --test e2e/fake-cli/claude.test.mjs` and the fake providers'
    self-test.
- `r1` (recordings with an account; the owner, not a worker), dependsOn none, any time before the
  final e2e.
  - Every row of "To record with an account", run on the owner's machine with a scratch repository,
    added to the fixtures with the same scrubbing. Each recording that contradicts a safe default
    becomes a correction in this plan, as code hosts did.

#### W · `providers3-web`, dependsOn P0 (validated), D

P0 was validated on 2026-10-01 (by delegation) with one correction for W: the prototypes show raw
protocol names, a Codex tool chip reading `COMMANDEXECUTION` and the permission mode `ACCEPTEDITS`.
The UI names tool kinds and modes in the person's words, through i18n (a command, a file change;
"Accept edits"), never the wire's identifiers.

- `u1` (chat-ui), dependsOn none within W.
  - `agentNameFor`, the `{{agent}}` keys of `chat.json` and `primitives.json`, `ProviderBadge` in
    `ChatBadges.tsx`, the boundaries test kept green.
  - Files: `packages/chat-ui/src/**`, `packages/ui/src/locales/**`, `packages/ui/src/components/**`
    (the badge's primitive only).
  - Checks: chat-ui and ui tests; the tokens test.
- `u2` (pages), dependsOn u1.
  - `ChatView.tsx` (header chip, details), `Chats.tsx`, `NewChat.tsx` (picker, models and modes by
    provider, capability gating), `lib/chat-ui.tsx` (injects `agentNameFor` from `/providers`),
    `chats.json` and `components.json` in both locales, and `e2e/specs/providers-chat.spec.mjs`.
  - Checks: web tests; the tokens test; the night-shift checklist.
- `u3` (copy review elsewhere), dependsOn u1.
  - The remaining rows of the copy table, the glossary entry, and the web test that guards
    chat-scoped keys.
  - Files: `apps/web/src/i18n/locales/{en,es}/{changes,observe,schedules,home,usage,workItem,suggestion}.json`,
    `apps/web/src/i18n/GLOSSARY.md`, `apps/web/test/agent-copy.test.ts`, and the components that
    pass `agent` to those keys (`apps/web/src/pages/ChangesReview.tsx`, …, listed by the task
    before it starts, none of them owned by `u2`).
  - Checks: web tests.

When W is merged into the branch: the full `pnpm typecheck`, `pnpm test`, `pnpm build` and
`pnpm e2e`, the plan's "Outcome of phase 3", `docs/status.md`, then one pull request to `main`.

**Who owns what, so parallel workers do not collide:**

| File or area | Owner |
|---|---|
| `packages/shared/src/types.ts`, schemas | `g1` only (later tasks add nothing; a missing type is a `g1` follow-up) |
| `chats.ts`, `live-chat.ts`, `chat-records.ts`, `processes.ts` | `g2` only |
| `db.ts` | `g3` only |
| `providers/registry.ts` | `g2`; then one line each from `c2` and `a2`, at the end of the transport map (a trivial merge) |
| `providers/codex/**` | `c2`, then `t1` (`transcripts.ts` only) |
| `providers/acp/**`, the three ACP manifests | `a2` |
| `chat-service.ts`, `index.ts` | `t1` |
| `detector.ts`, `README.md`, `docs/providers.md`, `e2e/fake-providers/**` | `x1` |
| `packages/chat-ui/**`, `packages/ui/**` | `u1` |
| `apps/web/src/pages/{ChatView,Chats,NewChat}.tsx`, `chats.json`, `components.json`, `e2e/specs/providers-chat.spec.mjs` | `u2` |
| the other locale files, `GLOSSARY.md` | `u3` |

Regenerated OpenAPI schemas are never merged by hand: on a conflict, take either side and run
`pnpm --filter @agentry/api openapi:schemas` again.

### Risks

| Risk | Where | What holds it |
|---|---|---|
| `git push` reaches a remote from a non-Claude stage | `c2`, `a2` | Two independent layers per provider (native setting or rule, plus the judge); conformance cases 11 and 16; Copilot and Gemini flow stages stay off until `r1` confirms their native rule under ACP |
| Codex `workspace-write` lets a `git push` to a local path succeed (no network needed) | `c2` | Documented; Agentry's worktrees push to the real `origin`; the judge sees escalations only. Accepted for phase 3 and listed in `docs/providers.md` |
| A CLI updates itself mid-run (recorded for Copilot) and leaves the tested range | `x1`, manifests | `COPILOT_AUTO_UPDATE=false` + `--no-auto-update`; OpenCode `autoupdate: false`; the handshake re-reads the version after a binary change |
| Codex's protocol moves fast (0.159 → 0.161 alpha the same day) and `app-server` is `[experimental]` | `c2` | Types generated per recorded version; range `<0.160.0`; above it is `degraded`, not broken; a schema diff test per new recording |
| The ACP capability set changes between patch releases (Copilot 1.0.65 → 1.0.90 recorded) | `a2` | `confirm` from `initialize` on every process; the manifest's set is the ceiling, the handshake the truth |
| Reading OpenCode's database disturbs OpenCode (locks, WAL growth) | `o1` | Read-only + `query_only`, one short read per call, no pooling, no checkpoint; a test that the database file and the `-wal` are byte-identical after reads |
| A secret leaks from OpenCode's database or a recording | `o1`, `g6` | The allowed-tables test; the fixture scrubbing test |
| Copilot finds credentials outside `COPILOT_HOME` (recorded) | detector | No readiness claim from the config home; `no-probe` until a session answers |
| A native id rebinding silently to another conversation | `g2` | A different native id from a later process fails the execution; conformance case 3 |
| Parallel edits to `types.ts`, `registry.ts` and the schemas collide | G, D | Additive types first (`g1`); the ownership table; schemas regenerated at integration |
| Free hosted models (OpenCode Zen) send a person's code to a vendor without any sign-in | product | Decision P3-4 |

### Decisions for phase 3 (settled 2026-10-01)

The owner delegated these four to the assistant ("take the freedom to do everything until the flow
is complete"); each was settled on its recommendation. The options are kept for the record.

1. **P3-1. Permission modes on providers other than Claude.**
   - **Recommended:** keep `PermissionMode` as Agentry's vocabulary, each driver declaring the modes
     it honours and their native value (the table in "Permission modes"); the picker offers only
     those.
   - A new neutral list (`ask`, `edits`, `plan`, `auto`, `all`) mapped to every provider, Claude
     included, with a migration of stored modes.
   - Each provider's own modes, shown with the provider's names (Copilot's Agent / Plan / Autopilot,
     Gemini's `auto_edit`, …).
2. **P3-2. Transcripts for Copilot and Gemini chats.**
   - **Recommended:** Agentry records what it streamed, as rows (`chat_entries`), and that is their
     transcript. Sessions started in a terminal are not listed in phase 3.
   - ACP `session/load` replay: a short-lived reader process loads a session and Agentry keeps the
     replayed updates. It lists terminal sessions too (`session/list`, Copilot and OpenCode), but
     starts the agent, and its MCP servers, to read history.
   - Per-agent file readers (Copilot's `session-state/<id>/events.jsonl`, Gemini's chat files), as
     OpenCode's database is read: no process, but two more internal formats to pin and record.
3. **P3-3. Where Codex's history is read from.**
   - **Recommended:** the `app-server` API (`thread/list`, `thread/turns/list`,
     `thread/items/list`), from an on-demand reader process: the vendor's versioned, schema-generated
     surface.
   - The rollout JSONL files under `CODEX_HOME/sessions/`: no process, but an internal format
     (`response_item`, `event_msg`, `world_state`) that changes without notice.
   - Agentry's own `chat_entries`, as for Copilot and Gemini: simplest, but Codex sessions run in a
     terminal are not listed.
4. **P3-4. OpenCode without credentials.** OpenCode opens sessions on free hosted models ("OpenCode
   Zen") with no sign-in (recorded).
   - **Recommended:** OpenCode is `ready` only with credentials (`auth.json` with a key, as phase 1
     probes). With none it is `signed-out`, and a person can opt in, in Settings → Providers, to
     "use OpenCode's free models", with a line saying where the code goes.
   - `ready` without credentials, using the free models by default.
   - Free models never used: Agentry always passes a model from a signed-in provider, and OpenCode
     without credentials is `signed-out` with no opt-in.

## Outcome of phase 3

Built on `feat/multi-provider-3` on 2026-10-01, in four orchestrations launched on the owner's
desktop app, every code-writing worker on `claude-sonnet-5-5`:

| Orchestration | Tasks | Cost | Result |
|---|---|---|---|
| P0 `providers3-prototypes` | p1, p2 | 4.15 USD | Validated; its check passed |
| G `providers3-groundwork` | g1–g6 | 4.70 USD | Passed after the fixer ran |
| D `providers3-drivers` | c1, c2, a1, a2, o1, t1, x1 | 18.43 USD | Passed after the fixer ran |
| W `providers3-web` | u1–u3 | 10.80 USD | Every check passed; its e2e spec had never run |

Running the chat spec (`providers-chat`) and the providers spec, which no worker ran, found real
bugs, all fixed on the branch:

1. **A Codex chat on the fakes never started.** The fake app-server wrote its thread file into a
   `CODEX_HOME` the sandbox only named. A real Codex makes its home as it needs it, so the fake now
   does too.
2. **Core ignored the binary override.** Drivers were built with the manifest's command, so a path
   set in Settings → Providers applied to detection but not to a chat. Core now hands each driver a
   binary read as a process starts, and the Codex transcript reader gets the same one.
3. **The composer's status line showed a wire identifier** (`acceptEdits`) on a Codex chat. It now
   goes through `modeLabel`, as the permission prompts already did.
4. **Copilot was never offered in New chat.** It has no probe that costs nothing, so detection says
   `unknown` with `no-probe` and never `ready`, and the picker only listed `ready` and `degraded`.
   A provider that reads `no-probe` is now offered; its first session says whether it is signed in.
5. **The Stop button of a phone's chat header had no name** (axe `button-name`): compact mode drew
   the icon alone. It has an `aria-label` now, and the `is-icon` class its CSS already expected.
6. **A migration was placed before released ones.** After merging `main`, `chat_entries` sat before
   the code hosts' and the checks' migrations, which 0.30.0 had already shipped: a database that had
   run them counts them as applied, so it would have skipped this one and run the last again. It is
   appended last, and a comment above it says why.

The providers spec still named Codex `0.50.0`, below the manifest's `>=0.159.3 <0.160.0`, so it now
uses the recorded `0.159.3`. Three API tests assumed Codex had no session driver; they use an id
that has none.

**Recordings that need an account** (`r1`: Codex, Gemini and OpenCode signed in) are the owner's to
make. The drivers are written from the recordings that needed none and from each CLI's own
documentation, and their conformance runs against the fakes.

## Phase 4: rotation between providers

Phase 4 is one delivery on one feature branch, **`feat/multi-provider-4`**, cut from `main` after
phase 3 (#167), and squash-merged once. It builds what "Rotation moves to providers" (owner,
2026-09-30, decisions 6 to 9) asks for. When a provider reaches its usage limit, the work goes on in
another provider, waits for the reset, or starts over. The person's settings decide which, and so
do three decision points when they are on. claude-swap is retired in the same pull request, so there
is never a release with neither kind of rotation.

It is split into four orchestrations (P0, G, D, W). Every code-writing worker runs on
`claude-sonnet-5-5` (the exact id, never the `sonnet` alias). Every task runs `pnpm typecheck` and
the tests of the packages it touches. No worker runs `pnpm e2e`. The full `pnpm test`, `pnpm build`
and `pnpm e2e` run once, at the end, on the branch.

### What phase 4 builds

- **A limit per provider**, not one for the whole app. Each driver's limit events become one neutral
  `ProviderLimit` per provider (`ok`, `near`, `exhausted`, `unknown`, with the binding window and its
  reset). It is kept as a SQLite row that every process on the data directory shares, and shown in
  Settings → Providers, in the status bar and in readiness (`degraded`, `limit-reached`).
- **Candidates.** One pure function says which providers can take a given run, and why each of the
  others cannot. It reads the person's order (global, or the project's), readiness, capabilities, the
  run's `ToolPolicy` (with `git push` denied), the model mapping and the limits. Starting work and
  moving work use the same function.
- **Three actions at a limit:**
  - **handoff:** a new chat on the next candidate, in the same worktree, whose first turn is a
    handoff built from the transcript;
  - **restart:** a new chat on the next candidate, in the same worktree, with the original prompt;
  - **wait:** the same chat replays its turn on the same provider once the limit resets.
  Each move is recorded as a row, and every chat in the chain links to the others.
- **Automated work carries a provider.** Flow runs, orchestration tasks, assistant runs and the
  decision engine's `cli` chats choose a provider from the candidates. They hand that provider their
  `ToolPolicy`, not Claude's rule strings. This closes a gap phase 3 left (see the facts below).
- **The decision points** `provider.on-limit`, `provider.pick` and `provider.model-map`, each
  shipping `off`, with consent, a state preview and a resolver, like every other point.
- **claude-swap retired:** core, API, web, Docker, Helm, the desktop app and the docs. A one-time
  notice tells existing multi-account users what changed and what was kept.

### Out of scope

- **Several accounts of one provider.** Decision 6: one account per provider, the one signed in to
  its CLI. Nothing switches credentials, and nothing reads another vendor's credential files.
- **Moving a live session.** A session belongs to its provider: Claude's JSONL cannot be resumed by
  Codex, and the reverse is just as impossible. A move always means a new chat (decision P4-1).
- **Summarising with a model.** The handoff is built by code from what Agentry already has. A
  summary written by an agent would spend on a provider while the work is short of quota, and would
  be one more thing to trust.
- **Budgets on providers that report no cost.** A run under a budget (`flow.maxCostUsd`, a task's
  `maxCostUsd`) moves only to a provider that declares `budgetLimit`, which is only Claude Code today.
- **Workflow-tool orchestrations** (`engine: 'workflow'`) and anything else that needs `workflowTool`
  stay on Claude. At a limit they can only wait.
- **ACP limit detection** beyond what is recorded. Until `r2` records how Copilot, Gemini and OpenCode
  report an exhausted quota, an ACP failure is an ordinary failure. Work can move to these agents,
  never away from them.
- **Dropping the old tables** (`rotation_events`, `usage_history`). Phase 4 stops writing them. A
  migration in a later release drops them, once no older process on the same data directory can
  still be writing.

### Facts the design rests on (checked in the code, 2026-10-01, `main` at `7c7b6e03`)

| Fact | Where |
|---|---|
| A rate limit reaches core as `DriverEvent` `rate-limit` (windows) or `rate-limited` (the wording), and as `result.rateLimited` | `providers/driver.ts:271-290` |
| Claude Code: `rate_limit_event` gives `status`, `rateLimitType`, `resetsAt` (unix seconds) and `unifiedWindows`. A result is rate-limited on `api_error_status === 429` or on `RATE_LIMIT_RE` matching its text. A stderr line that matches `RATE_LIMIT_RE` emits `rate-limited` | `providers/claude-code/stream.ts:9, 87, 186-199, 217` |
| Codex: `account/rateLimits/updated` becomes `rate-limit` (primary and secondary windows, `usedPercent`, `windowDurationMins`, `resetsAt`). A turn is rate-limited only when `codexErrorInfo` is `usageLimitExceeded` or `rateLimitExceeded`, never by its text. Status is `rejected` at 100 % and `allowed_warning` from 80 % | `providers/codex/events.ts:8, 20-40, 105-106, 225` |
| ACP (Copilot, Gemini, OpenCode): **no limit signal at all**. Every result sets `rateLimited: false`. `usage_update` is the context window, not quota | `providers/acp/session.ts:404-428`, `acp/updates.ts:111` |
| Declared `rateLimitWindows`: Claude Code and Codex only. `multiAccount`: Claude Code only (claude-swap) | `claude-code/manifest.ts:49-50`, `codex/manifest.ts:40` |
| The last rate limit is **one value for the whole app**, overwritten by whichever chat reported last, and served as `Overview.rateLimit` | `chats.ts:94, 168-170`, `index.ts:2233`, `types.ts:4195` |
| Rotation today: `rate-limited` → `rotateAndResume`, only with claude-swap managed and `rotateOnLimit` on. It rotates the account (pinned, by policy, or global), then `replayLastTurn` respawns the same chat with `--resume`. Orchestration workers and runs held to a schema are not replayed ("the next tasks use it") | `index.ts:871-938`, `chats.ts:1058-1114` |
| One rotation per execution (`MAX_ROTATION_RETRIES = 1`) | `chats.ts:76` |
| The flow waits for that rotation in memory (`awaitingRotation`) and fails the run with `no-account`, or `rate-limit` when the rotation was off | `flow.ts:240-244, 757-760, 1472-1521, 2067-2079` |
| An orchestration task whose result has a `cause` (`rate-limit` included) is never retried and never asked about. Today it fails | `orchestrator.ts:1129-1145, 1201-1210` |
| **Automated work names no provider.** Flow runs, orchestration tasks, assistant runs and the decision engine's `cli` chats start on `defaultSessionProvider`, which looks at the order and at whether a driver exists, **not at readiness**. They pass Claude's rule strings (`rulesFor('claude-code', …)`) and no `policy`, so on a non-Claude default the judge has no policy to enforce | `index.ts:1749-1758`, `flow.ts:1380-1381`, `orchestrator.ts:1429, 1858, 1902, 1993, 2403`, `assistant.ts:230`, `decisions/providers/cli.ts:108-122`, `chats.ts:196-202`, `providers/registry.ts:123-127`, `chats.ts:902` |
| A flow run passes the member's Claude agent file (`--agents` file from `.claude/agents/<agent>.md`: description, prompt, model, tools) | `index.ts:1759, 1795-1820` |
| `appendSystemPrompt` reaches Codex as `developerInstructions`. **ACP drivers drop it** | `codex/session.ts:127`; no reference in `providers/acp/` |
| A chat has one provider (`chats.provider` column) and one native session id. A fork records `derivedFrom: { chatId, at }` | `db.ts:543-545`, `types.ts:618-622, 758-768` |
| What a request asks for is gated by capability (`structuredOutput`, `budgetLimit`, `interactivePermissions`, `fork`, `multiAccount`…), with a 400 | `chat-service.ts:543-562` |
| `ModelTier` (`fast`, `balanced`, `strong`) is already declared "what model mapping across providers builds on". Claude ranks its aliases. **Codex ranks none** | `types.ts:105-110`, `claude-code/models.ts:29`, `codex/models.ts:7` |
| Codex can read its limits without spending: `account/rateLimits/read` (in the generated schema; signed out it answers "codex account authentication required"). The handshake calls only `initialize`, `account/read` and `model/list` today | phase 3 "Recorded facts", `codex/handshake.ts:27, 64-65` |
| The `cli` decision provider answers `rate-limited` at once, with no rotation and no resume | `decisions/providers/cli.ts:137-138` |
| docs/decision-engine.md lists "account rotation" as plain arithmetic the engine does not decide | `docs/decision-engine.md`, "Not decided by the engine" |
| claude-swap owns the credential while it manages accounts: `CredentialStore.suspend` clears `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`. `tokenSource` reads `cswap` | `credentials.ts:42-55`, `index.ts:882-887, 1017-1018` |
| A chat pinned to an account runs `cswap run <n> --share-history -- claude …`. An account may have its own `CLAUDE_CONFIG_DIR`, with `projects/` linked back so transcripts stay readable | `providers/claude-code/args.ts:65-76`, `account-config.ts:14-25`, `accounts.ts:462-474` |
| claude-swap state: `accounts.json` (auto-switch) and `account-config.json` (config dirs, rotation policies) in the data directory; the managed binary in `data/tools`; the tables `rotation_events` and `usage_history` | `accounts.ts:197`, `account-config.ts:97`, `cswap-install.ts:48`, `db.ts:55-65, 146-155` |
| Fakes: the core Claude fake has `FAKE-LIMIT-ONCE` (a 429, then the replay succeeds). The Codex fake has `RATE`. The ACP fake has none. The e2e Claude fake has no limit script. e2e runs with `CSWAP_BIN` pointing at nothing | `test/fixtures/fake-claude.mjs:14`, `fake-codex-app-server.mjs:18, 312`, `fake-acp-agent.mjs:31`, `e2e/run.mjs:183, 196` |
| Docker installs claude-swap and declares its volume. Compose and Helm mount it | `docker/Dockerfile:62-80, 104`, `docker-compose.yml:18, 28, 64`, `deploy/helm/agentry/templates/deployment.yaml:108` |

Two of these facts change the shape of the plan:

- **Automated work must name its provider and carry its policy** before anything can move it. If
  it does not, a move to Codex would hand Codex Claude's rule strings and no `git push` guard.
- **Claude's limit is only known while it runs.** claude-swap polled each account's usage, and that
  goes. Between turns, Agentry knows the last `rate_limit_event` it saw, and nothing newer. The UI
  says how old the reading is.

### How a limit is detected, per provider

A new module, `packages/core/src/providers/limits.ts` (`ProviderLimits`), folds what the drivers
already emit into one `ProviderLimit` per provider. It replaces `ChatManager.lastRateLimit`.

```ts
export type ProviderLimitState = 'ok' | 'near' | 'exhausted' | 'unknown';

export interface ProviderLimit {
  provider: ProviderId;
  state: ProviderLimitState;
  /** The window that binds (`5h`, `7d`, `primary`), when the provider names windows */
  window: string | null;
  /** Use of that window, 0..1; null when the provider reports none */
  utilization: number | null;
  /** ISO time the binding window resets; null when unknown */
  resetsAt: string | null;
  windows: Record<string, RateLimitWindow>;
  /** When the reading was taken: the UI says how old it is */
  observedAt: string;
  /** `stream`: a live run reported it; `probe`: a read that spends nothing; `failure`: a turn died on it */
  source: 'stream' | 'probe' | 'failure';
}
```

| Provider | Signal | Becomes | Reset known? | Read without spending |
|---|---|---|---|---|
| Claude Code | `rate_limit_event` | `ok` / `near` (`allowed_warning`, or the binding window ≥ 60 %) / `exhausted` (`rejected`) | Yes (`resetsAt`) | No. The last reading stands, with its age |
| Claude Code | result 429, or `RATE_LIMIT_RE` on the result or on stderr | `exhausted` (`source: failure`) | From the last `rate_limit_event` of that process, else unknown | — |
| Codex | `account/rateLimits/updated` | as `rateLimitInfo()` already maps it | Yes (`resetsAt` per window) | **Yes:** `account/rateLimits/read` in the detector's handshake when signed in, and every `PROVIDERS_TTL_MS` while the provider is `near` or `exhausted` |
| Codex | `turn/completed` failed with `usageLimitExceeded` / `rateLimitExceeded` | `exhausted` (`source: failure`) | From the last snapshot | — |
| Copilot, Gemini, OpenCode | none recorded | `unknown`, always | No | No |

- **Thresholds** follow the design system's usage bars: `near` from 60 % of the binding window,
  `exhausted` at 100 % or on `rejected`. The bars are neutral below 60 %, `warn` from 60 % and `bad`
  from 75 % or when exhausted.
- **An exhausted provider recovers on its own** when `resetsAt` passes: the reading becomes `unknown`
  (never `ok` without a new reading), and candidates may use it again.
- **`ProviderLimits.observe(provider, event)`** is called from `chat-fold.ts` where `noteRateLimit`
  is today, with the chat's provider. It writes the row (see "Persistence") only when the state or
  the binding window changes, or every 60 s at most, so a stream of events does not become a stream
  of writes.
- **Readiness:** the detector reads the row. `exhausted` makes the provider `degraded` with the new
  reason `limit-reached`; `near` gives `degraded` with `limit-near`. `ProviderStatus.limit` carries
  the reading.
- **What only an account can record (`r2`, the owner, any time before the final e2e):** Codex's
  signed-in `account/rateLimits/read` reply; a real `usageLimitExceeded` turn; and, for each ACP
  agent, what an exhausted quota looks like (error code, `data`, `stopReason`). Each recording that
  shows a stable code adds a `limitErrors` matcher to that agent's `AcpProfile`. It matches codes and
  fields, never message text. Until then ACP is `unknown`.

### Which providers can take a run: the candidates

`packages/core/src/providers/candidates.ts` is pure. `candidatesFor(run, context)` returns the
providers in order, each with the model it would use, plus the excluded ones with a reason the UI
shows ("Gemini: no structured output"):

```ts
export interface RunNeeds {
  kind: 'chat' | 'flow-run' | 'task' | 'assistant' | 'decision';
  projectId: string | null;
  /** The provider and model the work is on now; null when it has not started */
  from: { provider: ProviderId; model: string | null } | null;
  /** The model the work asks for, and the provider whose catalog it comes from */
  model: { provider: ProviderId; id: string } | null;
  needs: ProviderCapability[];        // structuredOutput for a schema, budgetLimit for a budget, …
  policy: ToolPolicy | null;          // null only for a person's chat with custom native rules
  nativeRules: boolean;               // the chat runs on rules typed for one provider
  automated: boolean;                 // Agentry started it: gitPush must be denied and enforced
  exclude: ProviderId[];              // providers this run already left in its chain, until their reset
}

export type Exclusion = 'disabled' | 'not-ready' | 'no-driver' | 'capability' | 'policy' | 'policy-not-portable'
  | 'no-mapping' | 'exhausted' | 'left-already' | 'not-in-order';
```

The filters, in order:

1. **Order.** The project's `providers.order` when it sets one, else the global order of
   `providers.json`. Only enabled providers count. A provider outside the order is never a candidate
   (decision 8).
2. **Readiness.** `ready`, or `degraded` for any reason except `limit-reached`. `unknown` with
   `no-probe` (Copilot) is a candidate only for a person's chat, as New chat already offers it
   (phase 3 outcome 4). Automated work needs a provider that has proved it is signed in.
3. **A session driver** that declares (and, where confirmed, has confirmed) every capability in
   `needs`. Schema → `structuredOutput`. Budget → `budgetLimit`. Host prompts →
   `interactivePermissions`. Workflow engine → `workflowTool`. A flow member's agent file does
   **not** need `subagents`: it is inlined (see "What moves").
4. **Policy.** The candidate's translation enforces every part the policy sets: nothing the run
   needs is in `unsupported`. For automated work, `gitPush: 'deny'` must sit in `rules` or
   `settings`, and in `host` too where the driver has a judge (phase 3, conformance cases 11 and 16).
   Copilot and Gemini flow stages stay off until `r1` confirms their native rule, as phase 3 decided.
   A chat on custom native rules with no policy cannot be translated: `policy-not-portable`.
5. **Model.** The model must be the candidate's own (its catalog lists it), or have a mapping from
   its provider to the candidate. With no mapping: `no-mapping` (decision 7: such a run waits, and
   says why). The target model's effort carries over when the candidate declares `effort` and lists
   that level; otherwise the candidate's default effort is used.
6. **Limit.** Not `exhausted` with a reset still ahead.
7. **Chain.** Not a provider this run already left, until that provider's reset has passed, and at
   most `rotation.onLimit.maxMoves` moves per run (default 2). This stops a run bouncing between two
   providers that are both at their limit.

**Starting automated work** uses the same function with `from: null`. The first candidate is what
the setting picks, and `provider.pick` may choose another one (see the points). This also fixes the
fact above: a flow run on a person whose default provider is Codex now starts on the first provider
that can enforce its stage. Every automated launch passes `provider` and `policy`. The rule strings
are derived from that provider's translation (`registry.translationFor`), never from
`rulesFor('claude-code', …)`.

### What happens at a limit

`packages/core/src/rotation.ts` (`ProviderRotation`) replaces `rotateAndResume`.
`ChatManager.maybeRotate` becomes `maybeLimit`, which emits `limit-hit` (chat, provider, the reading)
once per execution, under the same conditions as today: rate-limited, a last user turn, and not
already asked for this attempt.

1. **Record.** `ProviderLimits` marks the provider. `run.rateLimited` is emitted with `provider` and
   `resetsAt`.
2. **Who decides.**
   - A **person's chat** (origin `agentry`, not internal, no schema): nothing happens on its own
     (decision P4-2). The chat gets a limit banner (see "What the person sees"). Its actions are the
     feasible ones, and the setting's action is shown first.
   - **Automated work** (flow run, orchestration task, assistant run, a schedule's chat): the
     effective `onLimit` setting (the project's, else the global one), then `provider.on-limit` when
     it is on (below). The decision engine's own `cli` chats never move: they answer `rate-limited`,
     as today.
3. **Feasible actions.** `handoff` and `restart` need at least one candidate. `wait` is always
   feasible: it is the floor. An action the person did not allow is never taken, unless it is `wait`
   standing in for an infeasible one. A run whose model has no mapping waits, and the notice says so
   and links to the mapping editor on that pair.
4. **Act.**
   - **handoff / restart:**
     1. The chat is stopped if its process is still up, as `replayLastTurn` does today.
     2. A move row is inserted (`state: 'moved'`).
     3. `ChatService.continueOn(chatId, { provider, model, action })` creates the new chat: same
        `cwd` and worktree; mapped model; the same permission mode when the target offers it, else
        `manual`; the run's policy; the same MCP selection where the target declares `mcp`; the same
        `jsonSchema`; the remaining budget. Its first turn is the handoff, or the original prompt.
     4. Both chats get the link. The run, task or item is re-pointed (below). `run.providerMoved` is
        emitted.
   - **wait:**
     1. A move row is inserted with `state: 'waiting'` and `resets_at`. With an unknown reset, the
        wait lasts up to `maxWaitHours` (default 6).
     2. A timer in the process that owns the chat claims the row at the reset (guarded update, below)
        and replays the last turn on the same chat and provider, as `replayLastTurn` does.
     3. When the cap passes without a known reset, the row ends `failed`. The run fails with
        `limit-wait-expired`.
     `run.limitWaiting` is emitted when the wait starts.
5. **Restart of Agentry.** `rotation.recover()` re-arms the timers of the `waiting` rows whose chat
   this process restored. A claim whose `claimed_until` has passed may be taken again.

**Per kind of work:**

| Work | On a move | While waiting | Safety limits kept |
|---|---|---|---|
| A person's chat | Only by the person's click (P4-2). The old chat ends with a link to the new one | The banner shows the reset and a Cancel | — |
| Flow run | `flow_runs.chat_id` and `provider` are re-pointed by `UPDATE … WHERE id = ? AND chat_id = ?` (the old chat). The item gets the new chat as a link with the same role. A Developer's later run continues the newest chat of the chain | The run stays `running` and **keeps its slot** (`maxParallel` counts paid work in flight, waits included) | Bounces unchanged (a move is not a bounce). Budget: the continuation gets `maxCostUsd − spent so far` and needs `budgetLimit`. `git push` denied. Only a person moves to Done |
| Orchestration task | `task.runId` and `task.provider` move to the new chat; `task.chain` gets an entry. Not an attempt | `task.waiting` is set; the task stays `running` and keeps its place in `maxParallel` | `maxAttempts`, task limits (time and cost count across the chain) |
| Assistant run | As a flow run: a new chat with the same schema, on a `structuredOutput` candidate | As a flow run | Its proposals still need a person |
| Decision `cli` chat | Never moves. If its provider is at its limit, the engine's `cli` provider chooses the first candidate with `structuredOutput` and a mapping for its model (decision 9); otherwise `unavailable` (`rate-limited`), and today's behaviour decides | — | Its budget cap |

### The handoff

`packages/core/src/handoff.ts` is pure. `buildHandoff(input): { text, bytes, sections }` is built by
code, never by a model. It is English, like every prompt (the English records rule), and cut to
12 KiB:

1. **What was asked:** the chat's first prompt, and for a flow run or a task, the stage's or the
   task's own prompt as Agentry sent it.
2. **What was done:** the edit steps (`editStepsFromEntries`: each changed file with the sentence the
   agent wrote before changing it); the commands run, with their exit code (the last 20); and the
   checklist (the agent's task list or plan entries) with its state.
3. **Where it stands:** `git status --porcelain` and `git diff --stat` of the worktree, as the
   changes review reads them; and the agent's last message.
4. **What is left:** the open checklist items. For a flow run, the acceptance criteria not yet met;
   for a task, the open items the orchestrator already computes (`openItems`).
5. **The rules of this run:** the stage's or the task's closing instructions. For a flow member whose
   agent file cannot be passed as `--agent` (any provider but Claude), the file's prompt. It goes
   into `appendSystemPrompt` on a provider that takes one (Codex: `developerInstructions`), and at the
   head of the first turn on ACP, which drops `appendSystemPrompt`.

Everything that came from the transcript, git or a tool goes inside one `pasted()` block followed by
`PASTED_NOTE` (`prompt-rules.ts`). The new agent reads it as data, never as instructions.
`prompt-rules.test.ts` covers the module. The handoff never includes tool outputs longer than 2 KiB
each, file contents, environment variables or anything `decisions/redact.ts` masks.

### What moves, and what cannot

| | Moves | Does not move |
|---|---|---|
| Session and context | — | The provider's session, its compacted context and its native id. The new agent knows only the handoff |
| Transcript | Linked: the new chat's details show the old one, and the old one ends with a link to the new one | The old transcript stays with the old chat, in its provider's store |
| Worktree and files | The same `cwd` and worktree, uncommitted changes included (owner decision 7) | — |
| Model | Through the mapping only | A model with no mapping: the run waits |
| Effort | When the target declares `effort` and lists the level | Otherwise the target's default |
| Permission mode | The same mode when the target lists it in `permissionModes()`, else `manual` | Never a more permissive mode. "Allow always" grants given during the old session |
| Tools | The run's `ToolPolicy`, translated by the target | Custom native rules with no policy (`policy-not-portable`) |
| MCP servers | The chat's `McpSelection`, where the target declares `mcp` | claude.ai connectors (Claude only) |
| Agents and workflows | A flow member's agent file, inlined as instructions | Running subagents, background tasks and workflow runs: they end with the old process. Workflow-engine orchestrations only wait |
| Attachments | On a restart, the original attachments when the target takes images; otherwise listed by path | — |
| Budget | What is left of it, on a `budgetLimit` provider | Spending on providers that report no cost |
| Schema | The same `jsonSchema`, on a `structuredOutput` provider | — |

### What the person sees

- **Chat at a limit** (P0 `p2`):
  - A `warn` banner above the composer: "Claude Code reached its 5-hour limit · resets at 14:05
    (in 2 h 10 min)". When the reset is unknown, it says so, with the age of the last reading.
  - The actions are the feasible ones: **Continue on Codex** (handoff), **Start over on Codex**
    (restart), **Wait for the reset**. The one primary action of the zone is the setting's.
  - **See the handoff** opens a `Sheet` (a dialog on desktop) with the exact text the next agent will
    receive, its size, and the model it will run on.
  - An excluded provider is listed with its reason, in the person's words, never a wire identifier.
- **A moved chat:**
  - The old chat ends with a divider: "Continued on Codex in *<title>*", linking to the new chat.
  - The new chat's header shows its `ProviderBadge` and "Continued from Claude Code".
  - Its first message is a collapsed "Handoff from Claude Code" card.
- **Waiting:**
  - The chat, the task row and the board card say "Waiting for Claude Code · resets 14:05", in
    `warn` with a word, never colour alone.
  - Actions: **Move now** (opens the same sheet) and **Stop waiting**.
  - Nothing animates while waiting: it is not live work (design system, "Only live things move").
- **Orchestration task row:** the chain as chips (Claude Code → Codex), each opening its chat; "moved
  · handoff".
- **Flow:**
  - The item's activity has "Developer run moved from Claude Code to Codex (handoff)".
  - `FailedFlowRun` words the new causes `no-provider` and `limit-wait-expired`.
- **Status bar:**
  - The phase 1 dot per provider gains the limit: `warn` near, `bad` exhausted, with the word
    ("limit") and the reset in its title.
  - The phone's More sheet card shows the default provider's limit in place of claude-swap's account.
- **Settings → Providers** (P0 `p1`):
  - each provider row gets its limit bars (the same thresholds) and the age of the reading;
  - a **When a provider reaches its limit** card: the action, the allowed actions, the wait cap and
    the moves cap;
  - the **Model mapping** editor: a row per model of each provider, a counterpart per other
    provider, a `warn` "no counterpart" mark, and suggestions from `provider.model-map` marked
    "suggested" with Accept and Dismiss.
- **Project settings → Providers:** the order override and the on-limit override, each with "Use
  global".
- **The "decided" mark** on a move or a pick made by a point in `active`, opening the answer.
- **Notifications:** `run.providerMoved` ("<run> moved to Codex", "The turn goes on there with a
  handoff") and `run.limitWaiting` ("<run> waits for Claude Code's reset at 14:05"), both of normal
  urgency. They replace `run.accountRotated` and `account.switched`.

### The three decision points

All three follow the engine's rules:

- they ship `off`, ask for consent with the exact state, and declare their state fields;
- their questions are English;
- with the point `off` or unavailable, the setting decides at once;
- an act point on the `cli` provider can never clear its threshold (null confidence), so it is
  `active` only on Jev, and `watch` (shadow) otherwise.

The person's settings bound every answer: the options are only the feasible ones the person allowed.
A point is not asked when there is only one option.

#### `provider.on-limit` (act, project)

| | |
|---|---|
| Subject | `flow_run`, `task` or `assistant_run`, with its id. Never a person's chat (P4-2) |
| When asked | Step 2 of "What happens at a limit", for automated work, when at least two actions are feasible and allowed |
| Fields | `work` (`flow-run` / `task` / `assistant`, and the stage or task name), `progress` (`checklistDone`, `checklistTotal`, `filesChanged`, `turns`, `minutes`), `from` (provider, model, `resetsInMin` or null), `candidates` (the first three: id, label, mapped model, utilization, `resetsInMin`), `allowed` |
| Question | choice `action`: "This run hit its provider's usage limit. What should happen to it?" Options, only the feasible and allowed ones: `handoff` "Continue on the next provider with a handoff: enough useful work is done for a summary to carry it"; `restart` "Restart on the next provider from the original prompt: little useful work is done, or a summary would mislead"; `wait` "Wait for this provider's reset: it is soon, or the work depends on this provider" |
| Defaults | `maxStateBytes` 4 KiB, threshold 0.85, `visible: true`, `savesRun: false` |
| What an answer does | Active and above the threshold: the action replaces the setting's. Shadow: recorded; the setting decides |
| Resolver | Reads the move row and what the work led to. Agreed when the run or task it led to ended `passed` or `completed`; not agreed when it ended `failed` or `rejected`. Not judged when a person stopped it. The detail records the cost on each provider of the chain |
| Tests | The four-mode test; the options never include a disallowed or infeasible action; `wait` stands in for an infeasible answer; one answer per limit hit |

#### `provider.pick` (act, project)

| | |
|---|---|
| Subject | `flow_run`, `task` or `assistant_run`, at start |
| When asked | Automated work is about to start and at least two candidates pass the filter. It sits beside `orchestration.model`: a planner's draft gets its models first, then each task its provider through this point and the mapping |
| Fields | `work` (kind, stage or task name, title, `sizeEstimate`), `model`, `candidates` (id, label, mapped model, utilization, `resetsInMin`, and the last 30 days of this stage or kind on that provider in this project: `passed`, `failed`) |
| Question | choice `provider`: "Which provider should run this work?" Each option is "<label>: <model>, <n> % of its limit used". The ids are the provider ids |
| Defaults | 4 KiB, 0.85, `visible: true`, `savesRun: false` |
| What an answer does | Active and above the threshold: that candidate instead of the first in order. It can never pick outside the candidates |
| Resolver | Agreed when the run ended `passed` or `completed` on the chosen provider, and not agreed when it failed. In shadow, a pick equal to the order's first is judged the same way; a different pick is not judged (no counterfactual) |
| Tests | The four-mode test; no answer outside the candidates; it is not asked with a single candidate; a flow run's policy is enforced on the pick |

#### `provider.model-map` (suggest, global)

| | |
|---|---|
| Subject | the new subject kind `model`, id `<provider>:<model>→<provider>` |
| When asked | A limit or a pick finds `no-mapping` for a pair, at most once per pair per day; and when a person presses **Suggest** on an empty cell of the mapping editor |
| Fields | `model` (provider, id, display name, tier, description), `targets` (the target catalog: id, display name, tier, description, efforts; at most 40) |
| Question | choice `counterpart`: "Which model of <target> is the closest counterpart of <model> for coding work?" Options: the target's models, plus `none` "None: no model here can stand in for it" |
| Defaults | 8 KiB, `visible: true` |
| What an answer does | Active: a "suggested" chip in the mapping editor, with Accept and Dismiss. **A suggestion is never in force until a person accepts it**; accepting writes the entry with `origin: 'decision'` |
| Resolver | Agreed when the person accepts the suggested model for that pair; not agreed when they dismiss it or map the pair to another model |
| Tests | The four-mode test; nothing enters the mapping without a person; the target list is cut at 40 |

**Catalogue and settings changes** (G `g7`):

- the three entries in `decisions/points.ts`;
- the ids in `DECISION_POINT_IDS`, and `provider.model-map` in `GLOBAL_ONLY_POINTS`;
- `DecisionPointId` and `DecisionSubjectKind` (`model`) in shared types;
- a new area `providers` in `DecisionsTab.tsx`, with its keys in `decisions.json` (`en`, `es`);
- docs/decision-engine.md: 26 points, and the "Not decided by the engine" line reworded. The
  arithmetic (headroom, resets, the filters) stays code; the engine only chooses among feasible
  options.

### Settings

`providers.json` gains a `rotation` block. It is a settings document, rewritten whole and validated
on `PUT`:

```ts
export type LimitAction = 'handoff' | 'restart' | 'wait';

export interface RotationSettings {
  onLimit: {
    /** What automated work does at a limit; a person's chat offers it first */
    action: LimitAction;
    /** What a decision point may choose among; always includes `action` */
    allowed: LimitAction[];
    /** How long a wait with no known reset lasts before the run fails, 1..48 */
    maxWaitHours: number;
    /** Moves per run before it waits, 0..5 */
    maxMoves: number;
  };
  /** Global only (decision 9); never filled without a person */
  modelMap: ModelMapEntry[];
}

export interface ModelMapEntry {
  from: { provider: ProviderId; model: string };
  to: { provider: ProviderId; model: string };
  origin: 'person' | 'decision';
  at: string;
}
```

- **Defaults:** `action: 'wait'`, `allowed: ['wait']`, `maxWaitHours: 6`, `maxMoves: 2`,
  `modelMap: []`. A fresh install never sends work, or a handoff, to a second vendor until the person
  turns it on. `wait` replaces today's failure on a limit and spends nothing more than the replayed
  turn.
- **Per project:** `ProjectSettings.providers?: { order?: ProviderId[]; onLimit?:
  Partial<RotationSettings['onLimit']> }` in the project's settings document. A missing field
  inherits.
- **Validation:** known provider ids; mapping entries between two different providers; models are
  not checked against a catalog (a catalog changes with a CLI update). An entry whose model has left
  the catalog shows a `warn` "no longer offered" mark, and the candidate filter treats it as
  missing.
- **Who may change them:** `PUT /providers/settings` and the project's settings refuse a chat's own
  token with `403`. An injected chat must not widen where work and its handoff go. Like the decision
  settings, only the owner widens it.

### Retiring claude-swap, and migrating its users

**Removed** (owner decision 6):

| Area | Files |
|---|---|
| Core | `accounts.ts`, `account-config.ts`, `cswap-install.ts`, `cswap-pin.ts`; the account parts of `chats.ts`, `live-chat.ts`, `chat-records.ts` (`account` read and ignored), `chat-fold.ts`, `providers/driver.ts` (`AccountSupport`, `SessionLaunch.account`), `providers/claude-code/args.ts` (`cswap run`), `claude-code/driver.ts`, `credentials.ts` (`suspend`), `paths.ts` (`cswapBin`, `cswapManaged`), `processes.ts` (the `cswap` comments and matching), `index.ts` (`AccountManager`, `rotateAndResume`, `syncCredentialOwner`); `multiAccount` dropped from Claude's manifest and from `ProviderCapability` |
| API | `routes/accounts.ts` and its 18 rows in `openapi/routes.ts`; `security.ts` and `security/auth.ts` references; the README's Accounts table |
| Shared | `CswapInfo`, `CswapManagedInfo`, `AccountSummary`, `AccountUsage*`, `AutoSwitch*`, `AccountsOverview`, `AccountsSnapshot`, `SwitchAccountRequest`, `AddAccountTokenRequest`, `SetAccountAliasRequest`, `RotationPolicy*`, `AccountConfig`, `UpdateAccountConfigRequest`, `UsageHistoryPoint`, `RunAccountRotatedEvent`, `AccountSwitchedEvent`, `ChatStartOptions.account`, `Execution.account`, `Overview.accounts`, `Overview.rateLimit`, `tokenSource: 'cswap'` |
| Web | `pages/Accounts.tsx`, `pages/accounts/**`, `lib/cswap.ts`, the claude-swap parts of `CliCard.tsx`, `UpdatesCard.tsx`, `AccountTab.tsx`, `SecurityTab.tsx`, `StatusBar.tsx` (`AccountCard`), `lib/usage-now.ts` and `lib/shell-live.ts` (`swapUsageWindows`), `accountsConfig.json` (both locales); `/accounts` redirects to `/settings?tab=providers` |
| Packaging | `docker/Dockerfile` (the claude-swap install and its `VOLUME`), `docker-compose.yml`, `deploy/helm/agentry/**`, `.env.example`, `.github/workflows/ci.yml`, `apps/desktop/src/*` references |
| Docs and tests | `docs/desktop.md` "Multiple accounts", `docs/deploy.md`, `docs/plans/managed-claude-swap.md` and `docs/pinned-chat-rotation.md` marked superseded (kept as history); `e2e/specs/accounts-config.spec.mjs`, `packages/core/test/{accounts,account-config,cswap-install}.test.ts`, `apps/web/test/cswap.test.ts`; the web fixtures regenerated; `DesktopCuentas.html` and `MobileCuentas.html` removed from the references |

**Migration** for someone who used claude-swap (recommended form, decision P4-4):

1. **Nothing is deleted that Agentry did not write for itself.**
   - claude-swap's data (`~/.local/share/claude-swap`, its accounts and tokens) is not touched, and
     `cswap` keeps working from a terminal.
   - `accounts.json` and `account-config.json` stay in the data directory, unread.
   - The tables `rotation_events` and `usage_history` stay, unwritten.
2. **The account in force** is the one claude-swap left active, since it swapped the shared
   `.credentials.json`. Claude Code reads it as any signed-in CLI does. With the suspension gone, a
   token saved through Settings → Account (`credentials.json`) applies again and wins, as it did
   before claude-swap. The notice says which one is in force (`tokenSource`).
3. **A one-time notice** appears when any of `accounts.json`, `account-config.json`, Agentry's
   managed copy (`data/tools`) or `CSWAP_BIN` is found at boot. It is on Home's setup rows and at the
   top of Settings → Providers until dismissed. Dismissing it is a flag in `app-settings.json`. It
   says:
   - Agentry no longer switches Claude accounts, and work now moves between providers;
   - which account Claude Code is signed in with (`claude auth status`);
   - how to change it (sign in again in Claude Code, or save a token in Settings → Account);
   - which projects had a rotation policy, now gone, with a link to their provider order;
   - that claude-swap and its accounts are untouched.
   Its one action is **Remove Agentry's copy of claude-swap**, offered only when the managed copy
   exists. It deletes `data/tools/**` and nothing else.
4. **Pinned chats** lose the pin; their next execution runs on the account in force. Old executions
   keep `account` in their stored JSON, which the type no longer reads.
5. **Per-account `CLAUDE_CONFIG_DIR`s** are no longer passed. Their `projects/` was always linked
   back (`account-config.ts:21-25`), so no transcript disappears. The directories stay on disk.
6. **Docker and Helm:**
   - the image stops installing claude-swap;
   - `docs/deploy.md` says the `claude-swap` volume can be removed after the upgrade;
   - the credential in `~/.claude` (its own volume) is the last one claude-swap placed there.
7. **API clients:**
   - `/accounts*` routes are gone (404);
   - a chat request that still sends `account` gets `400` with "accounts were retired; see Settings
     → Providers", for this release. The next release drops the check.

### Persistence and API

**SQLite**, one migration appended last to `MIGRATIONS` in `db.ts`, after phase 3's `chat_entries`
(the same rule as phase 3's outcome 6: never before a released migration):

```sql
CREATE TABLE provider_limits (
  provider       TEXT PRIMARY KEY,
  state          TEXT NOT NULL,
  binding_window TEXT,
  utilization    REAL,
  resets_at      TEXT,
  windows        TEXT NOT NULL,
  observed_at    TEXT NOT NULL,
  source         TEXT NOT NULL
);
CREATE TABLE provider_moves (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  project_id    TEXT,
  from_chat     TEXT NOT NULL,
  to_chat       TEXT,
  from_provider TEXT NOT NULL,
  to_provider   TEXT,
  from_model    TEXT,
  to_model      TEXT,
  action        TEXT NOT NULL,
  state         TEXT NOT NULL,
  decided_by    TEXT NOT NULL,
  decision_id   TEXT,
  resets_at     TEXT,
  claimed_until TEXT,
  reason        TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX provider_moves_subject ON provider_moves (subject_kind, subject_id, at);
CREATE INDEX provider_moves_from_chat ON provider_moves (from_chat);
CREATE UNIQUE INDEX provider_moves_open ON provider_moves (from_chat) WHERE state IN ('waiting', 'resuming');
ALTER TABLE flow_runs ADD COLUMN provider TEXT;
```

- **`provider_limits`** is current state shared by every process on the data directory, like
  `host_rate_limits`. It is written with
  `INSERT … ON CONFLICT (provider) DO UPDATE SET … WHERE excluded.observed_at >= provider_limits.observed_at`,
  so an older reading never overwrites a newer one.
- **`provider_moves`** is the history and the wait queue in one. The unique partial index allows
  one open wait per chat, so two processes cannot both arm one. A wait is claimed with
  `UPDATE provider_moves SET state = 'resuming', claimed_until = ?, updated_at = ? WHERE id = ? AND (state = 'waiting' OR (state = 'resuming' AND claimed_until < ?))`.
  Only the process that changed one row replays. Rows older than 90 days are pruned at start-up and
  daily; open ones never are.
- **`flow_runs.provider`** is null on old rows (read as `claude-code`). Orchestration tasks and chats
  keep their new fields in their JSON documents (`orchestrations`, `chats.json` column), so they need
  no column.

**JSON:** `providers.json` (`rotation`), the project's settings (`providers`), and `app-settings.json`
(the retirement notice's dismissal).

**Shared types** (additive in `g1`; the removals in `w4`, once nothing uses them):

- `LimitAction`, `ProviderLimitState`, `ProviderLimit`, `RotationSettings`, `ModelMapEntry`;
  `ProvidersSettings.rotation`; `ProjectSettings.providers`.
- `ProviderStatus.limit?: ProviderLimit | null`; `ProviderReasonCode` `limit-reached`, `limit-near`.
- `ChatContinuation { chatId; provider; action: 'handoff' | 'restart'; at; moveId }`;
  `Chat.continuedFrom` and `Chat.continuedIn` (null when absent).
- `ProviderMove` (the row) and `ProviderMoveState` (`waiting`, `resuming`, `moved`, `resumed`,
  `failed`, `cancelled`).
- `OrchestrationTaskState.provider?`, `.chain?: Array<{ chatId; provider; model; action }>` and
  `.waiting?: { provider; resetsAt; moveId } | null`.
- `FlowRun.provider` and `FlowRun.waiting?`; `FlowRunCause` `no-provider` and
  `limit-wait-expired` (`no-account` stays readable for old rows).
- `Overview.limits: ProviderLimit[]` (beside `rateLimit` until `w4` removes it).
- `MoveChatRequest { provider; action: 'handoff' | 'restart'; model? }`;
  `HandoffPreview { text; bytes; provider; model; sections }`; `CandidateView { provider; model;
  utilization; resetsAt } | { provider; excluded: Exclusion }`.
- Events: `RunRateLimitedEvent` gains `provider` and `resetsAt`; `RunProviderMovedEvent`
  (`run.providerMoved`: from, to, action, `decidedBy`); `RunLimitWaitingEvent`
  (`run.limitWaiting`: provider, `resetsAt`).
- Decisions: the three ids and the `model` subject kind (`g7`).
- Then `pnpm --filter @agentry/api openapi:schemas`.

**Routes** (each with a summary and a tag, and a README row):

| Method | Route | What |
|---|---|---|
| `GET` | `/providers` | Existing; each status has `limit` |
| `GET` `PUT` | `/providers/settings` | Existing; with `rotation`. A chat's token gets `403` on `PUT` |
| `GET` | `/providers/candidates?chatId=` | The candidates for a chat at a limit, with exclusions, for the banner and the sheet |
| `GET` | `/chats/:id/handoff?provider=&model=` | The handoff text, exactly as it would be sent, built locally and not sent |
| `POST` | `/chats/:id/move` | A person moves a chat (`MoveChatRequest`); closes an open wait. `409` when the chat is live and not at a limit; `403` for a chat's token |
| `GET` | `/providers/moves?chatId=&projectId=&state=&limit=` | Move history and open waits |
| `POST` | `/providers/moves/:id/cancel` | Stop waiting. A flow run or task then ends `stopped` |
| `GET` | `/providers/model-map/suggestions` | Open `provider.model-map` suggestions |
| `POST` | `/providers/model-map/suggestions/:id` | `{ accept: boolean }`; accepting writes the entry. A chat's token gets `403` |
| — | `/accounts*` (18 routes) | Removed |

README: the Providers rows above; the Accounts table removed; "How it talks to Claude" loses the
claude-swap rows and gains Codex's `account/rateLimits/read`.

### Orchestrations and tasks

#### P0 · `providers4-prototypes` (design; gates W)

Night Shift screens per [docs/design-system.md](../design-system.md), dark and light, desktop and
phone. Reference files under `docs/design-system/reference/`, with their screenshots and the index.

- `p1`: Settings → Providers with the limits and the rotation:
  - `DesktopProveedores.html` and `MobileProveedores.html` updated with limit bars and reading age;
  - new `DesktopProveedoresRotacion.html` and `MobileProveedoresRotacion.html`: the on-limit card,
    and the mapping editor with a missing counterpart, a suggestion with Accept and Dismiss, and an
    entry no longer offered;
  - `DesktopProyectoAjustes.html` and `MobileProyectoAjustes.html` with the providers override.
- `p2`: the chat at a limit and after a move:
  - new `DesktopChatLimite.html` and `MobileChatLimite.html`: the banner with three actions and the
    handoff sheet, with one candidate excluded and its reason;
  - new `DesktopChatContinuado.html` and `MobileChatContinuado.html`: the old chat's divider, and the
    new chat's header and handoff card;
  - the waiting state on the chat.
- `p3`: automated work and the shell:
  - `DesktopOrquestacion.html` and `MobileOrquestacion.html` with a task chain and a waiting task;
  - `DesktopChatFlujo.html` with a moved flow run;
  - `StatusBar.html` with limits per provider (near and exhausted);
  - the retirement notice on Home (`Main.html`, `MobileInicio.html`) and Settings;
  - `DesktopAjustesDecisiones.html` with the Providers area and its three points.
- New variants (the limit bar inside a provider row, the chain chip, the handoff card) go into
  `docs/design-system.md` and `agentry-ds.css`.
- Check: the prototype tools pass (`lint.py`, `check.mjs`), and **the owner validates** before W
  starts. The copy names tool kinds, modes and causes in the person's words, never wire identifiers
  (phase 3's W correction).

#### G · `providers4-groundwork` (runs beside P0)

- `g1` (shared types, additive), dependsOn none.
  - Everything "Shared types" lists except the decision ids and removals.
  - Files: `packages/shared/src/types.ts`, `apps/api/src/openapi/schemas*` (regenerated),
    `packages/shared/test/*`.
  - Checks: shared tests; `openapi:schemas` with no drift; `pnpm typecheck`.
- `g2` (the migration), dependsOn g1.
  - Files: `packages/core/src/db.ts` (the migration, `PROVIDER_ROTATION_SCHEMA_VERSION`, the
    `provider_limits` upsert and reads, the `provider_moves` insert, claim, list, prune and
    `flow_runs.provider`), `packages/core/test/db.test.ts`.
  - Checks: core tests, including:
    - an upgrade from `CHAT_ENTRIES_SCHEMA_VERSION` with chats and flow runs;
    - two connections racing one claim, with one winner;
    - an older reading never overwriting a newer one.
- `g3` (settings), dependsOn g1.
  - `rotation` in `ProvidersSettingsStore` with its validation and defaults; `providers` in project
    settings; the `403` for a chat's token on `PUT /providers/settings`.
  - Files: `providers/settings.ts`, `project-settings.ts`, `apps/api/src/routes/providers.ts` (the
    settings route only), `test/providers-settings.test.ts`, `apps/api/test/providers.test.ts`.
  - Checks: core and API tests.
- `g4` (limits), dependsOn g2.
  - `providers/limits.ts`; Codex's `account/rateLimits/read` in `codex/handshake.ts`, with the
    generated protocol subset regenerated to include it; the detector reads the row into
    `ProviderStatus.limit` and the readiness reasons.
  - Files: `providers/limits.ts`, `providers/codex/handshake.ts`, `providers/codex/protocol/**`,
    `providers/detector.ts`, `test/provider-limits.test.ts`, `test/provider-detector.test.ts`.
  - Checks: core tests; for each provider in the detection table, a fixture event gives the expected
    `ProviderLimit`; a reset in the past reads `unknown`.
- `g5` (candidates and mapping, pure), dependsOn g1.
  - Files: `providers/candidates.ts`, `providers/model-map.ts`, `test/provider-candidates.test.ts`.
  - Checks: core tests, one case per filter and per exclusion; `git push` not enforced excludes a
    provider for automated work; Copilot `no-probe` only for a person's chat; the moves cap; a
    project order override.
- `g6` (the handoff, pure), dependsOn g1.
  - Files: `packages/core/src/handoff.ts`, `test/handoff.test.ts`; `prompt-rules.test.ts` covers
    the module.
  - Checks: core tests:
    - the 12 KiB cap keeps every section header;
    - transcript text sits only inside `pasted()`;
    - a secret in a command output is masked;
    - an agent file is inlined when the target lacks `subagents`.
- `g7` (the decision points declared), dependsOn g1.
  - The three catalogue entries and their question builders (the options from the subject's
    feasible list); `DECISION_POINT_IDS`, `GLOBAL_ONLY_POINTS`; `DecisionPointId` and
    `DecisionSubjectKind` in shared types; the web map and area; the copy in `decisions.json`.
  - Files: `decisions/points.ts`, `decisions/settings.ts`, `packages/shared/src/types.ts` (those two
    unions only, after `g1`), `apps/web/src/pages/config/DecisionsTab.tsx` (map and areas),
    `apps/web/src/i18n/locales/{en,es}/decisions.json`, `packages/core/test/decision-points-runtime.test.ts`,
    `packages/core/test/decision-settings.test.ts`.
  - Checks: core and web tests; `openapi:schemas` with no drift.

When G is merged into the branch, D starts.

#### D · `providers4-rotation`, dependsOn G

- `d1` (runtime), dependsOn none within D.
  - `ChatManager`:
    - `maybeLimit` and `limit-hit`, with the chat's provider;
    - `ProviderLimits.observe` in place of `lastRateLimit`;
    - `replayLastTurn` kept for `wait`;
    - every account field removed (`account` refused with `400` on create, resume and fork).
  - `ChatService`: `continueOn` (stop, new chat, links, mapped options, the policy), the candidates
    for a chat, and the handoff preview.
  - `ChatRecord`: `continuedFrom` and `continuedIn`.
  - The Claude driver without `cswap run`; `AccountSupport` gone from `driver.ts`.
  - Files: `chats.ts`, `live-chat.ts`, `chat-fold.ts`, `chat-records.ts`, `chat-service.ts`,
    `providers/driver.ts`, `providers/claude-code/{args,driver,manifest}.ts`, their tests,
    `test/fixtures/golden/claude-args.json` (the pinned-account cases removed).
  - Checks: core tests; the conformance suite for every driver; the Claude goldens unchanged except
    the removed cases.
- `d2` (decision call sites and resolvers), dependsOn none within D.
  - `decisions/provider-points.ts`: the subject builders, `onLimit(stance, …)` and `pick(stance, …)`
    as the other call sites do (`stanceOf`, `watch` / `wait`), and the model-map trigger at most
    once per pair a day.
  - Resolvers in `resolve.ts`. The `cli` decision provider chooses its provider (decision 9).
  - Files: `decisions/provider-points.ts`, `decisions/resolve.ts`, `decisions/providers/cli.ts`,
    `test/provider-points.test.ts`, `test/decision-cli-provider.test.ts`, `test/decision-resolve.test.ts`.
  - Checks: core tests, the four-mode test of each point, and each resolver on fixture rows.
- `d3` (rotation), dependsOn d1, d2.
  - `rotation.ts`: the flow of "What happens at a limit", the wait timers, the claim, `recover()`.
  - `index.ts`: wiring; `AccountManager`, `rotateAndResume` and `syncCredentialOwner` removed; the
    retirement notice's detection; `Overview.limits`.
  - Files: `rotation.ts`, `index.ts`, `credentials.ts`, `paths.ts`, `test/rotation.test.ts`.
  - Checks: core tests over the fakes:
    - handoff, restart and wait on Claude (`FAKE-LIMIT-ONCE`) and on Codex (`RATE`);
    - a wait survives a restart of `Core`;
    - two `Core`s on one data directory replay once;
    - the moves cap;
    - no move when every candidate is excluded.
- `d4` (automated work), dependsOn d3.
  - Flow:
    - `awaitingRotation` replaced by the move rows;
    - `rotated` replaced by `moved` and `waited`;
    - `flow_runs.chat_id` and `provider` re-pointed by guarded update;
    - the remaining budget;
    - the new causes;
    - the launch passes `provider` and `policy`, with the rules from the target's translation.
  - Orchestrator: `task.provider`, `chain` and `waiting`; a `rate-limit` cause handed to the rotation
    instead of failing; time and cost limits across the chain; `provider.pick` at task start.
  - Assistant: the same at start and at a limit.
  - Files: `flow.ts`, `orchestrator.ts`, `assistant.ts`, `index.ts` (the launch functions
    `launchFlowRun`, `launchAssistantRun` and their options only, after `d3`), `test/flow*.test.ts`,
    `test/orchestrator.test.ts`, `test/assistant*.test.ts`.
  - Checks: core tests:
    - a flow run on Claude at a limit continues on Codex with its policy and `git push` denied;
    - a flow run under a budget waits (no `budgetLimit` candidate);
    - `maxParallel` holds through a wait;
    - a default provider set to Codex no longer runs a stage with Claude's rules.
- `d5` (API), dependsOn d3.
  - The routes of the table; events and notification texts (`packages/shared/src/notifications.ts`);
    `/accounts*` removed; README rows; `apps/api/src/security.ts`.
  - Files: `apps/api/src/routes/{providers,chats,accounts}.ts` (`accounts.ts` deleted),
    `apps/api/src/openapi/routes.ts`, `packages/shared/src/notifications.ts`, `README.md`, API tests.
  - Checks: API tests (every route, validation, `403` for a chat token, the summary-and-tag test, no
    drift); shared notification tests.
- `d6` (retirement in core and packaging), dependsOn d3.
  - Delete `accounts.ts`, `account-config.ts`, `cswap-install.ts`, `cswap-pin.ts` and their tests.
  - Docker, Compose, Helm, `.env.example`, CI, the desktop app's references; `docs/desktop.md`,
    `docs/deploy.md`, the two superseded docs.
  - Files: those, `apps/api/test/packaging.test.ts`, `apps/desktop/src/**` (references only).
  - Checks: core, API and desktop tests; `docker build` is not run by a worker (the final check
    builds the image once).
- `d7` (e2e fakes), dependsOn none within D.
  - `e2e/fake-cli/claude` gains `FAKE-LIMIT` (a `rate_limit_event` `rejected` with `resetsAt`, then a
    429 result), the same as the core fake. `e2e/fake-providers/protocol.mjs` gains Codex `RATE`.
  - `e2e/run.mjs` drops `CSWAP_BIN`.
  - Files: `e2e/fake-cli/**`, `e2e/fake-providers/**`, `e2e/run.mjs`.
  - Checks: `node --test e2e/fake-cli/claude.test.mjs` and the fake providers' self-test.
- `r2` (recordings with an account; the owner, not a worker), any time before the final e2e.
  - The rows of "How a limit is detected" that need an account, added to the fixtures with phase 3's
    scrubbing. A recording that contradicts a safe default becomes a correction in this plan.

#### W · `providers4-web`, dependsOn P0 (validated), D

- `w1` (Settings), dependsOn none within W.
  - Settings → Providers: the limit bars, the on-limit card, the mapping editor with suggestions,
    and the retirement notice. Project settings: the providers override.
  - Files: `apps/web/src/pages/config/ProvidersTab.tsx`, `apps/web/src/pages/config/providers/**`
    (new), `apps/web/src/pages/home/ProjectSettings.tsx` (the providers section only), the locales'
    `providers.json` and `config.json` keys they use, `apps/web/src/api.ts` (the new hooks only).
  - Checks: web tests; the tokens test; the night-shift checklist.
- `w2` (chat page), dependsOn w1.
  - The limit banner, the move sheet with the handoff preview, the divider and the continued
    header, the waiting state.
  - The e2e spec `e2e/specs/provider-rotation.spec.mjs`:
    - a Claude chat at a limit, then a move to Codex with a handoff;
    - the old chat's divider and the new chat's header;
    - a wait cancelled;
    - phone layout and axe.
  - Files: `apps/web/src/pages/ChatView.tsx`, `apps/web/src/pages/chat/{LimitBanner,MoveSheet,HandoffCard}.tsx`
    (new), `chats.json` in both locales, the spec.
  - Checks: web tests; the tokens test; the night-shift checklist.
- `w3` (automated work and the shell), dependsOn w1.
  - Orchestration task chain and waiting; the moved flow run on the item and the board; the
    `FailedFlowRun` causes; the status bar per provider; the phone's More card; the notification copy.
  - Files: `OrchestrationBoard.tsx`, `OrchestrationDetail.tsx`, `pages/tasks/item/Activity.tsx`,
    `pages/chat/FailedFlowRun.tsx`, `components/shell/{StatusBar,TabBar}.tsx`,
    `lib/{usage-now,shell-live,notifications-model}.ts`, `workItem.json`, `components.json`,
    `orchestrationDetail.json` and `shell.json` keys.
  - Checks: web tests; the night-shift checklist.
- `w4` (retirement in the web, and the type removals), dependsOn w2, w3.
  - Delete the Accounts page, `pages/accounts/**`, `lib/cswap.ts`, `accountsConfig.json` and the
    claude-swap parts of the config cards; add the `/accounts` redirect.
  - Remove the shared types of the retirement table; regenerate the schemas and the web fixtures
    (`strings.json`, `class-names.json`, `module-graph.json`, `bundle-shape.json`).
  - Delete `e2e/specs/accounts-config.spec.mjs` and the two Cuentas references.
  - Files: those, `packages/shared/src/types.ts` (removals only), `apps/web/test/**` fixtures.
  - Checks: `pnpm typecheck`; web, shared and API tests; i18n parity.

When W is merged into the branch:

- the full `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e`;
- the Docker image built once;
- the plan's "Outcome of phase 4", `docs/status.md`, `docs/providers.md` (limits, candidates,
  rotation) and `docs/decision-engine.md`;
- then one pull request to `main`.

**Who owns what, so parallel workers do not collide:**

| File or area | Owner |
|---|---|
| `packages/shared/src/types.ts`, schemas | `g1`; then `g7` (two unions); then `w4` (removals only) |
| `db.ts` | `g2` only |
| `providers/settings.ts`, `project-settings.ts` | `g3` |
| `providers/limits.ts`, `codex/handshake.ts`, `codex/protocol/**`, `detector.ts` | `g4` |
| `providers/candidates.ts`, `model-map.ts` | `g5` |
| `handoff.ts` | `g6` |
| `decisions/points.ts`, `decisions/settings.ts`, `DecisionsTab.tsx`, `decisions.json` | `g7` |
| `chats.ts`, `live-chat.ts`, `chat-fold.ts`, `chat-records.ts`, `chat-service.ts`, `providers/driver.ts`, `providers/claude-code/**` | `d1` |
| `decisions/provider-points.ts`, `resolve.ts`, `decisions/providers/cli.ts` | `d2` |
| `rotation.ts`, `credentials.ts`, `paths.ts`; `index.ts` except the launch functions | `d3` |
| `flow.ts`, `orchestrator.ts`, `assistant.ts`; `index.ts` launch functions | `d4` |
| `apps/api/src/routes/**` (except the settings route of `g3`), `openapi/routes.ts`, `notifications.ts`, `README.md` | `d5` |
| `accounts.ts`, `account-config.ts`, `cswap-*.ts`, packaging, desktop, deploy docs | `d6` |
| `e2e/fake-cli/**`, `e2e/fake-providers/**`, `e2e/run.mjs` | `d7` |
| `pages/config/ProvidersTab.tsx`, `pages/config/providers/**`, `ProjectSettings.tsx`, `api.ts` | `w1` |
| `ChatView.tsx`, `pages/chat/{LimitBanner,MoveSheet,HandoffCard}.tsx`, `chats.json`, the rotation spec | `w2` |
| orchestration, item, shell and notification files of `w3` | `w3` |
| Accounts page and fixtures | `w4` |

Regenerated OpenAPI schemas and web fixtures are never merged by hand: on a conflict, take either
side and regenerate.

### Risks

| Risk | Where | What holds it |
|---|---|---|
| Work or a handoff goes to a second vendor without the person knowing | product | Defaults `wait` and `allowed: ['wait']`; a person's chat never moves on its own (P4-2); the handoff preview; the settings refuse a chat's token |
| A moved run escapes `git push` denial or its stage's limits | `d4`, `g5` | The candidate filter requires the policy enforced, `gitPush` in two layers; a test per provider; Copilot and Gemini stages stay off until `r1` |
| A flow budget is bypassed on a provider that reports no cost | `g5`, `d4` | `budgetLimit` required for a budgeted run; the remaining budget passed on |
| Two processes replay one waiting turn, or both move one run | `g2`, `d3` | The unique open-wait index, the guarded claim, the flow's guarded re-point; the two-`Core` test |
| A run bounces between two exhausted providers | `g5` | `maxMoves`, `left-already` until reset, `exhausted` excluded |
| Claude's headroom is stale between runs without claude-swap's polling | `g4`, W | The reading's age is shown; an unknown reading is not `ok`; the reset time comes from the last event |
| ACP quota failures are not recognised | `g4`, `r2` | Ordinary failures until recorded; ACP agents are only ever targets |
| A handoff carries an injection from the transcript to the next agent | `g6` | `pasted()` with `PASTED_NOTE`; no tool output over 2 KiB; redaction |
| The handoff misleads (a stale or partial picture) | product, `provider.on-limit` | `restart` offered beside it; git state, not the agent's word, says what changed; the resolver measures it |
| Retirement locks a multi-account user out, or changes the account silently | `d3`, `d6` | Nothing outside Agentry's own files is deleted; the notice names the account in force and how to change it |
| A waiting run holds a `maxParallel` slot for hours | `d4` | Accepted: it bounds paid work in flight; the wait cap; "Move now" and "Stop waiting" |
| The default-provider gap (automated work on Claude's rules) is hit before phase 4 lands | today | `d4` fixes it; until then `docs/providers.md` says automated work expects Claude Code first in the order |

### Decisions for phase 4 (owner, 2026-10-02)

The owner took the recommended option of each, and said to follow the recommendations:

1. **P4-1.** A move is a new chat on the next provider, linked both ways (`continuedFrom` /
   `continuedIn`); the run, task or item points to the newest. Each chat keeps one provider, one
   session and one transcript store.
2. **P4-2.** A person's own chat at a limit asks: a banner offers the feasible actions, the
   setting's first, and nothing spends on another vendor without a click.
3. **P4-3.** A fresh install's model mapping is empty; the first limit with no mapping waits and
   opens the editor on the missing pair, and a person accepts every suggestion.
4. **P4-4.** claude-swap users keep the account it left active; a one-time notice names it, lists
   the rotation policies that are gone and offers to remove Agentry's copy. Its own data is never
   touched.

## Outcome of phase 4

Built on `feat/multi-provider-4` on 2026-10-02 and 2026-10-03, in five orchestrations launched on the
owner's desktop app, every code-writing worker on `claude-sonnet-5-5`, and two independent audits
(on `claude-opus-5-5`) between them:

| Orchestration | Tasks | Cost | Result |
|---|---|---|---|
| P0 `providers4-prototypes` | p1–p3 | 45.54 USD | Validated; part of it ran into the account's session limit and was resumed after the reset |
| G `providers4-groundwork` | g1–g7 | 20.41 USD | Every check passed |
| D `providers4-rotation` | d1–d7 | 88.11 USD | Passed after the fixer ran (API tests that ran automated work, a limit read after the database closed) |
| W `providers4-web` | w1–w4 | 49.26 USD | Every check passed |
| F `providers4-fixes` | f1–f6 | FIXES_COST | FIXES_RESULT |

`d4` alone cost 58.90 USD: a core test started the machine's real Gemini CLI, which waited for a
sign-in for ever, and the worker waited on that test run until it was told why. Tests now never
reach a real agent CLI (core's `tempConfig()`, and `apps/api/test/isolate-providers.ts` for the API).

**The audit of D** found 4 blockers, 7 major and 9 minor findings. Fixed on the branch:

1. **Automated work with no policy could leave Claude Code.** Orchestration tasks start with the
   graph's own rules and no `ToolPolicy`, and the candidates let that through, so a task could move
   to a provider where nothing denies `git push`. Such work now stays on Claude Code and, at a
   limit, waits.
2. **A chat's token could change what its project does at a limit**, through the project settings.
   Like the tracker, a chat's copy of the settings keeps the stored providers.
3. **API tests detected the machine's own CLIs** and ran them (see above).
4. **A person's "Move now" left an orchestration task on the old chat**, and the wait open in the
   rotation's memory. `Core.moveChat` closes the wait into the move and re-points the work.
5. **A mapping made on an alias never matched**: the picker and the map hold Claude's aliases, a
   chat records the id the CLI resolved. Drivers name every name of a model (`modelNames`).
6. **A provider at its limit was "not ready" rather than "exhausted"**, so the reason was wrong,
   start-and-wait never fired, and a passed reset did not make it a candidate again.
7. **A limit whose handling threw left the work running for ever.** Waiting is now the floor.
8. **Detection handshakes left Gemini's real process running** (its launcher re-spawns itself);
   they now end their whole process group.

**The audit of W** found 1 blocker, 4 major and 15 minor findings. The blocker was that **no
provider status carried its limit**: Core built the detector before the runtime that keeps the
limits and never handed them over, so the chat's limit banner and the limit bars never showed. The
rest, with the core and API leftovers of the first audit, went to F.

Not built, by decision: several accounts of one provider, moving a live session, summarising with a
model, budgets on providers that report no cost, and ACP limit detection beyond what is recorded
(`r2`). The old tables (`rotation_events`, `usage_history`) are no longer written and are dropped in
a later release.

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

[[decisions/decision-engine.md]] · [[decision-engine.md]] · [[plans/decision-engine.md]] · [[providers.md]] · [[plans/code-hosts.md]] · [[plans/web-packages.md]] · [[plans/managed-claude-swap.md]] · [[pinned-chat-rotation.md]] · [[desktop.md]] · [[deploy.md]] · [[design-system.md]] · [[plans/agentry-assistant.md]] · [[status.md]]