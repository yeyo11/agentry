---
created_at: 2026-09-27T06:00:00Z
updated_at: 2026-09-27T18:00:00Z
tags:
    - work-items
    - board
    - milestones
    - orchestration
    - chats
    - project-ecosystem
    - decision
---
# Work items: the board, and what works on it

A project's **board** says what the project needs done. Each card is a **work item** (`AGN-12`), in
one of five fixed columns, and it keeps every chat and orchestration that worked on it. "Work on it"
starts a chat on an item in its own worktree, "Orchestrate" turns a selection into a graph, and
"Create a task from this message" turns a chat's message into an item; the item then moves by
itself as that work goes, within rules that never fight the person using the board.

Built by orchestration 1 of the [project ecosystem](plans/project-ecosystem.md) and fixed by 1b
after [its audit](plans/project-ecosystem-audit.md): the contract in `packages/shared`, the store in
`packages/core/src/work-items.ts` (with its rows in `work-item-rows.ts` and its checks in
`work-item-validation.ts`), the links and automation in
`packages/core/src/work-links.ts`, and the routes in `apps/api/src/routes/work-items.ts`.
Orchestration 2 (`ecosystem-board-web`) built the screens from the prototypes the owner validated on
2026-09-27: the board, the list, All projects, milestones, the item's page and panel, New task, and
the entry points in chats and orchestrations. See [The screens](#the-screens).

A board belongs to a project whose **Board** module is on; see [projects.md](projects.md).

## Why `WorkItem`

"Task" already means an orchestration task and a background command (`GET /tasks`), so the model is
`WorkItem` everywhere in code and the API. The interface says "Task" / "Tarea", and its routes are
`/tasks`.

## The model

Fixed on purpose, and not configurable:

- **Five columns**: `backlog`, `todo`, `in_progress`, `in_review`, `done`.
- **Four types**: `epic`, `story`, `task`, `bug`. One level of hierarchy: an epic groups items, has
  no epic itself, and an item that is not an epic has at most one epic, of the same project.
- **Four priorities**: `low`, `medium`, `high`, `urgent`. A priority is not a status: only `urgent`
  may be shown in a colour.
- **No time.** No due date, no estimate, no sprint. `createdAt`, `updatedAt` and `closedAt` are facts
  about what happened, never a plan.

The fixed orders live in `packages/shared/src/work-items.ts`, so core, the API's validation and the
web never disagree on them. Each is built with `valuesOf`, which checks the list against its union
both ways, so neither can grow without the other.

A work item has a key, type, title, Markdown description, status, priority, free labels, an assignee
(the person, or a team role, reserved for orchestration 3), an epic, a milestone, an **acceptance
checklist** (each entry checked on its own, recording who checked it), **relations** (`blocks` and
`blocked_by` only), comments by the person and by agents, its history, and its links. No attachments.

A project's settings name the types its board offers and an optional **limit per column**. Going
over a limit is allowed: the move succeeds and reports it, and the board shows the column in the warn
colour with a word. The store does not refuse a type the board does not offer; that list is for the
screens to draw.

### Keys

Only an item's **number** is stored. It comes from a per-project counter that is never decremented,
so a number is never handed out twice inside a project, even after a delete. The key is composed on
every read from the project's current prefix (`workItemKey`), so changing the prefix renames every
key at once, history included. The id (a UUID) is what never changes.

### Milestones

A name (`v0.19`), a Markdown description, open or closed, and a progress figure derived from its
items, epics left out because they group work rather than being work. No date. Deleting a
milestone keeps its items, without it, and each records that in its history.

### Order inside a column

Each item has a `rank` inside its column, a fractional string compared byte by byte
(`packages/core/src/work-item-rank.ts`), so the order a person gives by dragging survives. A client
never sees or sends a rank: it moves an item by naming the item it goes after (`afterId`: `null` for
first, absent for last), so two people reordering at once do not collide. A move writes only the
moved row; a column whose ranks grow past 24 characters is respread inside the same transaction.

Appending to a column does not take the midpoint towards the end, which added a character every six
cards and respread a column filled from the bottom every 117 creates: it grows the first digit of the
last rank that can still grow, which adds a character every sixty. `rankBetween` checks that its
inputs are ranks and that its answer lies strictly between them, and throws otherwise; the store
then respreads the column, as it does for a rank grown too long.

## The rules the store keeps

`WorkItemService` has no HTTP in it, so every caller (the routes, the automation, a later agent) gets
the same rules:

- an epic has no epic, and an item's epic must be an epic of its project;
- a relation never points at its own item (400) nor closes a cycle of `blocks` (409, checked with a
  recursive query);
- a number is never reused;
- a move over a column's limit succeeds and says so;
- the actor is one of `person`, `agent` or `system`, with a role of at most 64 characters, and a
  stored kind this version does not know reads as `system`, never as the person (the automation asks
  the history whether the person moved an item, so a stray kind would freeze it);
- a comment is at most 50,000 characters, and asking for the comments of a missing item answers 404,
  like its history and its links;
- a link's `chatId`, `orchestrationId` and `taskId` are non-empty strings when present (400
  otherwise).

Search (`q`) and the label filter fold case in **every language**, not only ASCII: they are matched
in JavaScript on text folded through upper case and back, so `sesión` finds `SESIÓN` and `ß` matches
`ss`. Labels are de-duplicated on write with the same folding.

**History is written by the store, never by the caller**: one entry per field that changed, with the
actor (`person`, `agent` or `system`) and, when a chat or an orchestration did it, the cause (the
chat, the orchestration and task, and a stable event code a client translates). References in the
history (an epic, a milestone, a related item, a link) are snapshots, items by number, so an entry
still reads after a rename, a delete or a new prefix.

**Several wrapper processes share the database**, so every write runs in `BEGIN IMMEDIATE`: it takes
the write lock before reading the counter or the neighbours' ranks. A deferred transaction would get
`SQLITE_BUSY` at the lock upgrade instead of waiting. A test runs four processes against one data
directory and checks the numbers and the ranks. When SQLite has already ended a failed transaction,
the `ROLLBACK` that follows fails too; that failure is swallowed so the caller sees the error that
caused it.

Storage is one migration at the end of `MIGRATIONS` in `packages/core/src/db.ts`: work items, labels,
criteria, relations, comments, history, links, milestones and the per-project counter, indexed by
project, status and rank. `db.ts` exports `migrate(db, until)` and `WORK_ITEMS_SCHEMA_VERSION`, so
the upgrade test builds the release before it without assuming this migration is the last.

## Access

Changing anything needs the project **imported and with its Board module on**; otherwise the routes
answer 409. Reads only need the project imported, so switching the module off never makes its items
look lost. Items of a project removed from Agentry stay readable by id but leave every list, and
nothing changes them until the directory is imported again (which takes the same project id back).

`GET /work-items` and `GET /work-items/board` are the **All projects** view: every item of the
imported projects with the Board module on, each naming its project. That board carries no column
limits, and its counts are recomputed over the projects it shows.

## Working on an item

### "Work on it"

`POST /work-items/:itemId/work` starts a chat in the item's project, prompted with its key, title,
description and acceptance criteria (`workItemPrompt`), with the options a new chat takes except the
prompt and the directory.

The chat runs in the item's **own worktree**, on branch `task/<key>` in lower case, under
`<main checkout>/.claude/worktrees/task-<key>`, where the CLI keeps the worktrees it makes. It is made
the first time, locked so `git worktree prune` leaves it alone, and found again by every later chat
on the item. A project that is not a git repository, or has no commit to branch from yet, is worked
on in its directory.

- **Deleted by hand**: git still holds the worktree, locked, and would refuse to check its branch out
  again. Its record is unlocked and pruned, and the worktree is added again on the same branch, with
  its commits.
- **A plain directory** at that path, which git does not list as a worktree, is refused with 409:
  a chat running there would reach the main checkout with its git commands.

Refused: an epic (400); an item in `done` (409, as "Orchestrate" refuses it: nothing an agent does
may take an item out of `done`); an item a chat or a node is already working on (409). The start
options are checked for their type before any chat starts, and a wrong one is a 400 (before, a
number for `model` reached the CLI's arguments and failed as a 500). Of `mcp`, only the server names
are passed on, never a config path.

The chat is linked to the item in the same tick its process is spawned (`ChatService.create` takes an
`onStart` callback for this), so the item follows it from its very first status. If writing the link
fails, the chat just started is stopped and the error returned, so no chat runs unlinked.

`GET /work-items/:itemId/changes` and `…/changes/diff?path=` show what the item's branch changed,
read by `changes.ts` exactly as a chat's worktree is: commits, files and what is not committed yet.
Once the worktree is gone the branch is still read by name. There is no automatic pull request.

An item records the worktree and branch of **the last chat or node that worked on it**: "Work on it"
records its own, and the automation records a node's when the node's status changes. So an item
worked by an orchestration shows the node's changes, and "Work on it" afterwards continues there, on
the node's branch.

### "Orchestrate"

`POST /projects/:id/work-items/orchestrate` takes a selection (`itemIds`) and returns a **draft**,
not a launched graph: one node per item in the order they were picked, each prompted with its item
and naming it in `workItemId`, and `dependsOn` wherever one selected item blocks another. A blocker
outside the selection that is not done comes back in `externalBlockers`, since the graph cannot wait
for it. Every node gets its own worktree when the project is a git repository. Epics, items already
done and items of another project are refused.

The existing `POST /orchestrations` launches the draft. It now goes through core, which checks each
`workItemId` (an item of a project whose Board module is on, and at most one node per item, since two
nodes would pull it two ways) and links each node to its item. A graph relaunched from a saved
template is left unlinked: it is new work, not the items' own, and a template saved from a graph
drops every `workItemId` for the same reason.

**A relaunch keeps each node on its item.** `specOfTask` and `cleanTask`
(`packages/shared/src/orchestration.ts`) carry `workItemId`, and `POST /orchestrations/:id/relaunch`
goes through `core.relaunchOrchestration`, which checks the nodes' items exactly as a launch does.

### "Create a task from this message"

`POST /chats/:id/work-items` creates an item in `backlog` of the chat's project, with the message as
its description and, unless a title is given, its first line (Markdown marks dropped, 120 characters
at most) as the title. It is linked to the chat as its **origin**, and the chat is the cause in its
history. A chat in no imported project is refused with 409.

`GET /chats/:id/work-items` lists the items a chat works on or was the origin of, for the chat's
header.

### Links

A link ties an item to a chat, an orchestration task or a document, with the role it played. An
item keeps **every** link, not only the last. Links are rows, so they survive a restart; the chat's
title, its state or the task's status are filled in when read.

The unions were settled in 1b for what orchestration 3 needs, so the web can switch over them
exhaustively without them growing later:

- `WorkItemLinkKind`: `chat`, `orchestration` and `document` (with `documentPath`, relative to the
  project), for the specifications and decisions the Documents module ties to items.
- `WorkItemLinkRole`: `origin`, `refine`, `work`, `verify` and `reference`. The roles past `origin`
  follow the fixed columns (`refine` in `backlog` and `todo`, `work` in `in_progress`, `verify` in
  `in_review`), so the set does not grow with whatever team role a project puts on a column.
  `reference` is a link made by hand.

Only the contract has these yet. The store accepts a chat or an orchestration task, as `work` or
`origin`, and refuses the rest with 400; it has no column for `documentPath`, `bounces` or
`waiting`, which orchestration 3 adds with its own migration.
- `WorkItemSourceKind` stays `chat` and `orchestration`: it is what acts on an item. A team role acts
  through a chat, the person acts with no source, and a document never acts.

A work item also carries two optional fields for the flow by column (decisions 29 and 30), which
nothing writes before orchestration 3: `bounces` (absent reads as 0) and `waiting`, `approval` or
`bounces` (absent reads as null); `WorkItemChange` has `waiting` for its history.

## The automation

`WorkItemAutomation` (`packages/core/src/work-links.ts`) moves items as the chats and nodes linked to
them work. It listens to events that already exist, never polls:

| What happened | The item moves to | Cause code |
| --- | --- | --- |
| A turn of a linked chat started (`run.updated` from another status into `busy`) | `in_progress` | `chat.started` |
| A turn of a linked chat ended well (the runtime's result, not an error) | `in_review` | `chat.turn-completed` |
| A linked node started running (`orchestration.task`) | `in_progress` | `orchestration.task.started` |
| A linked node completed | `in_review` | `orchestration.task.completed` |

A failed or stopped turn, and a failed node, move nothing. Every automatic move is made by the actor
`system`, recorded in the history with its cause, and held to three rules, so a board never fights
the person using it:

1. **Forward only**: an item already at or past the target column stays.
2. **Never out of `done`.** Moving to `done` is the person's call.
3. **A person's move wins**: if a person moved the item after the turn or the node's attempt began,
   the automatic move is skipped.

A turn starts only on a **real transition into `busy`**: the previous status is neither null nor
`busy`. While a run is busy the publisher sends a coalesced `run.updated` about every 250 ms with
`previousStatus: null`; counting it as a turn restarted the turn's clock, so an item a person dragged
back to `todo` returned to `in_progress` at once. It never moves an item now, and a test sends it
exactly as the publisher does. An item in `in_review` stays there when its chat takes another turn,
since moves only go forward.

Every handler swallows its own failures: it runs inside someone else's event, and a board that cannot
be updated must not break a chat. An item whose chat was cut by a restart stays where it was.

## Events

Every change reaches the feed: `workitem.created`, `workitem.updated` (naming the fields that
changed), `workitem.moved` (with the previous column and whether the new one is over its limit),
`workitem.removed`, and `milestone.changed` (`created`, `updated`, `closed`, `reopened`,
`deleted`). The store emits them once the transaction is committed. Reordering the acceptance
criteria emits `workitem.updated` naming `criterion` and returns the new `updatedAt`, without a
history entry: the history records what the checklist says, not its order. The audit log records the writes
as it does every route's, named by their OpenAPI summary.

## The screens

Orchestration 2 built these from the validated prototypes (`DesktopTablero`, `DesktopTableroVacio`,
`DesktopTareasLista`, `DesktopTareasTodos`, `DesktopHitos`, `DesktopTarea`, `DesktopNuevaTarea`,
`DesktopChatTarea` and their `Mobile*` screens), for desktop and phone, in dark and light. They read
everything through the API with TanStack Query. The event feed (`lib/events.ts`) refreshes
exactly what `workitem.*`, `milestone.changed` and `project.updated` touch, so an item an agent moves
shows up on an open board without a reload. Run events refresh the boards too: a failed turn
changes no item, but it does end a live card.

`apps/web/src/lib/work-items.ts` is the model every screen reads from:

- the columns in order, with their glyph and label;
- the types and priorities, with their marks;
- the filters, read from and written to the address;
- grouping by column, and the open count;
- what makes an item live: its chat or node `working` (the rail and the spinner), or `waiting` for
  the person.

![The Tasks board of harbor-api in the dark theme: five columns, In progress over its limit of 3 with the words "Over the limit: 4 of 3", a live card with its ring spinner, live rail and the command its chat is running, an epic counting its tasks, a card blocked by another, and "and 2 more" in Done](media/board.png)

### Where Tasks is

- **Sidebar.** Tareas sits between Chats and Orquestaciones, with the open count of the selected
  project. With All projects selected it shows the total, as the validated prototypes draw it (the
  plan had said no count).
- **Phone.** Tareas is first in the More sheet, with "N open", and a New task FAB appears on Tasks.
- **Command palette.** It has "New task" and "Go to tasks".

The routes:

- `/tasks`: the board, or `?view=list`;
- `/tasks/milestones`;
- `/tasks/:key`: one item;
- `?new=1` on any of them opens New task.

The API has no route by key, so `/tasks/:key` finds the item with a `q=<key>` search and keeps only
the exact match.

### The board

- **Columns.** There are five, each with its glyph, mono label, count and optional limit. A column
  over its limit gets the warn hairline and the words "Over the limit: 4 of 3". It never refuses a
  card. Done shows its first three cards and then "and N more".
- **Cards** show:
  - the key and the type;
  - the priority mark (only `urgent` has a colour);
  - the title;
  - the epic and the labels;
  - the assignee;
  - the checklist's progress;
  - what blocks the item.

  An epic card counts its items instead. A card whose chat or node is working gets the live rail,
  the ring spinner, and a line saying what the agent is doing (from the shell's own queries).
- **Moving a card.** On a desktop, drag it with the pointer, between columns or within one. From the
  keyboard: Space picks the card up, the arrows carry it, Space drops it and Escape cancels, and each
  step is announced. Every move names the card it lands after (`afterId`), so the order survives a
  reload. The move is drawn at once in every cached board and list. If the API refuses it, the card
  goes back and a toast says so.
- **Toolbar.**
  - Search: `/` focuses it.
  - Filters: type, priority, label, assignee, epic and milestone, plus project on All projects. They
    are kept in the address.
  - The Board / List / Milestones switch.
  - Select.
  - New task: the zone's one primary action. `N` opens it, and so does a column's `+`.
- **Selection and "Orquestar".** An epic, a done item and another project's item cannot be picked,
  and each says why. The selection bar says which picked item blocks which. Orchestrate asks the API
  for the draft and hands it to the orchestration editor
  (`navigate('/orchestration', { state: { workItemDraft } })`).
- **A card opens its item.** On a desktop it opens in a 760 px panel beside the board (`?item=KEY`).
  On a phone it opens the item's page.
- **Empty board.** It shows `Empty` with the `board` illustration and "Create the first task". The
  FAB hides while that button is on screen, so the screen has only one gradient.

### List, All projects and milestones

- **List** (`?view=list`): the items grouped by column in board order. `J` and `K` move between rows.
- **All projects**: with All projects selected, every card names its project and no column shows a
  limit, as `GET /work-items/board` answers.
- **Milestones** (`/tasks/milestones`):
  - the open milestones as cards with their progress; the first one gets the screen's `grad-border`;
  - the closed ones as rows, with Reopen;
  - the open items that have no milestone.

  There are no dates anywhere. The page title stays Tasks, and the view switch shows which view is
  on.

### On a phone

There is no horizontal board. The columns become sections of one list, and a segmented control
jumps between them, showing the current column's name and every column's count (the warn colour for
one over its limit). Other differences from the desktop:

- the filters open in a sheet;
- each row has a move sheet;
- selection turns rows into pressed toggles, with a bottom bar;
- the page holds the project chip, so the top bar leaves out its own selector on `/tasks`
  (`pageHoldsScope`);
- Milestones has no FAB, because its header already has New milestone.

<p align="center"><img src="media/board-mobile.png" alt="The same board on a phone: the column jump on In progress, the section marked over the limit, and the live card first, with the command its chat is running" width="320"></p>

### A work item

The same view (`apps/web/src/pages/tasks/item/`) is the page at `/tasks/:key` and the panel beside
the board. It shows:

- **The header**: the key, the type, the column and the title.
- **The description**, in Markdown. It is edited in the app's `CodeEditor` and read through the
  Markdown renderer, so the app still has one editor.
- **Properties**, each edited in place from a menu on a desktop or a sheet on a phone: column,
  priority, type, assignee, epic, milestone and labels.
- **The acceptance checklist.** The whole row is the checkbox's label, so the row is the control on
  a phone too. Each checked row says who checked it and when, read from the history.
- **Relations** (*blocks*, *blocked by*), with add and remove.
- **Links**: the chats and orchestration nodes that worked on the item, with the chat list's own
  state badges and what each did to the item.
- **Changes**: the item's worktree, through the chat inspector's `SummaryView`.
- **Activity**: the history told in sentences and interleaved with the comments. An automatic move
  names its cause.

On a phone, Detalle, Actividad and Cambios are tabs. The page keeps its own bottom bar (the actions,
or the comment box on Actividad), so `/tasks/:key` hides the tab bar, as a chat does.

**"Trabajar en ella"** is the item's primary action. It opens the start options New chat offers (same
fields, same copy), calls `POST /work-items/:itemId/work` and opens the chat.

- On an epic or an item in Done, the item says why the action is not offered.
- While a chat is already working on the item, the action is "Open its chat" instead of a second
  chat.

**Mover a Hecho** is a plain secondary button: it is the person's approval.

![A work item in the panel beside the board: its key, column and title, the acceptance checklist with the first criterion checked by you, its relations and its properties, with Move to Done and Open its chat, since a chat is working on it](media/work-item.png)

### New task

On a desktop New task is a dialog. On a phone it is a full screen. It has these fields:

- type, title and description;
- column and priority;
- assignee;
- epic and milestone;
- labels;
- relations;
- acceptance criteria.

Relations are added once the item exists, since the API relates two existing items.

### From a chat and an orchestration

- **A message's menu** (a sheet on a phone) has "Copy" and "Create a task from this message". The new
  task goes to Backlog, linked to the chat, and a toast offers to open it. When the chat is in no
  project, or its project's Board is off, the menu item says why.
- **The chat's header** names the item the chat works on, the way `PartOf` names an orchestration,
  and the whole row is the link. A chat that an item was created from says so. The inspector's
  Summary shows the item's card.
- **The orchestration editor** opens the draft the board hands over in the router state. Each node
  shows its item's key, and blockers left outside the selection appear as a warning before launch.
  The nodes keep their `workItemId`, so launching links them.
- **An orchestration's page** names each node's item by its key, linked to the item.

## Routes

The README's [Work items](../README.md#work-items) table lists every route, with the filters (`status`,
`type`, `priority`, `labels`, `assignee`, `epicId`, `milestoneId` and `q` over title, description and
key). The OpenAPI descriptions in `apps/api/src/openapi/routes.ts` carry the details of each refusal.

## Not built yet

- Assigning to a team role does nothing yet; the roles, the flow by column (a role that acts when a
  card enters its column, QA sending an item back) and the approval of `done` are orchestration 3.
- On the board, the parts of `DesktopTableroEquipo` that need a team (role avatars, a column's
  responsible role) wait for orchestration 3, and so do the project's Team and Documents tabs.
- Suggested work items are orchestration 4, and the web has no "Suggest tasks" button until then.

## Known gaps

Left open by the fixes of 1b, each for its owner to decide:

- **Schedules skip the node checks.** A schedule filled from `specOfOrchestration` carries each
  node's `workItemId`, and the scheduler launches through `orchestrator.create` directly, not
  through core's checks, so a scheduled graph links to those items. Stripping `workItemId` there, as
  a saved template does, is the likely answer.
- **Only `work` links make a card live.** `linkOf` and `isLive` in `work-item-rows.ts` know the roles
  written today; orchestration 3 has to count `refine` and `verify` chats as live when it starts
  writing them.
- A generic error thrown while "Work on it" creates its chat reaches the client as a 400, not a
  500: that is the API's shared error handler.

Left open by the web of orchestration 2 (its `web-review` report):

- **A link in the history names the chat by its name**, not its first prompt ("Linked with
  task-agn-12-…"). Core stores the chat's name when the link is made (`linkLabel` in
  `packages/core/src/work-items.ts`). The glossary says a chat is named by its first prompt, so this
  needs a change in core.
- **The empty board's illustration always draws "AGN-1"**, not the project's own key.
- **Phone headers**: Tasks and the other phone screens keep the app's top bar, not the prototypes'
  back arrow. That is how the shell works on every screen.
- **No route by key.** `/tasks/:key` resolves through a search. A `GET` by key would save a request
  and the exact-match filter.

## Related

[[projects.md]] · [[plans/project-ecosystem.md]] · [[plans/project-ecosystem-audit.md]] · [[design-system.md]] · [[status.md]]
