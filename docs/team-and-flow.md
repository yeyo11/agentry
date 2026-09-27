---
created_at: 2026-09-27T20:00:00Z
updated_at: 2026-09-27T21:30:00Z
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
orchestration. The screens follow the prototypes the owner validated the same day. The board this
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
  `model`, its `responsibility`, and the paths it may write (`writes`).

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
adds the roles the person accepts. A project without a template (imported before modules existed),
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
| `maxParallel` | Runs of the project at once, 1 to 10. Absent reads as 2 (`DEFAULT_FLOW_MAX_PARALLEL`) |

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

The flow **starts paid runs on its own**, so what it will not do is part of the design:

- **At most `maxParallel` runs per project at once**, so the flow cannot drain the accounts' quota by
  itself. The rest wait in order.
- **One run at a time per item, and one queued run per item.** A second trigger replaces the queued
  run rather than adding one.
- **A queued run whose item has left its column is cancelled**, never started: a person's move wins.
  So is one whose column nobody answers for any more.
- **A run is moot when a person is working in the item's chat**: it is cancelled rather than started
  beside them.
- **Switching the flow, the Team module or the Board module off** cancels the queue and stops what is
  running. That is how a person stops it spending.
- **A runtime at its concurrent run limit** puts the run back in its place in the queue until a chat
  ends.

### How a run starts

Each run is a chat, started by `launchFlowRun` in `packages/core/src/index.ts`:

- in the item's own worktree, on `task/<key>`, as "Work on it" places it;
- `--agent <agent>`, with `--agents` pointing at a definition read from the agent file **in the
  project's checkout**. The worktree only has the agent files that were committed, and the file the
  person edits in Agentry is the one that should run. The definition is written under
  `data/flow-agents/`, named by its content;
- `--model` from the member;
- `--append-system-prompt` with the journal (see [The journal](#the-journal));
- `--json-schema` with the stage's result schema (`flowResultSchema`);
- a prompt with the item, as "Work on it" gives it, then the stage's instructions (`flowPrompt`).

A Developer's run **continues the item's work chat** when there is one, and starts its own if that
chat cannot be resumed. After a bounce, its prompt carries QA's newest comment. The chat is linked to
the item as it starts, with the stage as the link's role (`refine`, `work`, `verify`) and the member's
role as `teamRole`.

**What a member may write.** With no `writes`, the run's chat is in `acceptEdits`. With `writes`, it
runs in `dontAsk`: whatever is not allowed outright is denied, and only `Edit`, `Write` and
`NotebookEdit` under those paths are allowed (`writeRules`).

The plan said `--disallowedTools`. The CLI's rules cannot say "every path but these", so the paths
are allowed rather than the rest denied. A path the flag's syntax cannot carry (a comma, a
parenthesis, a space, `..`, an absolute path) is left out, which allows less, never more. `writes`
bounds the edit tools, not a shell command, and from a terminal it is only the agent file's
instructions. The member's screen says so.

### The structured result

Every run ends with a result held to its stage's schema:

| Field | Stages | What it becomes |
| --- | --- | --- |
| `summary` | all | The member's comment on the item |
| `verdict` | verify, required | `pass` or `fail` |
| `memoryProposals` | all | Proposals waiting for the person, while Shared memory is on |
| `documents` | all | Document ties on the item (`spec`, `adr`, `report` or `doc`), while Documents is on |
| `description`, `acceptanceCriteria` | refine | The item's new description, and criteria to add |

The result is read defensively (`parseResult`). The lists are cut at 20 proposals, 20 documents and
30 criteria, and an unknown document kind reads as `doc`. A Product Owner's description or criteria
are not applied when a person edited them while the run worked. A run that ends without a readable
result, or a verification without a verdict, is `failed` and moves nothing.

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
| any | failed or stopped | Nothing |

**Only a person moves an item to `done`** (decision 29). The flow never does and never moves an item
out of it. A person's move answers whatever the item waited for and starts a new round: `waiting`
clears and `bounces` goes back to 0. Every move the flow makes has the actor `agent` with the role,
and a cause the history translates: `flow.refined`, `flow.worked`, `flow.rejected`, `flow.passed`,
`flow.bounces`.

### Runs are rows, and a restart picks them up

Runs are rows in `flow_runs`, in a migration of `packages/core/src/db.ts`, with the item's `bounces`
and `waiting` as columns of `work_items`. Each row is `queued`, `running` or `ended`, with an
outcome: `passed`, `rejected`, `failed` or `cancelled`.

Starting a run claims its row with a guarded update, so neither two dispatches nor two processes on
one database start the same run.

The flow is driven by the event feed and the runtime's results, never by polling. Nothing starts
until the runtime has restored its chats, since a chat still being restored looks like one that
ended. Then `recover()` puts a run that the restart cut off back in the queue, **keeping its chat**,
so it continues there with "Agentry restarted while you were on this run". If a newer trigger for the
item already waits, the cut run is cancelled instead.

While a run goes on, its chat is the flow's: the work-links automation leaves it alone, so the two
never move the same card twice. A chat that a person resumes afterwards drops the run's agent, schema
and `keepAlive` again.

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

Every route is in the README: [Team](../README.md#team) (with `GET /projects/:id/flow`),
[Documents](../README.md#documents) and
[Project journal and memory proposals](../README.md#project-journal-and-memory-proposals).

Each change reaches the event feed, and the web refetches exactly what it touched
(`apps/web/src/lib/events.ts`):

| Event | Carries | The web refetches |
| --- | --- | --- |
| `team.changed` | `created`, `updated`, `removed`, `template` | The team and the project's agent files |
| `journal.changed` | `added`, `removed` | Every page of that journal |
| `memory.proposal` | `created`, `approved`, `rejected` | The proposals and, once approved, what the approval wrote |
| `document.changed` | `written`, `removed`, `tied`, `untied` | The tree, the file and the item it was tied to |
| `flow.run` | `queued`, `started`, `ended` | Who works on what, and the card it makes live |

A settings change reads the team and the flow again, since both live in the settings. A member's live
line is patched from `chat.activity`, as the chat lists are, instead of refetching the team every few
seconds.

## The screens

Built from the validated `DesktopEquipo`, `DesktopEquipoVacio`, `DesktopMiembro`, `DesktopFlujo`,
`DesktopTableroEquipo`, `DesktopMemoria`, `DesktopDocumentos` and `DesktopDocumentoEditar` and their
`Mobile*` screens (`MobileMemoriaDiario` and `MobileMemoriaCLI` included), for desktop and phone, in
dark and light. The project page's tabs are now, in order: Resumen, Tablero, **Equipo**,
**Documentos**, Memoria, Recursos, Worktrees and Ajustes. Each of the first four follows its module.

**A role is drawn one way everywhere** (`RoleAvatar` in `apps/web/src/pages/team/`): a neutral
squircle with its initials in mono, and the role's own hue only on the diamond in its corner. A
person stays a round monogram, so a board never mixes the two up. The template's roles are
translated; any other role is shown as written.

### Team: `/?view=team`

- **Members.** Each member shows its role and agent file, the columns it answers for (or that it is
  only consulted), where it may write, and what it does now. A file that is `missing` or `drifted`
  says so in words, in warn. The member at work carries the live rail; the rest stand still. The
  last card offers the agent files no member plays. The flow shows at a glance, with the team's latest
  work. The tab counts its members.
- **Empty team.** `Empty` with the `team` illustration, the template's team with the roles it brings,
  and "Add a member".
- **A member** (`&member=<agent>`). Its responsibility, write paths and model, saved through the team
  route. Its agent file in the existing editor, saved through the resources route, the file a
  terminal reads. Beside them: its columns, what it runs now and ran before, and its memory. On a
  desktop it is a page of its own, without the project's header and tabs, and the crumbs read
  "Equipo / Desarrollador".
- **The flow** (`&section=flow`). The switch, the role of each column, the bounce limit and each
  role's model, edited as one draft and saved together: the flow into the settings, each model into
  its member. The crumbs read "Equipo / Flujo". `maxParallel` has no control yet: it is kept as the
  settings hold it, and set through `PUT /projects/:id/settings`.
- **Add a member.** A role, the agent file that plays it (one already in `.claude/agents/` or a new
  one Agentry writes), its model and what it answers for.

### The board worked by a team

On one project's board with the Team module on:

- each column shows the role that answers for it while the flow is on;
- a card at work names the member on it;
- a card that QA sent back shows "rebote 1 de 3", neutral while it has bounces left;
- an item waiting for the person says why, with "Aprobar y pasar a Hecho" when verification passed
  it.

The toolbar has a way to the flow, with its state in a word. The All projects board and a project
without a team draw the plain board.

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

A member, the flow and an open document end in their own Save bar and hide the tab bar
(`hidesTabBar` in `lib/shell-live.ts` reads the query string too). The empty team is drawn on the
page with full-width actions.

## Known gaps

- **A card being refined or verified is not live.** `isLive` in
  `packages/core/src/work-item-rows.ts` still counts only `work` links. So a Product Owner's or QA's
  run gives the item no `activeLink`, and its card carries no live rail or spinner, although the Team
  tab shows that member at work. [The audit](plans/project-ecosystem-audit.md) left this for
  orchestration 3, and it is still open. Counting `refine` and `verify` chat links there is the likely
  fix.
- **`maxParallel` has no control** on the Flow screen.
- **The `file` team action** is in the contract (`TeamChangeAction`), but nothing emits it: an agent
  file saved through the resources route does not emit `team.changed`.
- **The template's responsibilities are English**, written by core into the metadata and the agent
  file, so they show in English in the Spanish interface.
- **Not built yet**: the team activity's "Ver todo" has no route to go to. ("Pedir propuesta" came
  with the assistant in orchestration 4.)
- **Small differences from the references**, left by the review:
  - the model picker shows "sonnet", not "sonnet · Sonnet 5";
  - "Ahora y antes" has no task count;
  - a narrow card's live line wraps its time;
  - the phone journal shows the person's monogram without "Tú";
  - the phone's "Editar" bar sits under a short document rather than at the bottom;
  - the shell highlights "Inicio" where the references highlight "Proyectos" or "Más", and the phone
    project screens keep the app's top bar. These are shell choices from orchestration 2.

## Related

[[projects.md]] · [[work-items.md]] · [[assistant.md]] · [[plans/project-ecosystem.md]] · [[plans/project-ecosystem-audit.md]] · [[design-system.md]] · [[status.md]]
