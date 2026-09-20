# Plan: finish the roadmap

Status: **built; final verification pending**. Run as one orchestration on top of `main` at
`f78fab7` (`feat!: chats, projects and Agentry's own model`). Every task below has landed except the
pieces listed under [Outcome](#outcome-what-landed-and-what-did-not). `pnpm typecheck` and
`pnpm test` are green on the integrated branch; **no task ran `pnpm e2e`** (the rules forbade it), so the
browser specs the tasks wrote are unrun until the verification task at the end runs the suite.

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

## What "done" means for this orchestration

`pnpm typecheck`, `pnpm test`, `pnpm build` green on the integration branch, `pnpm e2e` green once
at the end, the OpenAPI schemas regenerated and committed, and every task's result saying plainly
what it delivered, what it left out, and how it verified it.
