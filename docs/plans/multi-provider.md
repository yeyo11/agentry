---
created_at: 2026-09-30T12:43:36.708551256Z
updated_at: 2026-09-30T13:51:15Z
tags:
    - plan
    - providers
    - detection
    - onboarding
    - architecture
    - planned
---
# Multiple agent providers

Status: **planned** (2026-09-30). Nothing here is built yet. The owner answered the open questions
the same day; see "Decisions" at the end.

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

1. **Claude Code**, rebuilt on the **Claude Agent SDK** (decision 2) behind the driver interface,
   with the behaviour Agentry has today. This is the proof the interface is right.
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

Agents that only have a terminal interface are not providers. A later "terminal" tab could host
them, but they cannot run orchestration stages.

## Phases, one PR each

1. **Detection and first run.** Manifests for every provider above (detection needs no driver),
   registry, `ProviderDetector`, readiness states, `GET /api/providers`, the `providers.changed`
   event, the Providers step and settings page. Visible on its own: a clean install lists every
   provider on the machine and says why each one is or is not ready. The same PR rewrites the one
   rule in `CLAUDE.md` and `CONTRIBUTING.md` (decision 1).
2. **Driver interface and Claude on the SDK.** `provider` column on chats; `ToolPolicy`; neutral
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

## Decisions (owner, 2026-09-30)

1. **The one rule is generalised** as in section 8. Rejected: relaxing it to allow internal
   endpoints and terminal scraping; and dropping it.
2. **The Claude Agent SDK is the base of the Claude driver.** The recommendation was to keep
   Agentry's own stream-json control protocol, which the SDK wraps; the owner chose the SDK.
   Consequences to handle in phase 2:
   - the SDK pins a protocol version while the CLI updates itself, so the manifest's `versions`
     range and contract tests against the pinned SDK are required;
   - the SDK is pointed at the person's installed CLI (`pathToClaudeCodeExecutable`), so detection
     stays the source of which binary runs, and accounts keep their `CLAUDE_CONFIG_DIR`;
   - Anthropic's terms for offering claude.ai login in third-party products are checked before
     release.
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

[[decisions/decision-engine.md]] · [[plans/managed-claude-swap.md]] · [[desktop.md]] · [[deploy.md]] · [[plans/agentry-assistant.md]]