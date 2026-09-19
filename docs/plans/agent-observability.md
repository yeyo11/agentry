# Plan: see what every agent is really doing, and step in on time

Status: **planned, top priority** (see [ROADMAP](../../ROADMAP.md)). Written on 2026-09-19 after
the first large orchestration Agentry ran on its own repository.

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

## 4. Prevent it in the first place

- **Worker prompts** tell workers to run long commands under `timeout` and to run the e2e suite one
  spec at a time. The worker in the case above did so once it was told.
- **The e2e harness protects itself**: a time limit per spec and per run, and Chrome closed on every
  exit path (signals included), so no headless browser outlives its run.
- **Per-task time and cost limits** in an orchestration. The cost limit already exists per run
  (`--max-budget-usd`) and only needs exposing per task, with a soft warning before the hard stop.

## 5. Verify once, after integrating

The same orchestration showed where the time goes: in the e2e suite, run by every worker on its own
part of the change. A worker cannot see the whole: the one building notifications does not have
the detail views, and the other way round. Its e2e failures are mostly not its own, and it chases
them for minutes at a time, in parallel with other workers running the same suite on the same CPU.
By the time stage 2 started, the workers had already run e2e commands 4, 2 and a dozen times.

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

- Tag background tasks a subagent started as "from subagent": the CLI marks them with
  `owned_by_subagent: true` on `task_started`.
- A run cut off by a wrapper restart is restored as `stopped` with no reason. Record "interrupted by
  a wrapper restart" and the real time it stopped.

## Suggested order

1. Execution detail (section 1). The detail views for subagents and background tasks come with the
   orchestration that builds the global event feed, and this builds on both.
2. Stuck-agent signals, badge, notifications and the cancel-command and send-hint actions
   (section 3), with the e2e harness fixes (section 4).
3. The verification phase and the split of checks between workers and it (section 5).
4. Editor links (section 2).
5. Per-task limits and the optional supervisor.
