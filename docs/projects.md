---
created_at: 2026-09-27T06:00:00Z
updated_at: 2026-09-27T20:00:00Z
tags:
    - projects
    - modules
    - templates
    - settings
    - project-ecosystem
    - decision
---
# Projects: modules, templates and settings

A project used to be a name and a path. It is now also the place where its work is followed: a
**settings document** says which **modules** are on (Board, Team, Documents, Shared memory), which
template it came from, the prefix of its work items' keys (`AGN-12`) and how its board is set up.
This is the first piece of the [project ecosystem](plans/project-ecosystem.md): orchestration 1
(`ecosystem-foundation`) built the server side, and orchestration 2 (`ecosystem-board-web`) built the
screens from the prototypes in `docs/design-system/reference/`, which the owner validated on
2026-09-27. The board itself is in [work-items.md](work-items.md). Orchestration 3 (`ecosystem-team`)
built the Team, Documents and Shared memory modules on top, core and web: see
[team-and-flow.md](team-and-flow.md).

## The record stays small, the settings go beside it

`ProjectRecord` (`packages/core/src/projects.ts`) is still `{ id, name, path }`. What a project
configures is a settings-shaped document, so it follows the storage convention: one JSON file per
project, `data/project-settings/<id>.json`, read and written whole with `writeAtomic`
(`packages/core/src/project-settings.ts`, `ProjectSettingsStore`).

`ProjectSettings` (`packages/shared/src/types.ts`, section *Project modules*):

| Field | What it holds |
| --- | --- |
| `modules` | The modules switched on, a list of `board`, `team`, `documents`, `memory` |
| `template` | The template it was created from, for reference only: editing never re-applies it |
| `keyPrefix` | The prefix of the work items' keys, unique among projects |
| `board` | The work item types the board offers and the optional limit per column |
| `team` | The team's members: each one's agent file name, role, model, responsibility and write paths ([team-and-flow.md](team-and-flow.md)) |
| `flow` | The flow by column: the switch, the role of each column, `maxBounces` and `maxParallel` |
| `documents` | The documents folder, `path` (`docs` when absent) |

Modules and board types are **lists**, not one boolean per member, so a module or a type added later
is simply absent from an old document instead of a missing required key. `Project` (what
`GET /projects` returns) gains `key` and `modules`, filled in by core. Both are **required** in the
contract since the fixes of orchestration 1b: core fills them on every project, and a client that had
to guess at their absence would show an empty key.

The lists of values (modules, templates, and the work item orders in
[work-items.md](work-items.md#the-model)) are built with `valuesOf` in
`packages/shared/src/work-items.ts`, which checks each list against its union both ways, so a member
added to a union cannot go missing from the validators and screens that read the list.

## A project nobody configured

A project with no settings document, which is every project imported before this, reads as **every
module off**. On that first read it gets a key prefix derived from its name, and the document is
written straight away so the prefix never moves.

### A read never writes over the person's file

A document that does not parse, or whose parts do not validate (one typo in a hand edit), is
answered **in memory**: the parts that still validate, and defaults and a derived prefix for the
rest. The file is left as the person wrote it, so the next `GET /projects` does not wipe the
modules, the column limits and the key prefix. A test asserts the file is unchanged.

A read writes only the two things that keep its own answer stable: the document of a project that
has none, and a prefix that clashes with another project's. For a clash only the prefix changes on
disk, and the project imported first keeps its prefix whichever of the two is read first. Listing
projects reads each document once (`readAll`), not once per project it is checked against.

The work item store asks for a project's settings synchronously and passes the project's name, so an
unusable prefix reads as the same derived one the project list shows.

`deriveKeyPrefix` takes the initials of the name's words when it has several (`claude wrapper` →
`CW`, `MyShop` → `MS`), or the first letter and the consonants after it when it has one (`Agentry`
→ `AGN`); accents are dropped and a name with fewer than two letters gets `PRJ`. A prefix already
taken gets a digit, from 2 up (`AGN2`). Derivation is serialized, so projects read for the first time
together never share a prefix.

A derived prefix is two to five letters. A person may edit it into anything that matches
`WORK_ITEM_KEY_PREFIX_PATTERN` (`packages/shared/src/work-items.ts`): upper case letters and
digits, starting with a letter, two to ten characters, still unique.

## Modules

Switching a module off **hides it and keeps its data**; switching it on again brings everything back.
Nothing is deleted by a switch. For the Board module this is enforced by the work item routes: with
the module off, changes answer 409 and reads keep working, so nothing looks lost (see
[work-items.md](work-items.md#access)).

The other three modules follow the same rule, and each is described in
[team-and-flow.md](team-and-flow.md):

- **Team**: the project's team of agents and the flow by column. The flow runs only while Team and
  Board are both on, and switching either off cancels its queue and stops its runs. Switching Team
  off touches nothing on disk: the agent files stay in `.claude/agents/`.
- **Documents**: the project's documents folder and the documents tied to work items.
- **Shared memory**: the project journal, the team's memory proposals and the CLI's own memory.

Each answers 409 to a change while it is off, and keeps answering reads.

## Templates

Five built-in templates live in code as data (`packages/core/src/project-templates.ts`) and are
listed by `GET /projects/templates`. A template carries configuration, not only switches, and is
applied once, when the project is created or imported.

| Id | Modules | Board types | Column limits | Team it offers |
| --- | --- | --- | --- | --- |
| `simple` | none | all | none | none |
| `software` | board, team, documents, memory | all | `in_progress` 3, `in_review` 2 | Product Owner, Architect, Developer, QA |
| `library` | board, documents, memory | epic, task, bug | `in_progress` 2 | Architect, Developer, QA |
| `research` | board, documents, memory | epic, task | none | Researcher, Writer, Reviewer |
| `custom` | none | all | none | the software team, if Team is switched on later |

Models follow the plan: Opus for the roles that decide (Product Owner, Architect, Researcher), Sonnet
for the ones that carry the work out. The team is what the empty Team tab offers: accepting it
writes each role's agent file and fills the flow's empty columns, with the flow left off (see
[team-and-flow.md](team-and-flow.md#the-starting-team)). There are no user-saved templates.

`name` and `description` are the English copy; a client that knows the `id` shows its own
translation.

## The screens

Orchestration 2 built these from the validated `NuevoProyecto`, `Proyecto`, `ProyectoAjustes` and
`Proyectos` prototypes, for desktop and phone, in dark and light.

### The wizard: `/projects/new`

The wizard replaces the create and import dialogs of the Projects page. It has four parts:

- **Where** the project is: a local directory, a repository URL to clone, or a new directory in the
  workspace.
- **The template**: the five, as radio cards.
- **The modules**: one switch each. The template preselects them, and you can change any of them.
- **A summary**, with the key prefix previewed from the name, and "Create project". With the Team
  module on, it counts the template's roles and says they are offered once the project exists, each
  one written to `.claude/agents/` when the person accepts it.

It sends the existing `POST /projects` or `POST /projects/import` request, with `template` and
`modules`.

On a desktop the four parts are on one page. On a phone they are steps, and the tab bar is hidden
(`hidesTabBar` in `lib/shell-live.ts`). When the Projects page offers a directory to import, it opens
the wizard prefilled with `?path=`, so an import goes through the same template and module steps as
a new project.

### The project page and its tabs

The project page (`/`, with a project selected) is a header over a strip of tabs.

- **The header** shows:
  - the monogram and the name;
  - the key prefix, boxed;
  - the template;
  - the path;
  - the number of chats and worktrees;
  - New chat, plus New task while the Board is on.

  New task takes the gradient only on Resumen. A tab that has a primary action of its own gets a
  plain New task button instead.
- **The tabs** each live at `/?view=<id>` (`apps/web/src/pages/dashboard/views.ts`):
  - Resumen: the dashboard that used to be the whole page, with no `view`;
  - Tablero (`board`);
  - Equipo (`team`);
  - Documentos (`documents`);
  - Memoria (`memory`);
  - Recursos (`resources`);
  - Worktrees;
  - Ajustes (`settings`).

  Tablero shows the number of open tasks, Equipo its members, Documentos its files and Worktrees
  its own count, in neutral grey. Memoria shows the memory proposals waiting for the person, in the
  idle colour.
- **A tab exists only while its module is on.** Tablero follows the Board module, Equipo the Team
  module, Documentos the Documents module and Memoria Shared memory; the other tabs are always
  there. An address that names a hidden tab lands on Resumen, and old `?tab=` links still redirect
  to `?view=`.
- **The top bar's breadcrumb** reads `Proyectos / <project> / <tab>`. Inside Equipo it goes one
  level deeper, "Equipo / Flujo" or "Equipo / Desarrollador", with "Equipo" as a link back.
- **On a phone**, the strip becomes a card of cells right under the header, and each tab opens as its
  own screen with a back button.

Memoria follows its module, as decision 6 says. An imported project starts with every module off, so
it has no Memoria tab until someone switches Shared memory on. Until then the dashboard's Memory
widget still shows its count, but it no longer links to the missing tab.

### Settings

The Ajustes tab (`apps/web/src/pages/home/ProjectGeneral.tsx`) now starts with Agentry's own
settings, above the Claude Code settings it already edited:

- **Name.**
- **Key prefix**, checked the same way the API checks it. A clash with another project shows in the
  field before you save.
- **Modules**: one switch each, with what switching it off means (the module is hidden and its data
  kept).
- **Column limits** for the board, while the Board module is on.
- **Remove** the project from Agentry.

On a phone, Save is a bar pinned to the bottom, just above the tab bar, and no FAB covers it.

### The projects list

Each project card shows its key and the modules that are on.

## Routes

- `GET /projects/templates` lists the templates.
- `POST /projects` and `POST /projects/import` accept `template` and `modules`, checked before a
  workspace directory is created. Modules given explicitly win over the template's. Without either,
  every module is off.
- `PATCH /projects/:id` takes `name`, `key` and `modules`, all optional, so a plain rename keeps
  working.
- `GET /projects/:id/settings` and `PUT /projects/:id/settings` read and replace the document whole,
  validated.

Every change emits `project.updated` on the event feed, naming what changed (`name`, `key`,
`modules`, `settings`). That includes importing a known directory again with other modules: the
import emits it, records the template the request named, and keeps whatever else the old document
holds, a part a hand edit broke included. The README's [Projects](../README.md#projects) table has every route.

## Removing and importing again

Removing a project from Agentry only makes it forget the directory. The settings document stays, and
so do the work items, which are keyed by the project's id. The document records the path it was
written for, so importing the same directory again finds it and **takes the old id back**, and with
it the settings and the board. `DELETE /projects/:id` says so in its description.

Switching the Board off and on again is tested through the API end to end: with the module off the
items still read and creating one answers 409; switched on again, the same keys, columns, epics and
order come back, and the next item is numbered after the last one made before the switch.

Changing the key prefix does not rewrite anything: only an item's number is stored, and its key is
composed when read, so a new prefix renames every key at once, history included.

## Related

[[work-items.md]] · [[team-and-flow.md]] · [[plans/project-ecosystem.md]] · [[plans/project-ecosystem-audit.md]] · [[design-system.md]] · [[status.md]]
