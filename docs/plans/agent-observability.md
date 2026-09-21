# Plan: see what every agent is really doing, and step in on time

Status: **landed, except the optional supervisor** (see [ROADMAP](../../ROADMAP.md)). Written on
2026-09-19 after the first large orchestration Agentry ran on its own repository, and built by the
orchestration in [roadmap-completion.md](roadmap-completion.md). Each section below starts with a
**Landed** note saying what shipped, where it differs from the text, and what did not. The text
itself is left as it was planned, and says `run` where the code now says `chat`.

Today the panel shows what an agent *says* it did: its status, its last message, its transcript.
It does not show what changed on disk, and it does not notice when an agent is stuck. Both had to
be done by hand during that orchestration, with `git log`, `ps` and `kill`. This plan puts them in
the product.

Everything below reads what already exists: the CLI's stream-json events, the files it writes, and
`git`. None of it talks to Claude Code in any other way.

## Why: the case that prompted it

One worker of the orchestration (`event-feed`, Opus) had been running for 40 minutes when someone
asked whether it was looping. It was not looping. It had spent **22 of those 40 minutes inside four
`pnpm e2e` runs** (420 s, 300 s, 270 s and 270 s) that hung, when the whole suite normally takes
about 80 s. The likely cause was its own change: an `EventSource` that never closes keeps a spec
waiting. Every run ended on a timeout, then it tried again.

Nothing in the panel said so. Finding out took reading its events by hand. Two more problems turned
up in that reading:

- It was **rewriting an existing e2e assertion** to make a failing spec pass, rather than fixing
  the app.
- The hung runs left **orphaned headless Chrome processes** behind. Three groups from earlier runs
  were still alive five hours later.

What ended it was a message to the worker (sent through `POST /runs/:id/messages`) and killing its
hung e2e process tree. Both should be one click away.

## 1. Execution detail: progress, commits, files, diffs

> **Landed.** `GET /orchestrations/:id/tasks/:taskId/changes` (and `…/changes/diff?path=`), the same
> two under `/orchestrations/:id/integration/`, `GET /chats/:id/changes` (and its `diff`), and the
> checklist at `GET …/checklist` for a task and for a chat. A chat with a worktree gets the git
> summary; any chat also gets the files its own `Write`/`Edit`/`NotebookEdit` calls touched, so one
> outside git still answers. A task is measured from where its own branch was cut (`baseCommit`), not
> from the graph's base, or a dependent task would be credited with its dependencies' work. It is
> live through a `changes.updated` event, looked at every 3 s only while a client listens. The UI
> is a **Work** panel on a task (`?task=<id>`) and **Doing now** and **Changes** cards on a chat, with
> the diff drawn by the existing code-block grammar, so no library was added.
>
> Two differences from the sketch: "what it is doing now" is read from the last unanswered tool call
> in the transcript, so it only shows while something works, and the time since its last event
> keeps growing during a long command that is alive.

For every orchestration task that has a worktree, and for the integration branch:

- **Branch and base**: the branch it works on, the commit it started from, how many commits ahead.
- **Commits**: hash, message, author, time. Live while the worker runs.
- **Files changed** against the base: added, modified or deleted, with `+/−` line counts
  (`git diff --numstat` and `--name-status`).
- **Uncommitted changes** in its worktree (`git status --porcelain`), which is what the worker is
  doing right now.
- **Diff per file**, highlighted, on click.

Progress beyond a status:

- **The worker's own checklist**: workers plan with the CLI's task tools (`TaskCreate`,
  `TaskUpdate`, `TodoWrite`). Those calls are in the transcript and can be drawn as done and pending
  items.
- **What it is doing now**: the running tool and command, its last message, and time since its last
  event.

For a plain run without a worktree: the **files it touched**, from its `Write`/`Edit` tool calls.
This works even outside git.

Sketch of the API: `GET /orchestrations/:id/tasks/:taskId/changes` →
`{ branch, base, ahead, commits[], files[{ path, status, additions, deletions }], uncommitted[] }`
and `GET …/changes/diff?path=` → the unified diff of one file. The same for `integration`.

## 2. Open it in the editor

> **Landed, with the settings in the browser.** Open the worktree, jump to a changed file or a
> changed line (from the diff's hunk headers), a link template, the container-to-host path rows and
> the optional `code --diff` command, edited in the **Editor** tab of Settings with a live preview.
> Templates whose scheme is `javascript:`, `data:`, `vbscript:`, `file:` or `blob:` are refused.
> **Not as planned:** the settings live in `localStorage` (`agentry-editor:v1`), not on the server,
> because they describe the machine the browser runs on and a server copy would need a route and a
> schema for one person's preference. And a browser cannot run `code --diff`, so that button copies
> the command instead of running it, and only on a task (a chat has no main-checkout path for the left
> side).

VS Code registers a URL scheme that the panel can link to:

```
vscode://file/<absolute path>                → open a folder or a file
vscode://file/<absolute path>:<line>:<col>   → open a file at a line
```

- **Open the worktree** (or a run's working directory) with one button. It is an ordinary git
  checkout: VS Code shows its branch and, in Source Control, what the worker has not committed yet.
- **Jump to a change**: each hunk header (`@@ -a,b +c,d @@`) gives the line in the new file, so
  clicking a changed line opens `vscode://file/<worktree>/<path>:<line>`.
- **Side-by-side diff in VS Code**: links cannot do it. The API can run `code --diff <base> <file>`
  when VS Code is on the same machine, as an optional button.

Limits and settings:

- Links work when the browser and the editor run on the same machine: local use and the desktop app.
- In Docker the paths are the container's (`/workspace/…`). A setting maps them to host paths, or
  the folder is opened through Dev Containers.
- The link template is a setting, so other editors fit: `cursor://file/{path}:{line}`, Windsurf,
  JetBrains IDEs. Default: VS Code.

## 3. Detect a stuck agent

> **Landed, apart from the supervisor.** All seven signals are computed in core
> (`hung-command`, `repeat-stall`, `no-progress`, `loop`, `weakened-test`, `silence`, `budget`), next
> to the facts a chat already had (last execution, waiting, context, branches). "Longer than usual"
> is measured from a SQLite table of command durations by kind, with the fixed 3 minutes until there
> are five runs, and a hang that was cancelled never lowers the bar. The rules prefer silence to a
> false positive: a test edit only counts when every assertion is gone, a test is skipped, an
> assertion that cannot fail is added or precise ones are swapped for lax ones. A loop needs the same
> call with the same answer four times. `health.changed` is on the feed and in the notification
> centre; a task carries its health in `GET /orchestrations`.
>
> The actions are `POST /chats/:id/commands/:toolUseId/cancel` (that command's process tree, found
> under the CLI's pid from the process tree and start times, never from a command line; Linux
> only), `POST /chats/:id/hint` and the task hint route that already existed. Each signal carries a
> hint text Agentry writes.
>
> **Levels are `ok`, `warn`, `bad`, not the plan's ok, slow, stuck and looping.** Those mix a
> severity with three kinds of signal, and severity is what the panel already rendered. The badge maps
> them: `warn` reads "slow", `bad` reads "stuck", and `bad` with a `loop` or `repeat-stall` reads
> "looping".
>
> **Not built: the optional supervisor** (the Haiku agent below). It stays open, see the note in the
> section.

The CLI already reports what is needed. While a command runs it sends a heartbeat every 30 s:

```json
{"type":"tool_progress","tool_name":"Bash","parent_tool_use_id":"toolu_…","elapsed_time_seconds":60,"heartbeat":true}
```

Signals, all computed from data Agentry already receives:

| Signal | Rule | In the case above |
|---|---|---|
| **Hung command** | A command runs far longer than usual for its kind (history of durations), or past a fixed limit (e.g. 3 min) | After the first e2e run hit 3 min |
| **Same stall again** | The same kind of command (`pnpm e2e`) hangs or fails again | On the second e2e run: "2 hung e2e runs in a row" |
| **Busy without progress** | X minutes spending time and tokens with no new commit and no change in the worktree | Between its two commits |
| **Loop** | The same command or the same edit repeated, or the same error text coming back in tool results | Not here: it was not looping |
| **Tests bent to pass** | An existing test file edited to remove or loosen assertions | Yes: it was rewriting `pages.spec` |
| **Silence** | No event at all for X minutes with no command running | A stalled API call or model |
| **Budget** | A task past a time or cost limit set for it | If it had one, e.g. 20 min |

What happens when one fires:

- **A health badge** on every run and orchestration task (ok, slow, stuck, looping) with the reason
  in one line, e.g. "`pnpm e2e` running 5 min (usually 80 s); 2nd hang in a row".
- **A notification**, through the notification system being built on the global event feed.
- **One-click actions** for what had to be done by hand:
  - **Cancel the command**: kill only that command's process tree (the descendants of the run's
    CLI process that belong to it), without ending the turn. The worker gets a failed tool result
    and carries on.
  - **Send a hint**: a message with a suggested text for the signal ("the e2e run hangs: is a
    connection left open?"). It is read at the worker's next step.
  - **Interrupt** the turn, or **stop** the task.
- **Optional supervisor**: a cheap agent (Haiku) that only wakes when a signal fires, reads the
  worker's last steps and drafts the hint. Off by default; when on, it proposes and a person
  approves, unless set to send on its own.
  Not built by the orchestration that finished the rest of this section (`roadmap-completion.md`):
  every signal already carries a suggested hint text, written by Agentry, which covers the same
  ground without a second model to pay for, watch and trust. Still open.

## 4. Prevent it in the first place

> **Landed.** Worker prompts now carry the split of checks (see section 5) and tell workers to run
> long commands under `timeout`. The e2e harness has a limit per spec (`E2E_SPEC_TIMEOUT`, 180 s)
> and per run (`E2E_TIMEOUT`, 900 s), Chrome takes its own debugging port and is killed by the pid the
> harness started on every way out (pass, failure, timeout, `SIGINT`, `SIGTERM`, `SIGHUP`, a crash),
> and `e2e/harness.test.mjs` proves that no browser or server outlives a forced timeout. Per-task
> limits are `TaskLimits { maxMinutes?, maxCostUsd? }` on a task or a graph: the cost goes to the CLI
> as `--max-budget-usd` (a retry only gets what is left), and the time is Agentry's own clock, which
> warns the worker at 80 % and ends the task with the reason at the limit. A workflow graph refuses
> limits instead of ignoring them.

- **Worker prompts** tell workers to run long commands under `timeout`, and leave the e2e suite to
  the verification phase (section 5). The worker in the case above switched to `timeout` once told.
- **The e2e harness protects itself**: a time limit per spec and per run, and Chrome closed on every
  exit path (signals included), so no headless browser outlives its run.
- **Per-task time and cost limits** in an orchestration. The cost limit already exists per run
  (`--max-budget-usd`) and only needs exposing per task, with a soft warning before the hard stop.

## 5. Verify once, after integrating

> **Landed.** `verification: { commands, fixer, maxAttempts, model?, timeoutMinutes? }` on the
> orchestration, run in `finish()` after integration and before the synthesis, so the synthesis
> prompt and the pull request body carry the outcome. Each command runs alone under a timeout (default
> 20 min) and a hung one's process tree is killed by pid. The fixer's rules come from Agentry, it
> sees the failure, its earlier attempts and what each task did, and each command has its own
> `maxAttempts`; after each fix every command runs again from the first. The outcome is `passed`,
> `fixed` (with the fixer's commits) or `failed` (with the report and the checks that never ran),
> and `POST /orchestrations/:id/verify` runs it by hand. Required: `worktree: true` on the graph
> engine.
>
> **Left out:** a cost limit for the fixer (its attempts are bounded, its spend is not), an install
> step (a fresh worktree has no `node_modules`, so the commands list one), and turning the graph
> `failed` when verification fails (the graph's status stays about its tasks and `verification` is
> its own field).

The same orchestration showed where the time goes: in the e2e suite, run by every worker on its own
part of the change. A worker cannot see the whole: the one building notifications does not have
the detail views, and the other way round. Its e2e failures are mostly not its own, and it chases
them for minutes at a time, in parallel with other workers running the same suite on the same CPU.
The two stage 2 workers had run 4 and 2 e2e commands within their first minutes, before they were
told to leave the suite to the final task.

Split the checks by what each step can actually judge:

- **Workers**: `pnpm typecheck` and `pnpm test`, fast and reliable on a part of the change. They may
  write or update e2e specs but do not run the suite. Agentry adds this to every worker's prompt
  instead of relying on the objective to say it.
- **A verification phase** after integration, configurable per orchestration:
  - commands to run on the integration branch (for this repo `pnpm build`, then the e2e suite spec
    by spec);
  - a fixer agent for what fails, with rules that come from Agentry, not the objective: every
    command under `timeout`, one spec at a time, headless browsers closed after a hang, existing
    assertions never loosened (a behaviour that changed on purpose is stated as such), and at most N
    attempts per failure before it stops and reports what is left;
  - its outcome on the orchestration: passed, fixed (with the commits it made), or failed with the
    report, before the pull request is offered.

## Smaller items noted on the way

> **Landed, each as its own commit** — except answering from the notification, which stays open:
> the seeded notification, the link that opens the prompt (`/chats/:id?prompt=<id>`), the restart
> reason and time, `agentId` on `workflow.ended`, `sessionId` on every subagent, and the `detail.ts`
> tests. The two polls at the end were kept on purpose and are still worth revisiting.

- A run cut off by a wrapper restart is restored as `stopped` with no reason. Record "interrupted by
  a wrapper restart" and the real time it stopped.

Left over from 0.11.0, which brought the event feed, the notifications and the detail panels:

- **A run already waiting when the page loads gets no notification**: nothing happens while the page
  is open, so no event announces it. Seed the list on load from the `pendingPrompts` of `GET /runs`.
- A "waiting" notification opens the run, not the prompt that is waiting. It should scroll to it, or
  offer to answer it from the notification.
- A finished workflow links to the Workflows page rather than to the agent that ended, because the
  event carries no agent id.
- `GET /runs/:id` leaves `sessionId` off the subagents it reports. The aggregated `GET /subagents`
  has it, which is what the panel reads, so nothing is broken; it is inconsistent.
- `lib/detail.ts` has no unit tests of its own for encoding and decoding the `?detail=` parameter.
- Polls kept on purpose, worth revisiting when the CLI reports more: accounts (10 s, usage has no
  event) and the detail panels while an agent or task runs (2.5 s, neither the output file nor the
  transcript announces each line).

## Suggested order

All five steps were done except the second half of the fifth: per-task limits landed, the supervisor
did not.

1. Execution detail (section 1). The detail views for subagents and background tasks come with the
   orchestration that builds the global event feed, and this builds on both.
2. Stuck-agent signals, badge, notifications and the cancel-command and send-hint actions
   (section 3), with the e2e harness fixes (section 4).
3. The verification phase and the split of checks between workers and it (section 5).
4. Editor links (section 2).
5. Per-task limits and the optional supervisor.
