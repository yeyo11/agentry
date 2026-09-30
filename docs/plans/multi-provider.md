---
created_at: 2026-09-30T12:43:36.708551256Z
updated_at: 2026-09-30T12:50:08Z
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
   - **GitHub Copilot CLI:** installed on the owner's machine. Its interface for programs (ACP, a
     server mode, or none) is checked first; without one it waits.

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

Each phase keeps `pnpm typecheck`, `pnpm test` and `pnpm e2e` green, regenerates the OpenAPI schemas
and adds its README rows.

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

## Related

[[decisions/decision-engine.md]] · [[plans/managed-claude-swap.md]] · [[desktop.md]] · [[deploy.md]] · [[plans/agentry-assistant.md]]