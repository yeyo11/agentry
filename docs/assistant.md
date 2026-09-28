---
created_at: 2026-09-27T21:30:00Z
updated_at: 2026-09-27T21:30:00Z
tags:
    - assistant
    - ai-suggestions
    - resources
    - work-items
    - project-ecosystem
    - decision
---
# The project assistant, suggested tasks and resources with AI

The **project assistant** reads a project and proposes what to create in it: a team, resources
(agents, skills, commands) and work items. It never writes anything itself. Each proposal waits for
the person, who accepts or discards it on its own, and only an accept makes Agentry write something,
through the service that already owns that thing: the team, the resources or the board.

It shows up in three places:

- **The assistant's page**, `/projects/:id/assistant`. The wizard leads there after creating a
  project, and the empty Team screen leads there through "Pedir propuesta". It proposes the team,
  the resources and the first tasks together.
- **"Sugerir tareas"** on the board, which proposes work items.
- **"Sugerir" and "Crear con IA"** on the project's Resources tab. The first proposes agents, skills
  and commands; the second writes one from a description.

Orchestration 4 of the [project ecosystem](plans/project-ecosystem.md) (`ecosystem-assistant`)
built this on 2026-09-27, core and web. It follows decisions 35 to 37 and the choices the planner
wrote for that orchestration. The screens follow the prototypes the owner validated the same day
(`Asistente*`, `SugerirTareas*`, `Recurso*`). The team it proposes into is described in
[team-and-flow.md](team-and-flow.md), the board in [work-items.md](work-items.md), and the wizard and
the modules in [projects.md](projects.md).

## The one rule holds

A run is a chat through the Claude Code CLI, started in the project's directory, that answers with a
structured result through `--json-schema`. No SDK and no HTTP call to Anthropic. The chat counts in
Usage and in the status bar like any other, and every screen that shows a run shows its model,
duration and cost, with a link to its chat.

## A run

`packages/core/src/assistant.ts` (`AssistantService`), with the prompt, the schema and how the answer
is read in `assistant-answer.ts`, and "what it read" in `assistant-sources.ts`. The contract is the
"project assistant" section of `packages/shared/src/types.ts`, and the value lists live in
`packages/shared/src/assistant.ts`.

### Three kinds

| Kind | Started by | Proposes |
| --- | --- | --- |
| `project` | the wizard, "Pedir propuesta" on the empty team, the assistant's page | team members, resources and work items |
| `work-items` | "Sugerir tareas" on the board, or the empty assistant page's description | work items |
| `resources` | "Sugerir" on the Resources tab, or "Crear con IA" with a description and a kind | resources; exactly one with a description |

A `project` run leaves out any kind whose module is off: no team members without the Team module and
no work items without the Board module. A `work-items` run is refused (409) while the Board is off.

### It can only read

An allow list alone does not make a chat read-only: `--allowedTools` adds to the rules of the
person's user, project and local settings, and no `Bash` rule can be told apart from a write
(`git log --output=<file>` writes a file). So the chat is **confined** (`ChatConfinement` in
`chats.ts`, checked against CLI 2.1.282):

| Flag | What it does |
| --- | --- |
| `--tools=Read,Grep,Glob` | the only tools the session has at all: no shell, no editor, no subagent, no web |
| `--setting-sources=` | loads no user, project or local settings file, so none of their allow rules, hooks or servers apply |
| `--restricted` | keeps the file tools to the working directory, the project |
| no `--add-dir` | the uploads directory every other chat gets is left out |
| no `--allow-dangerously-skip-permissions` | the chat can never be switched to `bypassPermissions` (`--restricted` refuses the flag) |
| `--permission-mode dontAsk` | denies whatever is not allowed outright |

It is allowed `Read`, `Grep` and `Glob`, and denied outright `Bash`, `Edit`, `Write`,
`MultiEdit`, `NotebookEdit`, `Task`, `Agent`, `WebFetch` and `WebSearch`, and every read of a
secret inside the project (`DENIED_READS`): `.env` files, keys and certificates, SSH and AWS
directories, `.npmrc`, `.netrc`, `.git-credentials`, `credentials*`, `secrets/`,
`settings.local.json`, and `.git/` (a remote's URL may carry a token). A run a restart cut off is
continued confined again; a person who continues the chat by hand gets an ordinary chat.

It has no MCP server and no tool preset, and it runs one turn. The model is `sonnet`
(`DEFAULT_ASSISTANT_MODEL`) unless the request names another: it reads and proposes, it does not
build.

### What it is handed, and what it read

Besides the directory, Agentry hands the run what only Agentry knows, so it does not propose what
the project already has:

- the journal, as a flow run gets it, and the project's `CLAUDE.md` (cut at 40,000 characters),
  through `--append-system-prompt`: with no setting source the CLI may not load `CLAUDE.md` itself;
- what it would have asked git (`assistantGit`): the branch, the latest 30 commits and up to 40
  uncommitted changes, since it has no shell. The history counts as read from the start;
- the work items (the first 150, and how many more there are) and the open milestones;
- the team and the project's own resources;
- the titles of the latest CLI chats in the directory.

"What it read" (`AssistantRun.sources`, shown as "Ver lo que ha leído") is laid out when the run
starts:

- from a look at the directory (at most 10 files and 10 folders, skipping `node_modules`, build
  output and lock files);
- and from what Agentry handed it, with counts.

The chat's own reads fill it in while it runs. They arrive on `chat.activity`, and the run announces
them at most every 3 seconds (`READ_EVENT_MS`). The answer's own list of what it read is added at the
end. Anything that was laid out and never read is dropped once the run ends, so the list it keeps is
only what it read.

### The answer

The schema asks for a summary, what it read, what it found (`stack` and `gap` tags, "TypeScript",
"no CI") and one list per kind it proposes. The answer is read defensively:

- a bad entry is dropped, not the whole answer;
- each list is cut at 12 proposals (`PROPOSALS_MAX`);
- text fields are cut at their limits;
- an answer that is not an object makes the run `failed`, with the code `assistant.error.unreadable`.

When the answer is stored:

- a member whose role or agent is already on the team is left out;
- a member's role and model are cut at 100 characters and its responsibility at 500, the team's own
  limits, so a proposal is one the team takes as it stands. An accept whose edits pass them is
  refused (400) before its agent file is written;
- a suggested resource the project already has is left out, but one built from a description is
  kept, since the person asked for it and can rename it;
- a work item's epic and "similar to" are resolved by key, or by the same title, against the project's
  items. A proposal that resembles an existing item ("Parecida a AGN-45") starts unselected in
  "Sugerir tareas".

### A project with nothing to read

When the directory has no files, no CLI chats and no git history, and the request has no
description, **no chat is started**. The run completes at once, with `empty: true`, no cost, and the
template's team as its proposals: the project's own template, or the software team for Simple or no
template. The assistant's page then asks what the project is for. That description starts a
`work-items` run, which proposes the first tasks from it.

### One at a time, and "Volver a sugerir"

- **One running run per project and kind.** A partial unique index on `assistant_runs` holds it; a
  second start while one runs is refused with 409.
- **A new run leaves the previous run's pending proposals as they are.** Only `supersede: true`
  ("Volver a sugerir") marks the pending proposals of the latest *completed* run `superseded`. They
  are set aside, never deleted, and the two runs name each other (`supersedes`, `supersededBy`).
- **A run that supersedes and then proposes nothing hands them back.** If it fails to start, fails,
  answers nothing readable or is stopped, the proposals it set aside are `pending` again and the
  previous run's `supersededBy` is cleared, in the same transaction that ends it. Its event names
  the previous run (`supersedes`), so a client reads it again.
- **Stopping a run** stops its chat. A stopped run proposes nothing, and a late result changes
  nothing.
- **A run a restart cut off** continues once, in its own chat (or in a new one if it never got one).
  If the restart finds the chat still going, it leaves it. A run that cannot continue, or that was
  already continued once, ends `failed` with `assistant.error.restart`.

A run's chat is listed by its first prompt, so the prompt's first line is a short title in the
person's language (`assistantTitle`): "Asistente de pagos-api" or "Assistant for pagos-api",
"Sugerir tareas · …", "Sugerir recursos · …", "Crear agente con IA · …". The language comes from
the request's `Accept-Language`, which the web sets to the language the person reads Agentry in;
the instructions below the title stay in English. A run a restart finds without a chat is asked
again in English, as its language is not kept.

A run's error is a `Localized`: a stable code (`assistant.error.start`, `.chat`, `.unreadable`,
`.ended`, `.restart`) that the web translates, plus English text.

## Proposals, one by one

Every proposal is a row in `assistant_proposals`, `pending` until the person decides (decision 36).

| Kind | Accepting it |
| --- | --- |
| `team-member` | Adds the member through the team service. When the run wrote instructions of its own, the agent file is written first with those instructions, where no file of that name exists, so the team keeps it as the person's; if the team then refuses the member (a role already taken), the file is removed again. With no instructions, the team writes its standard starting file |
| `resource` | **Is the editor's save.** The proposal opens in the existing editor, unsaved, in the project's scope unless the person picks User. Saving there accepts it with the name, content and scope the person left. A name that already exists at that scope is refused (409) until it is renamed |
| `work-item` | Creates the item in `backlog` with its type, priority, labels, acceptance criteria and epic, and the proposal's reason as its first comment, written by an agent. The item's history names the assistant's chat as its source |

- **An accept claims the proposal first.** Two accepts can never both write. If the write fails, the
  proposal goes back to `pending`. A proposal whose module is now off is refused (409) before
  anything is claimed.
- **Edits travel with the accept** (`AcceptAssistantProposalRequest`). A field left out keeps the
  proposed value.
- **Discard** sets a pending proposal aside, and **restore** brings a discarded one back to
  `pending`. Each is its own request and its own event.
- **Nothing is written before an accept.** The core tests check the directory, the team and the
  board after a run and before any accept.

## Routes and events

| Method | Route |
| --- | --- |
| POST | `/projects/:id/assistant/runs` (`{ kind, model?, description?, resourceKind?, supersede? }`) |
| GET | `/projects/:id/assistant/runs?kind=` (latest first, 50 at most) |
| GET | `/assistant/runs/:runId` (with every proposal it made) |
| POST | `/assistant/runs/:runId/stop` |
| POST | `/assistant/proposals/:proposalId/accept` (optional edits), `/discard`, `/restore` |

`apps/api/src/routes/assistant.ts`; the validation lives in core. The README's
[Assistant](../README.md#assistant) table describes each route.

Events:

- **`assistant.run`**: `started`, `read` (what it read or its cost changed, throttled), `ended` and
  `failed`. An event for a run that superseded another also names that run, so a client reads it
  again.
- **`assistant.proposal`**: `accepted`, `discarded` and `restored`. An accepted resource names the
  saved file (kind, name, scope), because resources have no event of their own and the web
  refetches that list from it.

## The screens

What every run draws the same way lives in `apps/web/src/components/assistant/run.tsx`, styled by
`styles/suggestion.css`:

- the live head, with the verb, the braille spinner, the elapsed time and "Detener";
- the facts line: model · time · cost · chat;
- "Lo que ha leído" and what it found;
- the proposal rows and phone cards.

A run in progress is the only thing that moves: it carries the one energy border of its screen. A
finished run is still.

### The assistant's page: `/projects/:id/assistant`

`apps/web/src/pages/assistant/`.

- **Never read.** What the assistant would do, and "Pedir propuesta".
- **Reading.** What it has read, on the left, and the three sections it will fill, dashed and still, on
  the right.
- **Finished.** One still line ("14 propuestas después de leer 61 archivos, 23 chats y docs/"), then
  three sections: Equipo, Recursos and Primeras tareas. Each counts what was accepted ("2 de 6
  aceptados"), and a section exists only while its module is on.
  - **Equipo**: each role with its model, what it may write, and whether it comes from the template.
    "Aceptar" adds it.
  - **Recursos**: each resource is reviewed in the editor. "Revisar" opens the Resources tab on it
    (`?view=resources&proposal=<id>`).
  - **Primeras tareas**: "Aceptar" creates each one in Backlog.
  - "Descartar" and "Deshacer" work on any proposal.
- **Nothing to read.** The template's team to accept role by role, and a field for what the project is
  for, which proposes the first tasks.
- **Failed or stopped.** Says so, with "Volver a sugerir".

The footer has "Omitir por ahora" and "Ir al proyecto", which carries the gradient. The top bar's
selector picks the page's project once, on arrival, and the crumbs read "Proyectos / <project> /
Asistente".

**How it is reached:**

- **The wizard.** "Proponer equipo, recursos y tareas" is on by default for every template but Simple
  (`assistantOnCreateByDefault`). With it on, creating the project starts a `project` run and leads
  here. If the run cannot start, the project still exists: the page offers to ask again.
- **The empty Team screen.** "Pedir propuesta" is its primary action, and the template's team stays
  beside it. If a run is already going (409), it leads to that run's page.

### "Sugerir tareas" on the board

`apps/web/src/pages/tasks/suggest/`. It opens at `?suggest=1`: a dialog on a desktop, a full screen
on a phone.

- An optional focus field says what to look for.
- While it runs: what it reads, "Detener", and the energy border.
- Once it answers: each proposal with its reason. On a desktop the pending ones carry checkboxes; on
  a phone, "Incluir" buttons. One that resembles an existing item starts unselected.
- "Crear las seleccionadas" accepts each one with **its own request**, in order: there is no bulk
  accept, and one that fails leaves the others created. "Descartar" and "Deshacer" work per
  proposal, and "Volver a sugerir" supersedes the pending ones.
- Closing the dialog leaves the run going; opening it again shows the same run.

### Resources with AI: the project's Resources tab

`apps/web/src/pages/home/ProjectResources.tsx` and `pages/home/resources/`.

- **The tab.** Agents, skills and commands are one view, All or one kind, with the assistant's
  proposals in a card beside them. Output styles, rules and workflows keep their own editor behind
  "Más".
- **"Sugerir".** Starts a `resources` run. Each proposal can be reviewed or discarded, and "Descartar
  todas" discards them one by one.
- **"Crear con IA"** (`?ai=1`). The person picks the kind and says what it should do. The run writes
  one resource, and "Abrir en el editor" opens it in the chosen scope. A run still going when the
  dialog closes is picked up again.
- **The editor.** A proposal (`?proposal=<id>`) opens unsaved, with its reason and where it will be
  saved. "Crear" saves it, which is the accept; "Descartar" sets it aside. Leaving loses only what the
  person typed: the proposal stays pending.
- **One editor.** `ResourceEditor` came out of `pages/config/ResourcesTab.tsx`, so the settings'
  Resources tab and the project tab edit a proposal, a new file and an existing file the same way.

### On a phone

The assistant's page, and a resource or proposal open in the editor, hide the tab bar and end in
their own bar with 44 px buttons (`hidesTabBar` in `lib/shell-live.ts`). The proposals are cards with
"Incluir" / "Incluida" in the accent, never checkboxes. The phone's Resources row keeps the short
"Sugerir", because "Volver a sugerir" crowded out "Crear con IA".

## The audit of orchestration 2, closed

`board-fixes` closed the four items [the audit](plans/project-ecosystem-audit.md#audit-of-orchestration-2-the-web-of-the-board)
had left for the owner:

- **Epics do not count** as open items nor against a column's limit (the owner chose option B). They
  stay on the board with their progress. See [work-items.md](work-items.md).
- The history names a chat link by the chat's **first prompt**, not its session name.
- The empty board's illustration draws the project's **own first key** (`SHOP-1`).
- The wizard's team line no longer says the agent files are written later.

## How it is tested

- `packages/core/test/assistant.test.ts` drives the real service with the fake CLI. It covers:
  - the flags a run starts with;
  - what it read, filled in and trimmed;
  - an answer made into proposals, with what the project has left out;
  - nothing written before an accept, and every accept path through the real services;
  - an accept refused and handed back;
  - discard and restore;
  - a failed run, a stopped run, one run at a time and "Volver a sugerir";
  - the empty project, "Crear con IA", a restart cut in the middle, and the migration on an older
    database.
- `assistant-cli.test.ts` runs the fake CLI process itself.
- `apps/api/test/assistant.test.ts` covers the routes.
- The web has `assistant-model.test.ts`, `suggest-model.test.ts`, `assistant-events.test.ts` (each
  event's invalidation) and the `hidesTabBar` cases in `shell-live.test.ts`.
- E2E, run in the verification on the merged branch: `assistant.spec.mjs`, `suggest.spec.mjs`, and
  the assistant screens in `a11y.spec.mjs` and `motion.spec.mjs`. The fake CLI now reads files and
  answers with a structured result, from a scripts file each spec writes.

## Known gaps

- **`CLAUDE.md` can show twice** in "Lo que ha leído": once as what Agentry laid out, once as the
  chat's own read.
- **"Crear con IA" does not stream** the file while it is written. The editor opens once the run
  answers.
- **"Sugerir tareas"'s focus travels as the run's `description`**, which the prompt heads as what the
  project is for. It works, but the prompt words it as a project description rather than a focus. A
  field of its own in `StartAssistantRunRequest` would say it plainly.
- **Only the wizard and the empty Team screen lead to the assistant's page.** Decision 35 also asks
  for "on demand from the project page", and the page can ask on its own. But once a project has a
  team, nothing on the project page links to it; its address is the only way in.
- **Small differences from the references**, left by the review:
  - the elapsed time reads "12s" where the reference has "0:41" (the app's clock format);
  - a one-word project shows a one-letter monogram ("N", not "NO");
  - the empty Team title is smaller than the reference's;
  - the project tabs highlight "Inicio" rather than "Proyectos", as in orchestrations 2 and 3.

## Related

[[team-and-flow.md]] · [[projects.md]] · [[work-items.md]] · [[plans/project-ecosystem.md]] · [[plans/project-ecosystem-audit.md]] · [[design-system.md]] · [[status.md]]
