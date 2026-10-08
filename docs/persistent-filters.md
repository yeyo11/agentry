---
created_at: 2026-09-27T12:00:00Z
updated_at: 2026-10-08T12:00:00Z
tags:
    - web
    - lists
    - projects
    - decision
    - feature
---
# Lists keep their filters until they are reset

Every list in the web UI keeps its search, state tab, sort and filters when the person leaves the
page, reloads or closes the browser, until they press Reset. Before, only the address held them, so
coming back through the sidebar showed the list unfiltered again, and Schedules, Projects and the
chat search lost them even on Back.

## What is kept

| List | Parameters | Scope |
| --- | --- | --- |
| Chats | `q`, `state`, `sort`, `origin`, `projects`, `models`, `workers`, `internal` | top bar's project (`loose` for chats under none) |
| Orchestrations | `q`, `status`, `sort` | top bar's project |
| Tasks (the board, the list and a project's Tablero tab) | `q`, `status`, `type`, `priority`, `label`, `assignee`, `epic`, `milestone`, `projects` | top bar's project |
| Schedules | `q`, `view` | top bar's project |
| Projects | `q`, `sort` | global |
| Settings → Security → audit | `path`, `method`, `status` | global |
| Settings → Plugins → Browse | `q` | global |

Views of a page are not filters and are not kept: `tab=templates`, `new`, `view`, `section`, and Tasks' `item`.

## How it works

`apps/web/src/lib/list-params.ts`, `useListParams(page, owned, scope)`:

- **The address stays the source of truth.** A filtered view can still be linked to and survives
  Back. Every change also goes to localStorage under `agentry:filters:<page>:<scope>`.
- **A visit with none of the page's parameters** (the sidebar, a bare link) puts the stored ones
  back, already on the first render, so the list does not flash unfiltered.
- **A link that carries some** applies them, and they become the stored ones.
- **Switching project in the top bar** under an unchanged address brings that project's own
  filters. Each project, and All projects, keeps its own set.
- **Reset** drops the page's parameters from the address and from storage. `ListToolbar` shows it
  whenever the list is `active` (searched, sorted or on another tab), not only while a chip is on.
- Until the top bar's scope is settled the hook neither restores nor stores, so a remembered
  project's filters are not replaced by All projects' while the projects load.
- A list with nothing in it at all keeps its toolbar in place but disabled; Reset stays usable.
- **A reset or a change is never undone by a decision taken before it** (CW-36). The hook decides
  what to show at render time and applies it to the address and storage in an effect; on a slow
  main thread a click can land in between. Each decision carries what storage held when it was
  taken, and the effect drops it when storage holds something else by then, whether it was bringing
  stored filters back or storing the ones a link carried. A reset or a change also makes the next
  render read storage again, even when the address did not move.

## Decisions

- **localStorage, not the server.** Filters are per browser; syncing them between devices would
  need an API route, a type and a JSON document for little gain. Kept in mind if that changes.
- **Per project.** The same list is usually filtered differently in each project.
- **Orchestrations and Schedules follow the top bar's project**, as `lib/project-scope.tsx` already
  promised: filtered in the client with `inProject` on the orchestration's `cwd` and the schedule
  target's `cwd`. A schedule with no `cwd` runs in the wrapper's directory and shows only under All
  projects.
- **The project selector lives in the top bar on every page and screen**; the phone's Chats header
  no longer carries its own chip.
- **Projects on a phone** hides its toolbar below five projects; a kept search is ignored then,
  so no card is hidden behind a toolbar that is not there.

## Related

[[plans/ui-redesign.md]] · [[design-system.md]] · [[phone-layout.md]]
