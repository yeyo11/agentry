# Plan: what the roadmap left open

Status: **specified, not launched**. Written on 2026-09-21 on top of `main` at `3aca743`
(v0.14.0), after the two orchestrations that built [agents-redesign.md](agents-redesign.md) (#60)
and [roadmap-completion.md](roadmap-completion.md) (#62). It closes the **Not built yet** list of
[ROADMAP.md](../../ROADMAP.md), minus what was decided against (below), and re-records the README's
media, which still shows the navigation from before #60.

This document is the source of truth for every task of the orchestration that runs it. Where a task
prompt and this plan disagree, this plan wins. Where this plan and
[CONTRIBUTING.md](../../CONTRIBUTING.md) disagree, CONTRIBUTING wins.

## Decided against, and why

These stay in the roadmap's **Next** and are not part of this orchestration. The `docs` task writes
the reasons there.

- **A banner on every page while read-only is on.** The Security tab says so; a person who turned
  it on knows.
- **A sign-in through an identity provider.** Agentry validates a JWT; a browser login flow
  (authorization code + PKCE) is a product of its own.
- **Helm Ingress, the chart under release-please, a real cluster in CI, and the e2e harness test in
  CI.** Packaging work, taken separately.

## The one rule, again

Agentry reaches Claude Code **only through its CLI**: flags, subcommands, stream-json events, files
the CLI writes. No SDK, no HTTP call to Anthropic, no terminal scraping. If a piece of a feature
below cannot be expressed that way, leave it out and say so in your result instead of inventing a
surface.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects,
   in English, body explaining why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with" trailer, ever.
3. **Code, comments, docs and UI strings in English.**
4. **Checks you run:** `pnpm typecheck` and `pnpm test`. You may *write or update* e2e specs, but
   **do not run `pnpm e2e`**: the verification phase runs the suite once on the integrated branch.
   Running it in parallel with other workers hangs it. The one exception is the `media` task,
   which drives a single sandboxed browser through the e2e driver, never the suite.
5. **Every long command under `timeout`**, e.g. `timeout 300 pnpm test`. If a command hits its
   timeout twice, stop retrying it and report it in your result.
6. **After touching `packages/shared/src/types.ts`**, run
   `pnpm --filter @agentry/api openapi:schemas` and commit the regenerated schemas. CI fails on
   drift.
7. **Every new route** needs a summary and a tag in `apps/api/src/openapi/routes.ts` (a test
   enforces it) and a row in the README REST API tables, which you add yourself.
8. **TypeScript strict, no `any`**, respect `noUncheckedIndexedAccess`. Comments explain why.
9. **Persistence:** settings-shaped documents in JSON files; streams and accumulating records as
   rows in SQLite (`packages/core/src/db.ts`).
10. **UI controls come from `apps/web/src/components/controls`** — never native
    `select`/`checkbox`/`range`/`date`/`details`/`title=`. Status is never colour alone: reuse
    `StatusBadge` and `Tag`. Icon-only buttons carry an `aria-label`. Keep
    `e2e/specs/a11y.spec.mjs` green.
11. **Do not touch files outside your scope.** The shared types land once, in the `types` task;
    every other task builds on them and only adds what its own feature needs. `README.md` (except
    the REST rows of rule 7), `ROADMAP.md` and `docs/plans/*` are edited by the `docs` task: put
    your feature's documentation notes in your result and let it write them.
12. **Every UI string has a key in `apps/web/src/i18n/locales/en` and `es`**, with parity; the
    untranslated-text guard in the web tests must stay green.
13. If something in your scope turns out to be impossible over the CLI, or much larger than it
    looks, **do the rest and say what you left out** in your result. Do not silently narrow the
    scope, and never loosen an existing test or assertion to make a check pass.

## Stage 0 — the shared types (task `types`)

One task lands every new type in `packages/shared/src/types.ts`, so the workers below do not
conflict in one file. It writes types and nothing else: no core logic, no routes, no UI. It leaves
`pnpm typecheck` green, with the OpenAPI schemas regenerated, and adds the route entries below to
`apps/api/src/openapi/routes.ts` as stubs only if the routes test needs them (otherwise each task
adds its own).

- **Audit** — `AuditFilter { path?, method?, status? }` as the query of `GET /audit`; `status`
  accepts a code (`404`) or a class (`4xx`).
- **Tool presets** — `ToolPresetsConfig { defaultPresetId: string | null }` and a
  `GET /config/tool-presets` shape that carries it beside the list.
- **Verification** — on `VerificationSpec`: `maxCostUsd?: number`, `install?: string | null`
  (absent: detected from the lockfile; `null`: no install step; a string: that command),
  `failGraph?: boolean`. On `VerificationState`: `costUsd: number`.
- **Rotation** — `RotationPolicy.looseChats?: boolean` (and on the request): the policy also
  governs chats that belong to no project.
- **Scheduling** — `ScheduleOverlap = 'parallel' | 'skip' | 'queue'`, `Schedule.overlap`
  (default `parallel`, which is today's behaviour), `ScheduleRunStatus` gains `'overlapped'`;
  events `schedule.changed { scheduleId, action }` and `schedule.fired { scheduleId, runId }`.
- **Usage** — `ProjectExport { project: Project, exportedAt, chats: ChatExport[] }`.
- **Server strings** — a `Localized { code: string; params?: Record<string, string | number>;
  text: string }` shape, used by `HealthSignal.reason` and `.hint` (keep the plain `text` in the
  existing fields for API readers and add `reasonCode`/`hintCode` + `params`, whichever reads
  better; say which in your result) and by the connector's authorisation steps, link labels and
  out-of-reach reasons.
- **Supervisor** — `SupervisorConfig { enabled: boolean; model: string; autoSend: boolean;
  maxCostUsd: number }`, `SupervisorProposal { id, chatId, taskId?, orchestrationId?, signal:
  HealthSignalKind, hint, costUsd, at, status: 'proposed' | 'sent' | 'dismissed' }`, event
  `supervisor.proposed`, `ChatHealth.proposal?: SupervisorProposal | null`.
- **Editor** — `EditorSettings` unchanged; `UpdateEditorSettingsRequest = EditorSettings`.

Names and shapes are a starting point: if a downstream task needs a different field, it adds it.
What matters is that the churn in `types.ts` happens mostly here.

## Stage 1 — core and API, in parallel, on `types`

### `security-2`

- **Audit filters.** `GET /audit` takes `method` and `status` beside `path`. The path filter in
  `db.ts` (`auditPage`) escapes `%`, `_` and `\` with `ESCAPE '\'`, so a filter on `%` matches a
  literal percent. Tests with paths that contain `%` and `_`.
- **Recovering the token without file access.** Today `AGENTRY_AUTH_TOKEN` is read only on a
  fresh install (`security/auth.ts`, `fromEnvironment`). Add `AGENTRY_AUTH_TOKEN_RESET=1`: on
  start, the token in the environment replaces the stored hash, the change is written to the audit
  log with actor `env`, and the same value is not applied twice (keep the hash of the last value
  applied, so a restart with the variable still set changes nothing). Document it in
  `.env.example` and in `SECURITY.md`'s recovery paragraph.

### `tool-presets-2`

- `defaultPresetId` in `tool-presets.json`, editable through `PUT /config/tool-presets/default`
  (or a field on the existing config route; say which). A new chat with neither `toolPreset` nor
  `allowedTools` takes it; `toolPreset: null` opts out.
- `POST /config/tool-presets/restore` rewrites the three shipped presets (`read-only`,
  `no-network`, `everything`) and leaves every other preset alone.
- **A fork inherits** the source chat's `ChatToolConfig` (preset, allowed and disallowed tools,
  MCP selection) unless the request says otherwise.
- **An edited server is picked up on resume.** A resume with no `mcp` in the request regenerates
  the `--mcp-config` file from the current definition of the same servers. Test: edit a server,
  resume, the file the CLI reads has the new value.

### `verification-2`

Touches `verification.ts` and `orchestrator.ts`; keep resume, retry, skip, integration and the
workflow engine green.

- **A cost limit for the fixer.** `maxCostUsd` on the spec goes to the CLI as `--max-budget-usd`,
  with what is left after each attempt; when it is spent, the verification is `failed` with a
  report that says so. `VerificationState.costUsd` accumulates it and the graph's cost includes it.
- **An install step Agentry adds itself.** With `install` absent, detect the lockfile in the
  integration worktree (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `package-lock.json`
  → `npm ci`, `yarn.lock` → `yarn install --frozen-lockfile`) and run it before the commands, as
  its own row in `VerificationState.commands`. `install: null` disables it; a string replaces it.
- **A failed verification can fail the graph.** `failGraph: true` ends the orchestration as
  `failed`, with an error that says the checks failed, and no pull request is offered. The
  default stays `false`: the graph's status stays about its tasks.

### `loose-rotation`

A rotation policy can govern chats that belong to no project (`looseChats`). When a chat with
`project === null` starts, that policy is applied before the global auto-switch, the same way a
project's policy is today. At most one policy has `looseChats`. Tests next to the existing ones in
`account-config`.

### `scheduling-2`

- **Overlap policy.** A slot fires while the last run is still going (its chat is `working` or
  its orchestration `running`): `parallel` starts it anyway (today), `skip` writes a run with
  status `overlapped` and starts nothing, `queue` starts it when the previous run ends, one
  pending at most — a slot that arrives while one is queued replaces it, and the run it writes
  says which slot it answers.
- **Events.** `schedule.changed` on create, edit, delete, enable and disable, and whenever
  `nextRunAt` is recomputed; `schedule.fired` when a run row is written. Both through
  `packages/core/src/events.ts`, with `Last-Event-ID` resume like every other event.

### `usage-2`

`GET /projects/:id/export?format=markdown|json`. Markdown: a header with the project, the range of
dates, models and the cost the CLI reported, then every chat as a section rendered the way
`chat-export.ts` renders one. JSON: a `ProjectExport`. Both streamed, because a project can hold
hundreds of chats; the response carries `content-disposition` with a file name.

### `i18n-server-strings`

- **Connectors** (`connectors.ts`): the authorisation steps, the link labels and the out-of-reach
  reasons carry a stable `code` and `params` beside the English text.
- **Health** (`health.ts`): every signal's `reason` and `hint` carry a `code` and the figures that
  made it fire (`params`: the command, the minutes, the file, the count) beside the text.
- A test that every code is stable and every text has a code. The web half is in
  `web-schedules-usage-2`.

### `supervisor`

The optional supervisor of [agent-observability.md](agent-observability.md) §3, off by default.

- `supervisor.json` in the data directory (settings-shaped): `enabled: false`, `model: 'haiku'`,
  `autoSend: false`, `maxCostUsd: 0.05`. `GET /settings/supervisor`, `PUT /settings/supervisor`.
- When enabled, a `health.changed` that reaches `bad` wakes it **once per signal per chat**, not on
  every tick: a housekeeping chat (`origin: internal`, no Agentry transcript record, the
  `read-only` preset, `--max-budget-usd` from the config) gets the signal and the worker's last
  steps read from its transcript (tool calls with inputs and results cut to a few lines, the last
  message), and answers with a hint of one or two lines.
- The answer is a `SupervisorProposal` row in SQLite (an accumulating record), emitted as
  `supervisor.proposed` and hung on `ChatHealth.proposal`. `POST /chats/:id/supervisor/:proposalId/send`
  sends it through the hint route that exists and marks it `sent`; `…/dismiss` marks it dismissed;
  the same two under `/orchestrations/:id/tasks/:taskId/…`. With `autoSend` it is sent on its own.
- Its cost is real (the `result` event of the housekeeping chat) and is added to the graph's cost
  when the worker is a task. Tests with a fake runner; never a real model in a test.

### `editor-settings-server`

`editor.json` in the data directory; `GET /settings/editor`, `PUT /settings/editor`. The
validation the web does today (`apps/web/src/lib/editor.ts`: templates whose scheme is
`javascript:`, `data:`, `vbscript:`, `file:` or `blob:` are refused) moves to core and the web
keeps calling it. No web changes here.

### `e2e-health-actions` (`e2e/` only, no dependency)

The health actions have unit tests of their rules and no browser coverage, because they need a
live process. Build one.

- A fake `claude` under `e2e/fake-cli/`: an executable that speaks stream-json just enough — the
  `init` event, an assistant turn with one `Bash` tool call that "runs" (a child process that
  sleeps) and sends `tool_progress` heartbeats, the control protocol for interrupt, a `result` on
  stdin close. Nothing more than the specs need.
- The sandbox in `e2e/run.mjs` puts it first in `PATH` **only for specs that ask** (a marker in
  the spec file or an env flag), so every other spec keeps the real CLI.
- `e2e/specs/health-actions.spec.mjs`: start a chat, the `hung-command` signal appears (lower the
  fixed limit through an env variable the health service already reads or add one), **cancel**
  ends the command's process tree and the worker goes on, **hint** reaches the process, **interrupt**
  ends the turn. Each under the harness's limit per spec.
- Leave the suite no slower than one more spec's worth. Raise `timeout-minutes` of the `test` job
  in `.github/workflows/ci.yml` to 20 and fix its comment (the job took 7.5 of 10 minutes on #62):
  this is the one change outside `e2e/` this task makes.

## Stage 2 — the web, in parallel

Every web task: controls from `components/controls`, status never colour alone, keyboard reachable,
`aria-label` on icon-only buttons, keys in both locales, and specs under `e2e/specs/` that they
write but do not run.

### `web-security-2` (deps `security-2`)

- Method and status filters on the audit list of the Security tab, beside the path one.
- **Answering a permission from the notification.** Each waiting notification in
  `Notifications.tsx` gets **Allow** and **Deny** for a tool permission, through
  `POST /chats/:id/permissions/:requestId`, and the item leaves the list when answered without
  opening the chat. A question (`AskUserQuestion`), a plan approval and "allow with edited
  arguments" keep the link that opens the prompt: two buttons cannot answer them.
- A sentence on the Security tab about `AGENTRY_AUTH_TOKEN_RESET` as the recovery path.

### `web-chats-tools` (deps `tool-presets-2`, `loose-rotation`)

- Tool presets tab: the default preset (a `Select`), a **Restore shipped presets** button with a
  confirmation, and the new-chat and resume forms saying which preset applies when none is picked.
  A fork's form says it inherits the source's tools.
- Templates list: rename in place (`PATCH /orchestrations/templates/:id` exists), without
  opening the graph.
- Schedule form: **From an existing orchestration** — a picker that fills the target from
  `GET /orchestrations/:id`.
- Accounts page, policies card: a **Chats without a project** option.

### `web-orchestration-3` (deps `verification-2`, `supervisor`, `editor-settings-server`)

- Launch form and verification card: `maxCostUsd`, the install step (detected / a command / none)
  and `failGraph`; the fixer's cost on the card; a graph failed by its checks says so.
- Supervisor: the toggle, model and cost ceiling in Settings; on a chat's or task's health badge,
  the proposal with **Send**, **Edit** (prefills the hint box) and **Dismiss**; a notification for
  `supervisor.proposed`.
- Editor tab: reads and writes `/settings/editor`. On load, when `agentry-editor:v1` is in
  `localStorage` and the server has nothing yet, migrate it once and remove the key.

### `web-schedules-usage-2` (deps `scheduling-2`, `usage-2`, `i18n-server-strings`)

- Schedules: drop the two 30 s `refetchInterval`s in `api.ts` and refresh from `schedule.*` on the
  feed (the fallback poll while the stream is down stays, like every other list); `overlap` in the
  form with a sentence saying what it does; `overlapped` runs with their own `Tag`.
- Usage: a `DatePicker` in `components/controls` (a calendar of Agentry's own: keyboard, `aria`,
  both themes, no library) for the custom range; the project export as a download on the project's
  Activity tab and on the Usage page when a project is selected.
- Server strings: the web translates connector and health strings by `code`, falling back to the
  server's text for a code it does not know; keys in `en` and `es`.

## Stage 3 — media and docs

### `media` (deps every web task and `e2e-health-actions`)

The README leads with `docs/media/tour.gif` and shows `docs/media/accounts.png`; both were recorded
on 2026-09-19 from a synthetic demo instance whose recorder was never committed, and the tour shows
the navigation from before #60 (Dashboard, Sessions). Make them reproducible.

- `scripts/record-media.mjs`, run as `pnpm media`: starts an isolated wrapper the way
  `e2e/run.mjs` does (temp data and config directories, the fake CLI of `e2e-health-actions` on
  `PATH`, a stubbed claude-swap with three accounts at different usage), seeds synthetic projects
  and transcripts (nothing personal in frame: invented names and prompts), and drives one headless
  Chrome through `e2e/driver.mjs` at 1280×800.
- **The tour** (`tour.gif`, 25–35 s, under 1.5 MB): Home with a project selected and its Activity
  tab, the command palette, a chat with a tool call and its Changes card, an orchestration board
  with a running graph and the verification card, and the accounts page. Frames from
  `Page.captureScreenshot`, encoded to GIF with a pure-JavaScript encoder added as a dev
  dependency of the root (`gifenc` or equivalent; justify the choice in the commit body — no
  native binaries, `ffmpeg` is not on the machines that build this).
- **Stills**: `accounts.png` again, plus `chat.png` (a chat with health, Doing now and Changes),
  `orchestration.png` (the board) and `schedules.png`.
- Chrome and the wrapper are killed by the pid the script started, on every way out, like the
  harness. Regenerate the files and commit them.
- Put in your result the alt text for each file and where each still belongs in the README; the
  `docs` task places them.

### `docs` (deps `media`)

- `README.md`: the new features in the feature list, every route the tasks added to the REST
  tables (check them route by route against `routes.ts`), the stills of `media` next to the
  sections they show, the tour's alt text rewritten for the new navigation, the security recovery
  path, and the Known limitations list updated (remove what this orchestration fixed).
- `SECURITY.md` and `.env.example`: `AGENTRY_AUTH_TOKEN_RESET`.
- `ROADMAP.md`: move everything delivered into **Done**; leave in **Next** only the decided-against
  list at the top of this plan and what a task reported as left out, each with its reason; keep
  **Out of reach of the CLI** as it is.
- `docs/plans/agents-redesign.md`: replace `Status: draft, under discussion` with a landed note
  saying #60 built it and what differs (a saved workflow as a project resource, `interrupted`,
  `Chat.health`), the way the other two plans do.
- `docs/plans/agent-observability.md`: the supervisor is built; say so in §3 and in the order.
- This file: fill the **Outcome** section from what the branches actually contain.
- **Never edit `CHANGELOG.md`**: release-please writes it from the commits.

## Launch settings

```json
{
  "name": "post-roadmap",
  "engine": "graph",
  "worktree": true,
  "model": "opus",
  "permissionMode": "bypassPermissions",
  "permissionPrompts": "none",
  "concurrency": 4,
  "maxAttempts": 2,
  "synthesize": true,
  "limits": { "maxMinutes": 120 },
  "verification": {
    "commands": ["pnpm install --frozen-lockfile", "pnpm build", "pnpm e2e", "node --test e2e/harness.test.mjs"],
    "fixer": true,
    "maxAttempts": 2,
    "timeoutMinutes": 20
  }
}
```

Tasks and dependencies:

| Task | Depends on |
| --- | --- |
| `types` | — |
| `security-2` | `types` |
| `tool-presets-2` | `types` |
| `verification-2` | `types` |
| `loose-rotation` | `types` |
| `scheduling-2` | `types` |
| `usage-2` | `types` |
| `i18n-server-strings` | `types` |
| `supervisor` | `types` |
| `editor-settings-server` | `types` |
| `e2e-health-actions` | — |
| `web-security-2` | `security-2` |
| `web-chats-tools` | `tool-presets-2`, `loose-rotation` |
| `web-orchestration-3` | `verification-2`, `supervisor`, `editor-settings-server` |
| `web-schedules-usage-2` | `scheduling-2`, `usage-2`, `i18n-server-strings` |
| `media` | `web-security-2`, `web-chats-tools`, `web-orchestration-3`, `web-schedules-usage-2`, `e2e-health-actions` |
| `docs` | `media` |

The install step in `verification.commands` is explicit because the install step Agentry adds
itself is what `verification-2` builds: this orchestration cannot use it yet.

## What "done" means

`pnpm typecheck`, `pnpm test`, `pnpm build` green on the integration branch, `pnpm e2e` and
`e2e/harness.test.mjs` green once at the end, the OpenAPI schemas regenerated and committed, the
media regenerated from the script in the repo, and every task's result saying plainly what it
delivered, what it left out, and how it verified it.

## Outcome

Written by the `docs` task from what the branches actually contain.
