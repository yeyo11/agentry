---
created_at: 2026-10-08T08:30:00Z
updated_at: 2026-10-08T08:30:00Z
tags:
    - dashboard
    - home
    - widgets
    - layout
    - feature
---
# The editable Home

Home is a dashboard of widgets. Since CW-34 a person shapes it: add, remove, reorder and resize
widgets, keep a layout for each project and one for All projects, and go back to the default. Two
widget types arrived with it, Documents and Flows. Before this, every Home drew a fixed
`defaultLayout(scope)`; the UI redesign left editing out on purpose
([plans/ui-redesign.md](plans/ui-redesign.md#not-in-this-orchestration)).

## What can be edited

- **Enter and leave.** A project's Home has an "Edit Home" button in its head (in the "⋯" menu on a
  phone); All projects has it in the hero. "Listo" leaves the mode.
- **Add** from a picker (a dashed tile and the head's "Añadir widget"; a `Sheet` on a phone). The
  picker offers the types that belong on that Home.
- **Remove** with "Quitar" in the widget's bar.
- **Reorder** inside the widget's own area (figures strip, wide column or narrow column). A widget
  never moves across areas. On desktop by dragging the handle, or with the keyboard: Space lifts,
  arrows move, Space drops, Escape cancels, announced in a live region.
- **Resize** with the size control, only where the type offers more than one size and the area uses
  sizes. Sizes apply in the wide column, on a 12-column grid; the figures strip and the narrow
  column have a fixed width, so their widgets show no size control.
- **Reset** with "Restablecer", which shows a toast with "Deshacer".
- In edit mode each widget is a still, dashed frame: it is drawn but not clickable.

There is no Save or Cancel. Each change is saved at once, as [design-system.md](design-system.md)
describes; if a save fails the previous layout comes back with a toast. (The work item said "draft
until Save"; the design won.)

## How a layout is stored

A layout is data, not markup: `{ version: 1, widgets: [{ id, type, size, config? }] }`, in drawing
order. The rules live in `packages/shared/src/dashboard-layout.ts` and both sides read them:

- `WIDGET_RULES` gives each type its allowed sizes, default size and scope (project, global or both).
- `layoutProblem` is strict and tells a save why it was refused: an unknown type, a type that does
  not belong on that Home, a size the type does not offer, a repeated id, a config over 2 KB, or more
  than 40 widgets.
- `validateLayout` is tolerant and repairs what it reads: it drops unknown or misplaced widgets and
  repeated ids, and resets an unoffered size to the default.

Core (`packages/core/src/dashboard-layouts.ts`, `DashboardLayoutStore`) keeps every layout in one
settings-shaped JSON file, `<dataDir>/dashboard-layouts.json`, keyed by project id and `all`. The
work item planned one file per Home; one document keyed by scope was kept because the layouts are
tiny and a write is a single atomic replace. Writes are chained so two in flight land in order. An
entry that no longer validates is dropped on read and that Home falls back to its default; a file
that is not JSON is left alone and refuses writes until it is fixed. Deleting a project does not
delete its entry; a project id that is unknown is refused on read and write.

When nothing is stored, or the read fails, the web draws the default (`defaultLayout`, built from
the registry), after a skeleton while it loads. The layout comes from the API, then follows the
`dashboard.layout` event, so a second window sees the change.

## Routes

| Route | Does |
|---|---|
| `GET /dashboard/layout?project=<id\|all>` | `{ project, layout }`, `layout` being `null` while the default applies |
| `PUT /dashboard/layout?project=<id\|all>` | Replaces the whole layout; 400 with the reason, 404 for an unknown project |
| `DELETE /dashboard/layout?project=<id\|all>` | Forgets it, so the default applies again |

`PUT` and `DELETE` are refused to a chat's token with 403 (`apps/api/src/security.ts`): an agent
does not rearrange a person's Home. Both emit `dashboard.layout`. The routes are in the Configuration
tag of the OpenAPI document and in the README's REST tables.

## The two widgets

Both are project widgets and both are in the project's default layout.

- **Documents** (`pages/dashboard/widgets/documents.tsx`) lists the most recently modified files of
  the project's documents, from `GET /projects/:id/documents`. It renders nothing when the Documents
  module is off. Sizes: s, m, l.
- **Flows** (`widgets/flows.tsx`) shows the flow's runs going now and queued, a row per board column
  with waiting cards and a count, and runs recently sent back or failed, from `/flow`,
  `/flow/waiting` and `/flow/runs`. `/flow/waiting` returns counts, not cards, hence one row per
  column. It renders nothing unless the Team and Board modules are on. Sizes: m, l, full.

Pick up again now defaults to full width in `defaultLayout`: half width would leave a gap beside it
in the wide column.

## Phone

Editing works with taps only. Each widget is one row with 44 px "Subir", "Bajar" and "Quitar"
buttons; adding opens a `Sheet`. There is no size control and no drag handle, and nothing works only
by dragging.

## Where it lives

`apps/web/src/pages/dashboard/`: `edit.ts` (pure edit functions), `DashboardEditor.tsx`,
`useHomeLayout.ts` (load, save, undo), `registry.ts`, `layout.ts`, `Dashboard.tsx`, `widgets/`. Strings
are in `locales/{en,es}/home.json`. Tests: `apps/web/test/home-edit.test.ts` (including that the
registry matches the shared rules) and `e2e/specs/home-edit.spec.mjs`.

## Known gaps

- The "Suéltalo aquí" drop-slot placeholder and the hero losing its gradient text while editing are
  in the design but were not built.
- The screens were type-checked and unit-tested; the e2e spec was written and runs in the
  verification phase.
- Not in this item: two widgets of one type on a Home (the id allows it, the picker does not),
  editing a widget's config beyond its size, a layout per device, moving a widget across areas.

## Related

[[status.md]] · [[design-system.md]] · [[plans/ui-redesign.md]] · [[team-and-flow.md]]
