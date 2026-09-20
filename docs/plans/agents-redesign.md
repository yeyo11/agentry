# Plan: chats, projects and Agentry's own model

Status: **draft, under discussion**. Extends [agent-observability](agent-observability.md) with the
context and cost of every conversation, and rebuilds the model the web is built on.

## Why

Agentry's API contract mirrors what the Claude Code CLI happens to write. `SubagentInfo.toolUseId`
identifies an agent by a tool call of the stream; `source: 'run' | 'cli' | 'disk'` says which pipe a
record came through; `SessionLive.status` and `ActiveCliSession.state` are the CLI's own words;
`ProjectSummary.id` is an encoded directory name under `~/.claude/projects`. Every question about
the product ("is this a run or a session?") turns into a question about plumbing, and every change
in the CLI reaches the browser.

This plan separates the two: **facts read from the CLI** stay in `packages/core`, and **Agentry's
model** is what `packages/shared/src/types.ts` and the web speak. A field that exists only because
the CLI writes it that way does not cross the API.

## The chat

The root entity is a **chat**, not an agent: one Claude Code conversation, and always one session
id. Subagents and workflow agents are not chats — their messages live inside the parent transcript
as sidechains (`TranscriptEntry.isSidechain`), so they are branches of a chat, not rows in a list.
The word is the same in the model and in the interface; "session id" stays as a technical attribute
of a chat.

```
Chat
  id            the session id, always
  title · firstPrompt · messageCount · startedAt · updatedAt · model · cliVersion
  project       Project | null
  cwd · worktree
  origin        agentry | external | orchestration
  derivedFrom   { chatId, at } | null
  state         one state (to be defined)
  control       what can be done now, and why not when it cannot
  execution     the live one, when there is one: pid, permission mode, model, account, budget
  executions[]  the history
  context       { used, window }
  cost          { usd | null, tokens }
  children      { subagents[], backgroundTasks[], workflows[] }
  environment   what Claude loaded (today's `EffectiveEnvironment`)
  health        from the observability plan
```

The id never goes missing: Agentry already generates the session id for its own chats and imposes it
on the CLI (`runner.ts:815`, `randomUUID()` + `--session-id`). The one gap is a fork, whose new id
the CLI decides and reports in its first event (`runner.ts:415`, `:1080`).

## Executions, resume and fork

A run is not a peer of a chat: it is an **execution** of one. `RunManager.start()` creates a new run
record even when it resumes an existing conversation (`runner.ts:494`), which is why the same chat
shows as one row in Sessions and N cards in Agents today. A chat holds a history of executions and
at most one live.

- **Resume never creates a chat.** It iterates on the same session, as the CLI already does:
  `--resume <id>` keeps the id (`runner.ts:811`); only `--fork-session` (`:813`) makes a new one.
- **A fork is a new chat**, offered on any chat, and it records where it came from.
- **A chat created outside Agentry is read-only while something else holds it.** When nothing does,
  resuming adopts it in place: it becomes interactive and no second chat appears. Its origin stays
  `external` — where a chat was born and what can be done with it now are two different things.
- Whether the session is held is decided **on the server, at resume time**, not from what the
  browser last saw. The guard already exists (`runner.ts:866`), fed by `claude agents --json` and by
  scanning the processes that drive a session id.

## Projects

Projects stop being discovered from the transcripts. `listProjects()` (`sessions.ts:357`) groups
every session by directory, so every directory the CLI has ever run in becomes a project — that is
the noise. Instead:

- A project is **a path and a name**, with an id of ours, imported by hand and kept in a JSON
  document. Importing a directory adopts every chat under it, retroactively.
- **Worktrees belong to their project** automatically; they are not projects of their own. `parentId`
  and `temporary` disappear, and so does the "temporary projects" filter.
- A chat whose `cwd` is under no imported project is **loose**: no project, listed on its own.
- Removing a project from Agentry (harmless) and purging what Claude Code keeps about it
  (`DELETE /projects/:id/state`, irreversible) stay two clearly separate actions.
- The curated list is also what the project scope of Config, Memory, New run and Orchestration
  offer, so they lose the same noise.

## State and control

Today three vocabularies describe the same thing and none of them agree: `RunStatus`
(`starting|busy|idle|completed|failed|stopped`), `SessionLive.status` (a free `string` from the CLI)
and `ActiveCliSession.live` + `state` (`done`, `blocked`). `Agents.tsx` uses all three on one screen.

They answer two different questions, so the model asks them separately.

**State — what is happening in the chat:**

| State | Meaning |
|---|---|
| `working` | A process is generating or running tools |
| `waiting` | Stopped for a person: a permission, a question or a plan |
| `idle` | Neither working nor waiting, with or without a live process |

`starting` is not a state (it is half a second of `working`), and how the last execution ended
travels with the execution, not the chat: `completed | failed | stopped | interrupted`. A chat that
crashed and one that finished are both `idle`; the outcome of their last execution tells them apart.

**Control — who is driving, which decides what can be done:**

| Driver | Control |
|---|---|
| Agentry | `interactive` |
| A terminal | `readOnly`, with the reason shown; the way forward is a fork |
| An orchestration, task running | `readOnly`, plus one explicit action: send a hint |
| An orchestration, task finished | `readOnly`; the way forward is a fork |
| Nobody | `resumable` |

## Orchestration chats

`record()` and `follow()` (`orchestrator.ts:611`, `:630`) put every result of a worker's run on its
task. So a message sent to a worker **while its task runs** is harmless — it is one more turn, and
the result the graph waits for is the next one. A message sent **after the task ended** overwrites
the task's result, adds cost and commits again, while the tasks that depended on it already started
with the old result. That is why a finished task is closed: it is continued by forking it.

The hint is an explicit action of the orchestration board, not a message typed into the chat, so
driving a graph never looks like having a conversation.

The chat list leaves workers out by default and offers a filter for them; their home is the board.
Chats whose origin is `internal` (the planner, the auth check) stay out too.

## Retrying a failed task

Today a failed task takes its whole branch with it: every dependant is marked `skipped` the moment
it fails (`orchestrator.ts:486-497`), and the only way back is `resume()` (`:392`), which re-runs
everything unfinished at once and only after the graph has stopped. It also leaves a mixed state —
the worktree of one attempt and a brand-new chat (`task.runId = null`) — and drops what the previous
attempt cost (`task.costUsd = 0`).

Instead:

- **A failed task is retried automatically**, up to a number of attempts configured per
  orchestration (2 in total by default). A retry is **a new execution of the same chat**, continuing
  where it stopped with its worktree intact, so no duplicate chat appears and the chat's execution
  history shows every attempt and what it cost.
- **The retry message is written by Agentry** from the error, the way the observability plan already
  has Agentry, not the objective, set the rules workers follow.
- **Two failures are never retried automatically**: a budget that ran out (the retry meets the same
  ceiling) and a task stopped on purpose. Rate limits are not retried here either — they already
  have their own rotate-and-resume one layer down (`runner.ts:51`).
- **Dependants are not skipped while attempts remain.** When they run out, the task is `failed` and
  its dependants become **`blocked`**: waiting for a decision, which `pending` cannot express (it
  would not say whether a task waits for its turn or for a person).
- **`skipped` becomes a decision**, not a cascade: giving a branch up so the graph can finish
  without it.
- **With tasks blocked the orchestration is `waiting`**, a new status beside `running`, `completed`,
  `failed` and `stopped`. It **holds integration and synthesis** (`finish()`, `:787-795`, runs them
  today as soon as nothing is running): a half integration can be redone — `integrateLate()` exists
  for exactly that — but a synthesis written over an incomplete graph reads like the final report.
- Once attempts run out the offer is **retry clean** (a new chat, the worktree rebuilt from the
  base) or **skip the branch**. The optional supervisor of the observability plan is what can
  propose which, off by default.

## Context and cost

`agents.ts:59-99` already folds a transcript into token usage, grouping by message id because
summing lines would count a message once per content block. The same fold over a chat's own
transcript gives two numbers that must not be confused:

- **Context in use** — `input + cache` of the **last** response. A snapshot, not a sum, so the CLI's
  own compaction shows up on its own: when it compacts, the number drops.
- **Tokens spent** — the sum over the whole chat, which is what was paid for.

Sidechains split the two: a subagent's messages do not count towards the chat's context (the
subagent has a window of its own) but do count towards its tokens spent. `isSidechain` already
tells them apart.

**Only real data is shown.** `total_cost_usd` arrives in the `result` event, so cost exists for what
Agentry launched and for every chat of an orchestration; for a chat started from a terminal the CLI
records none, and the cost reads **not available**. Nothing is estimated from a price table: the
tokens are real and they are shown, the cost either exists or it does not.

Tokens are kept **per model**, because a chat can change model mid-conversation
(`RunSettingsUpdate.model` does it live), and the model id is used whole, variant suffix included:
the same family with a 1M context has a different window, and a session of 328k tokens read against
a 200k window looks like a broken counter. When the model is unknown, tokens are still shown and the
percentage of the window is not invented.

Where it is shown: the percentage of context in the chat list (what tells you a chat is about to
compact), context, tokens and cost in the chat detail, the total per orchestration — what a large
piece of work cost, which `orch.costUsd` already accumulates — and totals per project and per day on
the home page.

## Navigation

Eleven entries become six:

| Today | Becomes |
|---|---|
| Dashboard | **Home** |
| Agents + Sessions | **Chats** |
| Orchestration | **Orchestrations** |
| Projects | **Projects** — import and manage |
| Accounts | **Accounts** |
| Config + Memory + Plugins | **Settings**, as tabs |
| Background tasks | gone: a branch of a chat |
| Workflows | split in two |

The workflows page mixes two things today: the saved scripts (`GET /workflows/saved`, from
`.claude/workflows/`) and the runs (`GET /workflows`). By the same rule that moves subagents and
background tasks inside a chat, **a workflow run is a branch of a chat**. A **saved workflow is a
project resource**, like the agents, skills and commands already in Settings — `ResourceKind` only
needs one more value. Running a saved one starts a chat, so that button belongs beside "new chat".

The project selector sits in the top bar and scopes Home, Chats and Orchestrations. Notifications
ignore it: a chat waiting in another project is still worth knowing about.

## Home is an inbox

Today it is a dashboard of counters. What is needed first is what is waiting for a person:

```
 ── Waiting for you ───────────────────────────────
   2 chats stopped for a permission           [answer]
   1 task blocked: failed after 2 attempts    [retry clean · give the branch up]
   ! pnpm e2e running 5 min (usually 80 s)    [cancel the command · send a hint]
   ! merge conflict integrating event-feed    [open]

 ── Right now ─────────────────────────────────────
   3 chats working · 1 orchestration (4/7 tasks)
   each with its context and what it has spent

 ── Today ─────────────────────────────────────────
   tokens and cost for the day, per model

 ── Pick up again ─────────────────────────────────
   the last idle chats
```

The first block is actionable and comes from the observability plan and the orchestration rules
above; the rest is informative. With nothing waiting, the first block is absent and the page is
short, which is the point.

## Accessibility

Growing the surface is what makes this worth fixing now, and it is checked, not asserted:

- Status is never colour alone: text and an icon as well.
- Every control reachable and operable from the keyboard, with a visible focus ring and a sane tab
  order; the command palette is not the only way in.
- Landmarks and ARIA that match what the page does, and names on icon-only buttons.
- Contrast that passes in both themes.
- Real responsive behaviour, not a sidebar that collapses.
- **axe-core in the e2e suite**, so a regression fails the build instead of waiting to be noticed.

## The project is the home

With a project selected in the top bar, a home filtered by that project and a separate project page
filtered by the same project would be two places for one idea. They are one page, with tabs:

```
 [ agentry v ]
 Activity · Settings · Memory · Resources · Worktrees        (+ Knowledge, Roadmap, ...)
```

- *Activity* is the inbox above: what waits for a person, what runs now, what the day has cost.
- With **All projects** selected only *Activity* remains; the rest mean nothing without a project.
- **Projects** stays as the management screen: import, rename, remove, purge.
- The tabs this is meant to grow — a knowledge base, a roadmap, the decisions taken — are new tabs,
  not a new design.

This also settles a duplication that exists today: Config has a project scope of its own
(`pages/config/scope.tsx`, and every `/config` route takes `?project=`), which would have been a
second way of saying the same thing as the selector.

| | Holds |
|---|---|
| **Settings** | User scope only: settings, instructions, user MCP, plugins, user memory, resources, files, credential |
| **Project** (home) | Everything of its own: settings and `CLAUDE.md`, its MCP, its memory, its agents, skills, commands and saved workflows, its worktrees and its activity |

`?project=` disappears as a switch inside Config: the scope is what the top bar says.

## Nothing is left behind

Whatever stops being used is deleted, not deprecated. `Sessions.tsx` and `SessionView` (absorbed by
Chats), `RunView` as a page of its own, `SessionLive`, `SessionOrigin`, `ActiveCliSession` as a
public type, the four `source` fields, `parentId` and `temporary` on projects, the Config scope
switch, and the `/sessions*` routes with no redirect behind them.

The same rule decides the data migration: the run and orchestration rows kept as JSON in SQLite
(`db.ts`) are **migrated once at startup** and the old shape is gone. A reader that tolerates both
forever is the legacy this is trying to avoid.

What does not die is the data behind three aggregates — `GET /tasks`, `GET /subagents` and
`GET /workflows` — because the inbox needs to see a hung command wherever it is. They are rewritten
in the new vocabulary; what disappears is their entry in the sidebar.

Projects stop being discovered, so the first start after the change finds none. It offers to import
the directories with the most chats rather than showing an empty screen.

## Order of execution

`types.ts` is imported by core, api, web and the generated OpenAPI schemas, which CI checks for
drift. Two workers editing it at once collide by construction, so the model is one task, alone,
first.

**Stage 0 — the model.** Domain types, the adapter in core that translates the CLI's facts,
regenerated schemas, the README REST tables, route summaries and tags, and unit tests for the
mapping. No other task touches `types.ts`.

**Stage 1, in parallel**
- **A. Chats and executions** (`runner.ts`, `sessions.ts`): one chat per session, executions indexed
  by chat, resume that adopts, fork that records where it came from, the guard on the server.
- **B. Imported projects**: the JSON document, attachment by path, worktrees to their project, loose
  chats, and `listProjects()` gone.

**Stage 2, in parallel, on A**
- **C. Context and cost**: the `agents.ts` fold reused for a chat, per model, the window table, and
  "not available" where there is nothing.
- **D. Orchestration**: automatic retries, `blocked`, `waiting`, synthesis held back, the hint as an
  explicit action.

**Stage 3 — the web, in parallel**
- **E. Chats**: list and detail (on A and C).
- **F. Navigation, project scope and the home page** (on B and C).
- **G. The orchestration board** (on D).

**Stage 4 — H. Accessibility**, with axe-core in the e2e suite, once the interface stops moving.

**Stage 5 — verification**: `pnpm build` and the e2e suite once, on everything merged. Workers run
`pnpm typecheck` and `pnpm test` only, as section 5 of the observability plan argues.

Three things belong in the brief each worker gets:

- **An owner per shared file**, which is what avoids conflicts: `types.ts` belongs to stage 0 and to
  nobody afterwards; `App.tsx` and `api.ts` belong to F; each task edits only its own lines of
  `routes.ts`; each web task fixes the e2e specs it breaks, and H adds axe-core.
- **The API contract changes shape**, so commits use `feat!` / `BREAKING CHANGE` and release-please
  marks the release; the image and the desktop app follow.
- **The observability plan is written in terms of runs and tasks.** This lands first, and that
  document is rewritten to speak of chats, or two plans contradict each other.
