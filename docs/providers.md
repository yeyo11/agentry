---
created_at: 2026-09-30T14:00:00Z
updated_at: 2026-10-01T18:00:00Z
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

Status: phase 1 (detection) is done and phase 2 put Claude Code behind the driver interface and
added the conformance suite every driver must pass. Phase 3 adds the other drivers; this table says
where each stands, and the code wins when it differs.

| Provider | Driver | Transport | Declared at | Starts a chat |
|---|---|---|---|---|
| Claude Code | `providers/claude-code/` | `stream-json` | the manifest | yes |
| Codex | `providers/codex/` | `json-rpc` (`codex app-server`) | `>=0.159.3 <0.160.0` | driver done, passes its conformance file |
| Copilot | `providers/acp/` with the Copilot profile | `acp` (`copilot --acp`) | `>=1.0.65 <1.1.0` | driver done, passes its conformance file |
| Gemini | `providers/acp/` with the Gemini profile | `acp` (`gemini --acp`) | `>=0.62.0 <0.63.0` | driver done, passes its conformance file |
| OpenCode | `providers/acp/` with the OpenCode profile | `acp` (`opencode acp`) | `>=1.18.34 <1.19.0` | driver done, passes its conformance file |

The type names below are the ones phase 1 defines in `packages/shared/src/types.ts`; if they differ
from the code, the code wins and this document is stale.

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

### The handshake

A driver with a handshake (`ProviderDriver.handshake`) is asked once its version is in range and the
provider is not signed out. It runs on a process of its own, built for the binary the detector
found (an override included), and spends nothing:

- **Codex:** `initialize`, `account/read` and `model/list` on `codex app-server`. It gives the
  account (an email, else `ChatGPT <plan>`, or `API key`), the account's models and what the models
  confirm (`setModel`, `effort`). `codex login status` stays the cheap probe between handshakes.
- **ACP agents (Copilot, Gemini, OpenCode):** `initialize` and nothing else, so no session starts
  and no MCP server is launched. It says what the agent can do (`loadSession`, `session/fork`,
  `session/resume`, MCP) and confirms those declared capabilities. It cannot say whether anyone is
  signed in (`authMethods` are offered either way), so a provider with no login probe stays
  `unknown` with `no-probe`, and a recording of a signed-in account is what settles it.

What a handshake reads is kept for the binary and version it was read from, and run again only when
either changes, never once per TTL. A handshake that fails (the process did not start, did not answer
or exited) changes no status: the probes already said what they could, and it is tried again after
one TTL. What it confirmed goes on the status as `confirmed`, filed under the version `--version`
printed, the one a status is compared with; a later session's first event replaces it.

The status also carries `permissionModes`: the modes the provider's driver honours, in the order to
list them, so a picker offers only those. The models a handshake listed are cached in
`provider-catalogs.json` in the data directory (per provider and version, rewritten whole) and handed
to the driver that serves `GET /providers/:id/models`; the next run starts from that file, so the
picker is not empty before its first handshake. A driver with no catalog yet answers with one
default option.

**No CLI updates itself under Agentry.** Copilot is started with `--no-auto-update` and
`COPILOT_AUTO_UPDATE=false` (a recording session saw it update itself), OpenCode with
`OPENCODE_DISABLE_AUTOUPDATE=1`. A version change that happens anyway is read at the next detection
and, being a new version, handshaken again.

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

## Who may do what: the policy judge

A chat or a stage carries a `ToolPolicy` (what it may read, edit, run, fetch, delegate, and whether
it may push to a remote). Each driver translates it into the provider's own rules (`translatePolicy`),
and a part the provider cannot enforce is listed as `unsupported`, never dropped: a run that needs it
is refused on that provider, and a provider that cannot enforce `gitPush: 'deny'` is never offered
for a flow stage.

A second layer, the **judge** (`packages/core/src/policy-judge.ts`), is pure: it takes the policy
and a neutral request (`command`, `edit`, `read`, `fetch`, `delegate`, `other`, with the command, the
paths or the URL) and answers `allow`, `deny` or `ask`. A push in any form is `deny` when the policy
says so. When a driver's translation lists a part in `host`, the permission request the agent sends
is judged by Agentry first: `allow` and `deny` are answered at once and recorded as a notice, and
`ask` goes to the person, or is denied when nobody can be asked. Claude Code's translation has no
`host` part, so its path is unchanged. Each driver maps its own requests to the neutral one (Codex's
`commandExecution` and `fileChange`, an ACP tool call's `kind`).

Two independent layers hold a push on every provider: a native setting or rule, and the judge. One
gap is accepted and written down: under Codex's `workspace-write` sandbox a push to a local path needs
no network and succeeds, and the judge only sees escalations. Agentry's worktrees push to the real
`origin`, which the sandbox's network-off setting stops.

## Rotation at a limit

What happens when a provider reaches its limit is decided per kind of work. A person's chat only
asks: it is announced, and nothing moves until the person clicks. Automated work (a flow run, a
task, the assistant) moves by the rotation settings, and only to a provider that enforces its tool
policy with pushes denied, so it never lands where its rules would be lost.

- **A schedule's chat is treated as a person's.** The rotation does not know it as work, so at a
  limit it only asks. This is the safe direction: a schedule never moves on its own to a provider
  whose rules differ from the ones it was written for, and its next run starts again on the
  provider it names.
- **A decision chat is automated with a policy that allows no tool at all** (read off, edit none,
  commands none, network and pushes denied). That is what lets the `cli` decision provider run on
  the first ready provider with structured output and a model for the configured one, and keeps it on
  Claude Code where nothing else enforces the policy.
- **The effort carries over** when the target takes an effort and lists the level: Claude Code's own
  scale (`low` to `max`) and, for the other providers, `low`, `medium` and `high`; a level the target
  does not list falls back to its default.

## Where transcripts live

Not every provider writes its transcripts as files, and each provider's `TranscriptStore` reads what
its own CLI offers, read-only:

| Provider | Where the history comes from |
|---|---|
| Claude Code | JSONL under its projects directory |
| Codex | Codex's own app-server API (`thread/list`, `thread/read`) |
| OpenCode | the tables of its SQLite database (`opencode.db`, WAL mode), opened read-only with `query_only`, one short read per call, no pooling and no checkpoint; a busy read is retried, never taken for an empty session; only the tables the reader names may be read, so a credential in that file cannot leak; a schema newer than the one pinned is `schema-untested` |
| Copilot, Gemini | what Agentry streamed, kept as rows in `chat_entries` (`chat_id`, `seq`, `entry`, `at`); chats started in a terminal are not listed |

A store never writes, locks or checkpoints another program's files. The stores for Codex and OpenCode
and the routing that picks one by the chat's provider arrive in the same phase as the drivers; until
a driver's `transcripts` is filled, its conformance case skips with that reason. See the plan's notes
under OpenCode and "Transcripts for the other providers".

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
5. **Ship a fake for e2e**, a small binary the e2e suite reaches by the override in `providers.json`.
   The suite never depends on the real agent. `e2e/fake-providers/` has one script behind four names
   (`codex`, `copilot`, `gemini`, `opencode`): it answers `--version` and `login status`, and when it
   is started as the manifest's `launch` says (`app-server`, `--acp`, `acp`) it becomes the protocol
   fake in `packages/core/test/fixtures` (`fake-codex-app-server.mjs`, `fake-acp-agent.mjs`), so the
   detector's handshake and a chat run against the same replies the recordings show. What it
   answers is read from `$AGENTRY_DATA_DIR/fake-providers/<name>.json`; its own test is
   `node --test e2e/fake-providers/fake-providers.test.mjs`.
6. **Update the docs** in the same PR: the table in this document if a field or state changed, and
   [status.md](status.md).
7. **Write the driver** (`providers/<id>/driver.ts`) against the `ProviderDriver` interface in
   `packages/core/src/providers/driver.ts`: `launch`, `attach`, `translatePolicy`, `models`,
   `confirm` and the rest. Events come out neutral (`RunEvent`); Agentry's `ToolPolicy` goes in and
   the provider's own rules come out, and a part the provider cannot enforce is listed in
   `unsupported`, never dropped. The policy table is in
   [plans/multi-provider.md](plans/multi-provider.md), phase 2.
8. **Pass the conformance suite.** Add a fake of the provider's CLI that speaks its protocol, then
   a test file like `packages/core/test/conformance-claude-code.test.ts` that calls
   `driverConformance(name, harness)` from `packages/core/test/conformance/suite.ts`. The harness
   gives the driver, the environment its fake needs, and how to script a turn. A case whose
   capability the manifest does not declare is skipped with that reason, so the manifest's
   capabilities are what the suite holds the driver to.

## How to add an ACP agent

An agent that speaks the Agent Client Protocol over stdio needs no driver of its own: the ACP driver
in `packages/core/src/providers/acp/` runs the protocol, and what differs per agent is a profile.

1. **Record it first.** Run the agent's `initialize` and `session/new` against a scratch repository
   and keep the lines under `packages/core/test/fixtures/recordings/<id>/<version>/`, scrubbed (no
   email, no home path, no token; a test fails on any). A method that answers `-32601` is a fact to
   write down. The profile and the manifest declare what the recording shows, not what the docs imply.
2. **Add the manifest** in `providers/<id>/manifest.ts` with `transport: 'acp'`, the tested `range`,
   the `capabilities` the `initialize` reply confirms and `launch` (`args`, `env`, `unsetEnv`). Pass
   whatever turns the agent's self-update off (`--no-auto-update`, an environment variable).
3. **Add a profile** in `acp/profiles.ts`: the modes it honours with the native value of each (the
   ids `session/set_mode` takes), how a live model switch is made (`config-option`, `set-model` or
   none), the models to offer before a session names its own, which grants the host makes, the
   policy translation (`policy-<id>.ts`, with a part it cannot enforce listed as `unsupported`) and
   the launch extras (arguments, environment, a per-launch file removed when the process exits).
4. **Teach the fake agent the profile.** `fake-acp-agent.mjs` replays the recording and takes
   `--profile <id>`; add the profile's recorded files, which methods answer, and nothing it did
   not record.
5. **Pass the conformance suite** with a `conformance-<id>.test.ts` that builds the ACP driver
   with the manifest and the fake, as the three existing ones do.
6. **Add a fake for e2e** (step 5 above), the row in the table at the top and the README.

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
