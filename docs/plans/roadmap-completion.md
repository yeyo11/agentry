---
created_at: 2026-09-21T07:35:14Z
updated_at: 2026-10-07T18:00:00Z
tags:
    - plan
    - roadmap
    - verified
---
# Plan: finish the roadmap

Status: **Verified on `a0d6f2967` (0.33.1)**, with the full `pnpm e2e` run: see
[Verification (2026-10-07)](#verification-2026-10-07), and the first pass in
[Verification (2026-10-01)](#verification-2026-10-01). Run as one orchestration on top of `main` at
`f78fab7` (`feat!: chats, projects and Agentry's own model`). Every task below landed except the
pieces listed under [Outcome](#outcome-what-landed-and-what-did-not). Most of those were built later
by [post-roadmap](post-roadmap.md), and the accounts pieces were retired on purpose by #188. The one
item open is `paging.spec.mjs`, which fails alone on a loaded machine (CW-32).

This document is the source of truth for every task of that orchestration. It closes the whole
**Next** section of [ROADMAP.md](../../ROADMAP.md): agent observability, security, richer chat
control, orchestration v2, the connectors panel, multi-account continued, scheduling, usage and cost
observability, and packaging.

Where a task prompt and this plan disagree, this plan wins. Where this plan and
[CONTRIBUTING.md](../../CONTRIBUTING.md) disagree, CONTRIBUTING wins.

## The one rule, again

Agentry reaches Claude Code **only through its CLI**: flags, subcommands, stream-json events, files
the CLI writes. No SDK, no HTTP call to Anthropic, no terminal scraping. If a piece of a feature
below cannot be expressed that way, leave it out and say so in your result instead of inventing a
surface.

## Vocabulary after #60

The model is **chats** and **projects** now, not runs and sessions. `packages/core/src/chats.ts`,
`chat-service.ts`, `chat-model.ts`, `chat-records.ts`, `projects.ts`; routes `/api/chats`,
`/api/projects`. [docs/plans/agent-observability.md](agent-observability.md) was written before that
rename and still says `GET /runs`, `runId`, "run": read it as chats. Keep new endpoints under
`/chats/...` and `/orchestrations/...`.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects,
   in English, body explaining why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with" trailer, ever.
3. **Code, comments, docs and UI strings in English.**
4. **Checks you run:** `pnpm typecheck` and `pnpm test`. You may *write or update* e2e specs, but
   **do not run `pnpm e2e`** — a single verification task runs the suite once at the end, on the
   integrated branch. Running it in parallel with other workers hangs it and leaves orphaned Chrome
   processes behind.
5. **Every long command under `timeout`**, e.g. `timeout 300 pnpm test`. If a command hits its
   timeout twice, stop retrying it and report it in your result.
6. **After touching `packages/shared/src/types.ts`**, run
   `pnpm --filter @agentry/api openapi:schemas` and commit the regenerated schemas. CI fails on
   drift.
7. **Every new route** needs a summary and a tag in `apps/api/src/openapi/routes.ts` (a test
   enforces it) and a row in the README REST API tables.
8. **TypeScript strict, no `any`**, respect `noUncheckedIndexedAccess`. Comments explain why.
9. **Persistence:** settings-shaped documents in JSON files; streams and accumulating records as
   rows in SQLite (`packages/core/src/db.ts`).
10. **UI controls come from `apps/web/src/components/controls`** — never native
    `select`/`checkbox`/`range`/`details`/`title=`. Status is never colour alone: reuse
    `StatusBadge` and `Tag`. Icon-only buttons carry an `aria-label`. New pages keep
    `e2e/specs/a11y.spec.mjs` green (the verification task runs it).
11. **Do not touch files outside your scope.** The shared types for the whole roadmap land once, in
    the `types` task; every other task builds on them and only adds what its own feature needs.
    `README.md` and `ROADMAP.md` are edited by the `docs` task — put your feature's documentation
    notes in your result and let it write them, except for the REST table rows of rule 7, which you
    add yourself.
12. If something in your scope turns out to be impossible over the CLI, or much larger than it
    looks, **do the rest and say what you left out** in your result. Do not silently narrow the
    scope, and never loosen an existing test or assertion to make a check pass.

## The shared types (task `types`)

One task lands every new type in `packages/shared/src/types.ts`, so fourteen workers do not conflict
in one file. It writes types and nothing else: no core logic, no routes, no UI. It must compile and
leave `pnpm typecheck` green, with the OpenAPI schemas regenerated.

Types to add, grouped by the feature that consumes them:

- **Execution detail** — `ChangeSummary { branch, base, ahead, commits: Commit[], files:
  ChangedFile[], uncommitted: ChangedFile[] }`, `Commit { hash, subject, author, at }`,
  `ChangedFile { path, status: 'added'|'modified'|'deleted'|'renamed', additions, deletions }`,
  `FileDiff { path, diff }`, and `TouchedFile { path, at, tool }` for a chat with no worktree.
- **Health** — `HealthLevel = 'ok'|'slow'|'stuck'|'looping'`,
  `HealthSignal { kind: 'hung-command'|'repeat-stall'|'no-progress'|'loop'|'weakened-test'|'silence'|'budget', reason, since, detail? }`,
  `Health { level, signals: HealthSignal[] }`, added to the chat and orchestration task shapes.
  `CancelCommandRequest`, `HintRequest`, `TaskLimits { maxMinutes?, maxCostUsd? }`.
- **Editor links** — `EditorSettings { template, diffCommand?, pathMap?: { from, to }[] }`.
- **Verification phase** — `VerificationSpec { commands: string[], fixer: boolean, maxAttempts,
  model? }`, `VerificationState { status: 'pending'|'running'|'passed'|'fixed'|'failed', attempts,
  commands: { command, status, output, durationMs }[], commits: Commit[], report }` on
  `Orchestration`.
- **Security** — `AuthConfig { mode: 'none'|'token'|'oidc', token?: never, oidc?: { issuer,
  audience, clientId } , readOnly: boolean }` (a token is never returned, only set),
  `AuditEntry { id, at, actor, method, path, status, summary }`, `AuditPage`.
- **Richer chat control** — `McpSelection { servers: string[], config?: string }` and
  `ToolPreset { id, name, allowedTools: string[], disallowedTools?: string[] }` on the new-chat
  request and as stored presets.
- **Orchestration v2** — `OrchestrationTemplate { id, name, spec: OrchestrationSpec, createdAt,
  updatedAt }`, `RelaunchOrchestrationRequest { spec?: Partial<OrchestrationSpec>, tasks?:
  OrchestrationTaskSpec[] }`.
- **Connectors** — `Connector { id, name, kind: 'docs'|'gmail'|'calendar'|'other', status:
  'connected'|'needs-auth'|'unknown', scopes?: string[] }`, `ConnectorAction { id, label, prompt }`.
- **Multi-account** — `AccountConfig { number, configDir: string|null, rotationPolicy?:
  RotationPolicy }`, `RotationPolicy { threshold: number, order?: number[], projects?: string[] }`,
  `UsageHistoryPoint { at, pct, window: '5h'|'7d', account: number }`.
- **Scheduling** — `Schedule { id, name, cron, timezone?, target: { kind: 'chat', chat:
  NewChatRequest } | { kind: 'orchestration', spec: OrchestrationSpec }, enabled, lastRunAt,
  nextRunAt, createdAt }`, `ScheduleRun { id, scheduleId, at, status, chatId?, orchestrationId?,
  error? }`.
- **Usage and cost** — `UsageSeries { bucket: 'day'|'week', points: { at, costUsd, tokens, chats }[]
  }`, `UsageBreakdown { byProject: …[], byModel: …[] }`, `ExportFormat = 'markdown'|'json'`.
- **Packaging** — `CliVersionInfo { current, pinned: string|null, latest: string|null,
  checkedAt: string|null, updateAvailable: boolean }`.

Names and shapes are a starting point, not a contract: if a downstream feature needs a different
field, that task adds it. What matters is that the churn in `types.ts` happens mostly here.

## 1. Agent observability (roadmap's top priority)

Full reasoning and the case that prompted it:
[docs/plans/agent-observability.md](agent-observability.md). Read it whole before starting any of
the four tasks below.

### `git-changes` — what actually changed on disk

Core + API. Sections 1 of the observability plan.

- `GET /orchestrations/:id/tasks/:taskId/changes` → `ChangeSummary`, and the same for
  `/orchestrations/:id/integration/changes`.
- `GET …/changes/diff?path=` → `FileDiff` for one file.
- `GET /chats/:id/changes` — for a chat with a worktree, the same summary; without one, the files
  its `Write`/`Edit`/`NotebookEdit` tool calls touched, from the transcript, so it works outside git.
- Everything from `git` (`log`, `diff --numstat`, `--name-status`, `status --porcelain`) through the
  helpers in `packages/core/src/git.ts`; add helpers there rather than shelling out ad hoc.
- Live: while a worker runs, the summary changes. Emit an event on the global feed
  (`packages/core/src/events.ts`) when a task's commits or dirty files change, so the UI does not
  poll. Debounce it — a commit is not a keystroke.
- The worker's own checklist: `TaskCreate`/`TaskUpdate`/`TodoWrite` calls are in the transcript;
  expose the done and pending items on the task detail. Add `GET
  /orchestrations/:id/tasks/:taskId/checklist` or fold it into the task shape, whichever reads
  better, and say which in your result.
- Unit tests over a temporary git repository, and API tests through Fastify inject.

### `stuck-signals` — notice, and be able to step in

Core + API. Sections 3 and the per-task limits of section 4.

- Compute `Health` for every running chat and orchestration task from what Agentry already receives:
  `tool_progress` heartbeats (`elapsed_time_seconds`), tool calls and results, commits and worktree
  changes, cost and elapsed time. The seven signals and their rules are the table in the
  observability plan. Keep a history of command durations per kind of command (in SQLite) so "far
  longer than usual" is measured, not guessed, with a fixed fallback limit of 3 minutes.
- `weakened-test`: an `Edit` on an existing spec or test file that removes or loosens an assertion.
  Detect it from the tool call's `old_string`/`new_string`, conservatively — a false positive here
  is noise on every honest test edit.
- `POST /chats/:id/commands/:toolUseId/cancel` — kill only that command's process tree, the
  descendants of the CLI process that belong to it, without ending the turn: the worker gets a
  failed tool result and carries on. Reuse `packages/core/src/processes.ts`. Never kill by pattern
  matching a command line.
- `POST /chats/:id/hint` (and `…/orchestrations/:id/tasks/:taskId/hint`, which already exists) with
  a suggested text per signal.
- Per-task time and cost limits: `TaskLimits` on a task spec, the cost one through the CLI's
  `--max-budget-usd`, the time one enforced by Agentry, with a soft warning before the hard stop.
- Notifications: emit health events on the global feed so the notification centre picks them up.
- The optional Haiku supervisor of the plan is **out of scope** for this orchestration. Leave a note
  in the plan instead.

### `e2e-harness` — a suite that cannot hang

`e2e/` only, no dependency on the shared types.

- A time limit per spec and per run, both configurable, with a clear failure when one trips.
- Chrome closed on **every** exit path: normal end, failure, timeout, `SIGINT`, `SIGTERM`,
  uncaught exception. No headless browser outlives its run, and no orphan survives a hang.
- Kill by PID of the process the harness itself started, never `pkill -f` on a pattern.
- A spec (or a unit test of the harness) that proves the browser is gone after a forced timeout.
- Leave the suite green and no slower than it is today (~80 s).

### `verification-phase` — verify once, after integrating

Core + API, depends on `stuck-signals` and `orchestration-v2` (it changes the same orchestrator).

- `VerificationSpec` on an orchestration: commands to run on the integration branch (for this repo
  `pnpm build`, then the e2e suite), a fixer agent for what fails, `maxAttempts`.
- The fixer's rules come from Agentry, not from the objective: every command under `timeout`, one
  spec at a time, browsers closed after a hang, existing assertions never loosened (a behaviour that
  changed on purpose is stated as such), at most N attempts per failure, then stop and report.
- Outcome on the orchestration — `passed`, `fixed` (with its commits) or `failed` (with the report)
  — recorded and shown before the pull request is offered.
- Worker prompts Agentry builds get the split of checks: typecheck and unit tests for workers, the
  suite for verification. That text belongs in the orchestrator, not in every objective.

### `pending-gaps` — what 0.11.0 and #60 left

Small, independent fixes. Each one is its own commit.

- A chat already waiting for an answer when the page loads raises no notification: seed the list on
  load from the `pendingPrompts` of `GET /chats`.
- A "waiting" notification opens the chat, not the prompt: scroll to it, or answer from the
  notification.
- A chat cut off by a wrapper restart is restored with no reason: record "interrupted by a wrapper
  restart" and the real time it stopped.
- A finished workflow links to the Workflows page instead of the agent that ended, because the event
  carries no agent id: carry it.
- `GET /chats/:id` leaves `sessionId` off the subagents it reports, while `GET /subagents` has it.
  Make them consistent.
- `apps/web/src/lib/detail.ts` has no unit tests for encoding and decoding `?detail=`. Add them.

## 2. Security (task `security`) — required before exposing the port

- **Authentication in front of every route.** `AuthConfig` with three modes: `none` (today's
  behaviour, the default, so a local install keeps working untouched), `token` (a bearer token, and
  the same token accepted as a query parameter *only* for `GET /api/events`, which `EventSource`
  cannot send headers on), and `oidc` (validate a JWT against an issuer's JWKS, check `aud` and
  `exp`). Store a **hash** of the token, never the token. `GET /api/health` stays open, everything
  else is guarded, `/docs` included.
- **Read-only mode**: an optional switch that rejects every mutating method with `405`, except
  answering a permission prompt. Useful for showing the panel to someone.
- **Secret redaction** in `GET /config/mcp`: `env` values and `headers` values never leave the
  process; return a placeholder that says a value is set, and accept writes that keep the stored
  value when the placeholder comes back unchanged. Check the other config routes for the same leak
  and redact them too.
- **Audit log of writes**: every mutating request as a row in SQLite — when, actor (token id or OIDC
  subject), method, path, status, and a one-line summary. `GET /audit` paginated, newest first,
  filterable by path. Never log bodies: they contain prompts and secrets.
- **TLS guidance** in the README: a reverse proxy in front, the headers it must pass, and why
  Agentry does not terminate TLS itself.
- The UI half is the `web-security` task's; here, make sure the web client sends the credential (a
  stored token, `Authorization` header) and that a `401` is a clean, actionable state, not a blank
  page.
- Tests: every mode, a guarded route without a credential, the event stream with a query token,
  read-only rejecting a `POST`, redaction round-tripping without losing the stored secret.

## 3. Richer chat control (task `chat-mcp-tools`)

- **Per-chat MCP configuration**: choose which of the configured servers a chat starts with, through
  the CLI's `--mcp-config` / `--strict-mcp-config`, writing the config the CLI reads. Default: what
  it does today.
- **Allowed-tools presets**: named, stored sets of `--allowedTools` / `--disallowedTools`, pickable
  when creating a chat and when resuming, editable in configuration. Ship two or three sensible
  presets (read-only, no network, everything) as defaults a person can edit.
- Both are settings-shaped: JSON files, not SQLite.
- Show on the chat detail which preset and which servers a chat is running with, because it explains
  a refusal.

## 4. Orchestration v2 (task `orchestration-v2`)

- **Re-run a single task** of a finished graph: `retryTask`/`retryTaskClean` already exist for a
  failed one — extend to a completed graph, re-running the task and everything that depends on it,
  and re-integrating.
- **Edit and relaunch a finished graph**: `POST /orchestrations/:id/relaunch` taking a
  `RelaunchOrchestrationRequest` — the same graph with corrected prompts, models, concurrency or
  tasks, as a new orchestration that records where it came from.
- **Reusable templates**: save a graph (or a draft plan) as a named template, list them, launch one
  with a new objective and `cwd`, edit and delete. JSON files.
- Do not break resume, `retryTask`, `skipTask`, integration or the workflow engine: they are covered
  by tests, keep them green.

## 5. claude.ai connectors panel (task `connectors`)

- A page listing the connectors reachable **through the CLI** — Docs, Gmail, Calendar — with their
  status: configured, needs authorisation, unknown. Read it from what the CLI reports about its MCP
  servers; do not call claude.ai.
- Guided "ask Claude" actions: buttons that open a new chat with a prepared prompt ("summarise my
  calendar for tomorrow"), nothing more magic than that.
- Say plainly in the UI what is out of reach and why: **web artifacts and claude.ai memory have no
  public API or CLI command**. A sentence in the page, not a silent gap.
- Authorisation happens in an interactive CLI session (`claude mcp`, `/mcp`) or in claude.ai's
  connector settings: link to the instructions instead of pretending Agentry can do it.

## 6. Multi-account, continued (task `accounts-config`)

- **A config directory per account**: today every account shares `~/.claude`. Give each one its own
  `CLAUDE_CONFIG_DIR`, defaulting to the shared one so nothing changes for an existing install, and
  pass it to every process started for that account. Migration must be explicit and reversible, and
  never move a person's `~/.claude` without being asked.
- **Rotation policies per project**: which accounts a project may use, in which order, and at what
  usage threshold to rotate. The existing global auto-switch stays the default.
- **Usage history per account**: the usage Agentry already fetches, kept as rows in SQLite, with a
  series per account and window for the UI to draw.

## 7. Scheduling (task `scheduling`)

- Cron-like recurring chats and orchestrations: `Schedule` with a cron expression and a timezone,
  stored as JSON (the definition) plus a SQLite table of runs (the history).
- A scheduler in core that survives a restart: on boot, compute the next fire from the last run, and
  never fire the same slot twice. A missed window while the wrapper was down is skipped, not
  replayed — say so in the UI.
- CRUD routes, enable/disable, "run now", and `GET /schedules/:id/runs` for the history with what
  each run produced (chat or orchestration id, or the error).
- No `node-cron` dependency unless it is already in the lockfile: a small parser for the five-field
  expressions is enough and is testable. Justify whichever you choose in the commit body.

## 8. Usage and cost observability (task `usage-cost`)

- Usage and cost over time, per project and per model, from the records Agentry already keeps
  (`packages/core/src/usage.ts`, `usage-report.ts`, the chat records in SQLite). Buckets by day and
  by week, a range, and a breakdown by project and by model.
- `GET /usage/series` and `GET /usage/breakdown`, both with a date range.
- **Export of transcripts**: `GET /chats/:id/export?format=markdown|json` — Markdown readable by a
  person (turns, tool calls collapsed, cost and model in a header), JSON faithful to the events.
  Export a whole project too if it falls out cheaply.
- Numbers come from the CLI's own reporting, never estimated from token counts by hand.

## 9. Packaging (task `packaging`)

- **Pinned CLI version with an in-UI update check**: pin the version the image installs, expose
  `CliVersionInfo` (current, pinned, latest, whether an update is available) from what the CLI and
  its registry metadata report, and show it on the System page with what to do about it. The check
  is on demand or daily, never on every page load.
- **Helm chart** under `deploy/helm/` (or `charts/`): deployment, service, one PVC for the data
  volume, values for the image tag, the port, resources and the auth mode of section 2.
- **Compose profiles** in `docker-compose.yml`: a default profile, and one that puts the API behind
  a TLS-terminating proxy, matching the TLS guidance.
- **Healthcheck-driven restarts**: the image's healthcheck already exists; make the compose service
  and the chart restart on it, and document the signals the process handles so a restart is clean.
- Do not change the published tags or the release workflow.

## 10. The web half

Four tasks, each depending on the core work it shows. All of them: controls from
`components/controls`, status never colour alone, keyboard reachable, `aria-label` on icon-only
buttons, and specs under `e2e/specs/` that they **write but do not run**.

- **`web-observability`** (deps `git-changes`, `stuck-signals`) — on a task and a chat: branch and
  base, commits, changed files with `+/−`, uncommitted changes, a highlighted diff per file on
  click, the worker's checklist, and what it is doing now with time since its last event. A health
  badge (ok, slow, stuck, looping) with the reason in one line, and the three actions: cancel the
  command, send a hint (prefilled per signal), interrupt. Editor links: open the worktree, jump to a
  changed line (`vscode://file/<path>:<line>`), with the template, the optional `code --diff` button
  and the container→host path mapping as settings. Reuse the diff rendering that already exists for
  code blocks rather than adding a library.
- **`web-security`** (deps `security`) — configuration for the auth mode, setting and rotating the
  token (shown once), the OIDC fields, the read-only switch, the audit log as a filterable list, and
  a sign-in state for a `401` that is not a blank page.
- **`web-schedules-usage`** (deps `scheduling`, `usage-cost`) — a Schedules page (list, create with a
  cron builder that explains what it will do in words, enable/disable, run now, history) and a Usage
  page: cost and usage over time, by project and by model, with a range picker, plus the transcript
  export button on a chat. Charts: no new dependency — SVG drawn from the series, accessible (a
  table behind the chart or `aria` description), and readable in both themes.
- **`web-orchestration-v2`** (deps `orchestration-v2`, `accounts-config`, `connectors`) — relaunch
  and edit a finished graph, save and launch templates, per-task time and cost limits in the launch
  form, the verification phase's outcome when it exists; the per-account config directory, the
  per-project rotation policy and the usage history per account on the accounts page; and the
  connectors panel of section 5.

## 11. `docs` — the last task

Depends on every web task.

- `README.md`: the new features in the feature list, every new route in the REST API tables, the TLS
  and auth guidance of section 2, the Helm and compose profiles of section 9.
- `ROADMAP.md`: move everything this orchestration delivered into **Done**, rewrite the Done entries
  that #60 left stale (chats, projects and Agentry's own model), and leave in **Next** only what is
  genuinely still out: the Haiku supervisor, whatever a task reported as left out, and anything the
  CLI does not expose.
- `docs/plans/agent-observability.md` and this file: mark what landed, keep what did not and say
  why.
- **Never edit `CHANGELOG.md`**: release-please writes it from the commits.

## Outcome: what landed and what did not

Written by the `docs` task from what the branches actually contain, not from this plan. Where a
section above says otherwise, the code and this section win.

### Landed

| Section | What shipped |
| --- | --- |
| Shared types | Every type in one commit; later tasks added `ChatSubagent.sessionId`, `WorkflowEndedEvent.agentId`, `CliVersionInfo.error`, `VerificationSpec.timeoutMinutes`, `VerificationState.commit`, `orchestration.updated`'s `verificationStatus` and `ChatStartOptions.mcp: null` |
| 1 `git-changes` | Changes, diff and checklist routes for a task, the integration branch and a chat; `changes.updated` on the feed |
| 1 `stuck-signals` | Seven signals, `health.changed`, cancel one command, hint, per-task time and cost limits, a notification |
| 1 `e2e-harness` | A limit per spec and per run, and Chrome and the server closed by pid on every way out, proved by `e2e/harness.test.mjs` |
| 1 `verification-phase` | The checks once on the integration branch, a fixer with Agentry's rules and a cap, the outcome on the graph, `POST /orchestrations/:id/verify`, and the split of checks in every worker prompt |
| 1 `pending-gaps` | Six fixes, one commit each (below) |
| 2 `security` | `none`, `token` and `oidc`; hashed token; read-only; redaction in `GET /config/mcp` and `GET /config/settings`; audit log; `?token=` on three GETs; the web client sends the credential and a `401` is a sign-in screen |
| 3 `chat-mcp-tools` | `toolPreset` and `mcp` on start, resume and fork; three editable default presets in `tool-presets.json`; the chat shows what it runs with |
| 4 `orchestration-v2` | Re-run a task of a finished graph, relaunch with corrections, templates |
| 5 `connectors` | `GET /connectors` from `claude mcp list`, prepared prompts, authorisation steps, the out-of-reach sentence |
| 6 `accounts-config` | Config directory per account, rotation policies per project, usage history per account |
| 7 `scheduling` | Cron schedules with a hand-written parser (no dependency: none is in the lockfile, and a package that owns a timer is the opposite of one that restarts cleanly), a run table, run now, preview, skipped-not-replayed |
| 8 `usage-cost` | `GET /usage/series`, `GET /usage/breakdown`, per-model cost from the CLI's own `modelUsage`, transcript export as Markdown or JSON |
| 9 `packaging` | Pinned CLI and an update check, a Helm chart, a `tls` compose profile with Caddy, healthcheck-driven restarts, `docs/deploy.md` |
| 10 `web-observability` | Work panel, health actions, Changes and Doing-now cards, editor links and their settings tab |
| 10 `web-security` | The Security tab: mode, token shown once, OIDC fields, read-only, audit log |
| 10 `web-schedules-usage` | Schedules page with a cron builder, Usage page with an accessible SVG chart, export links on a chat |
| 10 `web-orchestration-v2` | Re-run, relaunch, templates, limits and the verification card; config directory, policies and usage history on the accounts page; the Connectors page |
| 11 `docs` | README (features, security and deployment guidance, UI, limitations), SECURITY.md, ROADMAP.md and the two plans |

The six `pending-gaps`: a chat already waiting raises a notification on load; a waiting notification opens
the prompt (`?prompt=<id>`); a chat cut off by a restart records why and when it stopped; `workflow.ended`
carries `agentId`; `sessionId` is on every subagent; `apps/web/test/detail.test.ts`.

### Left out, and why

- **The Haiku supervisor.** Out of scope by the plan. Each signal already carries a hint text Agentry
  writes; a second model to pay for, watch and trust would add little. Still open.
- **Health levels `slow`, `stuck`, `looping`.** The types kept `ok`, `warn`, `bad`: the plan's names mix a
  severity with three kinds of signal. The badge maps them for the person.
- **Editor settings on the server.** They are per browser (`agentry-editor:v1`): they describe the
  machine the editor runs on, and a server copy needs a route and a schema for one person's
  preference. `code --diff` is a copied command, not a button that runs it: a browser cannot.
- **Answering a permission from the notification.** The link opens the prompt, scrolled into view and
  focused; the toast still opens the chat.
- **Plugin and connector servers in a chat's MCP selection.** They are in no file Agentry can read, and
  `--strict-mcp-config` drops them. Forks do not inherit the source chat's tools, a resume keeps the
  MCP config as picked, and there is no named default preset and no "restore the shipped presets".
- **A sign-in through an identity provider.** `oidc` only validates a JWT. The audit log has no method or
  status filter and its path filter does not escape `%` and `_`; there is no banner on every page while
  read-only is on.
- **Verification.** No cost limit for the fixer, no install step Agentry adds itself, and a failed
  verification does not fail the graph.
- **Scheduling.** No overlap policy, no `schedule.*` event (the page refetches every 30 s), and no
  import of an existing orchestration into the form.
- **Usage.** No project export (core has no route), and the custom range is typed, not picked.
- **Packaging.** No Helm Ingress template, the chart is not wired into release-please, and the image
  build, the Caddy profile and the chart were checked with `helm lint`, `helm template` and
  `docker compose config`, not run.
- **Web-orchestration-v2.** Server-written strings (authorisation steps, link labels, out-of-reach
  reasons) are shown in English, and a template cannot be renamed without opening its graph.
- **Cancelling a command off Linux.** It reads `/proc`.
- **Browser coverage.** No task ran `pnpm e2e`. Specs were written for observability, security, schedules,
  usage, tool presets, connectors, accounts config and orchestration v2, and the health action buttons
  need a live process, so they have unit tests of their rules but no spec.

## Verification (2026-10-01)

This section checks every row of [Landed](#landed), every bullet of
[Left out, and why](#left-out-and-why) and [What "done" means](#what-done-means-for-this-orchestration)
against `main` at 0.29.1, following [verify-roadmap-plans.md](verify-roadmap-plans.md) (CW-7). Since
this plan was written, `main` has gained multiple providers (phases 1–2), code hosts (phase 1) and
the split of the web UI into `@agentry/ui` and `@agentry/chat-ui`. Where a claim is now met by code
that moved, the evidence names the file where the code is today. The marks: **done** means present
and working as described. **done later** means listed as left out here and built by
[post-roadmap](post-roadmap.md#outcome). **fixed** means repaired by this verification. **dropped**
means absent on purpose, with the reason. **open** means a follow-up that is too large to fix here.

### Landed

| Item | Mark | Evidence / reason |
| --- | --- | --- |
| Shared types, and the fields later tasks added | done | `packages/shared/src/types.ts`: `ChatSubagent.sessionId`, `WorkflowEndedEvent.agentId`, `CliVersionInfo.error`, `VerificationSpec.timeoutMinutes`, `VerificationState.commit`, `verificationStatus` on `orchestration.updated`, `ChatStartOptions.mcp?: McpSelection \| null`. Regenerating the OpenAPI schemas leaves no diff |
| 1 `git-changes` | done | `GET /chats/:id/changes`, `…/changes/diff` and `…/checklist`, the same under `/orchestrations/:id/tasks/:taskId/` and `/orchestrations/:id/integration/changes`; `changes.updated` from `packages/core/src/change-watcher.ts`. Tests: `packages/core/test/changes.test.ts`, `apps/api/test/changes.test.ts`; `observability.spec.mjs` passes |
| 1 `stuck-signals` | done | `packages/core/src/health.ts` and `health-service.ts` raise all seven signals (`hung-command`, `repeat-stall`, `no-progress`, `loop`, `weakened-test`, `silence`, `budget`) and four more. Command durations are rows of `command_durations` in `db.ts`. Cancel walks `/proc` in `processes.ts`. Routes: `POST /chats/:id/commands/:toolUseId/cancel` and `POST /chats/:id/hint`; limits in `task-limits.ts`. Tests: `health.test.ts`, `stuck-signals.test.ts` (core and api), `task-limits.test.ts`; `health-actions.spec.mjs` passes |
| 1 `e2e-harness` | done | `e2e/run.mjs` and `e2e/processes.mjs`: a limit per spec and per run, and kills by process group. `e2e/harness.test.mjs`: 14 of 14 pass on their own, and the full run is flaky under load (see [The checks](#the-checks)) |
| 1 `verification-phase` | done | `packages/core/src/verification.ts`, `POST /orchestrations/:id/verify`, the split of checks in every worker prompt (test "every worker is told which checks are its own…"). `packages/core/test/verification.test.ts`; `orchestration-v2.spec.mjs` passes |
| `pending-gaps`: a chat already waiting raises a notification on load | done | `seedWaiting` in `apps/web/src/lib/notifications.ts`, called from `components/Notifications.tsx`. It had no test of its own: `apps/web/test/notifications-seed.test.ts` (`ff8e0b3d`, `test(web): cover the notifications a page seeds from the prompts chats hold`) now covers it |
| `pending-gaps`: a waiting notification opens the prompt | done | `PROMPT_PARAM` (`?prompt=<id>`), read now in `packages/chat-ui/src/components/PermissionPrompts.tsx` (moved by the web split) |
| `pending-gaps`: a chat cut off by a restart says why and when | done | `INTERRUPTED_BY_RESTART` in `packages/core/src/chat-model.ts`; `restore.test.ts` "an execution a restart cut off says why, and stopped when…" |
| `pending-gaps`: `workflow.ended` carries `agentId` | done | `WorkflowEndedEvent.agentId: string \| null` in `types.ts` |
| `pending-gaps`: `sessionId` on every subagent | done | `ChatSubagent.sessionId: string` in `types.ts` |
| `pending-gaps`: `apps/web/test/detail.test.ts` | done | The file exists and passes; `detail.spec.mjs` passes |
| 2 `security` | done | `none`/`token`/`oidc` in `packages/core/src/security/` (JWKS validation in `oidc.ts`, with no dependency), and only the SHA-256 of a token is stored. Read-only answers `405` (`apps/api/src/security.ts`). `redactSecrets` covers `GET /config/mcp` and `GET /config/settings`. The audit log is `auditPage` in `db.ts`. There are now **five** `?token=` GETs, not three: post-roadmap added the two exports. Tests: `apps/api/test/security.test.ts` and `packages/core/test/security.test.ts`; `security.spec.mjs` passes |
| 3 `chat-mcp-tools` | done | `packages/core/src/chat-tools.ts` (three shipped presets, `--mcp-config` + `--strict-mcp-config` from `providers/claude-code/args.ts`); `chat-tools.test.ts`; `tool-presets.spec.mjs` passes |
| 4 `orchestration-v2` | done | `rerunTask` in `orchestrator.ts`, `POST /orchestrations/:id/relaunch` (`relaunchedFrom`), `orchestration-templates.ts` and the `/orchestrations/templates` routes; `orchestration-v2.spec.mjs` passes |
| 5 `connectors` | done | `packages/core/src/connectors.ts` runs `claude mcp list` and carries the out-of-reach entries (web artifacts, claude.ai memory); `connectors.test.ts`; `connectors.spec.mjs` passes when run alone, flaky under load |
| 6 `accounts-config` | done | `account-config.ts`, `PUT /accounts/:number/config`, `/accounts/policies`, `GET /accounts/usage`; `account-config.test.ts` ("every fresh reading of the usage is kept as a row…"); `accounts-config.spec.mjs` passes |
| 7 `scheduling` | done | `cron.ts` (no `node-cron`), `schedules.ts`, `GET /schedules/preview`, `GET /schedules/:id/runs`; `schedules.test.ts` ("a window missed while the wrapper was down is skipped, once…"); `schedules.spec.mjs` passes |
| 8 `usage-cost` | done | `GET /usage/series`, `GET /usage/breakdown` (`usage-series.ts`), `GET /chats/:id/export` (`chat-export.ts`); `usage-series.test.ts`; `usage.spec.mjs` passes |
| 9 `packaging` | done | `docker/Dockerfile` pins `CLAUDE_CODE_VERSION=2.1.278` and exports `AGENTRY_CLAUDE_CODE_PINNED`. `GET /system/cli-version` and `POST /system/cli-version/check` (`cli-version.test.ts`). `deploy/helm/agentry` has a deployment with startup, liveness and readiness probes, a service, a PVC and a secret. `docker-compose.yml` has the `tls` profile with Caddy and `restart: unless-stopped`; `docker compose config -q` passes for both profiles. `docs/deploy.md`. `helm` is not installed on this machine, so the chart was not linted |
| 10 `web-observability`: work panel, health actions, Changes and Doing now | done | `apps/web/src/components/observe/` (`Work.tsx`, `Health.tsx`), "Doing now" in `locales/en/observe.json`; `observability.spec.mjs` and `health-actions.spec.mjs` pass |
| 10 `web-observability`: editor links and their settings tab | dropped | Removed by [changes-review](changes-review.md) decision 1 (#115). Changes are reviewed inside Agentry, and `/settings/editor` answers 404. See [status.md](../status.md#what-is-built) |
| 10 `web-security` | done | `apps/web/src/pages/config/SecurityTab.tsx`, sign-in on a `401` (`apps/web/test/auth.test.tsx`); `security.spec.mjs` passes |
| 10 `web-schedules-usage` | done | `pages/Schedules.tsx` with a cron builder (`cron-builder.test.ts`, `cron-words.test.ts`), `pages/Usage.tsx` with a chart and its table, export links in `pages/chat/Header.tsx`; `schedules.spec.mjs` and `usage.spec.mjs` pass |
| 10 `web-orchestration-v2` | done | Re-run, relaunch, templates, limits and the verification card (`orchestration-v2.spec.mjs`); config directory, policies and usage history (`accounts-config.spec.mjs`); the Connectors page (`connectors.spec.mjs`) |
| 11 `docs` | done | README (features, *Securing it*, *Deploying*, Known limitations), `SECURITY.md`, `ROADMAP.md`. Every route in `routes.ts` (276) has a README row; this was checked by script, path by path, with combined rows such as `GET/PUT` |

### Left out, and why

| Item | Mark | Evidence / reason |
| --- | --- | --- |
| The Haiku supervisor | done later | [post-roadmap `supervisor`](post-roadmap.md#stage-1--core-and-api): `packages/core/src/supervisor.ts`, `/settings/supervisor`, `supervisor.test.ts`; `supervisor.spec.mjs` passes |
| Health levels `slow`, `stuck`, `looping` | dropped | The plan's own reason: "the plan's names mix a severity with three kinds of signal". `HealthLevel = 'ok' \| 'warn' \| 'bad'`, and the kind is on the signal |
| Editor settings on the server | dropped | Built later by post-roadmap `editor-settings-server`, then removed with the whole editor integration by [changes-review](changes-review.md) decision 1 (#115) |
| `code --diff` as a copied command | dropped | Removed with the editor integration (#115). CLAUDE.md now says "never hand out a command to copy" |
| Answering a permission from the notification | done later | [post-roadmap `web-security-2`](post-roadmap.md#stage-2--the-web): `PermissionAnswer` in `apps/web/src/components/NotificationPanel.tsx`; `notifications.spec.mjs` ("a tool permission has Allow and Deny in the list") passes |
| Plugin and connector servers in a chat's MCP selection | dropped | ROADMAP *Out of reach of the CLI* and README Known limitations: "they are in no file Agentry can read, and `--strict-mcp-config` drops them" |
| Forks do not inherit the source chat's tools | done later | post-roadmap `tool-presets-2`; `chat-tools.test.ts` "a fork runs with the tools and servers of its source unless it picks others" |
| A resume keeps the MCP config as picked | done later | post-roadmap `tool-presets-2`; `chat-tools.test.ts` "a resume that picks no servers starts them as they are defined now" |
| No named default preset, no "restore the shipped presets" | done later | post-roadmap `tool-presets-2`: `PUT /config/tool-presets/default`, `POST /config/tool-presets/restore`; `apps/api/test/tool-presets.test.ts`; `tool-presets.spec.mjs` passes |
| A sign-in through an identity provider | dropped | ROADMAP *Decided against, for now*: "a browser login flow … is a product of its own" |
| The audit log's method and status filters, and escaping `%` and `_` | done later | post-roadmap `security-2`: `auditPage` uses `path LIKE ? ESCAPE '\'`, and `GET /audit` takes `method` and `status`; filters on the Security tab |
| A banner on every page while read-only is on | dropped | ROADMAP *Decided against, for now*: "a strip across every screen buys nothing for the noise" |
| Verification: no fixer cost limit, no install step, a failed check does not fail the graph | done later | post-roadmap `verification-2`; `verification.test.ts` (cost limit, lockfile install, `failGraph`) |
| Scheduling: no overlap policy, no `schedule.*` event, no import of an orchestration | done later | post-roadmap `scheduling-2` and `web-chats-tools`; `schedules.test.ts` (overlap, events); "From an existing orchestration" in the schedule form; `schedules.spec.mjs` passes |
| Usage: no project export, the custom range is typed | done later | post-roadmap `usage-2` (`GET /projects/:id/export`, `project-export.test.ts`) and `web-schedules-usage-2` (`DatePicker`, now in `packages/ui/src/components/controls/DatePicker.tsx`, used by `pages/Usage.tsx`) |
| Packaging: no Ingress, the chart is not under release-please, nothing run for real | dropped | ROADMAP *Decided against, for now*, "Packaging, taken separately". `deploy/helm` still has no Ingress template, and `release-please-config.json` does not name the chart |
| Server-written strings shown in English; a template cannot be renamed in place | done later | post-roadmap `i18n-server-strings` and `web-schedules-usage-2` (`apps/web/src/lib/server-strings.ts`, `server-strings.test.ts` in core and web); `web-chats-tools` (rename in place, `orchestration-v2.spec.mjs` "rename a template in place") |
| Cancelling a command off Linux | dropped | ROADMAP *Out of reach of the CLI* and README Known limitations: "cancelling a command needs Linux" (`/proc`) |
| Browser coverage: no spec run, no spec for the health action buttons | done later | post-roadmap `e2e-health-actions` (`e2e/fake-cli/claude`, `health-actions.spec.mjs`). The specs this plan wrote pass here (see [The checks](#the-checks)) |

### What "done" means

| Item | Mark | Evidence / reason |
| --- | --- | --- |
| `pnpm typecheck`, `pnpm test`, `pnpm build` green | done | See [The checks](#the-checks) |
| `pnpm e2e` green once at the end | open → follow-up | This plan's specs pass one by one, and `connectors` is flaky under load. The full suite was not run here, and its last run on `main` failed 6 specs ([status.md](../status.md#how-it-is-checked)). A full run belongs to its own task: see [post-roadmap's follow-ups](post-roadmap.md#follow-ups) |
| OpenAPI schemas regenerated and committed | done | No drift after `openapi:schemas` |
| Every task's result says what it delivered, left out and verified | done | Recorded in [Outcome](#outcome-what-landed-and-what-did-not), and checked item by item above |

### The checks

Run on 2026-10-01 in a worktree off `main`, on a machine with a load average between 23 and 58.
Typecheck and the unit tests ran on `main` at `7242b4fe` (0.29.1). The build, the harness test and
the browser specs ran on `e0efe0eb`, which is `main` plus the two commits of this verification: a
corrected route description and a new test. A third commit, `ff8e0b3d`, adds
only a unit test.

- `pnpm typecheck`: passes, all seven workspace projects (`TYPECHECK EXIT 0`).
- `pnpm test`: passes. 2,714 tests (core 1,443, web 967, api 217, desktop 49, shared 31, chat-ui 4,
  ui 3), `# fail 0` in every package. `apps/api/test/security.test.ts`, run again on its own after
  `e0efe0eb`: `# pass 35`, `# fail 0`. The web suite, run again after `ff8e0b3d` added a test:
  `# pass 969`, `# fail 0`.
- `pnpm build`: passes (`✓ built in 13.93s`, `BUILD EXIT 0`).
- `pnpm --filter @agentry/api openapi:schemas`: `wrote 502 schemas`, and `git status` shows no diff.
- `node --test e2e/harness.test.mjs`: **14 tests pass on their own; the run as a whole is flaky under
  load.** In one run at a load near 58, 10 passed and 4 failed. Two failed because a probe spec never
  started inside the 12 s run limit. Two failed with `API did not start`: the runner waits about 20 s
  for `/api/system`, and the server did not answer in that time. Run alone, two passed. The other two
  (`E2E_SHARDS=1 and a single spec…` and `SIGTERM to a sharded run…`) failed again with the same
  message, then passed on a second try at a load near 31 (`# pass 1`, `# fail 0` each). No port was
  taken in the harness's range. This is the server's start-up time under load, not a fault in the
  harness. See the follow-ups.
- `pnpm e2e`: **the full suite was not run.** This verification ran only the specs that prove a
  claim of these two plans, one at a time
  (`node e2e/run.mjs <spec>` with `E2E_PORT=8863`): `observability`, `health-actions`, `security`,
  `notifications`, `detail`, `schedules`, `usage`, `tool-presets`, `connectors`, `accounts-config`,
  `orchestration-v2` and `supervisor`. On the first try, 11 passed and `connectors.spec.mjs` failed
  with `assertion failed: Connectors is in the navigation`. Run again alone, it passed (`✓
  connectors.spec.mjs (5.2s)`, `all 1 spec file(s) passed`). The spec reads the sidebar a fixed
  1.2 s after it loads `/`, and the item is in `App.tsx`'s `space` group. So it is flaky under load.
  It is not on the list of [known flaky specs](redesign-night-shift.md#before-launching), which names
  `config`, `home`, `observability`, `chats` and `orchestration-v2`. The last full-suite results on
  `main` are in [status.md](../status.md#how-it-is-checked).

**Count:** 48 items. 27 done, 11 done later, 9 dropped, 1 open. No claim of the plan failed.
`fixed` is not used in this plan: the one wrong text found (the `?token=` list) is recorded in
[post-roadmap](post-roadmap.md#verification-2026-10-01), whose claim it is.

## Verification (2026-10-07)

The final verification: every item again, on `main` at `a0d6f2967` (0.33.1), and the full
`pnpm e2e` suite the run of 2026-10-01 left open. Since then `main` has gained multiple providers
phases 3 and 4 (#167, #188), code hosts phases 2 to 6, the decision engine's later points, and
dropped Jira ([no-jira.md](../decisions/no-jira.md), #211). Phase 4 retired claude-swap and the
Accounts page, which changes two marks below. Every file and test named in the 2026-10-01 tables
was looked up again; the rows that only repeat that check say "as on 2026-10-01".

### Landed

| Item | Mark | Evidence / reason |
| --- | --- | --- |
| Shared types, and the fields later tasks added | done | As on 2026-10-01, every name still in `packages/shared/src/types.ts`. `openapi:schemas` writes 596 schemas and leaves no diff |
| 1 `git-changes` | done | The eight changes, diff and checklist routes are in `routes.ts` (with `…/changes/steps` added by #115); `change-watcher.ts`, `changes.test.ts` (core and api); `observability.spec.mjs` |
| 1 `stuck-signals` | done | As on 2026-10-01: `health.ts`, `health-service.ts`, `processes.ts`, `task-limits.ts`, `command_durations` in `db.ts`, `POST /chats/:id/commands/:toolUseId/cancel`, `POST /chats/:id/hint`; `health-actions.spec.mjs` |
| 1 `e2e-harness` | done | `e2e/run.mjs`, `e2e/processes.mjs`; `node --test e2e/harness.test.mjs` (see [the checks](#the-checks-2026-10-07)). The server start limit is now `E2E_SERVER_START_TIMEOUT`, 120 s by default, which closes the 2026-10-01 follow-up |
| 1 `verification-phase` | done | `verification.ts`, `POST /orchestrations/:id/verify`, `verification.test.ts` "every worker is told which checks are its own, whatever the objective says" |
| `pending-gaps`: a chat already waiting raises a notification on load | done | `seedWaiting` in `apps/web/src/lib/notifications.ts`, called from `components/Notifications.tsx`; `apps/web/test/notifications-seed.test.ts` |
| `pending-gaps`: a waiting notification opens the prompt | done | `PROMPT_PARAM` in `packages/chat-ui/src/lib/permission-param.ts`, read by `PermissionPrompts.tsx` and written by `apps/web/src/lib/notifications-model.ts` |
| `pending-gaps`: a chat cut off by a restart says why and when | done | `INTERRUPTED_BY_RESTART` in `chat-model.ts`; `restore.test.ts` "an execution a restart cut off says why…" |
| `pending-gaps`: `workflow.ended` carries `agentId` | done | `WorkflowEndedEvent` in `types.ts` |
| `pending-gaps`: `sessionId` on every subagent | done | `ChatSubagent` in `types.ts` |
| `pending-gaps`: `apps/web/test/detail.test.ts` | done | The file passes; `detail.spec.mjs` |
| 2 `security` | done | As on 2026-10-01 (`security/oidc.ts`, `redactSecrets`, `auditPage`); `QUERY_TOKEN` in `apps/api/src/security.ts` lists five `?token=` GETs, and `apps/api/test/security.test.ts` checks all five; `security.spec.mjs` passes after `392455dee` made it wait for the tab's cards |
| 3 `chat-mcp-tools` | done | `chat-tools.ts`, `--strict-mcp-config` in `providers/claude-code/args.ts`, `chat-tools.test.ts`; `tool-presets.spec.mjs` |
| 4 `orchestration-v2` | done | `rerunTask` (`orchestrator.ts`), `POST /orchestrations/:id/relaunch`, `relaunchedFrom`, `orchestration-templates.ts`; `orchestration-v2.spec.mjs` |
| 5 `connectors` | done | `connectors.ts`, `connectors.test.ts`; `connectors.spec.mjs` now waits for `#sidebar nav a` instead of a fixed pause, which closes the 2026-10-01 follow-up |
| 6 `accounts-config` | dropped | Retired with claude-swap by multiple providers phase 4 (#188): "Several accounts of one provider. Decision 6: one account per provider, the one signed in to its CLI" ([Out of scope](multi-provider.md#out-of-scope-2)). `account-config.ts`, its test, the `/accounts` routes and `accounts-config.spec.mjs` are gone; README *Coming from claude-swap* says so, and ROADMAP's Multi-account bullet now does too |
| 7 `scheduling` | done | `cron.ts`, `schedules.ts`, `GET /schedules/preview`, `GET /schedules/:id/runs`; `schedules.test.ts`; `schedules.spec.mjs` |
| 8 `usage-cost` | done | `GET /usage/series`, `GET /usage/breakdown` (`usage-series.ts`), `GET /chats/:id/export` (`chat-export.ts`); `usage-series.test.ts`; `usage.spec.mjs` |
| 9 `packaging` | done | `docker/Dockerfile` (`CLAUDE_CODE_VERSION=2.1.278`, `AGENTRY_CLAUDE_CODE_PINNED`), the `cli-version` routes and test, `deploy/helm/agentry` (deployment, service, PVC, secret), Caddy's `tls` profile in `docker-compose.yml`, `docs/deploy.md`. `helm` is still not installed here |
| 10 `web-observability`: work panel, health actions, Changes and Doing now | done | `components/observe/Work.tsx`, `Health.tsx`; `observability.spec.mjs`, `health-actions.spec.mjs` |
| 10 `web-observability`: editor links and their settings tab | dropped | As on 2026-10-01: removed by [changes-review](changes-review.md) decision 1 (#115); no `settings/editor` anywhere in the source |
| 10 `web-security` | done | `pages/config/SecurityTab.tsx`, `apps/web/test/auth.test.tsx`; `security.spec.mjs` (after `392455dee`) |
| 10 `web-schedules-usage` | done | `pages/Schedules.tsx`, `pages/Usage.tsx`, export links in `pages/chat/Header.tsx`; `cron-builder.test.ts`, `cron-words.test.ts`; `schedules.spec.mjs`, `usage.spec.mjs` |
| 10 `web-orchestration-v2`: re-run, relaunch, templates, limits, verification card, Connectors page | done | `orchestration-v2.spec.mjs`, `connectors.spec.mjs` |
| 10 `web-orchestration-v2`: config directory, policies and usage history on the accounts page | dropped | The Accounts page was retired in #188, as for `accounts-config` above |
| 11 `docs` | done | README, `SECURITY.md`, `ROADMAP.md`. Every one of the 324 routes in `routes.ts` has a README row (checked by script; the plugin actions share one row) |

### Left out, and why

| Item | Mark | Evidence / reason |
| --- | --- | --- |
| The Haiku supervisor | done later | [post-roadmap `supervisor`](post-roadmap.md#supervisor): `supervisor.ts` (model `haiku`, the `read-only` preset, `maxCostUsd`), `supervisor.spec.mjs` |
| Health levels `slow`, `stuck`, `looping` | dropped | The plan's own reason; `HealthLevel = 'ok' \| 'warn' \| 'bad'` |
| Editor settings on the server | dropped | Built by post-roadmap, then removed with the editor integration (#115) |
| `code --diff` as a copied command | dropped | Removed with the editor integration (#115); CLAUDE.md: "never hand out a command to copy" |
| Answering a permission from the notification | done later | post-roadmap `web-security-2`: `PermissionAnswer` in `components/NotificationPanel.tsx`; `notifications.spec.mjs` |
| Plugin and connector servers in a chat's MCP selection | dropped | README Known limitations, as on 2026-10-01 |
| Forks do not inherit the source chat's tools | done later | post-roadmap `tool-presets-2`; `chat-tools.test.ts` "a fork runs with the tools and servers of its source…" |
| A resume keeps the MCP config as picked | done later | post-roadmap `tool-presets-2`; `chat-tools.test.ts` "a resume that picks no servers…" |
| No named default preset, no "restore the shipped presets" | done later | `PUT /config/tool-presets/default`, `POST /config/tool-presets/restore`; `apps/api/test/tool-presets.test.ts`; `tool-presets.spec.mjs` |
| A sign-in through an identity provider | dropped | ROADMAP *Decided against, for now* |
| The audit log's method and status filters, and escaping `%` and `_` | done later | post-roadmap `security-2`: `ESCAPE '\'` in `db.ts`, `method` and `status` on `GET /audit` |
| A banner on every page while read-only is on | dropped | ROADMAP *Decided against, for now* |
| Verification: no fixer cost limit, no install step, a failed check does not fail the graph | done later | post-roadmap `verification-2`; `verification.test.ts` "a spec keeps its cost limit, install step and failGraph…" |
| Scheduling: no overlap policy, no `schedule.*` event, no import of an orchestration | done later | post-roadmap `scheduling-2` and `web-chats-tools`; `schedules.test.ts`; "From an existing orchestration" in `locales/en/schedules.json` |
| Usage: no project export, the custom range is typed | done later | post-roadmap `usage-2` (`project-export.ts`, `project-export.test.ts`) and `web-schedules-usage-2` (`packages/ui/src/components/controls/DatePicker.tsx`) |
| Packaging: no Ingress, the chart is not under release-please, nothing run for real | dropped | ROADMAP *Decided against, for now*. `deploy/helm/agentry/templates` has no Ingress, and `release-please-config.json` does not name the chart |
| Server-written strings shown in English; a template cannot be renamed in place | done later | post-roadmap `i18n-server-strings` (`server-strings.test.ts` in core and web) and `web-chats-tools` (`orchestration-v2.spec.mjs` "rename a template in place") |
| Cancelling a command off Linux | dropped | README Known limitations: it reads `/proc` |
| Browser coverage: no spec run, no spec for the health action buttons | done later | post-roadmap `e2e-health-actions` (`e2e/fake-cli/claude`, `health-actions.spec.mjs`), and the full suite ran on this date (below) |

### What "done" means

| Item | Mark | Evidence / reason |
| --- | --- | --- |
| `pnpm typecheck`, `pnpm test`, `pnpm build` green | done | The typecheck and the build pass. The tests pass but for two web timing tests that missed their budget at a load near 109 and pass alone; see [the checks](#the-checks-2026-10-07) |
| `pnpm e2e` green once at the end | open → CW-32 | The full suite ran once and was not green on this machine (45 passed, 14 failed, 11 not run). Alone, 21 of the 25 pass, three more pass after `392455dee` and `26004cc82`, and only `paging.spec.mjs` still fails: CW-32. CI ran the suite green the same day |
| OpenAPI schemas regenerated and committed | done | `wrote 596 schemas`, no diff |
| Every task's result says what it delivered, left out and verified | done | [Outcome](#outcome-what-landed-and-what-did-not), checked item by item above |

### The checks (2026-10-07)

Run on 2026-10-07 in a worktree off `main` at `a0d6f2967` (0.33.1), each once, under `timeout`. The
machine was shared with other orchestrations: the load average was between 65 and 109 on 12 cores
for the typecheck, the tests and the build, and fell to between 12 and 25 afterwards. The only commit
of this verification before the checks touched `ROADMAP.md` alone.

- `pnpm typecheck`: passes, every workspace project (`TYPECHECK EXIT 0`).
- `pnpm test`: **4,074 tests pass, 2 fail, both timing budgets missed under load.** shared 32,
  ui 3, chat-ui 4 and web 1,236 of 1,238. pnpm stops at the first package that fails, so core, api,
  mcp and desktop were run straight after with `pnpm --no-bail --filter …`: core 2,463, api 272,
  desktop 52, mcp 12, `# fail 0` in each. The two web failures, at a load near 109:
  - `highlight.test.ts` "the first block in a grammar shiki compiles on the spot is still coloured":
    1 styled run instead of 3, because compiling the C++ grammar ran past the per-line time budget
    (the test took 17.8 s);
  - `robustness.test.ts` "a block of 59 000 characters of one shape is still read in time": `bash`
    took 43.8 s over 59,000 characters of `"\r\n"`, past the test's 30 s.

  Run alone at a load near 100 both failed again; run alone at a load near 18
  (`npx tsx --test test/highlight.test.ts test/robustness.test.ts`), `# pass 14`, `# fail 0`. They
  measure time, so they fail on a machine this loaded and are recorded as flaky under load, not as
  a fault.
- `pnpm build`: passes (`BUILD EXIT 0`).
- `pnpm --filter @agentry/api openapi:schemas`: `wrote 596 schemas`, and `git status` shows no diff.
- `node --test e2e/harness.test.mjs`, by hand at a load near 12: `# tests 14`, `# pass 14`,
  `# fail 0`, the whole file in one run. The 2026-10-01 flake (`API did not start`) is gone with the
  120 s server start limit.
- `E2E_PORT=8899 timeout 3000 pnpm e2e`, once, after `pnpm build`: **the full suite ran, and it was
  not green.** Four shards on ports 8899 to 8902 (620 to 864 s each, against 305 to 345 s
  estimated), at a load average of 16 when it started and up to 63 during it. Of the 71 spec files,
  45 passed, `chat.spec.mjs` was skipped (it needs `E2E_LIVE=1`), 14 failed, and 11 were not run:
  `merge.spec.mjs` passed its 600 s limit, and shard 1 stops after a timed-out spec, since that spec
  may still be driving the browser. One failure (`create-ai-stream`) was `Unknown system error
  -122` on a write: `/tmp`, a 16 GB tmpfs shared with the other orchestrations' test runs, went
  from 46 % to 80 % full during the afternoon.

  Each of the 25 was then run alone (`E2E_SHARDS=1 node e2e/run.mjs <spec>.spec.mjs`), one at a
  time, on `E2E_PORT=8951`. Another orchestration started its own e2e run on 8899 to 8901 halfway
  through, so the solo runs of `shell` and `tasks-review` that met it were thrown away and repeated
  on 8951.
  - **Passed alone at the first try (16):** `detail`, `team-gaps`, `checks`, `create-ai-stream`,
    `decisions`, `flow-waiting`, `merge` (235 s), and nine of the 11 that never ran: `models`,
    `motion`, `provider-rotation`, `providers-chat`, `providers`, `slash-menu`, `suggest`,
    `tasks-links` and `trackers`.
  - **Flaky under load (5):** they failed alone at loads between 28 and 51 and passed alone later:
    `projects-wizard` ("the card shows the key"), `orchestration-v2` ("Show all resets the search",
    twice at loads of 41 and 51, then passed at 19), `reviews`, `tasks-item` and `webhooks` (whose
    second solo run died on `disk I/O error` from SQLite as `/tmp` filled, and whose third passed).
    Of the known flaky specs in [redesign-night-shift.md](redesign-night-shift.md#before-launching)
    (`config`, `home`, `observability`, `chats`, `orchestration-v2`), only `orchestration-v2` is
    among them; the others passed in the full run.
  - **Fixed (3):** `security`, `shell` and `tasks-review` failed alone each time, each because it
    read the page a fixed pause after loading it. `security` read the tab before
    `/security/auth` answered: the audit log was drawn and the Read-only, Access and Token cards were
    not yet (a screenshot taken a moment later shows them all). `shell` measured the phone tab bar,
    and the FAB on the new orchestration form, before they were drawn. `tasks-review` pressed `n`
    before the board that owns the shortcut was drawn. They now wait for those conditions, as #166
    did for the others: `392455dee` (`test(e2e): wait for the security tab's cards instead of a
    fixed pause`) and `26004cc82` (`test(e2e): wait for the phone tab bar, the new orchestration
    form and the board instead of fixed pauses`). All three pass alone after the change.
  - **Open (1):** `paging.spec.mjs`, "no long tasks while typing", failed alone three times, at loads
    of 41, 39 and 22, with 16 to 27 long tasks of 52 to 268 ms. It also failed alone on 2026-09-28.
    The check fails on any long task over 50 ms, so on this machine it cannot tell a regression from
    a busy CPU: **CW-32**.

  For comparison, CI ran all four e2e shards green the same day on `5a253a2c4` (run 37629191381, a
  branch that contains #205 and #211), on runners nobody else was using.

**Count:** 49 items (the `web-orchestration-v2` row is split in two). 26 done, 11 done later, 11
dropped, 1 open (CW-32). Against 2026-10-01, two marks changed from done to dropped, because #188
retired the accounts pieces on purpose, and the open item moved from "the full suite was never run"
to the one spec that fails alone. No claim of the plan failed. `fixed` is not used for a claim:
the three e2e specs repaired here tested claims that hold, and are recorded in
[the checks](#the-checks-2026-10-07).

## What "done" means for this orchestration

`pnpm typecheck`, `pnpm test`, `pnpm build` green on the integration branch, `pnpm e2e` green once
at the end, the OpenAPI schemas regenerated and committed, and every task's result saying plainly
what it delivered, what it left out, and how it verified it.

## Related

[[plans/post-roadmap.md]] · [[plans/agent-observability.md]] · [[status.md]] ·
[[plans/verify-roadmap-plans.md]] · [[plans/changes-review.md]]
