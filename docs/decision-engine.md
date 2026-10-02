---
created_at: 2026-09-30T18:00:00Z
updated_at: 2026-10-01T12:00:00Z
tags:
    - decisions
    - decision-engine
    - jev
    - typesafe
    - settings
    - privacy
    - shadow
    - checks
---
# The decision engine

Agentry makes many small judgments: whether a card needs refining, whether a failed task is worth a
retry, whether a run that ended on a report owes more work, which journal entries an agent reads.
Each used to be a fixed rule, a paid Claude run or a person. The **decision engine** gives them one
home in `packages/core/src/decisions/`: a decision point puts typed questions to a provider and
runs today's behaviour whenever the answer is missing, late or not sure enough.

Everything ships **off**. A fresh install behaves exactly as before and sends nothing anywhere. The
owner's eighteen decisions are in [decisions/decision-engine.md](decisions/decision-engine.md), the
plan that built it is [plans/decision-engine.md](plans/decision-engine.md), and this page describes
what was built.

## Questions and answers

There are three question types, named as TypeSafe names them:

- **choice**: pick one of 2 to 255 options;
- **score**: pick a level of a rubric of 2 to 10 levels, lowest first;
- **noul**: yes or no.

Every answer is a value plus a confidence in [0, 1] (`null` when the provider has none). Every
question and rubric is English ([decisions/english-technical-language.md](decisions/english-technical-language.md)).
A point batches all its questions into one provider call.

## Providers

| | `cli` (default) | `jev` (optional) |
| --- | --- | --- |
| What it is | Claude Code through its CLI | TypeSafe's Jev, an outside service that only answers typed questions |
| How | One housekeeping chat per batch, one turn, `--json-schema` (an enum per choice or score, a boolean per noul) | `@typesafe-ai/sdk`, behind one adapter file (`providers/jev.ts`) |
| Model | `haiku` at effort `low` by default, `--max-budget-usd` 0.02 | pinned to `jev-1.13.0`; it never upgrades by itself |
| Confidence | always `null`, so it never clears a threshold | calibrated, per answer |
| Deadline | 30 s | 1.5 s, one retry with backoff on 429 or 529 |
| Leaves the machine | nothing beyond what Claude Code already sends | the point's state, to TypeSafe |
| Key | none | the owner's, in `decision-credentials.json` (mode 0600), never returned by the API |

The `cli` provider is inside the [one rule](../CONTRIBUTING.md): it is the Claude Code CLI and
nothing else. Its chat is `internal` (no transcript, hidden, never supervised), has no tool and no
settings file (`confine`), and gets no `AGENTRY_API_URL` or `AGENTRY_API_TOKEN` (`NewChat.api:
false`), so it can never call back. Its prompt follows the shared rules of [prompts.md](prompts.md):
the state sits in one `pasted()` block followed by `PASTED_NOTE`, there is no reason field, and a
Sonnet model is told to think the problem through. A result without a readable structured answer is
`invalid-answer`; a stop on `max_tokens` is `max-tokens` even when the JSON parses; a rate-limited
turn is `rate-limited` at once, with no rotation and no resume.

Jev is the one bounded exception to the one rule ("typed decision services" in CONTRIBUTING.md):
off by default, the owner's key, no text or code, no call to Anthropic, only the state a point
declares after consent, and Agentry works in full with `cli` alone. Nothing falls back from `jev` to
`cli`: a paid, slow run in place of a 0.2 s call would be a silent change of cost.

**Provider unavailable.** A provider that cannot answer (`no-key`, `timeout`, `rate-limited`,
`no-quota`, `max-tokens`, `server-error`, `network`, `invalid-answer`) makes `ask` return `act:
false`, so the caller runs today's behaviour at once. The row is written as `unavailable` with the
reason. A decision never waits for quota and never blocks a run. The tab warns ("Provider
unavailable") when three or more requests of one provider failed in the last hour.

## Modes

Each point has a mode, set globally and overridable per project for the points of project scope:

- **off**: nothing is asked.
- **shadow**: the engine asks and records; today's behaviour decides and nothing visible changes.
- **active**: a **suggest** point prepares something a person then decides (a sort, a prefill, a flag)
  and works with either provider. An **act** point changes what happens only when `confidence >=
  threshold` (default 0.85, 0.5 to 0.99). A `null` confidence never clears it, so the UI does not
  offer `active` on an act point whose provider is `cli`; if the provider turns to `cli` later, the
  point behaves as shadow.

Effective settings resolve as project override, then global, then the point's default. Consent is
always global.

## The points

Twenty-five points. **Suggest** points never change what happens by themselves.

| Area | Point | Kind | Scope | What it decides |
| --- | --- | --- | --- | --- |
| Project flow | `flow.refine-needed` | act | P | Skip the refine run when the card is ready as written |
| | `flow.bounce` | act | P | After QA rejects: fixable (bounce back) or needs a person |
| | `flow.criteria-precheck` | act | P | Send a card back before QA when a criterion is clearly unmet; it never passes a card |
| | `flow.criteria-merge` | suggest | P | Flag proposed criteria that duplicate existing ones |
| | `flow.restart` | act | P | Requeue a run cut by a restart, or not |
| | `flow.scope-drift` | suggest | P | Flag a commit that drifts from the card |
| | `team.assign` | suggest | P | Propose the member for a card |
| Board | `board.triage` | suggest | P | Prefill type, priority and a duplicate warning while typing a task |
| Memory | `memory.triage` | suggest | P | Score memory proposals so the best come first |
| | `journal.relevance` | act | P | Reorder the journal entries an agent reads; code still applies the byte budget |
| Assistant | `assistant.rerank` | suggest | P | Order the project assistant's proposals |
| | `assistant.sources` | act | P | Which files the assistant reads first |
| Orchestrations | `orchestration.retry` | act | P | Retry a failed task in the same chat, or not |
| | `orchestration.model` | suggest | P | A model per task in the draft plan |
| | `orchestration.fixer` | act | P | Stop asking the fixer when more attempts will not help |
| | `run.continuation` | act | P | Whether a run that ended on a report owes more work (the phrase part of `openItems`; the structural part stays code) |
| Health | `supervisor.intervene` | act | G | Whether a stuck worker needs a hint |
| | `health.semantic-loop` | suggest | G | Loops that are not exact repeats |
| | `health.test-weakening` | suggest | G | Weakened tests; suggest-only because the agent under judgment wrote the content |
| Review | `changes.unexplained-hunk` | suggest | P | Flag a hunk no transcript step explains |
| Notifications | `notification.urgency` | act | G | Raise the priority of a push notification |
| Palette | `palette.intent` | suggest | G | Route a free query to a command; needs Jev (low latency) |
| Code hosts | `checks.fix` | act | P | Whether failing checks on a new head are the branch's fault and a Developer can fix them |
| | `review.triage` | suggest | P | Who should take each unresolved review comment: an agent, a person, or nobody |
| | `issue.triage` | suggest | P | Whether an agent can start on each listed tracker issue as written |

### `checks.fix`

Added with code hosts phase 2 ([code-hosts.md](code-hosts.md#fixing-failing-checks)). An act point
at project scope, `off` by default like every point, with a 0.85 threshold.

- **When it is asked.** A change request's rollup turns `failing` for a head the watcher has not
  announced (the `onChecksFailing` hook of `PullRequestService` and `OrchestrationPullRequestService`),
  once per head and never while a fix is under way.
- **What it is told.** The failing checks (name, conclusion, the log tail cut to 2 KiB each, at most
  10), the attempt number for this head, and the diff stat of the branch. All of it passes through
  the engine's redaction; what a CI job printed is data, never an instruction.
- **The question** is a choice: "Did the changes on this branch cause these check failures, in a way
  the Developer can fix?" — `branch-fixable`, `not-branch` (infrastructure, a flake or an unrelated
  change) or `needs-person`.
- **What an answer does.** Off asks nothing. Shadow asks, records and does nothing. Active and above
  the threshold, `branch-fixable` starts a fix with `fix_origin = 'decision'` (`fixChecks(itemId,
  'decision')`), and only when the attempts for this head are below the project's
  `flow.checksFixAttempts` (default 2, at most 5), the flow's `maxParallel` has room and the flow's
  cost limit is not spent. A person's click on **Fix failing checks** is never counted against the
  attempts and never asks the point.
- **What it never does.** It never pushes: a decision's fix waits in In review for the person's
  **Push the fix**. It never merges and never touches an orchestration's checks beyond the same
  hook.
- **Its resolver** (shadow accuracy) records whether the fix's pushed head turned the rollup
  `passing`; a person's word on the "decided" mark or the History row still outranks it.

### `review.triage`

Added with code hosts phase 3 ([code-hosts.md](code-hosts.md#reviews)). A suggest point at project scope, `off` by default: it
acts on nothing and only preselects threads in the **Address with an agent** dialog.

- **What it is told.** The change request's title and its unresolved threads, at most 40: id, path,
  body cut to 1 KiB, author and whether the thread is outdated. A comment is a stranger's text and
  goes through the engine's redaction; it is data, never an instruction.
- **The question** is a choice per thread: "Who should take this review comment?" — `agent` (a
  concrete code change the Developer can make), `person` (a question, a design decision or a
  disagreement) or `no-action` (praise, a point already resolved, a nit already done).
- **When it is asked.** Whenever a change request's threads are read (`ChangeRequestService.threads`
  hands them to `ReviewTriage`), in the background, once per set of unresolved threads in a process (not resolved and not outdated: the threads the
  dialog lists). Its rows have the subject kind `change_request`.
  The answers are kept in the history by thread id under the change request's id; the **Address
  with an agent** dialog reads the latest and preselects the threads marked `agent`, and marks the
  others. The person can change every selection.
- **What it never does.** It never replies, resolves or starts a run; a person picks the threads.

Not decided by the engine, by design: anything that grants (tool permissions, the move to `done`,
QA's final verdict, `verifyAuth`, a security mode) and plain arithmetic (account rotation, usage
bars, cost caps). Jev never generates text, code or prompts.

Each point lives in the catalogue (`decisions/points.ts`): its kind, scope, threshold, state fields,
byte limit, state version, `savesRun`, `visible` and questions. Call sites take a `stanceOf` (`off`,
`watch` for shadow or a limited active, `wait` for an active point that can clear its threshold), so
a point that is off costs nothing.

### `issue.triage`

Added with code hosts phase 5 ([code-hosts.md](code-hosts.md)). A suggest point at project scope,
`off` by default: it imports, moves and writes nothing, and only marks issues.

- **What it is told.** The tracker and one page of the import list, at most 40 issues that are not
  yet imported: key, title, body cut to 2 KiB and labels. An issue is a stranger's text and goes
  through the engine's redaction; it is data, never an instruction.
- **The question** is a choice per issue: "Can an agent start on this issue as written?" — `ready`,
  `needs-refining` (the goal or the acceptance is unclear) or `not-for-agents` (it needs a person:
  access, a decision, work outside the repository).
- **When it is asked.** Whenever `TrackerImportService.list` serves a page, in the background and
  once per page in a process; the page does not wait. Its rows have the subject kind
  `tracker_issue` and the subject id `<project id>:<tracker id>`, with the answers keyed by the
  issue's key.
- **Where it shows.** The list reads the newest answer per key back into `TrackerIssue.triage`, so
  the import dialog marks the issues on the next read. Marks on the imported cards read the same
  rows through `GET /decisions`.

## Consent and privacy

- **The state is declared.** A point sends only the fields its catalogue entry lists, every string
  cut to the point's byte limit, with anything that looks like a secret masked
  (`decisions/redact.ts`). The builder is the single source of what leaves.
- **Consent per point.** Moving a point out of `off` the first time opens a dialog with the exact
  state (`GET /decisions/points/:point/preview`: the last request, or what it would send now, built
  locally and not sent), its size and the provider it goes to. Consent records the state version and
  the providers it covers: a state that changes shape asks again, and consent given on `cli` does not
  cover `jev`. A point without consent stays off whatever an override says.
- **With `cli` nothing leaves the machine** beyond what Claude Code already sends, and the dialog
  says so.
- **With `jev`** titles, comments, error text and journal lines go to TypeSafe. Zero retention exists
  only on enterprise accounts. Saving the key shows a general notice.
- **Only the owner widens it.** A chat's own token is refused with `403` on
  `PUT /decisions/settings`, `PUT` and `DELETE /decisions/credentials` and `PUT
  /decisions/points/:point/consent`, so an injection in a chat cannot consent to a point or switch
  to Jev. A project override can set a mode or provider, never consent.
- **Untrusted text is marked.** Every state goes into the question inside a `pasted()` block with
  `PASTED_NOTE`, for both providers.

## Shadow accuracy

Each row records what the engine answered. A resolver per point (`decisions/resolve.ts`) later reads
the signal the app already produces (a flow run ending, a work item edited, a proposal accepted or
rejected, a task's status) and writes `outcome`, `agreed` and `resolved_at`. A sweep runs shortly
after the relevant events and every five minutes. The person's word outranks the inference: useful /
not useful on the "decided" mark (active) or on a History row (shadow) sets `agreed`.

Every point has a resolver. Three of them read a signal the app stores for them (CW-28):

- **`palette.intent`**: the palette asks in shadow as well as active (Jev only), shows nothing in
  shadow, and reports what the person did through `POST /decisions/:id/palette-action`
  (`{ commandId }`, or null when the palette closed without one). The row keeps it in
  `palette_action` as `proposed`, `other` or `dismissed`; the first report wins. A proposed id is
  agreed only when that command ran; "none" is agreed when the palette was dismissed or the command
  that ran was not among the listed ones. The palette no longer sends `useful` by itself: useful /
  not useful is the person's explicit word.
- **`notification.urgency`**: the service worker adds `notification=<key>` to what a click opens; the
  app reports it once with `POST /decisions/notification-opened` (`{ key }`) and removes the parameter.
  That sets `opened_at` on the newest row of that key. The window is the push TTL, one hour: `high`
  is agreed when opened within it and `normal` is not. A push nobody opened, or opened after the
  hour, is not scored and the row stays unresolved: most pushes are ignored, a push the worker did
  not show because a focused window was open can never be opened, and none may have reached a
  device, so "not opened" had made the score mostly the share of `normal` answers. The first
  review is in [decisions/jev-shadow-review-first-day.md](decisions/jev-shadow-review-first-day.md).
- **`orchestration.model`**: an orchestration launched from a planner's draft carries
  `plannerRunId`. The resolver finds the first one created after the row with that planner run and,
  for each task the row answered, compares the launched model (`task.model ?? orchestration.model`)
  with the suggested one. A kept model is right if the task completed and wrong if it failed; a
  stronger suggestion (haiku < sonnet < opus, by family name in the id) is right if the task failed
  and wrong if it completed; a weaker suggestion is wrong if it failed and not judged if it
  completed; unranked ids that changed, and `skipped` or `stopped` tasks, are not judged. The row
  waits while any answered task is `pending`, `running`, `blocked` or `interrupted`; the verdict is
  a majority (`right * 2 >= judged`) and the detail lists per task the suggested and launched model,
  whether it was kept, and the final status. A draft that is never launched stays unresolved until
  retention prunes it.

The signals are two columns of the history row (`opened_at`, `palette_action`), not part of any
point's state, so no `stateVersion` changes and consent is not asked again. Recording either signal
schedules the same debounced sweep as the events do. Both routes are refused to a chat's token.

The tab shows, per point: count, share acted, mean confidence (a dash for `cli`), agreement with
the outcome with its n, useful and not useful, unavailable, cost and Claude runs saved. Nothing
switches a point to `active` by itself.

## Where it shows

- **Settings → Agentry → Decisions** (`apps/web/src/pages/config/DecisionsTab.tsx`, with
  `decisions/`): Engine (provider, CLI model, effort and cost cap, the Jev key with a connection test,
  history days), Decision points (mode, threshold, consent and metrics per row, grouped by area),
  Supervisor (the former tab, `supervisor.json` unchanged) and History (filter, open a row, useful /
  not useful, delete, clear). `?tab=supervisor` still lands on the Supervisor section.
- **Project settings → Decisions**: the provider (inherit, CLI, Jev when a global key exists) and
  mode and threshold per project point, with a "Use global" reset.
- **The "decided · 0.93" mark** (`components/DecisionMark.tsx`): only on a row where an act point
  changed something a person sees (`visible`), or "suggested" for a suggestion. It opens the answer in
  a popover (a sheet on a phone) with useful / not useful. Surfaces: board and item, new task,
  memory and assistant proposals, orchestration task rows and the plan draft, the supervisor hint in
  a chat, and unexplained hunks in the diff.
- **Usage**: a line "Decisions · Jev $0.004 · 37 Claude runs saved", hidden when the window has no
  decision.
- **Command palette**: with `palette.intent` active or in shadow on Jev, a query that ranks nothing locally asks
  `POST /decisions/palette` (in shadow nothing is proposed); the local score always answers first and nothing blocks typing.

## Settings and storage

- **`decisions.json`** in the data directory: the provider, the `cli` model, effort and cost cap,
  the mode, threshold and consent per point, and `historyDays` (30, from 1 to 365). Validated whole on
  `PUT`, written atomically.
- **`decision-credentials.json`**, mode 0600: the Jev key. The API returns only `keySet` and
  `keyHint` (its last four characters).
- **Per-project override**: `ProjectSettings.decisions` in the project's settings, points of project
  scope only.
- **`decisions` table** in SQLite (one row per question batch): the exact state sent, questions,
  answers, confidence, threshold, `acted`, `visible`, `saved_run`, latency, tokens, cost, outcome,
  `agreed`, feedback. Rows older than `historyDays` are pruned at start-up and once a day. Consent is
  a setting, not a row.

## Routes

All under tag `decisions`; the full table is in the README's [REST API](../README.md#decisions).

| Method | Route | What |
| --- | --- | --- |
| `GET` `PUT` | `/decisions/settings` | The global settings (key masked); replace them whole |
| `PUT` `DELETE` | `/decisions/credentials` | Save or remove the Jev key |
| `POST` | `/decisions/test` | One small fixed request to a provider |
| `GET` | `/decisions/points` | The catalogue with the settings in force (`?projectId=`) |
| `GET` | `/decisions/points/:point/preview` | The exact state a point sends |
| `PUT` | `/decisions/points/:point/consent` | Grant or withdraw consent |
| `GET` `DELETE` | `/decisions` | History, filtered and paged; clear a filtered set |
| `GET` | `/decisions/stats` | Per-point metrics, Jev cost, Claude runs saved |
| `GET` `DELETE` | `/decisions/:id` | One decision; delete it |
| `POST` | `/decisions/:id/feedback` | Useful or not useful |
| `POST` | `/decisions/palette` | Route a palette query (`palette.intent`) |
| `POST` | `/decisions/:id/palette-action` | What the palette did with the proposal; a chat's token gets `403` |
| `POST` | `/decisions/notification-opened` | The app was opened from a push; a chat's token gets `403` |
| `POST` | `/projects/:id/work-items/triage` | `board.triage` for a draft being typed |

## How it is tested

- **Core unit tests**: settings validation and the project, global, default resolution; consent
  gating; redaction; the threshold rule (a `null` confidence never clears it); the deadline and
  fallback on every `unavailable` reason; the migration, pruning, stats and resolvers. Each point has
  the four-mode test: `off` changes nothing and calls no provider, `shadow` records but today's
  behaviour decides, `active` acts only above the threshold, `unavailable` falls back at once.
- **Providers**: `cli` over the fake CLI (a schema answer, an invalid one, a `max_tokens` stop, a
  rate limit, the `pasted()` block, `THINK_THROUGH` only on Sonnet, no API url or token in the
  chat's environment); `jev` with the SDK stubbed. No test reaches TypeSafe or Anthropic.
  `prompt-rules.test.ts` scans `decisions/` for banned phrasing.
- **API tests** (Fastify inject): every route and validation error, the key never returned, a chat
  token refused with `403`, the summary-and-tag test, no OpenAPI drift.
- **Web tests**: the tab sections and the `?tab=supervisor` alias, `active` disabled for an act
  point on the CLI, the consent dialog, the mark only when `visible`, the Usage line hidden when
  empty, i18n parity and the tokens guard.
- **e2e**: `e2e/specs/decisions.spec.mjs` (the tab from `?tab=supervisor`, consent to shadow, a
  History row from a faked CLI provider, phone layout and axe), with `shell.spec.mjs`, `a11y.spec.mjs`
  and `motion.spec.mjs`.
- **After merge**, the owner runs chosen points in shadow on their own projects and moves them to
  `active` one at a time from the metrics.

## Related

- [[plans/decision-engine.md]]: the plan, its task graph and its Outcome.
- [[decisions/decision-engine.md]]: the owner's eighteen decisions.
- [[code-hosts.md]]: the checks and the fix that `checks.fix` starts, and the review threads that `review.triage` sorts.
- [[decisions/english-technical-language.md]]: English questions and rubrics.
- [[prompts.md]]: the `cli` provider's prompt and the twelve-point check.
- [[team-and-flow.md]] · [[assistant.md]] · [[work-items.md]]: where most points act.
- [[plans/agent-observability.md]]: the health signals and the supervisor.
- [[layered-settings.md]] · [[design-system.md]]
