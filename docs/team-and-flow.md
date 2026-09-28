---
created_at: 2026-09-27T20:00:00Z
updated_at: 2026-09-28T23:30:00Z
tags:
    - team
    - flow
    - memory
    - journal
    - documents
    - project-ecosystem
    - decision
---
# The team, the flow by column, shared memory and documents

A project with its **Team** module on has a team of agents. Each member plays a role (Product Owner,
Developer, QA…). With the **flow by column** switched on, a card that enters a column starts the run
of the role that answers for that column: the Product Owner refines it, the Developer implements it,
and QA verifies it and passes it or sends it back. Agents move cards, but only a person moves one to
Done. What the team learns goes through the person too:

- members **propose** memory entries, and a person approves each one;
- a project **journal** records the decisions taken and the items closed, and every run is handed
  it;
- the documents a run writes (a specification, an architecture decision, QA's report) are tied to
  the item.

Orchestration 3 of the [project ecosystem](plans/project-ecosystem.md) (`ecosystem-team`) built this,
core and web, on 2026-09-27, following decisions 26 to 34 and the choices the planner wrote for that
orchestration. The screens follow the prototypes the owner validated the same day. Orchestrations 5
(`ecosystem-review-fixes`) and 6 (`ecosystem-gaps`) fixed it on 2026-09-28; the gaps 6 closed are
named by their number in [the plan](plans/project-ecosystem.md#orchestration-6-ecosystem-gaps). The board this
works on is in [work-items.md](work-items.md), and the modules and settings in
[projects.md](projects.md).

## The one rule holds

Everything a member does goes through the Claude Code CLI. A member is a CLI agent file, a run is a
chat started with `--agent`, and a run's result comes back through `--json-schema`. No SDK and no
HTTP call to Anthropic.

## A member is an agent file plus Agentry's metadata

`packages/core/src/team.ts` (`TeamService`). A member (decision 26) is two things:

- **An agent file**, `.claude/agents/<agent>.md` in the project. `claude --agent` reads it, so the
  same member works from a terminal.
- **Metadata** in `settings.team.members` of the project's settings document: the `role`, its
  `model`, its `responsibility`, the paths it may write (`writes`) and, optionally, the shell
  commands it may run in the work stage (`commands`, see
  [What a run may do](#what-a-run-may-do)).

**The agent file belongs to the person.** Agentry writes a starting file only where there is none,
with an exclusive create, so not even a race overwrites one. The file's frontmatter has `name`,
`description` (the responsibility) and `model`. Its body states the role, what the role does when
the flow hands it a card, what it may write, and how a flow run ends.

Afterwards Agentry rewrites the file to follow the metadata **only while it is byte for byte what
Agentry last wrote**. It keeps the hash of every file it wrote in `data/team-files/<projectId>.json`
to know that. Any other file is the person's and is never written again. `GET /projects/:id/team`
reports each member's file as:

- `ok`;
- `drifted`, naming the fields (`name`, `description`, `model`) whose frontmatter disagrees with the
  metadata;
- `missing`, when the file was deleted.

The person decides what to do about it; nothing is overwritten silently. The team also lists the
agent files in `.claude/agents/` that no member plays (`unassignedAgents`), which "Add a member"
offers.

- **Two members may not share a role** (409), since the flow hands a column to a role.
- **Taking a member off the team** keeps its agent file. The flow's columns keep naming the role,
  and nobody answers for them until a member takes the role again.
- **Changes need the Team module on** (409); reads do not. Switching the module off touches nothing
  on disk.

### The starting team

Proposing a team by reading the project is the assistant's job ([assistant.md](assistant.md)). Since
orchestration 4 the empty Team screen's primary action is "Pedir propuesta", which starts a `project`
run and opens the assistant's page; beside it stay the **template's team** and "Add a member". `POST /projects/:id/team/from-template`
adds the roles the person accepts, and answers **201 when it added a member and 200 when every role
was already on the team**, like the other creating routes (orchestration 6, gap 18). A project without a template (imported before modules existed),
or whose template has no team (Simple), is offered the Custom template's team, which is the software
one: switching Team on means wanting a team.

A role the template knows also fills the flow's **empty** columns: the Product Owner (or the
Researcher) takes `backlog` and `todo`, the Developer (or the Writer) `in_progress`, and QA (or the
Reviewer) `in_review`. The Architect is consulted and takes no column. A flow created this way is
**off**, with `maxBounces` 3: turning it on is the person's choice.

## The flow by column

`packages/core/src/flow.ts` (`FlowService`), decisions 28 to 30. The flow lives in the project's
settings, `flow`:

| Field | What it holds |
| --- | --- |
| `enabled` | The switch |
| `columns` | The role that answers for each column |
| `maxBounces` | How many times verification may send an item back in one round, 0 to 20 |
| `maxParallel` | Runs of the project at once, 1 to 10 (`MAX_FLOW_PARALLEL`). Absent reads as 2 (`DEFAULT_FLOW_MAX_PARALLEL`) |
| `maxCostUsd` | What one run may spend, in USD, above 0 and up to 100. Optional: absent means no limit of Agentry's own |

Both limits are edited on the Flow screen (see [Team](#team-viewteam)).

The flow runs only while it is on **and** the Team and Board modules are on.

### What starts a run

The column says the stage (`FLOW_STAGE_OF_COLUMN` in `packages/shared/src/work-items.ts`):
`backlog` and `todo` refine, `in_progress` works, `in_review` verifies, and `done` starts nothing.
A run starts when a card enters a column that has a responsible role with a member playing it. What
counts as entering:

- **A person's move**;
- **a new card**, since every path that makes one is a person's (decision 23);
- **the flow's own move**, which is how an item goes from one role to the next.

A move made by a chat or an orchestration following its own work (the work-links automation, actor
`system`) starts nothing: that item is already being worked on, and a run would compete with it.
Epics are never run on.

**Switching the flow on is not an entry**, so the cards already on the board do not start by
themselves. Instead, **with the person's consent**, they start as if they had just entered their
columns (CW-9, [spec](plans/flow-start-waiting.md), option A of
[the plan](plans/flow-start-and-chat-token.md)). When a save on the Flow screen takes the saved flow
from `enabled: false` to `enabled: true`, the screen reads `GET /projects/:id/flow/waiting`. If any
card waits, it asks "N tarjetas esperan en columnas con responsable", with one line per column and
its role:

- **"Ponerlas en marcha"** calls `POST /projects/:id/flow/start-waiting`. That queues one run per
  waiting card in board order (backlog, todo, in progress, in review, then by rank, top card first)
  through the same queue and limits as any other run. A toast says how many start now
  (`min(queued, maxParallel − running)`) and how many wait.
- **"Solo las nuevas"**, Escape or closing the dialog start nothing, as before.

A card **waits** when all of these hold:

- it is not an epic and not in `done`;
- its column has a role with a member playing it;
- it has no run queued or running;
- in `todo`, it was not refined and left unchanged since (the one-refine rule below).

The count and the queuing both come from core (`FlowService.waiting` and `startWaiting`), and the
test runs again inside the write transaction, so two clicks or two tabs never queue a card twice.
These runs keep `flow_runs.queued_by = 'person'` (`FlowRun.queuedBy`, and on the `flow.run` event),
and the item's history says a person started them ("Refinado puesto en marcha · <person> · …"), as
it does for a retry. Only the Flow screen asks: a raw `PUT /projects/:id/settings` that switches the
flow on starts nothing, and a client can call `start-waiting` itself. It was not made a flag on the
settings PUT, because that route replaces a whole document and should not start paid work as a side
effect. Rejected: always starting them (it spends without asking), and only a per-card start (the
surprise stays).

The flow **starts paid runs on its own**, so what it will not do is part of the design:

- **At most `maxParallel` runs per project at once**, so the flow cannot drain the accounts' quota by
  itself. The rest wait in order.
- **One run at a time per item, and one queued run per item.** A second trigger replaces the queued
  run rather than adding one.
- **A backlog card costs one refine run** (orchestration 6, gap 4). The Product Owner's move to `todo`
  would start the `todo` check, a second paid run to say the same. That check now starts only when
  the role's latest refine of the item did not pass, or when something changed on the item since that
  refine started: an edit, a criterion, a relation, or a comment from anyone but that run. Moves and
  links do not count. A check queued while the refine ran is cancelled when it claims its place, with
  the reason. Putting a card back in `backlog` still refines it, and a different role answering for
  `todo` still gives its own opinion.
- **A queued run whose item has left its column is cancelled**, never started: a person's move wins.
  So is one whose column nobody answers for any more.
- **A run is moot when a person is working in the item's chat**: it is cancelled rather than started
  beside them.
- **Switching the flow, the Team module or the Board module off** cancels the queue and stops what is
  running. That is how a person stops it spending. **Removing an item** stops its run too.
- **A runtime at its concurrent run limit** puts the run back in its place in the queue until a chat
  ends.
- **Each stage has only the tools it needs**, and `git push` is denied to every run (see
  [What a run may do](#what-a-run-may-do)).
- **A budget per run, when the person sets one.** `flow.maxCostUsd` goes to the CLI as
  `--max-budget-usd`, and the CLI stops the run once it is spent. There is **no default**: the owner
  decided on 2026-09-28 that runs are not capped unless the person asks, so a project that leaves the
  field out passes no budget at all.
- **A member never takes over a person's chat**, and a run a restart cut off goes on at most twice
  (see [Runs are rows, and a restart picks them up](#runs-are-rows-and-a-restart-picks-them-up)).

### How a run starts

Each run is a chat, started by `launchFlowRun` in `packages/core/src/index.ts`:

- working and verifying run in the item's own worktree, on `task/<key>`, as "Work on it" places it.
  **Refining runs in the project's checkout** and makes no worktree: it changes no code, a worktree
  per refined card was only clutter, and its specification belongs in the documents folder the
  Documents module reads;
- `--agent <agent>`, with `--agents` pointing at a definition read from the agent file **in the
  project's checkout**. The worktree only has the agent files that were committed, and the file the
  person edits in Agentry is the one that should run. The definition carries the file's `tools` and
  `disallowedTools` (as a comma list, a `[a, b]` list or a block list of `- a` lines,
  `readFrontmatterList` in `team.ts`) and the **member's** model, so a `model` in the file never runs
  a role on a model its screen does not show. It is written under `data/flow-agents/`, named by its
  content;
- `--model` from the member;
- `--append-system-prompt` with the journal (see [The journal](#the-journal));
- `--system-prompt-snapshot off`. By default the CLI records a conversation's system prompt on its
  first request and sends that record on every later resume, so a Developer's chat continued after a
  bounce would keep an old journal, and a person continuing a member's chat would keep the agent's
  prompt. Off, nothing is recorded;
- `--json-schema` with the stage's result schema (`flowResultSchema`);
- the stage's rules (below), and `--max-budget-usd` when the project sets `flow.maxCostUsd`;
- no `--add-dir` for the uploads directory: a run carries no attachment, and the people's uploads are
  not its to read;
- a prompt whose **first line is a title in the person's language**: the member's role, the item's key
  and its title ("Desarrollador · AGN-12 · Fix the cart"), since a chat is listed by the first line of
  its first prompt (orchestration 6, gap 13). A run starts with no request of the person's behind it,
  so the core keeps the language the panel last named in `Accept-Language`; a header that names none
  of Agentry's languages leaves it as it was. The run stores that language when it is queued
  (`flow_runs.language`, `FlowRun.language`), so a run still queued when Agentry restarts, before the
  person's next request names a language again, is titled as it would have been. The item follows, as "Work on it" gives it, then the
  stage's instructions in English (`flowPrompt`).

**A member never takes over a person's chat.** A Developer's run continues **its own chat from an
earlier round** (the item's latest `work` run in `flow_runs`), and starts its own if that chat cannot
be resumed. It never continues a chat a person started with "Work on it", although the item links
both the same way: resuming it gave the person's chat the member's agent, rules and schema, and they
stayed after the run. After a bounce, its prompt carries QA's newest comment. The chat is linked to
the item as it starts, with the stage as the link's role (`refine`, `work`, `verify`) and the member's
role as `teamRole`.

### What a run may do

`stageRules` in `flow.ts` gives each stage its permission mode and rules:

| Stage | Mode | Allowed | Denied |
| --- | --- | --- | --- |
| refine | `dontAsk` | `Read`, `Glob`, `Grep`; edits under the documents folder | `git push` |
| work, no `writes`, no `commands` | `acceptEdits` | the read tools, `Bash`, `WebFetch`, `WebSearch`, edits anywhere | `git push` |
| work, with `writes` or `commands` | `dontAsk` | the read tools, `WebFetch`, `WebSearch`; `Bash` whole, or `Bash(<pattern>)` for each of `commands`; edits under `writes` and the documents folder, or anywhere without `writes` | `git push` |
| verify | `dontAsk` | the read tools; `git status`, `diff`, `log`, `show`; the project's test commands; edits under the documents folder | `git push`; `--output` on those git commands, which writes a file |

- **`git push` is denied** as `Bash(git push)` and `Bash(git push *)`: a member's work stays on the
  item's branch until a person takes it further.
- **Only working reaches the network.** Refining and verifying read the project.
- **The documents folder is writable in every stage**, since each stage's prompt asks for its
  document there (a specification, an architecture decision, a report). A member with `writes: []`
  writes nothing of the project but that. Its agent file says so ("You write none of the project's
  files"); before, it said "no limit", the opposite of what the flow did.
- **The test commands a project declares** (`testCommandRules`) are what verifying may run: the
  `test`, `test:*`, `typecheck`, `lint` and `check` scripts of its `package.json`, run with the package
  manager its lockfile names; `make test` when the Makefile has that target; `cargo test`, `go test`
  or `pytest` for such a project. A `build`, `deploy` or `publish` script is never one of them.
- **`dontAsk` denies whatever is not allowed outright.** The CLI's rules cannot say "every path but
  these", so the paths are allowed rather than the rest denied (the plan said `--disallowedTools`). A
  path the flag's syntax cannot carry (a comma, a parenthesis, a space, `..`, an absolute path) is
  left out, which allows less, never more.
- **`writes` bounds the edit tools; `commands` bounds the shell** (orchestration 6, gap 7). A member
  without `commands` has the whole `Bash`, as before. With a list, each pattern (`npm test`,
  `pnpm *`…) becomes a `Bash(<pattern>)` rule in `dontAsk`, so nothing else runs, and an empty list
  means no shell at all. One rule in `packages/shared` (`teamCommandProblem`, and
  `isTeamCommandPattern` over it) decides what a pattern may be, for `PUT /projects/:id/team/:agent`,
  the settings document, the flow and the member's screen alike: one printable line, no parentheses,
  not only a wildcard, and **no comma**, since the flow hands the CLI its rules as one comma-joined
  `--allowedTools=` list and a comma would cut a rule in two. The route and the screen say a comma
  is the problem; the flow leaves out a pattern that got into the settings anyway, which allows
  less, never more. `null` in the route drops the list. The agent file Agentry owns says what the member may run. The
  template's Developer gets no list, so the default stays unlimited unless the owner chooses.
  Refining and verifying keep their own tool sets whatever `commands` says. From a terminal, both are
  only the agent file's instructions.

### The structured result

Every run ends with a result held to its stage's schema:

| Field | Stages | What it becomes |
| --- | --- | --- |
| `summary` | all | The member's comment on the item |
| `verdict` | verify, required | `pass` or `fail` |
| `criteria` | verify, required | Each acceptance criterion by its id, `met` or not, with a `note` |
| `memoryProposals` | all | Proposals waiting for the person, while Shared memory is on |
| `documents` | all | Document ties on the item (`spec`, `adr`, `report` or `doc`), while Documents is on |
| `description`, `acceptanceCriteria` | refine | The item's new description, and criteria to add |

The result is read defensively (`parseResult`). The lists are cut at 20 proposals, 20 documents and
30 criteria, and an unknown document kind reads as `doc`. A Product Owner's description or criteria
are not applied when a person edited them while the run worked. A run that ends without a readable
result, or a verification without a verdict, is `failed` and moves nothing.

**QA checks each criterion** (decision 18). Its prompt lists the item's criteria with their ids, and
its result judges every one. A criterion found met is **checked on the item as QA** (`checkedBy` is
the agent with its role). One found unmet is left as it is, so a person's own check stays. **The run
passes only when every criterion of the item is met**, whatever its `verdict` says: a `pass` with a
criterion unmet or left out is a rejection. QA's comment is its summary followed by each criterion as
`- [x]` or `- [ ]`, with QA's note, so the Developer who gets it back reads what is missing. An item
with no criteria is judged by its verdict.

### What a run's end moves

A move needs the flow still on, the item still in the column the run found it in, and **no person's
move since the run started**. Otherwise the run leaves its comment and moves nothing.

| Run | Ends | The item |
| --- | --- | --- |
| Refine in `backlog` | well | Moves to `todo` |
| Refine in `todo` | well | Stays: the summary says whether it is ready, and a person moves it on |
| Work | well | Moves to `in_review` |
| Verify | `pass` | Stays in `in_review`, **waiting for approval** (`waiting: 'approval'`) |
| Verify | `fail`, with bounces left | Back to `in_progress`, `bounces` + 1, and the Developer's chat resumes with QA's comment |
| Verify | `fail`, no bounces left | Stays, **waiting for the person** (`waiting: 'bounces'`) |
| any | failed or stopped | Nothing; a failed run says why in a comment |

**Only a person moves an item to `done`** (decision 29). The flow never does and never moves an item
out of it. A person's move answers whatever the item waited for and starts a new round: `waiting`
clears and `bounces` goes back to 0. Every move the flow makes has the actor `agent` with the role,
and a cause the history translates: `flow.refined`, `flow.worked`, `flow.rejected`, `flow.passed`,
`flow.bounces`.

**A failed run says so on its item.** It leaves a comment as its member, "This work run failed and
moved nothing: <reason>", with the run's chat as its source. The run carries the same reason in
`error`, in English. Before, the item only showed a chat that ended and moved nothing, and the reason
was on the Team screen alone. The Team screens show the reason beside the outcome, in the bad
colour, and the item's chat link reads "Ejecución fallida" with the reason. A run that ends on the CLI's budget says "it reached its budget of
<n> USD (flow.maxCostUsd)", and one cut by the account's rate limit with no other account to take it
over says so. A cancelled run
is a person's doing, or the flow going off, and writes nothing.

**Every run of an item is served by the core** (orchestration 6, gap 2):
`GET /work-items/:itemId/runs` answers every flow run of the item, newest first, with its stage,
member, outcome, error and chat. The item's links read it, each flow-made chat showing the newest run
in it, so an older failed run stays failed after the member runs again (before, the web read the team
data, which holds each member's latest run only). A chat a member ran for the flow says under its
"Works on" row that the run for that item failed, and gives the reason.

**The team's activity is paged** (gap 6): `GET /projects/:id/flow/runs` answers every run of the
project, newest first, filtered by `agent`, `status` (`queued`, `running` or an outcome) and `itemId`,
50 a page by default and 200 at most. Its cursor is the run's place in the queue rather than an offset, so a run queued
meanwhile does not shift the pages after it.

**A failed run keeps its cause as a code** (`FlowRunCause` in `packages/shared/src/types.ts`), beside
the English `error`: `budget`, `no-account`, `rate-limit`, `stopped`, `restarts`, `unreadable`,
`no-verdict`, `not-started`, `not-continued`, `chat-ended` or `chat-failed`, and for a cancelled run
its reason (`item-moved`, `item-removed`, `item-done`, `replaced`, `flow-off`, `no-member`, `refined`,
`chat-busy`). The web words the cause in the person's language, with the raw error under it in mono;
the English comment on the item is never shown as it is. A run ended before causes were kept reads
its cause from its error. Orchestration 7 added this for the design review, which asks for every
failure to say why in the person's words.

**A person can retry a failed run.** `POST /flow-runs/:runId/retry` queues the same step again for the
item while the item is still in the run's column; it answers 409 once the item left that column, or
once a later run of the same step exists. The retry counts as a person's move, so the item starts a
new round. The new run records the run it retries (`retryOf`); the failed run is read with the next
run of its step (`retriedBy`, whatever started it) and with `retryable`, whether a retry would queue
now. So a screen offers "Reintentar" only while it can work, and afterwards says what the next run
did.

**A run carries its step by column** (`step`, `FLOW_STEP_OF_COLUMN` and `flowStepOf` in
`packages/shared/src/work-items.ts`). The Product Owner's `refine` stage is a refinement in `backlog`
and a check in `todo`, where it only checks that the item is ready, so the screens say "comprobación"
and "Falló al comprobarla" there.

### Runs are rows, and a restart picks them up

Runs are rows in `flow_runs`, in a migration of `packages/core/src/db.ts`, with the item's `bounces`
and `waiting` as columns of `work_items`. Each row is `queued`, `running` or `ended`, with an
outcome: `passed`, `rejected`, `failed` or `cancelled`.

Starting a run claims its row with a guarded update, so neither two dispatches nor two processes on
one database start the same run. **The count of running runs and the claim share one `BEGIN
IMMEDIATE` transaction**: two processes could otherwise both see the last free place under
`maxParallel` and both take it.

The flow is driven by the event feed and the runtime's results, never by polling. Nothing starts
until the runtime has restored its chats, since a chat still being restored looks like one that
ended. Then `recover()` puts a run that the restart cut off back in the queue:

- It **keeps its chat**, and continues there with "Agentry restarted while you were on this run".
- It **keeps when it started** (`started_at`), so a person's move made before the restart still stops
  the run from moving the item.
- **Only its own chat.** If that chat cannot be continued (its record is gone, or something else
  holds it), the run **fails**, with its comment on the item. Before, it started a fresh chat whose
  only prompt was "Agentry restarted…", with none of the item's context, and that chat's result
  still moved the card.
- **At most twice** (`MAX_FLOW_RESTARTS`, counted in `flow_runs.restarts`). A run cut off a third
  time fails, since whatever keeps taking the wrapper down would keep spending.
- If a newer trigger for the item already waits, the cut run is cancelled instead.

While a run goes on, its chat is the flow's: the work-links automation leaves it alone, so the two
never move the same card twice.

**A person who continues a chat a member ran gets a chat back.** `ChatService.resume` asks the core
whether a flow or assistant run ever used the chat (`memberChat`). If one did, the runtime drops
everything the run set before the person's own options apply (`handBack` in `chats.ts`): the agent,
the agents file, the schema, the recorded-prompt switch, the appended journal, the allow and deny
lists, the budget, the permission-prompt setting and the servers. It also restores `keepAlive`, the
default permission mode and the uploads directory. The tools are what a new chat gets: the default
preset unless the person picks one. The model stays, because it is the chat's, shown on it and
switchable. Before, a person continuing the Developer's chat was still in `dontAsk` with the member's
allow list, and every edit outside `writes` was denied silently.

**A run that hits a rate limit waits for the account rotation** (orchestration 6, gap 3). When an
account hits its limit, the core rotates to another and replays the turn that died, as it does for a
chat. When the rotation is on its way (rotation on, `claude-swap` managing the accounts, a turn left
to replay, `FlowService.awaitsRotation`), the flow holds the run instead of failing it, ignores the
process the limit took down, and hears from the core's `rotateAndResume` how it went. Resumed, the
turn is replayed **in the same chat on the next account**, and the run ends as any other. With no
account left, or a replay that failed, the run fails and says why on the item. A run stopped while it
waits is never replayed. Each execution of a chat gets its own rotate-and-resume, so a member's chat
continued by a later run is not left without one. An assistant run's turn, also held to a schema
(`ChatManager.heldToSchema`), is still not replayed: the run that started it ended on the error, and
replaying it would spend on a result nobody reads.

## The journal

`packages/core/src/journal.ts` (`JournalService`), decision 32. The CLI's own memory (`CLAUDE.md` and
the project's memory directory) is shared memory as it is. The journal is what Agentry adds beside
it: rows per project in `journal_entries`, newest first, paged.

Three things write it:

- **An item reaching `done`** writes a `closed` entry with its title, who moved it and the chats that
  worked on it. It is written once per item, from the event feed. A partial unique index holds "once"
  even against two processes.
- **A memory proposal addressed to the journal**, once a person approves it (`memory`).
- **A person, by hand**: a `decision` or a `note`.

Every entry records who wrote it and, when it needed one, who approved it. An entry is at most 8,000
characters, since a longer one is a document.

**What a run is handed.** `handoff()` gives each flow run the newest entries that fit **16 KiB**
(`JOURNAL_HANDOFF_BYTES`), as one `--append-system-prompt` argument. It stops at the first entry that
does not fit, so the story a run reads has no hole. The size comes from two limits:

- the journal travels as one argument of `claude`, which Linux caps at 128 KiB;
- every run reads it on top of the role's own prompt, and a few thousand tokens of the newest entries
  is what a member needs to know what was decided.

## Memory proposals

`packages/core/src/memory-proposals.ts` (`MemoryProposalService`), decision 33. There is **no private
memory per role**, and a member never writes memory itself. A flow run's result proposes entries,
each with:

- a **target**:
  - `instructions`, a heading of the project's `CLAUDE.md`;
  - `memory`, a file of the CLI's memory directory;
  - `journal`;
- a **text**;
- a **reason**.

A target that could never be written is refused when the proposal is made, not at approval.

A proposal is a row, `pending`, until a person decides. Nothing reaches `CLAUDE.md`, the memory
directory or the journal before.

- **Approving** writes the target, with the person's edited text when they changed it:
  - to a memory file, it appends to the file, or creates it with frontmatter and indexes it in
    `MEMORY.md` (through `MemoryStore`);
  - to the instructions, it goes under the named heading of `CLAUDE.md`, ignoring headings inside
    code fences;
  - to the journal, it adds a `memory` entry.
- **Rejecting** writes nothing but the decision, with an optional reason.

Two processes may decide one proposal at once. The decision is claimed on the row first, so only one
writes the target. A target that cannot be written hands the proposal back to `pending`.

The journal's and the proposals' changes need the Memory module on (409); reads do not. There is no
route that creates a proposal: only a flow run's result makes one.

## Documents

`packages/core/src/documents.ts` (`DocumentService`), decision 34. The Documents module is the
project's **documents folder**, `documents.path` in its settings (`docs` by default): its Markdown
files, read and written from Agentry, and tied to work items.

**Path traversal is refused twice.** `document-paths.ts` refuses a path's shape first: absolute,
`..`, empty or hidden parts, not Markdown, or outside the folder. Then the file, or its nearest
folder that exists, is resolved through `realpath` and must still be inside the folder. So a symbolic
link planted in the repository cannot carry a read, a write, a delete or a tie out of it. The tree
skips links rather than following them. It is bounded at 16 levels and 5,000 files, and skips
`node_modules`, for a folder set to the project's root.

**A save never overwrites what an agent wrote meanwhile.** `PUT …/documents/file` takes the
`baseUpdatedAt` the editor opened, and a file changed since is refused with 409. The editor keeps the
person's draft and offers a reload. A file is at most 2 MiB.

**A tie is a work item link** of kind `document`, so an item keeps one list of everything it is tied
to. One migration added `document_path`, `document_kind` and `team_role` to `work_item_links`, for
every place the audit's note N5 lists:

- the row conversion reads every contract kind and role, and an unknown one reads as an inert
  `reference`;
- `link()` accepts every kind and de-duplicates a document by its path;
- the history labels a tie by its path;
- a document link has no chat state and is never live;
- tying or untying one emits `document.changed`.

`team_role` is general: the flow records the role whose run made any link.

- **A run's documents** are written by the agent itself, in the worktree, and reported in its
  result. Agentry ties each to the item with the run's stage as the link's role and the member's role
  as `teamRole`.
- **A person** ties a document by hand with `POST /work-items/:itemId/documents`, role `reference`.
- **Deleting a file** unties it from every item.

Reads work with the module off; changes need it on.

## Routes and events

Every route is in the README: [Team](../README.md#team) (with `GET /projects/:id/flow`, the team's
activity `GET /projects/:id/flow/runs`, the waiting cards `GET /projects/:id/flow/waiting` and
`POST /projects/:id/flow/start-waiting`, and an item's runs `GET /work-items/:itemId/runs`),
[Documents](../README.md#documents) and
[Project journal and memory proposals](../README.md#project-journal-and-memory-proposals).

Each change reaches the event feed, and the web refetches exactly what it touched
(`apps/web/src/lib/events.ts`):

| Event | Carries | The web refetches |
| --- | --- | --- |
| `team.changed` | `created`, `updated`, `removed`, `template`, `file` | The team, the agents list and the project's agent files |
| `journal.changed` | `added`, `removed` | Every page of that journal |
| `memory.proposal` | `created`, `approved`, `rejected` | The proposals and, once approved, what the approval wrote |
| `document.changed` | `written`, `removed`, `tied`, `untied` | The tree, the file and the item it was tied to |
| `flow.run` | `queued`, `started`, `ended` | Who works on what, the team's activity, an item's runs, and the card it makes live |

**An agent file saved or deleted through the resources route announces itself** (orchestration 6,
gap 19). `/config/resources/agents/:name?project=` tells a listener of every save and delete, and the
core emits `team.changed` with action `file` when the file is a member's, or while the Team module is
on (its unassigned agents changed). Before, the action was in the contract and nothing emitted it, so
the Team screen went stale after an edit in Recursos.

A settings change reads the team and the flow again, since both live in the settings. A member's live
line is patched from `chat.activity`, as the chat lists are, instead of refetching the team every few
seconds.

## The screens

Built from the validated `DesktopEquipo`, `DesktopEquipoVacio`, `DesktopMiembro`, `DesktopFlujo`,
`DesktopTableroEquipo`, `DesktopMemoria`, `DesktopDocumentos` and `DesktopDocumentoEditar` and their
`Mobile*` screens (`MobileMemoriaDiario` and `MobileMemoriaCLI` included), for desktop and phone, in
dark and light. Orchestration 7 brought them to the designer's review of those screens, which added
`DesktopEquipoActividad` and `DesktopChatFlujo` and their phone screens; what it applied and left is
at the end of [the review's note](design-system/ecosystem-review.md#applied-in-development). The project page's tabs are now, in order: Resumen, Tablero, **Equipo**,
**Documentos**, Memoria, Recursos, Worktrees and Ajustes. Each of the first four follows its module.

**A role is drawn one way everywhere** (`RoleAvatar` in `apps/web/src/pages/team/`): a neutral
squircle with its initials in mono, and the role's own hue only on the diamond in its corner. A
person stays a round monogram, so a board never mixes the two up. The template's roles are
translated; any other role is shown as written. It comes in four sizes; the 18 px one (`xs`) is for
the chips, a card's foot and a column's head.

**A run is named by its step**, the same way everywhere: refinado, comprobación, implementación,
verificación. A member at work says its step's verb (Refinando, Comprobando, Implementando,
Verificando), never the chat's tool verb. A running clock reads `m:ss` from the first second
("0:41"); an ended run's duration is words ("3 min 40 s").

**A responsibility that is still the template's is shown in the person's language** (orchestration
6, gap 14). Core keeps English in the metadata and the agent file, since Claude reads them. The web
translates a responsibility that is still the template's word for word, by role; an edited one shows
as written, and saving a member untouched keeps the English. A test reads core's
`project-templates.ts`, so the two lists cannot drift.

### Team: `/?view=team`

- **Members.** Each member shows its role and agent file, the columns it answers for (or that it is
  only consulted), where it may write, and what it does now. A file that is `missing` or `drifted`
  says so in words, in warn. The member at work carries the live rail and leads with the spinner,
  the item and its step verb; the rest stand still. A member whose last run failed says "Falló" in
  bad with the short reason. The last card offers the agent files no member plays. The flow shows at
  a glance, with the team's latest work; "Ver todo" opens Team activity (orchestration 6, gap 6). The
  tab counts its members. "Pedir propuesta" sits beside "Añadir miembro" on a team that has members
  too, as `DesktopEquipo` and `MobileEquipo` draw it.
- **Three views.** A segmented control switches between the members, the flow and Actividad.
- **Empty team.** `Empty` with the `team` illustration, redrawn with the flow's three roles over the
  stage each one does, the template's team with the roles it brings, "Pedir propuesta" and a quiet
  "Add a member", the only way to add one by hand. On a desktop the card reaches the status bar.
- **A member** (`&member=<agent>`). Its responsibility, write paths, shell commands and model, saved
  through the team route. The shell is any command, none, or the patterns listed, checked as the
  route checks them. The model is a `ModelPicker` (`components/controls`): the alias as a tag and the
  model it resolves to today, "[sonnet] Sonnet 5", once a chat has run on the alias (see
  [Known gaps](#known-gaps)); a list on a desktop and a sheet on a phone. "Ahora y antes" reads the
  member's runs from the team's activity, counts the tasks they worked on, and times the live row as
  `4:12`. Its agent file in the existing editor, saved through the resources route, the file a
  terminal reads. Beside them: its columns, what it runs now and ran before, and its memory. On a
  desktop it is a page of its own, without the project's header and tabs, and the crumbs read
  "Equipo / Desarrollador".
- **The flow** (`&section=flow`). The switch, the role of each column, one **Límites** card
  (orchestration 6, gap 5) and each role's model as a `ModelPicker`, edited as one draft and saved
  together: the flow into the settings, each model into its member. Límites holds the bounces and the
  runs of the project at once (steppers; 1 to 10, 2 unless chosen) and the cost per run (a field,
  empty for no limit), and leads to the runs. Unlimited stays the default: an empty field or zero
  drops `maxCostUsd`, and the default parallelism drops `maxParallel`, so nothing the person did not
  choose is saved. The field keeps the cost as typed, so "0." on the way to "0.5" is not wiped, and
  offers a decimal keypad on a phone. The list of items QA sent back moved to Team activity's
  "Devueltas". The crumbs read "Equipo / Flujo". A save that switches the flow on while cards wait
  opens the prompt from [What starts a run](#what-starts-a-run): a `Dialog` on a desktop, a bottom
  `Sheet` on a phone with both actions 44 px tall (`FlowWaiting.tsx`, `.flow-waiting`).
- **Team activity** (`&section=activity`, `pages/team/Activity.tsx`). Every flow run of the project,
  from `GET /projects/:id/flow/runs`: "Ahora" on top with what runs and waits, then one group per day
  ("Hoy", "Ayer · domingo 27"), where a run shows its bare hour and, before today, the day heads the
  group. Filters: Todas, En marcha, Fallidas and Devueltas, and a chip per member. Each row has the
  member's squircle, "QA · verificación", the outcome as a badge with its word, the item, what it did
  and, once ended, how long it took. A failed run shows its reason, the raw error, "Ver el chat" and
  "Reintentar", or what the retry did once it ran; a run whose item was deleted says so. Beside the
  runs: today by member and the flow's limits. The list pages by 50 with "Mostrar 50 más · quedan
  N". The crumbs read "Equipo / Actividad".
- **Add a member.** A role, the agent file that plays it (one already in `.claude/agents/` or a new
  one Agentry writes), its model and what it answers for.

### The board worked by a team

On one project's board with the Team module on:

- each column's head shows the role that answers for it while the flow is on;
- a card's strip, at its foot, says what the team is doing with it: a role queued for a place, at
  work with its step verb and clock, or failed with its reason ("Falló al comprobarla"); QA's words
  on a card it sent back; "te espera" with "Aprobar y pasar a Hecho" once QA passed it (see
  [work-items.md](work-items.md#the-board));
- a card the Product Owner refines or QA verifies is live too (orchestration 6, gap 1): `isLive` in
  `work-item-rows.ts` counts `refine` and `verify` chat links as it counts `work` ones, so the card
  carries the live rail and its strip says "Refinando" or "Verificando". Origin and reference chats
  and document ties never make a card live. On a narrow column the strip's verb wraps inside the card
  rather than pushing past its edge, and its clock keeps its place (`board-live-verb.test.ts` checks
  the rules in `board.css`);
- a card that QA sent back shows "rebote 1 de 3", neutral while it has bounces left.

The flow's button leads the header's views, with its state in a word; on a phone the flow's state is
one row under the view switch. The All projects board and a project without a team draw the plain
board.

**Assignee.** A task can be assigned to a role (decision 13). The task page, New task and the
board's Assignee filter offer the team's members while the Team module is on, and draw a role with
its avatar and translated name. The activity and the comments name roles the same way.

### A task's documents and waiting state

A task shows the documents tied to it, each with its kind (SPEC, ADR, INFO, DOC), its title and the
role that wrote it, and can tie one by hand.

Its **waiting panel** (`.item-wait`) says what it waits for (QA passed it, or QA sent it back as
often as the project allows), with the verifier's newest comment and the two moves that end the
wait: "Aprobar y pasar a Hecho" and "Volver a En curso". Approval puts the first one first; used-up
bounces put "Volver a En curso" first. Either move is the person's, so it clears the wait and resets
the bounces.

### Documents: `/?view=documents`

- **On a desktop**: the folder as a tree, the open document, and the documents tied to tasks, side by
  side.
- **An open document** (`&doc=<path>`) is rendered at reading width. With `&mode=edit` it opens in
  the one `CodeEditor` with its path bar.
- **A generated document** says where it came from: the role, the task, the chat and when.
- **New document**: blank, or tied to a task from the start, with its path starting from the task's
  key.
- **On a phone**, each part is a screen of its own, and the editor and a preview of the draft take
  turns.

The tab counts the files.

### Memory: `/?view=memory`

- **Proposals**, approved, edited or discarded one by one. The tab counts those waiting, in the idle
  colour.
- **The journal**, grouped by day, with entries added by hand and what every flow run is handed.
- **The CLI's files**: `CLAUDE.md` and the memory directory, opened in the editor.

On a phone the three are tabs of one screen (`&section=proposals|journal|cli`).

### On a phone

These screens have no app top bar. A project's page and its tabs are routes the shell marks
`phoneHeader: 'page'` (`components/shell/phone-header.ts`), and each draws `PhoneHeader`: the way
back, "Equipo" over the project with its member count (or its unsaved changes), and "⋯" as a sheet.

A member, the flow and an open document end in their own Save bar and hide the tab bar
(`hidesTabBar` in `lib/shell-live.ts` reads the query string too). The empty team is drawn on the
page with full-width actions, "La plantilla trae" over the template's roles, and its third action in
"⋯". In Team activity the member filter is the header's button, and a whole row opens the run's
chat, with no control inside it. The Flow's Límites are cells.

A failed run's chat keeps the chat page's header on a phone, as every chat does; see
[work-items.md](work-items.md#from-a-chat-and-an-orchestration) for its banner.

Since orchestration 6 the phone screens follow their references more closely:

- **They head themselves** (gap 21). A project's tabs, a member, the flow, the team's activity and a
  document drop the app's top bar below 900 px (`hidesTopBar` in `lib/shell-live.ts`, by the routes
  of `phone-header.ts`) and start with their own `PhoneHeader`: a 44 px way back and the title. The
  desktop app keeps the bar, which is also its window's title bar.
- **Every tab's screen leads to the assistant** (gap 8): the first entry of its "⋯" sheet
  (`assistantEntry` and `phoneViewMore` in `pages/home/ProjectHead.tsx`), on the Team screens and
  their activity too, and on Ajustes and Recursos, whose sheet holds only it. The project's own
  screen has the assistant row instead.
- **The shell marks where the person is** (gap 22): the tab bar marks "Más" on a project's page and
  its tabs, where Projects lives, and the sidebar marks "Proyectos" on a desktop
  (`components/shell/nav.ts`).
- **A document's bars sit at the bottom edge** (gap 23). Reading, "Editar" is pinned there however
  short the document, as `MobileDocumento` draws it. Editing, the screen takes the height the page
  leaves, the editor fills it and scrolls a long file itself, and "Descartar" and "Guardar" reach the
  edge above a divider, as `MobileDocumentoEditar` draws them.
- **The journal says "Tú"** beside the person's monogram, as `MobileMemoriaDiario` does, and drops
  "written by you", which would say it twice.

## Known gaps

Orchestration 6 (`ecosystem-gaps`, 2026-09-28) closed every gap this section listed; each is
described above where it now lives. The last detail, the model's name, was closed after it:

- **The member's model reads "sonnet · Sonnet 5" once a chat has run on the alias.** The member
  page writes, after the model, the label the overview's `system.models` gives it (`ModelName` in
  `pages/team/RoleAvatar.tsx`), and the model pickers list the same labels. The CLI's own list
  (`additionalModelOptionsCache` in `.claude.json`, read by `packages/core/src/models.ts`) labels
  only the models an account adds beyond the aliases, never `sonnet`, `opus`… So the name of an
  alias is learned from the CLI's stream instead (option A, the owner's choice on 2026-09-28): each
  chat's `system/init` event reports the model id its process runs, and when the chat was started
  with an alias (`--model sonnet`) that id is kept for it (`ModelAliasIds` in `models.ts`, the
  document `model-aliases.json` in the data dir, rewritten only when an alias moves to another
  model). The name comes from the id by rule (`modelDisplayName`): drop `claude-`, a trailing
  release date and a `[…]` variant, then the family capitalised and the version's digits joined
  with dots, with the variant after it: `claude-sonnet-5` is "Sonnet 5", `claude-opus-5-5`
  "Opus 5.5", `claude-haiku-4-5-20251001` "Haiku 4.5", `claude-fable-5-1[1m]` "Fable 5.1 (1M)". A
  label the CLI gives wins over the derived one. Until a chat has run on an alias it shows alone,
  and an id off that scheme is left unnamed rather than guessed. No list of Agentry's own and no
  call to Anthropic: only what the CLI reported.

## Related

[[projects.md]] · [[work-items.md]] · [[plans/flow-start-waiting.md]] · [[plans/flow-start-and-chat-token.md]] · [[assistant.md]] · [[plans/project-ecosystem.md]] · [[plans/project-ecosystem-audit.md]] · [[design-system.md]] · [[status.md]]
