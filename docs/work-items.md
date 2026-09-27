---
created_at: 2026-09-27T06:00:00Z
updated_at: 2026-09-27T12:00:00Z
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
`packages/core/src/work-links.ts`, and the routes in `apps/api/src/routes/work-items.ts`. There is
no screen yet: the board, the list, the item's page and the entry points in a chat are prototyped in
`docs/design-system/reference/` and orchestration 2 builds them once the owner validates them.

A board belongs to a project whose **Board** module is on; see [projects.md](projects.md).

## Why `WorkItem`

"Task" already means an orchestration task and a background command (`GET /tasks`), so the model is
`WorkItem` everywhere in code and the API. The interface will say "Task" / "Tarea".

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

## Routes

The README's [Work items](../README.md#work-items) table lists every route, with the filters (`status`,
`type`, `priority`, `labels`, `assignee`, `epicId`, `milestoneId` and `q` over title, description and
key). The OpenAPI descriptions in `apps/api/src/openapi/routes.ts` carry the details of each refusal.

## Not built yet

- Every screen: orchestration 2, once the prototypes are validated.
- Assigning to a team role does nothing yet; the roles, the flow by column (a role that acts when a
  card enters its column, QA sending an item back) and the approval of `done` are orchestration 3.
- Suggested work items are orchestration 4.

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

## Related

[[projects.md]] · [[plans/project-ecosystem.md]] · [[plans/project-ecosystem-audit.md]] · [[design-system.md]] · [[status.md]]
