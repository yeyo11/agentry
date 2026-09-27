---
created_at: 2026-09-27T01:59:47.104538408Z
updated_at: 2026-09-27T20:00:00Z
tags:
    - plan
    - projects
    - work-items
    - board
    - team
    - memory
    - ai-suggestions
    - design-system
---
# Plan: the project ecosystem

Turn a project from "a name and a path" into the place where its work is followed, the way a real
project is: a board of work items tied to chats and orchestrations, a team of agents with roles, a
memory the team shares, documents, and an assistant that reads the project and suggests what to
create. Every piece is a **module** a project switches on when it is created or edited.

This plan is the source of truth for the orchestrations that build it, together with CLAUDE.md,
CONTRIBUTING.md and [docs/design-system.md](../design-system.md). Where a task prompt and this plan
disagree, the plan wins; where the plan and the design system disagree on a visual detail, the
design system wins.

Status: **orchestration 1 (`ecosystem-foundation`) built on 2026-09-27, and fixed by orchestration
1b (`ecosystem-fixes`) the same day** after [its audit](project-ecosystem-audit.md), see
[Outcome](#outcome). The prototypes wait for the owner's validation. Orchestrations 2 to 4 are described here and get their task sections before each is launched.

## Why

Agentry runs chats and orchestrations, but it has nowhere to say *what the project needs done*. Work
starts from a prompt typed on the spot and leaves no trace once the chat is closed. The resources of
a project (agents, skills, commands) are written by hand in an editor, with no help and no relation
to what the project is. A project is only `{ id, name, path }`, and the only thing that can be
edited about it is its name.

## Decisions already taken, not to be reopened by a task

They were agreed with the project's owner on 2026-09-26 and 2026-09-27.

### Projects and modules

1. **Modules per project.** Board, Team, Documents and Shared memory are modules. Creating or
   editing a project offers a **template that preselects modules, plus one switch per module**.
2. **Five built-in templates**: Simple (no modules), Professional software (everything), Library or
   package, Research or documentation, Custom (everything off). No user-saved templates for now.
3. **A template carries configuration, not only switches**: the modules, the work item types, the
   optional limits per column, the starting team and the model of each role.
4. **Switching a module off hides it and keeps its data.** Switching it on again brings everything
   back. Nothing is deleted by a switch.
5. **Projects already imported keep every module off** until someone switches one on.
6. **The ecosystem lives in tabs on the project page**: Overview, Board, Team, Documents, Memory,
   Resources, Settings. A tab exists only while its module is on. The sidebar gets a **Tasks** entry
   between Chats and Orchestrations that opens the board of the selected project; with All projects
   selected it shows every project's work items with the project named on each. On a phone, Tasks
   is in the More sheet and the board is a list grouped by column.

### Work items

7. **The model's name is `WorkItem`**, because `task` already means an orchestration task and a
   background command (`GET /tasks`). The interface says "Task" / "Tarea".
8. **No time in a work item.** No due date, no estimate, no time tracking, no sprints with a
   calendar. `createdAt` and `updatedAt` exist as facts, never as a plan.
9. **Five fixed columns**: `backlog`, `todo`, `in_progress`, `in_review`, `done`. Not editable.
10. **Fixed types**: `epic`, `story`, `task`, `bug`.
11. **One level of hierarchy**: an epic groups work items. An epic has no parent, and a work item
    that is not an epic has at most one epic.
12. **A key per project, YouTrack style**: `AGN-12`. The prefix is derived from the project's name,
    editable in the project's settings, and the number never repeats inside a project.
13. **Fields**: key, type, title, description (Markdown), status, priority (`low`, `medium`, `high`,
    `urgent`), free labels, assignee (the person, or a team role once the Team module exists), epic,
    milestone, acceptance criteria, relations.
14. **Milestones without dates**: a name ("v0.19"), a description, open or closed, and a progress
    figure derived from its work items.
15. **Two views**: the board, and a list with filters and search.
16. **Optional limit per column.** Going over it is allowed and shows in the warn colour with a
    word; it never blocks the move.
17. **Inside a work item**: the automatic history of changes, and comments written by the person
    and by agents. No attachments.
18. **Acceptance criteria are a structured checklist**, each entry checked on its own, with who
    checked it.
19. **Relations**: `blocks` and `blocked by` only. Orchestrating a selection turns them into the
    graph's `dependsOn`.
20. **Work items and git**: working on an item happens in its own worktree and branch
    (`task/<key>`, lower case), and the item shows what changed there. No automatic pull request.

### Links with chats and orchestrations

21. **"Work on it"** starts a chat in the project with the item's description and acceptance
    criteria as the prompt, in the item's worktree. The item moves to `in_progress` when the chat
    starts and to `in_review` when the chat's turn ends well. A failed or stopped chat moves
    nothing. Every automatic move is recorded in the history with its cause.
22. **"Orchestrate"** on a selection creates an orchestration whose nodes are those items. Each node
    is linked to its item, and the item follows the node's status.
23. **Only work items created on the board are cards.** An orchestration launched from elsewhere
    does not create cards.
24. **"Create a task from this message"** in a chat creates a work item in `backlog`, linked to the
    chat, with the message as its description.
25. A work item keeps **every chat and orchestration that worked on it**, not only the last.

### Team, memory and documents (orchestration 3)

26. **A team member is a CLI agent file** in the project's `.claude/agents/`, so it also works from a
    terminal, plus role metadata Agentry keeps (role, responsibility, model, what it may write).
27. **The assistant proposes the team** after reading the project, and the person accepts member by
    member. With nothing to read, the template's team is offered.
28. **Flow by column, switchable per project**: each column has a responsible role that acts when a
    card enters it. The Product Owner refines in `backlog` and `todo`, the Developer implements in
    `in_progress`, QA verifies in `in_review`.
29. **Agents move cards; the person approves the move to `done`.**
30. **When QA rejects**, the item goes back to `in_progress` with the comment and the same chat is
    resumed. After a maximum number of bounces, set per project, the item waits for the person.
31. **A model per role**, editable: Opus for Product Owner and Architect, Sonnet for the others.
32. **Shared memory** is the CLI's own (`CLAUDE.md` and the project's memory directory) plus a
    **project journal** Agentry keeps (decisions taken, items closed), handed to each agent when it
    starts.
33. **Every role proposes memory entries and the person approves each one.** No private memory per
    role.
34. **Documents**: a viewer and editor of the repository's documents folder, plus documents
    generated by an agent and tied to work items (specifications, architecture decisions).

### Suggestions (orchestration 4)

35. **The assistant suggests on demand and when a project is created**: team, resources and first
    work items. Never on a schedule.
36. **Suggested work items and resources are accepted one by one** before anything is written.
37. **Resources with AI**: "Suggest" reads the project and proposes agents, skills and commands with
    their content; "Create with AI" builds one from a description. Both open the existing editor so
    the person reviews before saving, in the project's scope by default.

### How it is built

38. **The one rule holds.** Everything an agent does goes through the Claude Code CLI: a chat with
    `--json-schema` for structured suggestions, agent files for roles. No SDK and no HTTP call to
    Anthropic.
39. **Prototypes first.** Every new screen gets a static prototype in
    `docs/design-system/reference/`, in both themes, desktop and phone. The owner validates them
    before any web task builds a screen.
40. **Four orchestrations, all landing in one branch, `feat/project-ecosystem`**, all tasks on Opus,
    with no time or cost limit. Each starts from the head of that branch and is merged back into
    it; nothing reaches `main` until the owner has tried the whole feature, in one pull request
    (decided on 2026-09-27, replacing "one pull request each"). What the first one left to fix is in
    [the audit](project-ecosystem-audit.md):

| # | Name | Builds |
|---|---|---|
| 1 | `ecosystem-foundation` | Shared types, project modules and templates, the work item store and API, the links with chats and orchestrations, and the prototypes of **every** new screen |
| 2 | `ecosystem-board-web` | The web of orchestration 1: project wizard and settings, project tabs, board, list, work item detail, the chat and orchestration entry points. Launched once the prototypes are validated |
| 3 | `ecosystem-team` | Team, flow by column, journal and memory proposals, documents, core and web |
| 4 | `ecosystem-assistant` | The project assistant, suggested work items, resources with AI |

## Not in orchestration 1

- Any file under `apps/web/src`. The web is orchestration 2, after the prototypes are validated.
- Team, flow, journal, documents and suggestions in core or in the API. Orchestration 1 only
  **prototypes** their screens. The shared types may reserve `assignee.role` as a string.
- Dates, estimates, sprints, attachments, editable columns, configurable types, user templates.
- New languages.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects, in
   English, with a body that explains why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By` and no "Generated with" trailer, ever.
3. **Code, comments and docs are in English.** The prototypes show the intended `es` copy, which
   follows `apps/web/src/i18n/GLOSSARY.md`: Spanish from Spain, infinitive buttons, sentence case.
4. **Checks you run:** `timeout 900 pnpm typecheck` and `timeout 900 pnpm test`. You may write e2e
   specs, but **do not run `pnpm e2e`**: it runs once, in the verification, on the merged branch.
5. **Every long command runs under `timeout`.** If one hits its timeout twice, stop and report it.
6. **TypeScript strict and no `any`.** Respect `noUncheckedIndexedAccess`. Comments explain why.
7. **Storage follows the convention.** Settings-shaped documents go in JSON files written with
   `writeAtomic`; accumulating records go in SQLite as rows, through a new entry at the end of
   `MIGRATIONS` in `packages/core/src/db.ts`. Never edit a migration that already exists.
8. **Every new route** gets a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in the
   README's REST API tables. After changing `packages/shared/src/types.ts`, run
   `pnpm --filter @agentry/api openapi:schemas` and commit the result.
9. **Every change reaches the event feed.** A work item or a project's modules changing emits an
   `AgentryEvent` that names what changed and carries the ids to refetch it.
10. **Never touch the real `~/.claude`.** Tests and experiments set `CLAUDE_CONFIG_DIR` and the data
    directory to scratch directories.
11. **Don't touch files outside your scope** (see ownership). If you need something from another
    task's file, say so in your result instead of editing it.
12. If something in your scope turns out impossible, or much larger than it looks, **do the rest
    and say what you left out**. Don't silently narrow the scope.
13. **In your result**, say plainly what you delivered, what you left out and why, how you verified
    it (the exact commands and their outcome), and documentation notes for the `docs` task.

### Rules of the prototype tasks

14. **Read [docs/design-system.md](../design-system.md) in full and open the existing reference**
    (`docs/design-system/reference/index.html`, the `Desktop*` and `Mobile*` screens, `DSComponentes`,
    `DSEstados`, `DSMovil`) before drawing anything. A new screen is built from the components that
    exist. The shell (sidebar, top bar, status bar, tab bar) is the one the other screens use.
15. **Tokens only**: every colour, radius, shadow, font, duration and easing comes from the
    variables of `agentry-ds.css`. No hex, `rgb()`, pixel radius or millisecond value in a page.
16. **Both themes, both sizes.** Desktop at 1440 x 1024 and phone at 390 x 844, dark and light
    (`#light`). Contrast is at least 4.5:1 for text and 3:1 for large numbers in both.
17. **The gradient is used sparingly**: at most two gradient surfaces per screen, on the one primary
    action of a zone and on what the screen is about. Never as a background.
18. **Only live things move.** Cyan and loops mean an agent is working now. A card whose chat is
    running carries the live rail and the ring spinner; a card at rest is still. At most one energy
    border per screen.
19. **Status colours mean one thing each** and always come with a word or an icon: ok is done, warn
    is near a limit or stopped, bad is failed or destructive, idle is waiting for the person.
    Priority is **not** a status: it uses neutral marks, with `urgent` the only one allowed a colour.
20. **Type**: Geist for the interface, Geist Mono for keys (`AGN-12`), ids, paths, counts and section
    labels, on the scale of the design system. Numbers are tabular.
21. **Phone**: touch targets of at least 44 px, inputs at 16 px, "..." menus as a sheet, no
    always-visible checkboxes, and no horizontal board: columns are sections of one list, with a
    segmented control to jump between them.
22. **Empty states** use the `Empty` pattern with one illustration, never next to live data. A new
    illustration is drawn in the language of the existing set, coloured by classes, and its SVG goes
    into `docs/design-system/illustrations/`.
23. **Screenshots**: every screen is captured with headless Chrome (`CHROME_BIN`) into
    `docs/design-system/reference/screenshots/<Screen>-dark.webp` and `-light.webp`, and you look at
    them before finishing. A screen you have not looked at is not done.
24. **A new component variant** goes into `agentry-ds.css` and into §2 of `docs/design-system.md`,
    with the app class it will map to.

## File ownership

| Task | Owns |
|---|---|
| `types` | `packages/shared/src/types.ts` (the new sections), the generated OpenAPI schemas |
| `proto-foundation` | `docs/design-system/agentry-ds.css`, `docs/design-system/illustrations/**`, the project, board and work item screens under `docs/design-system/reference/`, and their screenshots |
| `project-modules` | `packages/core/src/projects.ts`, new `packages/core/src/project-settings.ts` and `project-templates.ts`, `apps/api/src/routes/projects.ts`, the `Projects` entries of `openapi/routes.ts`, their tests |
| `work-items` | new `packages/core/src/work-items.ts` (and siblings), the new migration in `packages/core/src/db.ts`, their tests |
| `proto-team` | the team, flow, memory and documents screens under `docs/design-system/reference/`, their screenshots, and the section of `agentry-ds.css` that `proto-foundation` reserved for it |
| `proto-ai` | the assistant, suggestion and resources screens under `docs/design-system/reference/`, their screenshots, and its reserved section of `agentry-ds.css` |
| `work-items-api` | new `apps/api/src/routes/work-items.ts`, its registration, its entries in `openapi/routes.ts`, the new events in core's event sources, the README rows, its tests |
| `proto-index` | `docs/design-system/reference/index.html`, `manifest.json`, §2 of `docs/design-system.md`, cross-screen fixes of the new prototypes |
| `work-links` | the links between work items, chats and orchestrations in core and in the API, their tests |
| `docs` | `docs/**` except `docs/design-system/**`, `README.md`, `ROADMAP.md` |

## Stage 0

### `types` (the contract)

Add to `packages/shared/src/types.ts`, each under its own section header with the reasoning as a
comment:

- **Project modules**: `ProjectModule` (`board`, `team`, `documents`, `memory`), `ProjectSettings`
  (modules on, template it came from, key prefix, limit per column, and what the later
  orchestrations will add, reserved as optional fields), `ProjectTemplate` and its id union.
  `Project` gains `key` and `modules`. `CreateProjectRequest` and `ImportProjectRequest` accept a
  template and modules; `UpdateProjectRequest` accepts the name, the key and the modules, all
  optional, so renaming keeps working.
- **Work items**: `WorkItem`, `WorkItemType`, `WorkItemStatus`, `WorkItemPriority`,
  `WorkItemAssignee`, `AcceptanceCriterion`, `WorkItemRelation`, `WorkItemComment`,
  `WorkItemHistoryEntry` (what changed, from, to, who, and the cause when a chat or an orchestration
  did it), `WorkItemLink` (a chat or an orchestration task, and the role it played), `Milestone`
  with its derived progress, and the requests to create, update, move, comment and filter.
- **Board**: `Board` as what one request returns to draw it: the columns in order, each with its
  limit, its count and its items in rank order. An item has a `rank` inside its column so the order
  a person gives by dragging survives.
- **Events**: `workitem.created`, `workitem.updated`, `workitem.moved`, `workitem.removed`,
  `milestone.changed`, `project.updated`, added to the `AgentryEvent` union.
- No field for dates other than `createdAt`, `updatedAt` and `closedAt` as facts.
- **Done when**: typecheck passes across the workspace, the OpenAPI schemas are regenerated and
  committed, and nothing that exists changed shape in a way that breaks a caller.

### `proto-foundation` (design system additions and the project, board and work item screens)

Add to `agentry-ds.css`, in a new numbered section, and to §2 of the design system doc: the module
switch card, the template card, the project tab strip, the board column (header with mono label,
count and limit), the work item card, the key chip (mono), the type icon, the priority mark, the
milestone bar, the acceptance checklist row, the history entry, the comment (person and agent), the
linked chat or orchestration row. Reserve two empty, clearly delimited sections after yours, one
for `proto-team` and one for `proto-ai`, so the three of you never edit the same lines.

Draw the illustration for an empty board, and its SVG in `docs/design-system/illustrations/`.

Screens, each desktop and phone unless it says otherwise:

- **New project**: the wizard. Name and directory or git URL, then the template cards, then the
  module switches the template preselected, then a summary. The primary action is the one gradient
  surface.
- **Project settings**: name, key prefix, modules with their switches, and what switching one off
  means (hidden, data kept).
- **Project page**: the tab strip with Overview active, showing how the dashboard sits under it.
- **Board**: five columns, cards of every type and priority, an epic label on cards, one column
  over its limit, one card whose chat is running and one whose orchestration node is running. The
  toolbar holds search, filters (type, priority, label, assignee, epic, milestone), the board and
  list switch, the selection mode with "Orchestrate", and "New task" as the primary action.
- **Board, empty**: the `Empty` pattern with the new illustration and "Create the first task".
- **List**: the same items as rows, grouped by column, with the filters applied.
- **Work item detail**: key and title, type, status, priority, labels, assignee, epic, milestone,
  the description, the acceptance checklist, relations, the linked chats and orchestrations with
  their state, what changed in its worktree, and the history and comments. "Work on it" is the
  primary action.
- **New task**: the form, as a dialog on desktop and a full screen on a phone.
- **Milestones**: the list with progress bars, open and closed.
- **Chat, with the entry point**: the message menu with "Create a task from this message", and the
  chat header naming the work item it works on.

**Done when**: every screen exists in both themes and both sizes with its screenshots, and the rules
of the prototype tasks hold on each.

## Stage 1

### `project-modules` (depends on `types`)

- `ProjectRecord` stays a name and a path. What a project configures goes in a **settings document
  per project**, a JSON file in the data directory keyed by the project's id, read and written
  whole.
- A project without a settings document reads as every module off, and gets a key prefix derived
  from its name on first read (upper case letters, two to five, unique among projects, a digit
  appended on a clash).
- The five templates live in code as data, each with its modules and configuration.
  `GET /projects/templates` lists them.
- `POST /projects` and `POST /projects/import` accept a template and modules. `PATCH /projects/:id`
  accepts the name, the key and the modules. `GET /projects/:id/settings` and
  `PUT /projects/:id/settings` read and replace the document, validated.
- Changing the key prefix does not rename the keys of existing work items' history; the item's
  number is what is stored, and the key is composed when read.
- Removing a project from Agentry keeps its settings document and its work items, so importing the
  directory again brings them back. Say so in the route's description.
- Emits `project.updated`.
- **Done when**: tests cover the defaults, the templates, validation, the key derivation and its
  clashes, and a module switched off and on again with its data intact.

### `work-items` (depends on `types`)

- Tables, as one new migration: work items, their labels, acceptance criteria, relations, comments,
  history, links, milestones, and the counter that hands out numbers per project. Indexed by
  project and status.
- A service in core with no HTTP in it: create, read, update, move (status and rank), delete,
  comment, check a criterion, relate, link, list with filters and search over title and
  description, the board of a project, milestones and their derived progress.
- **Rules it enforces**: an epic has no epic; a relation cannot point at itself or close a cycle of
  `blocks`; a number is never reused, even after a delete; a move over a column's limit succeeds and
  reports it.
- **History is written by the service**, never by the caller: one entry per field that changed, with
  who did it and the cause.
- Several wrapper processes share the database: allocate numbers and ranks inside a transaction.
- **Done when**: tests cover every rule above, the filters, the rank order after moves, and the
  migration applied on top of a database at the previous version.

### `proto-team` (depends on `proto-foundation`)

Screens: **Team** (the members as cards with role, model and what each is doing now; an empty state
that offers the assistant's proposal or the template's team), **Member** (the role, its
responsibility, its model, what it may write, and the agent file's content in the existing editor),
**Flow** (each column with its responsible role, the switch for the automatic flow, who approves
`done`, the maximum number of bounces), **Memory** (the CLI's memory, the project journal, and the
entries proposed by agents waiting for approval, each with who proposed it and from which work
item), **Documents** (the tree of the documents folder, the viewer and editor, and the documents
tied to work items). Add the role avatar, the flow row and the proposal row to your section of the
stylesheet. On the board, show a card being worked by a role.

### `proto-ai` (depends on `proto-foundation`)

Screens: **Project assistant** (after creating a project: reading the repository as a live state,
then the proposed team, resources and first work items, each accepted or discarded on its own),
**Suggest tasks** (from the board: the proposals with type, priority and the reason for each, and
"Create the selected ones"), **Resources with AI** (the resources tab with "Suggest" and "Create
with AI", the proposals list, and a proposal opened in the existing editor marked as not saved yet).
A suggestion in progress is a live state; a finished one is still. Say where the cost of each run
shows.

## Stage 2

### `work-items-api` (depends on `work-items` and `project-modules`)

- Routes under `/projects/:id/work-items` for the collection, the board and the milestones, and
  under `/work-items/:itemId` for one item, its comments, criteria, relations, links and history.
  `GET /work-items` lists across projects for the All projects view.
- A project whose Board module is off answers these routes with a clear error, not with an empty
  list, except reads of what it already holds, which stay possible so nothing looks lost.
- Emits the work item and milestone events on the feed.
- The audit log records creations, deletions and moves, as the other routes do.
- **Done when**: route tests cover every route, the module switch, validation errors and the events
  emitted; OpenAPI and the README tables are complete.

### `proto-index` (depends on `proto-team` and `proto-ai`)

Add every new screen to `index.html` and `manifest.json`, grouped as the existing ones are. Go
through all of them side by side and fix what differs between tasks: spacing, the same component
drawn two ways, copy that breaks the glossary. Complete §2 of the design system doc with every new
variant and the app class it maps to. Write `docs/design-system/reference/README` notes only if the
folder already has one.

## Stage 3

### `work-links` (depends on `work-items-api`)

- `POST /work-items/:itemId/work` starts a chat for the item: prompt built from its title,
  description and acceptance criteria, in a worktree and branch named after its key, with the chat
  start options a new chat accepts. Working on an item that already has a worktree continues in it.
- `POST /projects/:id/work-items/orchestrate` takes a selection and returns an orchestration
  **draft**, not a launched graph: one node per item, `dependsOn` from `blocks`. Launching it is the
  existing route, which now accepts the link between each node and its item.
- `POST /chats/:id/work-items` creates an item from a message of the chat.
- **Automation**, driven by the events that already exist, never by polling: the item moves when
  its chat starts and when its turn ends well, and follows its orchestration node. A person's move
  always wins over an automatic one, and an automatic move never takes an item out of `done`.
- The item reports what changed in its worktree through what `changes.ts` already does.
- It survives a restart: links are rows, and an item whose chat was cut by a restart stays where it
  was.
- **Done when**: tests cover each automatic move and each case where nothing must move, the draft
  built from a selection with relations, and the item created from a message.

## Stage 4

### `docs` (depends on every other task)

- `docs/projects.md` and `docs/work-items.md`: what each feature is and how it works, from the
  results of the tasks.
- README: the feature list and the REST tables. ROADMAP: what landed and what is next.
  `docs/status.md`: the new state of the project.
- This plan's **Outcome** section: what each task delivered and where it went past or around this
  text.

## Orchestration 1b: `ecosystem-fixes`

Fixes what [the audit](project-ecosystem-audit.md) found, before the web is built. It starts from
`feat/project-ecosystem` and is merged back into it. The audit is the list of work: every finding in
your area is yours unless this section gives it to another task. The rules of orchestration 1 apply,
the prototype rules included, and `apps/web/src` stays untouched except `lib/events.ts` when a new
event type forces it.

Decisions taken for the findings that needed one:

- **"Work on it" on an item in `done` is refused** with a 409, as "Orchestrate" already does.
- **An item in `in_review` stays there when its chat takes another turn.** Moves are forward only.
- **No bulk accept.** "Aceptar las 3 que quedan" is removed (decision 36).
- **The acceptance checklist on a phone**: the whole row is the control, at least 44 px high, and the
  design system records the checklist as the one place a check mark is always visible.
- **The code editor on a phone is a preview with an "Editar" button**, as the member screen does.
- **The starting team of the software template has four roles** (Product Owner, Architect,
  Developer, QA), as `project-templates.ts` says. The prototypes follow the code.
- **One data set for every prototype of `claude-wrapper`**: 27 work items, 15 open and 12 done, with
  the columns adding up to it; `pagos-api` is the empty project, with no counts.
- **Breadcrumb on the project's tabs**: `Proyectos / <project> / <tab>`.

### File ownership

| Task | Owns |
|---|---|
| `fix-settings` | `packages/shared/src/types.ts`, `packages/shared/src/work-items.ts`, the generated schemas, `packages/core/src/project-settings.ts`, `project-templates.ts`, `projects.ts`, the project parts of `packages/core/src/index.ts`, `apps/api/src/routes/projects.ts`, `apps/web/src/lib/events.ts`, their tests |
| `fix-store` | `packages/core/src/work-items.ts` and the files it is split into, `work-item-rank.ts`, the work item parts of `db.ts`, their tests |
| `fix-links` | `packages/core/src/work-links.ts`, `packages/shared/src/orchestration.ts`, the link parts of `packages/core/src/index.ts`, `orchestrator.ts`, `chat-service.ts`, `apps/api/src/routes/work-items.ts` and `orchestrations.ts`, their tests |
| `proto-fix-system` | `docs/design-system/agentry-ds.css`, `Sidebar.html`, `MobileMas.html`, `TabBar.html`, the generators if they are recovered |
| `proto-fix-desktop` | the new `Desktop*` screens and their screenshots |
| `proto-fix-phone` | the new `Mobile*` screens and their screenshots |
| `proto-fix-review` | `index.html`, `manifest.json`, `docs/design-system.md`, cross-screen fixes |
| `docs-fixes` | `docs/**` except `docs/design-system/**`, `README.md`, `ROADMAP.md` |

### `fix-settings`

Audit, "Bugs to fix in the code", items 2 and 7, and the minor findings of the contract: a read
never writes over a document that does not parse or validate, and a test asserts the file is
unchanged; `Project.key` and `Project.modules` become required; the value lists cannot drift from
their unions; a re-import that changes modules emits `project.updated` and records the template it
named; listing projects reads each settings document once; the round trip "Board off and on with its
work items and keys intact" is tested through the API. Decide `WorkItemSource.kind` and
`WorkItemLinkRole` now for what orchestration 3 needs (documents tied to items, a role refining and
a role verifying), and add the optional fields the flow needs on a work item (bounces, waiting for
approval), so the web is built on unions that will not grow.

### `fix-store`

Audit item 6, the store's part: search folds case for every language, not only ASCII; reordering
criteria emits an event and returns the new `updatedAt`; appending to a column does not use up rank
length; `rankBetween` refuses to return a rank outside its bounds and the column is respread
instead; the actor's kind is validated; `comments()` answers 404 for a missing item and a comment
has a maximum length; a failed `ROLLBACK` does not hide the original error; link ids are validated
as non-empty strings; the migration test does not assume its migration is the last. Split
`work-items.ts` along the lines the audit suggests if it can be done without changing behaviour.
Add the tests the audit lists as missing.

### `fix-links` (depends on `fix-settings` and `fix-store`)

Audit items 1, 3, 4 and 5, and the links' part of 6: a turn starts only on a real transition into
`busy`, tested with the coalesced event as the publisher really emits it; a relaunch keeps
`workItemId` and goes through the same checks as a launch; an item worked by a node records the
node's worktree and branch and reports its changes; a worktree deleted by hand is recovered, and a
plain directory at its path is refused; a link write that fails stops the chat it belonged to; start
options are type checked; "Work on it" on a `done` item is refused. Find why the first test of
`apps/api/test/work-links.test.ts` takes 20 s and fix it.

### `proto-fix-system`

The stylesheet and the shared pieces, first, so the two screen tasks build on them: an
`--on-accent` token and a hue token instead of `#fff` and `hsl()`; segmented controls, the column
jump and chips at 44 px on a phone, in the stylesheet, not inline; one selected-row accent; the
type sizes of sections 15 to 17 on the documented scale; `--fg-2` on `--bg-4` where the contrast
fell short. Add Tasks to `Sidebar.html` and to the More sheet in `MobileMas.html`. If the
generators still exist in `/tmp/ns-gen` and `/tmp/ns-ai`, bring them into
`docs/design-system/reference/tools/` with a note on how to run them; if not, say so.

### `proto-fix-desktop` and `proto-fix-phone` (both depend on `proto-fix-system`)

Every finding of the audit for your size, and the screens it lists as undrawn. Desktop also draws
the Tasks view with All projects selected, suggestions while they run, the assistant on an empty
project and the document editor. Phone draws wizard steps 1 and 4, selection with "Orquestar", the
filter sheet, the Activity and Changes tabs of a work item, relations on the work item and on the
new task form, the Journal and CLI tabs of Memory, the Team and Resources proposals, the document
editor, and an epic and an urgent item on the board. Nothing that carries the meaning is truncated,
and nothing sits under the FAB or a toolbar. Capture every screen you touch again, in both themes,
and look at it.

### `proto-fix-review` (depends on both)

Every screen side by side once more, in both themes and both sizes, against the audit: each
finding is either fixed or listed in your result with the reason. Update the index, the manifest
and the design system doc (15 illustrations, the checklist exception, the new tokens). End with the
list of screens for the owner to validate.

### `docs-fixes` (depends on `fix-links` and `proto-fix-review`)

Bring `docs/projects.md`, `docs/work-items.md`, the README and `docs/status.md` up to what changed,
complete the plan's Outcome with what orchestration 1 left undrawn and what this one fixed, and
mark in the audit which findings are closed and which stay open.

## Orchestration 2: `ecosystem-board-web`

The web of what orchestrations 1 and 1b built: creating and editing a project with its template and
modules, the project page and its tabs, the Tasks board and list, a work item, milestones, and the
entry points from chats and orchestrations. It starts from `feat/project-ecosystem` and is merged
back into it. The prototypes it builds from were **validated by the owner on 2026-09-27**: the 66
new screens in `docs/design-system/reference/` are the target, screen by screen, in both themes and
both sizes.

The rules of orchestration 1 apply, except the one that kept `apps/web/src` out of scope, plus:

- **The prototype is the specification of the screen.** Open `<Screen>.html` and its two
  screenshots before building a screen, and compare your build against them before you finish:
  capture your screen at 1440 x 1024 and 390 x 844, dark and light, with headless Chrome against the
  sandbox `e2e/run.mjs` builds (or `pnpm dev` with scratch `CLAUDE_CONFIG_DIR` and data directory),
  seeding work items through the API. Look at yours next to the reference and fix what drifts. The
  reference's data is illustrative; structure, hierarchy, spacing, colour use and motion are not.
- **Restyle, don't duplicate.** The prototype's class names (`.wi-card`, `.wi-jump` …) are mapped to
  app classes in §2 of `docs/design-system.md`: build those app classes, in the stylesheet the task
  owns. Tokens only: `apps/web/test/design-tokens.test.ts` must pass.
- **UI controls come from `apps/web/src/components/controls`**, never native select, checkbox or
  range. Icon-only buttons carry an `aria-label`. Status is never colour alone. Phone: 44 px
  targets, 16 px inputs, "…" menus as a `Sheet`.
- **Copy through i18n with `en`/`es` parity** (`i18n.test.ts`, `hardcoded-strings.test.ts`,
  `parity.test.ts`). The prototypes carry the `es` copy; write the `en`. Keys, ids, paths and counts
  in Geist Mono; numbers tabular.
- **Only live things move**, and every animation stops under the motion levels, reduced motion and a
  hidden tab: `e2e/specs/motion.spec.mjs` stays green.
- **Data through the API only**, with TanStack Query keys from `api.ts` and invalidation from the
  event feed (`lib/events.ts`): a work item moved by an agent shows on an open board without a reload.
- **Every screen gets an e2e spec** under `e2e/specs/`, written by the task that builds it. Do NOT
  run `pnpm e2e`: it runs once, in the verification, on the merged branch. Keep the classes the
  existing specs select (`grep e2e/specs` before renaming anything).
- **Team and Documents tabs are orchestration 3.** Their module switches exist and save, but the
  project page shows their tabs only once orchestration 3 builds them. The assistant, "Suggest
  tasks" and resources with AI are orchestration 4: no button for them in this one.

### Contract between the tasks

- `web-foundation` creates every new route and page file as a stub, so the screen tasks never edit
  `App.tsx`: `/tasks` (board and list of the selected project, or of all projects), `/tasks/:key`
  (a work item, by its key), `/tasks/milestones`, `/projects/new` (the wizard). Its stubs render
  a heading and nothing else; the owning task replaces the file whole.
- "Orchestrate" on the board calls `POST /projects/:id/work-items/orchestrate` and navigates to
  `/orchestration` with the draft in the router state: `navigate('/orchestration', { state: {
  workItemDraft } })`. The orchestration editor opens that draft as it opens a planner's, with each
  node showing the key of its item.

### File ownership

All paths under `apps/web/` unless they say otherwise.

| Task | Owns |
|---|---|
| `web-foundation` | `src/api.ts`, `src/lib/events.ts`, new `src/lib/work-items.ts`, `src/App.tsx`, `src/components/shell/**`, `src/components/icons.tsx`, `src/components/illustrations/**` and `src/styles/illustrations.css`, `src/styles/tokens.css`, `src/i18n/index.ts` and `src/i18n/locales/*/shell.json`, the new empty namespaces, the stub pages, their tests |
| `web-projects` | `src/pages/Projects.tsx`, `src/pages/Home.tsx`, `src/pages/home/**`, `src/pages/dashboard/views.ts`, new `src/pages/projects/**`, new `src/styles/projects.css`, `locales/*/projects.json` and `home.json`, `e2e/specs/projects-*.spec.mjs` |
| `web-board` | new `src/pages/tasks/Board.tsx`, `List.tsx`, `Milestones.tsx`, `toolbar/**`, `board/**`, new `src/styles/board.css`, `locales/*/tasks.json`, `e2e/specs/tasks-board*.spec.mjs` |
| `web-item` | new `src/pages/tasks/WorkItem.tsx`, `NewTask.tsx`, `item/**`, new `src/styles/work-item.css`, `locales/*/workItem.json`, `e2e/specs/tasks-item*.spec.mjs` |
| `web-links` | `src/components/Transcript.tsx` (the message menu only), `src/pages/chat/**`, `src/pages/Orchestration.tsx`, `src/pages/OrchestrationDetail.tsx`, `src/components/OrchestrationBoard.tsx`, `src/components/TaskEditor.tsx`, `locales/*/chat.json`, `orchestration.json`, `orchestrationDetail.json`, `e2e/specs/tasks-links.spec.mjs` |
| `web-review` | any web file, for cross-screen fixes only, after every other task has landed |
| `docs-web` | `docs/**` except `docs/design-system/reference/**`, `README.md`, `ROADMAP.md` |

### `web-foundation`

- **API client**: every route of projects (templates, settings, modules, key), work items, board,
  milestones, comments, criteria, relations, links, history, changes, "Work on it", orchestrate and
  a task from a message, typed with the shared types, and their query keys.
- **Events**: `workitem.*`, `milestone.changed` and `project.updated` invalidate exactly the queries
  they affect (the board of that project, the item, the all-projects board, the counts). Replace the
  empty cases orchestration 1 left in `lib/events.ts`.
- **`lib/work-items.ts`**: the pure model the screens share: columns in order with their icon and
  label key, types and priorities with their marks, filters to and from the URL, grouping a board,
  the open count, whether an item is live (its chat or node running). Unit tests.
- **Shell**: "Tareas" in the sidebar between Chats and Orquestaciones, with the open count of the
  selected project (none with All projects, as the prototype); on the phone, "Tareas" in the More
  sheet with its count; the command palette entries "Nueva tarea" and "Ir a tareas". Update
  `shell.spec.mjs` and `mobile.spec.mjs` without loosening them.
- **Illustrations**: port `board.svg` and `team.svg` from `docs/design-system/illustrations/` into
  the set, as the other thirteen were, with their names in `IllustrationName`, and extend
  `illustrations.test.tsx`.
- **Tokens**: the light `--live` becomes `#0b6680`, the value the reference moved to for contrast
  (audit, "What stays open"). Add the tokens the reference added (`--on-accent` for text on the
  accent, the hue token of the epic mark and role avatar).
- **Routes and stubs** as the contract says; the new i18n namespaces (`tasks`, `workItem`) created
  with parity and registered.
- **Done when**: typecheck and tests pass, the sidebar and More sheet show Tareas, and every new
  route renders its stub.

### `web-projects` (depends on `web-foundation`)

References: `DesktopNuevoProyecto`, `MobileNuevoProyecto*`, `DesktopProyecto`, `MobileProyecto`,
`DesktopProyectoAjustes`, `MobileProyectoAjustes`, the Proyectos screens.

- **The wizard** at `/projects/new`, replacing today's create dialog: name, and directory or git URL;
  the five template cards; the module switches the template preselected; a summary with "Crear
  proyecto". Import of an existing directory offers the same template and modules steps.
- **Project settings**: name, key prefix (validated as the API does, a clash shown in the field),
  modules with their switches and what switching one off means (hidden, data kept), board column
  limits. Replaces `pages/home/ProjectSettings.tsx`'s content where it overlaps, keeps what it
  already edits.
- **The project page tabs**: Resumen (today's dashboard), Tablero (the board of the project), Memoria,
  Recursos, Ajustes, plus Worktrees where it is today. A tab exists only while its module is on;
  Board off hides Tablero. Old `?view=` links keep working.
- **Projects list**: each card shows its key and its modules.
- **Done when**: a project is created and edited through the wizard and the settings, the tabs
  follow its modules, and its e2e spec covers both.

### `web-board` (depends on `web-foundation`)

References: `DesktopTablero`, `DesktopTableroVacio`, `DesktopTableroEquipo` (only the parts that do
not need a team), `DesktopTareasLista`, `DesktopTareasTodos`, `DesktopHitos`, and their `Mobile*`
screens with `MobileTableroSeleccion` and `MobileTableroFiltros`.

- **Board**: five columns with icon, mono label, count and optional limit (over it: warn colour and a
  word, never blocking); cards with key, type, priority mark (only urgent coloured), title, epic,
  labels, assignee, checklist progress, relation mark; a card whose chat or node is running carries
  the live rail and a ring spinner with what it is doing; "y N más" in Hecho.
- **Moving**: drag and drop between and inside columns on desktop, keyboard accessible, and a move
  menu on the phone; each move calls the API with `afterId` so the order survives; an optimistic
  update that rolls back on error with a toast.
- **Toolbar**: search, the filters (type, priority, label, assignee, epic, milestone) kept in the
  URL, the Board / List / Milestones switch, "Seleccionar", "Nueva tarea" as the one primary action.
- **Phone**: no horizontal board. Columns are sections of one list with the segmented column jump;
  the filters in a sheet; selection with a bottom bar.
- **Selection and "Orquestar"**: pick items, see which blocks which, and hand the draft to the
  editor as the contract says.
- **List**, **All projects** (every project's items, the project named on each) and **Milestones**
  (open and closed, progress bars, no dates).
- **Empty board**: `Empty` with the `board` illustration and "Crear la primera tarea".
- **Done when**: the board, list, all-projects view and milestones match their references in both
  themes and sizes, a move persists across a reload, a move made by the API while the board is open
  shows without a reload, and the e2e specs cover it.

### `web-item` (depends on `web-foundation`)

References: `DesktopTarea`, `MobileTarea`, `MobileTareaActividad`, `MobileTareaCambios`,
`DesktopNuevaTarea`, `MobileNuevaTarea`.

- **The work item** at `/tasks/:key`, as a page and in the detail panel from the board: key and
  title, type, status, priority, labels, assignee, epic, milestone, all editable in place; the
  description in Markdown with the existing editor; the acceptance checklist, each criterion checked
  with who and when, the whole row the control on a phone; relations (bloquea, bloqueada por) with
  add and remove; linked chats and orchestrations with their live state; what changed in its worktree
  (the existing diff components); history and comments, the person's and the agents'.
- **"Trabajar en ella"** as the primary action: starts the chat through the API, with the start
  options a new chat offers, and opens it. Refused on an item in Hecho, with the reason shown.
- **Mover a Hecho** is the person's approval, a secondary action.
- **New task**: a dialog on desktop, a full screen on the phone, with type, title, description,
  priority, labels, epic, milestone, criteria and relations.
- **Done when**: every field edits and persists, the checklist, relations, comments and "Trabajar en
  ella" work end to end against the fake CLI, and the e2e specs cover them.

### `web-links` (depends on `web-foundation`)

References: `DesktopChatTarea`, `MobileChatTarea`, and the orchestration screens.

- **A chat**: "Crear una tarea con este mensaje" in the message menu (a sheet on the phone), which
  creates the item in Backlog and offers to open it; the chat header names the work item it works
  on, as the `PartOf` row does for an orchestration, the whole row a target.
- **The orchestration editor** opens a draft handed over by the board, each node showing its item's
  key; launching sends `workItemId` per node. `externalBlockers` from the draft are shown as a
  warning before launching.
- **An orchestration's detail**: each node linked to an item shows its key, linking to it.
- **Done when**: a task created from a message, a chat started from an item and a graph launched from
  a selection each show their links both ways, and the e2e spec covers them.

### `web-review` (depends on `web-projects`, `web-board`, `web-item`, `web-links`)

Every new screen side by side with its reference, both themes, both sizes, and against each other:
the same component drawn the same way, the same figure the same everywhere, copy by the glossary,
one primary gradient per zone, one energy border per screen, motion off under every motion level.
Run `pnpm typecheck` and `pnpm test`; fix what differs. Update `a11y.spec.mjs` and `motion.spec.mjs`
to cover the new screens without loosening them. End your report with what you fixed and what you
left, screen by screen.

### `docs-web` (depends on `web-review`)

`docs/projects.md` and `docs/work-items.md` describe the screens as built; README's feature list and
screenshots of the board (`docs/media/`); `docs/status.md`; this plan's Outcome for orchestration 2.

## Orchestration 3: `ecosystem-team`

The Team, flow by column, shared memory and Documents modules, core and web (decisions 26 to 34).
It starts from `feat/project-ecosystem` with orchestration 2 merged and is merged back into it. The
screens were validated with the rest of the prototypes on 2026-09-27: `DesktopEquipo`,
`DesktopEquipoVacio`, `DesktopMiembro`, `DesktopFlujo`, `DesktopTableroEquipo`, `DesktopMemoria`,
`DesktopDocumentos`, `DesktopDocumentoEditar` and their `Mobile*` screens, `MobileMemoriaDiario` and
`MobileMemoriaCLI` included.

### Decisions taken for this orchestration

Written by the planner on 2026-09-27 where the plan left a choice open; the owner can reopen them.

- **A member runs as its agent through the CLI**: `claude --agent <agent>` with `--model` from the
  member, in the item's worktree. The agent file in `.claude/agents/<agent>.md` is the role's
  instructions, so the same member works from a terminal.
- **What a member may write** (`writes`) is enforced on the chats Agentry starts for it, through the
  CLI's permission rules (`--disallowedTools` for `Edit`/`Write` outside those paths). From a
  terminal it is only the agent's instructions; the member screen says so.
- **The starting team** comes from the project's template (four roles in "Software profesional").
  Proposing a team by reading the project is orchestration 4: the empty Team screen offers only the
  template's team and "add a member" here.
- **The journal is Agentry's**: rows in SQLite per project, written when an item reaches `done`
  (its title, who approved it, its links), when a person approves a memory proposal addressed to it,
  and by hand. It is handed to every flow run with `--append-system-prompt`, the newest entries
  first, capped at a size the task decides and documents.
- **Memory proposals come from flow runs' structured results.** Every chat the flow starts ends with
  a `--json-schema` result: `{ summary, verdict?, memoryProposals[], documents[] }`. A proposal names
  its target (a CLI memory file of the project, or the journal), its text and its reason; it waits
  for the person, who approves (optionally editing it), or rejects. Nothing is written before.
- **Documents written by a run** (the Product Owner's specification, an architecture decision, QA's
  report) are files in the project's documents folder (`documents.path`, default `docs`), written by
  the agent itself in the worktree, and reported in the result so Agentry links them to the item
  with the role that wrote them.
- **The flow**, per decision 28 to 30, only while `flow.enabled`:
  - a card entering a column that has a responsible role starts that role's run on the item: refine
    in `backlog` or `todo` (the Product Owner completes the description and the acceptance
    criteria, and writes the specification), work in `in_progress` (the Developer, in the item's
    worktree, continuing its work chat when there is one), verify in `in_review` (QA checks each
    criterion and gives a verdict);
  - QA passing leaves the item in `in_review` waiting for the person's approval (`waiting:
    'approval'`); QA failing sends it back to `in_progress` with QA's comment, increments `bounces`
    and resumes the Developer's chat; past `maxBounces` it waits for the person (`waiting:
    'bounces'`);
  - only a person moves an item to `done`, which clears `waiting`; a person's move always wins and
    cancels nothing already running, but no new run starts from an automatic move the person undid;
  - **at most `flow.maxParallel` runs per project at once** (new optional setting, default 2), the
    rest queued in order, so the flow cannot drain the accounts' quota on its own;
  - driven by the event feed, never by polling, and it survives a restart: a queued or cut run is
    rows, resumed or started again once the runtime is back.

### Routes (the contract between the core and the web tasks)

| Method | Route | Owner |
|---|---|---|
| GET | `/projects/:id/team` (members, each with its agent file's state and what it is doing now) | `team-core` |
| POST | `/projects/:id/team/from-template` | `team-core` |
| PUT, DELETE | `/projects/:id/team/:agent` (metadata; the file itself through `/config/resources/agents/:name?project=`) | `team-core` |
| GET, POST | `/projects/:id/journal` | `memory-core` |
| DELETE | `/journal/:entryId` | `memory-core` |
| GET | `/projects/:id/memory/proposals?status=` | `memory-core` |
| POST | `/memory-proposals/:proposalId/approve` (optional edited text), `/memory-proposals/:proposalId/reject` | `memory-core` |
| GET | `/projects/:id/documents` (the tree, each file with the items it is tied to) | `documents-core` |
| GET, PUT, DELETE | `/projects/:id/documents/file?path=` | `documents-core` |
| POST | `/work-items/:itemId/documents` (tie a document by hand, role `reference`) | `documents-core` |
| GET | `/projects/:id/flow` (runs running and queued, by item) | `flow-core` |

Events: `team.changed`, `journal.changed`, `memory.proposal` (created, approved, rejected),
`document.changed`, `flow.run` (queued, started, ended); item changes keep using `workitem.*`.

### File ownership

| Task | Owns |
|---|---|
| `team-types` | `packages/shared/src/types.ts` and `work-items.ts`, the generated schemas, `apps/web/src/api.ts` (client functions and query keys for every route above), `apps/web/src/lib/events.ts` |
| `team-core` | new `packages/core/src/team.ts`, the team routes in new `apps/api/src/routes/team.ts`, their tests |
| `memory-core` | new `packages/core/src/journal.ts` and `memory-proposals.ts`, a new migration, new `apps/api/src/routes/journal.ts`, their tests; `memory.ts` only to add what approving needs |
| `documents-core` | new `packages/core/src/documents.ts`, the `document` link kind in `work-items.ts`, `work-item-rows.ts` and a migration (the `document_path` column; see the audit's note N5 for every place a new link kind touches), new `apps/api/src/routes/documents.ts`, their tests |
| `flow-core` | new `packages/core/src/flow.ts`, the flow's parts of `packages/core/src/index.ts`, `work-links.ts` and `project-settings.ts` (`maxParallel`), new `apps/api/src/routes/flow.ts`, their tests |
| `web-team` | new `apps/web/src/pages/team/**`, the Team tab in `pages/dashboard/views.ts` and `pages/projects/**`, the role on board cards in `pages/tasks/board/**`, new `styles/team.css`, `locales/*/team.json`, `e2e/specs/team*.spec.mjs` |
| `web-memory-docs` | `apps/web/src/pages/home/ProjectMemory.tsx`, new `pages/documents/**`, the Documents tab, the documents and the waiting state on `pages/tasks/item/**`, new `styles/documents.css`, `locales/*/documents.json` and `home.json`, `e2e/specs/documents*.spec.mjs`, `e2e/specs/memory*.spec.mjs` |
| `web-review-3` | any web file, for cross-screen fixes only, after both web tasks |
| `docs-3` | `docs/**` except `docs/design-system/reference/**`, `README.md`, `ROADMAP.md` |

Two tasks that need the same file (`views.ts` for the tabs, `index.ts` in core for wiring) touch
only their own lines and say so in their result; the integration merges them.

### `team-types`

The shared types for members as served (agent file present or missing, drifted from the metadata,
what it is doing now), journal entries, memory proposals and their targets, documents and the tree,
flow runs and the structured result a flow run returns, the new events, `flow.maxParallel`; the
web client and query keys for every route in the table, and the invalidation of each new event.
**Done when**: typecheck passes, the schemas are regenerated, and nothing existing changed shape.

### `team-core` (depends on `team-types`)

Members are agent files plus the metadata in `settings.team`. From the template: write each role's
agent file (frontmatter with `name`, `description`, `model`; a body that states the role, its
responsibility, what it may write, and that it ends a flow run with the structured result) unless
a file of that name exists, which is kept. A member whose file was deleted or edited by hand is
reported, never overwritten silently. The Team module switched off hides nothing on disk.

### `memory-core` (depends on `team-types`)

The journal and the proposals, as the decisions say. Approving a proposal to a CLI memory file
writes it through `MemoryStore` (appending to the file it names, or creating it and indexing it in
`MEMORY.md`); to the journal, adds an entry. Every entry and decision records who and when. An item
reaching `done` writes its journal entry, once.

### `documents-core` (depends on `team-types`)

The documents folder: a tree of Markdown files under `documents.path`, read and written with path
traversal refused, and ties to items as `document` links with their role. Implement every place the
audit's note N5 lists for a new link kind, in one migration.

### `flow-core` (depends on `team-core`, `memory-core`, `documents-core`)

The flow as the decisions say: queue, start with `--agent`, `--model`, `--append-system-prompt`
(the journal) and `--json-schema`, the permission rules from `writes`, read the result, write the
comment, the proposals, the document links, the bounce and the waiting state, and move the card.
Test every transition, every case where nothing must happen (flow off, module off, a person's move,
`done`), the cap, and a restart in the middle, with the fake CLI.

### `web-team` (depends on `flow-core`)

Team, empty Team, Member (with the agent file in the existing editor), Flow, and the board worked by
a role, as their references draw them, both themes, both sizes; the Team tab while the module is on.

### `web-memory-docs` (depends on `flow-core`)

Memory with its three tabs (proposals approved one by one, the journal, the CLI's files), Documents
with the viewer and the editor, and on a work item its documents and its waiting state (approval or
bounces) with the action that clears it; the Documents tab while the module is on.

### `web-review-3` (depends on `web-team` and `web-memory-docs`) and `docs-3` (depends on `web-review-3`)

As in orchestration 2: every new screen next to its reference and against each other, a11y and
motion specs extended; then `docs/projects.md`, `docs/work-items.md`, a new `docs/team-and-flow.md`,
README, status and this plan's Outcome.

## Verification

Once the graph is integrated: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm e2e`, with a fixer.

## Outcome

Orchestration 1 (`ecosystem-foundation`) delivered every task of Stages 0 to 4 on its integration
branch. What it built is described in [projects.md](../projects.md) and
[work-items.md](../work-items.md); this section says what each task delivered and where it went past
or around the text above. The merged branch's `pnpm build` and `pnpm e2e` run in the verification
phase, after this was written.

**`types`** — the contract as planned, plus `packages/shared/src/work-items.ts` with the fixed
orders (modules, templates, columns, types, priorities), the key pattern and the key and branch
helpers, so core, the API and the web share them. Went past the plan: `Project.key` and
`Project.modules` are optional in the type, only until core fills them; modules and board types are
lists rather than booleans, so a later member is absent from old documents; a rank is opaque, and a
move names the item it goes after (`afterId`) instead. Went around it: the web's exhaustive event
map (`apps/web/src/lib/events.ts`) gained the six events, the one file under `apps/web/src` this
orchestration touched, because without it the workspace did not type check. Work item events
refetch nothing there until the board exists.

**`project-modules`** — as planned: `data/project-settings/<id>.json` written whole, every module off
and a derived prefix on first read (written at once, derivation serialized), five templates as data,
the routes, `project.updated`. Went past it: the document records the project's path, so importing a
removed project's directory again takes its old id back, which is how its settings and work items
return. A derived prefix is two to five letters, but an edited one may be up to ten letters or
digits. A template's `board.types` narrows the types its board offers; the store does not enforce it.

**`work-items`** — the migration, the service and every rule, as planned. Went past it: writes run in
`BEGIN IMMEDIATE` (a deferred transaction fails with `SQLITE_BUSY` instead of waiting), proven by a
four-process test; ranks are fractional strings respread past 24 characters; the history stores
snapshots of what it references, so it reads after a rename, a delete or a new prefix; `Db` exposes
its connection so the store keeps its queries in its own module.

**`work-items-api`** — the routes, events, audit and README rows as planned. Went past it:
`GET /work-items/board` is the All projects board, with no column limits and counts recomputed over
the projects shown; items of a removed project stay readable by id but leave every list; core owns
the `WorkItemService` wired to the event bus and to each project's settings.

**`work-links`** — "Work on it", the orchestration draft, the item from a message, and the automation,
as planned. Went past it: `GET /work-items/:itemId/changes` and `…/changes/diff` read the item's
branch; `GET /chats/:id/work-items` lists a chat's items for its header; the draft returns
`externalBlockers` (blockers outside the selection that are not done); `POST /orchestrations` now
goes through core, which checks each node's `workItemId` and allows one node per item; a graph
launched from a saved template is not linked. The plan's "a person's move always wins" is kept as
three rules: forward only, never out of `done`, and never over a person who moved the item after
the turn or the node's attempt began. Epics cannot be worked on or orchestrated, and an item already
being worked on refuses a second "Work on it" (409). The item's worktree lives at
`<main checkout>/.claude/worktrees/task-<key>`, locked. `ChatService.create` gained an `onStart`
callback so the link exists before the chat's first status reaches the feed. The task's two commits
carry only a generic subject, not a Conventional Commits one with a body; the squash-merged pull
request gets its own message.

**`proto-foundation`, `proto-team`, `proto-ai`** — 48 static screens (23 desktop, 25 phone), each
captured dark and light: the project wizard, settings and page; the board (also empty, and worked
by roles), the list, a work item, a new task, milestones and a chat working on an item; the team
(also empty), a member, the flow, memory and documents; the assistant (reading, then its
proposals), suggested tasks, and resources with Suggest and Create with AI. Sections 15, 16 and 17
of `agentry-ds.css` hold their components, §2 of [design-system.md](../design-system.md) maps each
to the app class it should become, and two illustrations joined the set: `board.svg` and `team.svg`.
Went past the plan: section 15 also draws the switch, checkbox, radio and dialog the app already
has, so prototypes stop mocking them with native inputs; the phone gets two extra screens
(`MobileNuevoProyectoModulos`, `MobileDocumento`); a role is drawn as a neutral squircle and a person
stays round; every suggestion run shows a facts line with model, time, cost and chat, which is where
the cost of each run shows.

**`proto-index`** — every new screen in `index.html` and `manifest.json`, cross-screen fixes across
fourteen new screens and the illustrations sheet, and §2 completed. Its commit, like
`work-links`', has a generic subject.

**`docs`** — [projects.md](../projects.md), [work-items.md](../work-items.md), the README's feature
list (its REST tables were already complete from the API tasks), the ROADMAP (a Done entry and
orchestrations 2 to 4 under Next), [status.md](../status.md) and this section.

**What orchestration 1 left undrawn**, which this section did not say at first: on the phone, steps
1 and 4 of the project wizard, selection with "Orquestar", the filter sheet, a work item's Activity
and Changes tabs, the Journal and CLI tabs of Memory, the assistant's Team and Resources proposals,
and the document editor; on both sizes, suggestions while they run, the assistant on an empty
project, and Tasks with All projects selected. The phone also lacked relations on the work item and
the new task form. Two tasks, `work-links` and `proto-index`, ended without a final report, and the
prototypes' generators were left in `/tmp`.

### Orchestration 1b: `ecosystem-fixes`

[The audit](project-ecosystem-audit.md) of orchestration 1 found five bugs, a contract still open and
prototypes that disagreed with each other. Orchestration 1b fixed them on 2026-09-27, each code bug
first reproduced by a test that failed without its fix. The audit marks each finding closed or
open.

**`fix-settings`** — a settings read never writes over a document it cannot use: it answers the
parts that validate, in memory, and leaves the file (a test asserts it is unchanged). `Project.key`
and `Project.modules` are required. The value lists are built with `valuesOf`, checked against their
unions both ways. The unions a web switch is exhaustive over are settled for orchestration 3:
`WorkItemLinkKind` gains `document` (with `documentPath`), `WorkItemLinkRole` is `origin`, `refine`,
`work`, `verify` and `reference`, following the fixed columns, and `WorkItemSourceKind` stays `chat`
and `orchestration`; a work item gains the optional `bounces` and `waiting` for decisions 29 and 30.
A re-import that changes modules emits `project.updated` and records its template; listing reads
each document once; the Board off and on is tested through the API. Nothing under `apps/web/src`
changed; one web test's project fixture gained the two required fields.

**`fix-store`** — `work-items.ts` split into the service, `work-item-rows.ts` and
`work-item-validation.ts`, as it was, before the fixes. Then: search folds case in every language;
reordering criteria emits `workitem.updated` and returns its `updatedAt`; appending to a column adds
a rank character every sixty cards instead of six, and `rankBetween` refuses an answer outside its
bounds so the column is respread; the actor is validated and an unknown stored kind reads as
`system`; `comments()` answers 404 for a missing item and a comment is capped at 50,000 characters;
a failed `ROLLBACK` no longer hides the original error; link ids are validated; the migration test no
longer assumes its migration is the last (`migrate(db, until)`).

**`fix-links`** — a turn starts only on a real transition into `busy`, tested with the coalesced
`run.updated` as the publisher sends it; a relaunch keeps `workItemId` and is checked as a launch
(`core.relaunchOrchestration`), while a saved template drops the items; a node records its worktree
and branch on its item, whose changes are then read from there; a worktree deleted by hand is
recovered on its branch and a plain directory at its path is refused (409); "Work on it" refuses a
`done` item (409), type-checks its start options (400) and stops its chat if the link cannot be
written. The first API test took 22 s because the fake CLI never answered `--version`; it now does,
and the test takes 1.6 s.

**`proto-fix-system`** — the generators are in `docs/design-system/reference/tools/`, with `lint.py`
(tokens only) and `check.mjs` (contrast in both themes, touch targets on the phone). `--on-accent`
and the `--hue-*` tokens replace `#fff` and `hsl()`; phone controls reach 44 px from the stylesheet;
one selected-row accent (`--sel-bg`, `--sel-mark`); sections 15 to 17 on the type scale; Tasks is in
`Sidebar.html` and in the More sheet. Went past it: light `--live` is `#0b6680` in the reference, for
contrast on its tint; the app's `tokens.css` still has `#0e7490`, for orchestration 2 to take.

**`proto-fix-desktop` and `proto-fix-phone`** — one data set (27 work items, 15 open and 12 done;
`pagos-api` empty), one breadcrumb (`Proyectos / <project> / <tab>`), 24 px phone titles, the four
template roles, no bulk accept, relations on the phone, the checklist row as its own control,
nothing meaningful cut, nothing under the FAB or a toolbar, and the glossary's copy. They drew the 18
missing states (4 desktop, 14 phone), so the ecosystem has 66 screens: 27 desktop and 39 phone.

**`proto-fix-review`** — moved the rules the two screen tasks had left in their pages into
`agentry-ds.css`, aligned where the two sizes told different stories, and brought the index, the
manifest and [design-system.md](../design-system.md) up to date (15 illustrations, the new tokens,
the checklist exception). `lint.py` finds nothing in 69 files and `check.mjs` nothing on the 66
screens, in both themes.

**`docs-fixes`** — [projects.md](../projects.md), [work-items.md](../work-items.md), the README's
rows for "Work on it", an item's changes, the relaunch and templates (and the same two OpenAPI
descriptions), the ROADMAP, [status.md](../status.md), this section and the audit's status.

What 1b left open is listed at the end of [the audit](project-ecosystem-audit.md#what-stays-open).
What is next is unchanged: the owner validates the prototypes, then orchestration 2 builds the web.

### Orchestration 2: `ecosystem-board-web`

The owner validated the 66 prototypes on 2026-09-27, and orchestration 2 built their web the same
day. What it built is described in [projects.md](../projects.md#the-screens) and
[work-items.md](../work-items.md#the-screens). The merged branch's `pnpm build` and `pnpm e2e` run in
the verification phase, after this was written.

**`web-foundation`** — as planned:

- the API client for every project and work item route, with its query keys;
- the events that invalidate what they touch;
- `lib/work-items.ts` with its tests;
- Tasks in the sidebar, the More sheet and the palette;
- the `board` and `team` illustrations;
- the light `--live` at `#0b6680`, plus the hue tokens;
- the stub routes and the `tasks` and `workItem` namespaces.

Where it went past the plan:

- The API has no route by key, so `/tasks/:key` finds the item through a `q=<key>` search, keeping
  only the exact match.
- Run events refresh the boards too, because a failed turn ends a live card without changing the
  item.
- The status, type and priority marks, the key and the epic label became shared components with
  their own stylesheet.
- A New task FAB shows on Tasks.

Where it went around the plan: the sidebar shows the total open count with All projects selected,
as the validated prototypes draw it, where this plan said none.

**`web-projects`** — as planned:

- the wizard at `/projects/new`, which replaces the create and import dialogs;
- the project page as a header over tabs that follow the modules;
- Agentry's settings above Claude Code's in Ajustes;
- each project card showing its key and modules.

Where it went past the plan:

- The wizard also creates a new directory in the workspace.
- The Projects page's candidates open the wizard prefilled with `?path=`.
- A phone walks the wizard step by step, without the tab bar.
- Ajustes also removes the project.
- An address naming a hidden tab lands on Resumen.

Memoria follows the Shared memory module. So an imported project, with every module off, loses that
tab until someone switches it on; the review kept this, as decision 6 says.

**`web-board`** — as planned:

- the board, the list, All projects and milestones;
- the empty board;
- moving cards by pointer and keyboard, with `afterId`, an optimistic update and a rollback with a
  toast;
- the toolbar with its filters in the address;
- selection, with "Orquestar" handing the draft over as the contract says;
- the phone's sectioned board, with its jump, move sheet, filter sheet and pressed selection rows.

Where it went past the plan:

- Keyboard shortcuts: `/` for search, `N` for New task, `J` and `K` in the list.
- Selection says why an epic, a done item or another project's item cannot be picked.
- On a phone the page holds the scope chip, so the top bar leaves it out on `/tasks`.
- Milestones are a view of Tasks, not a page of their own, so their title stays Tasks.

**`web-item`** — as planned:

- the work item as a page and as the board's panel;
- every field edited in place;
- the description in the existing editor;
- the checklist with who checked each entry and when, the whole row the control;
- relations;
- links with their live state;
- changes through the chat's `SummaryView`;
- the activity with comments;
- "Trabajar en ella" with New chat's options, refused on an epic or in Hecho with the reason;
- "Mover a Hecho" as a plain button;
- New task as a dialog on a desktop and a screen on a phone.

Where it went past the plan:

- An item a chat is already working on offers that chat instead of a second one.
- `/tasks/:key` hides the phone's tab bar, since the page has its own bottom bar.
- The history, cause and link keys are typed against the English locale file.

Where it went around the plan: a new task's relations are added once the item exists.

**`web-links`** — as planned:

- "Crear una tarea con este mensaje" in the message menu (a sheet on a phone);
- the chat header's row naming the item;
- the draft opened in the orchestration editor with each node's key and the external blockers as a
  warning;
- nodes naming their item on an orchestration's page.

Where it went past the plan:

- The menu item says why when the chat has no project or the Board is off.
- A chat that an item was created from says so.
- The inspector's Summary gains the item's card.

**`web-review`** merged the four and compared 19 screens with their references. It captured them at
1440 × 1024 and 390 × 844, dark and light, in Spanish, against an isolated server seeded with the
data set of the prototypes. It fixed what sat between the tasks:

- The board never mounted the item panel, so `?item=` did nothing.
- A card's blocker key ran under the checklist icon.
- A selectable card was an `<article>` with the checkbox role.
- A project tab's breadcrumb read "Inicio".
- On a phone:
  - the FAB covered Save, doubled the "+" on Milestones and added a second gradient to the empty
    board;
  - Save sat in the middle of the settings form;
  - the project's tabs came after a dozen widgets.
- The tab counts were 4.4:1.
- The Memory widget linked to a tab that did not exist.
- The phone's New task carried a second banner.

It extended `a11y.spec.mjs`, `motion.spec.mjs` and `pages.spec.mjs` over the new screens without
loosening them.

**`docs-web`** — this section, and:

- [projects.md](../projects.md) and [work-items.md](../work-items.md) as built;
- the README's feature list, UI table, shortcuts, and the board's screenshots in `docs/media/`
  (`board.png`, `board-mobile.png`, `work-item.png`);
- the ROADMAP;
- [status.md](../status.md).

The screenshots were taken with a one-off script against an isolated wrapper and the fake CLI, as
`web-review` took its own. `scripts/record-media.mjs` does not record them yet.

**What orchestration 2 left open**, listed in [work-items.md](../work-items.md#known-gaps):

- A link's history entry names the chat by its name, not its first prompt. The fix is in core.
- The empty board's illustration always draws `AGN-1`.
- The phone screens keep the shell's top bar, not the prototypes' back arrow.
- On a phone, the Projects list keeps its gradient "Nuevo proyecto" next to the FAB.
- Resumen stays today's dashboard, as this plan says.

The Team and Documents tabs and the parts of `DesktopTableroEquipo` that need a team are
orchestration 3, and "Suggest tasks" is orchestration 4.

### Orchestration 3: `ecosystem-team`

Orchestration 3 built the Team, flow by column, shared memory and Documents modules, core and web,
on 2026-09-27. What it built is described in [team-and-flow.md](../team-and-flow.md). The merged
branch's `pnpm build` and `pnpm e2e` run in the verification phase, after this was written. The
reports of the tasks before `web-review-3` did not reach the documentation task, so their part below
is written from their commits and the code.

**`team-types`** — the contract as planned:

- members as served, flow runs and the structured result, journal entries and pages, memory
  proposals with a flat target, documents with their tree and ties;
- the five events, and `flow.maxParallel`;
- the web client, a query key prefix per project for each collection, and each event's
  invalidation.

Every change to an existing type is an optional field or a new union member. The value lists and
the column-to-stage map (`FLOW_STAGE_OF_COLUMN`) joined `work-items.ts`. Went past the plan: a
member's live line is patched from `chat.activity` instead of refetching the team.

**`team-core`** — as planned: members as agent files plus `settings.team`, the template's team, and
the four routes with `team.changed`.

Where it went past the plan:

- Agentry knows which agent files are still its own by their hash, in
  `data/team-files/<projectId>.json`. It rewrites a file to follow the metadata only while the file
  is byte for byte what Agentry wrote, and reports any other file as `drifted` or `missing`.
- "From template" also fills the flow's empty columns, and leaves the flow off.
- Two members may not share a role.
- A project with no template, or with Simple, is offered the software team.

**`memory-core`** — as planned: the journal as rows, the `closed` entry once per item (a partial
unique index holds it across processes), proposals that write nothing until approved, and approval
through `MemoryStore`.

The size the plan left to the task is **16 KiB**: the newest entries that fit, stopping at the first
that does not so the story has no hole. Where it went past the plan:

- An approval claims the row first, and hands it back to `pending` if the target cannot be written.
- An `instructions` target goes under a named heading of `CLAUDE.md`, ignoring headings inside code
  fences.
- Proposals have no create route: only a flow run's result makes them.

**`documents-core`** — as planned: the tree, the file routes and the `document` link kind in one
migration, covering every place of the audit's note N5.

Where it went past the plan:

- The migration also adds `document_kind`, and `team_role`, which the flow uses for every link it
  makes.
- Path traversal is refused on the path's shape and again on disk through `realpath`, so a symbolic
  link cannot lead out of the folder.
- A save with a stale `baseUpdatedAt` is refused (409).
- The path travels in the query string, so no router normalises a `..` before core refuses it.
- `POST /work-items/:itemId/links` with kind `document` goes through the documents service, and no
  longer passes fields the API does not take, so a caller cannot set a link's team role.

**`flow-core`** — the flow as the decisions say, in `flow.ts` with a `flow_runs` table and the item's
`bounces` and `waiting` columns.

Where it went around the plan:

- **What a member may write** is enforced with `dontAsk` and `Edit`/`Write`/`NotebookEdit` allowed
  under its paths, not `--disallowedTools`. The CLI's rules cannot say "every path but these".
- **`--agent` travels with `--agents`**, a definition read from the agent file in the project's
  checkout, because the item's worktree only has the committed agent files.

Where it went past the plan:

- Only a person's move, a new card or the flow's own move starts a run.
- One queued run per item; a queued run whose item left its column is cancelled.
- A run that ends after a person's move comments but moves nothing.
- A Product Owner's run in `backlog` moves the item to `todo`; in `todo` it only reports whether the
  item is ready.
- A runtime at its concurrent limit puts the run back in the queue.
- A resumed chat can carry an agent, a schema and `keepAlive` for one execution, which a person's
  resume drops again.
- The work-links automation leaves a running flow chat to the flow.
- `GET /projects/:id/flow` is readable with the flow off.

**`web-team`** — as planned:

- the Team tab while the module is on;
- the members with what each is doing, and the empty team offering the template's team;
- a member's page with its metadata and its agent file in the existing editor;
- the Flow screen, edited as one draft;
- "Add a member";
- the board worked by a role, as `DesktopTableroEquipo` draws it.

**`web-memory-docs`** — as planned:

- Documents, with the tree, the viewer, the one `CodeEditor`, the tied documents and New document;
- Memory, with proposals approved, edited or discarded one by one, the journal grouped by day, and
  the CLI's files;
- a task's documents and its waiting panel with the moves that end it;
- the Documents tab while the module is on.

Where it went past the plan:

- Memory's tab counts its waiting proposals, in idle.
- A save that meets an agent's write is refused and offered as a reload, and the draft is kept.

Its specs seed what flow runs write straight into the sandbox's database, since the fake CLI returns
no structured result.

**`web-review-3`** merged the two web tasks and compared every Team, Memory and Documents screen with
its reference, at 1440 × 1024 and 390 × 844, dark and light, in Spanish. It fixed what sat between
them:

- The two tasks shared `.workitem-waiting`, so one restyled the other's board card. The item page's
  panel became `.item-wait`.
- Documents and Memory drew roles with a stand-in. Every screen now uses `RoleAvatar`.
- A role as a task's assignee was drawn as a person with its raw id, and no role could be picked.
  The task page, New task and the Assignee filter now offer the team's members (decision 13).
- The crumbs now read "Equipo / Flujo" and "Equipo / Desarrollador", and a member's page on a
  desktop stands without the project's header.
- On a phone, a member, the flow and an open document hide the tab bar, and their Save bars sit
  flush. The empty team is drawn on the page.

It extended `a11y.spec.mjs` and `motion.spec.mjs` over the new screens, with a Developer working
through the fake CLI, and added `team-review.spec.mjs`.

**`docs-3`** — this section, and:

- the new [team-and-flow.md](../team-and-flow.md);
- [projects.md](../projects.md) and [work-items.md](../work-items.md) as built;
- the README's feature list, events and UI table (the REST rows came with the core tasks);
- the ROADMAP;
- [status.md](../status.md);
- the audit's open item on live links.

**What orchestration 3 left open**, listed in [team-and-flow.md](../team-and-flow.md#known-gaps):

- **A card being refined or verified is not live.** `isLive` still counts only `work` links, which
  the audit had left for this orchestration.
- The Flow screen has no control for `maxParallel`.
- The `file` action of `team.changed` is never emitted.
- The template's responsibilities are English in the Spanish interface.
- "Pedir propuesta" (orchestration 4), "Ver todo" on the team's activity, and a few small
  differences from the references.

## Related

[[status.md]] · [[projects.md]] · [[work-items.md]] · [[team-and-flow.md]] · [[design-system.md]] · [[plans/agents-redesign.md]] ·
[[plans/redesign-night-shift.md]] · [[knowledge-base.md]]
