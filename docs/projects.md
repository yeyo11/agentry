---
created_at: 2026-09-27T06:00:00Z
updated_at: 2026-09-27T06:00:00Z
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
This is the first piece of the [project ecosystem](plans/project-ecosystem.md), built by orchestration
1 (`ecosystem-foundation`). The board itself is in [work-items.md](work-items.md).

Only the server side exists so far. The screens (the new project wizard, the project's tabs, its
settings) are prototyped in `docs/design-system/reference/` and wait for the owner's validation;
orchestration 2 builds them.

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
| `team`, `flow`, `documents` | Reserved for orchestration 3, already validated when stored |

Modules and board types are **lists**, not one boolean per member, so a module or a type added later
is simply absent from an old document instead of a missing required key. `Project` (what
`GET /projects` returns) gains `key` and `modules`, filled in by core.

## A project nobody configured

A project with no settings document, which is every project imported before this, reads as **every
module off**. On that first read it gets a key prefix derived from its name, and the document is
written straight away so the prefix never moves.

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

The Team, Documents and Shared memory modules can already be switched on and are stored, but
nothing reads them yet: their behaviour is orchestration 3.

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
for the ones that carry the work out. The team is only data for now; nothing creates agent files
from it until orchestration 3. There are no user-saved templates.

`name` and `description` are the English copy; a client that knows the `id` shows its own
translation.

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
`modules`, `settings`). The README's [Projects](../README.md#projects) table has every route.

## Removing and importing again

Removing a project from Agentry only makes it forget the directory. The settings document stays, and
so do the work items, which are keyed by the project's id. The document records the path it was
written for, so importing the same directory again finds it and **takes the old id back**, and with
it the settings and the board. `DELETE /projects/:id` says so in its description.

Changing the key prefix does not rewrite anything: only an item's number is stored, and its key is
composed when read, so a new prefix renames every key at once, history included.

## Related

[[work-items.md]] · [[plans/project-ecosystem.md]] · [[design-system.md]] · [[status.md]]
