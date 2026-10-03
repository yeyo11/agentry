---
created_at: 2026-09-28T22:00:00Z
updated_at: 2026-09-28T22:00:00Z
tags:
    - spec
    - web
    - phone
    - design-system
    - shell
    - CW-8
    - proposed
---
# Spec (CW-8): phone headers for the rest of the app, as Night Shift draws them

Status: **refined**, ready to build. This is the separate job recorded by the owner's decision in
[project-ecosystem.md, decision 1 of orchestration 7](project-ecosystem.md#separate-job-recorded-here-so-it-is-not-lost)
and listed as open in [status.md](../status.md#what-is-open):

> switch `phoneHeader: 'page'` on for every phone detail screen Night Shift drew with a back arrow
> (chat, a task's chat, a flow run's chat, orchestration, accounts, changes…), each page drawing its
> back, title and "⋯" sheet.

UI only. No route, shared type or CLI change, so no OpenAPI or README work.

## Why

On a phone Night Shift draws every detail screen with a back arrow, its title and a "⋯" sheet, and
no app top bar. Orchestration 7 moved only the ecosystem's screens. Everywhere else the phone still
shows the global top bar (scope, search, the bell), and often a second header under it. The result
is two stacked headers and less room for content, on the screens people open most.

## How it works today (do not rebuild)

- `apps/web/src/components/shell/phone-header.ts`: `PHONE_HEADER_ROUTES` and `phoneHeaderOf(pathname, projectPage)`.
  A route marked `phoneHeader: 'page'` makes `useOwnPhoneHeader()` true on a phone in a browser. The
  shell (`App.tsx`) then adds `.shell-bare`, and `shell.css` hides `.topbar` under
  `:root:not(.is-desktop)`. The desktop app keeps its top bar, which is the window's title bar.
- `apps/web/src/components/shell/PhoneHeader.tsx`: `PhoneHeader` (back through `BackButton`, or
  `dismiss` for a modal flow, `title`, `subtitle`, `lead`, `actions`, and `more` → `MoreActions`,
  which opens as a `Sheet` on a phone). Draw it only where `useOwnPhoneHeader()` is true.
- The phone decision is made by pathname only. The query string does not change it.

## Screens in scope

Each row is one entry in `PHONE_HEADER_ROUTES`, plus the page heading itself on a phone. The
reference is in `docs/design-system/reference/` (`.html` and the `-dark`/`-light` `.webp`).

| Route | Page | Reference | Phone header |
|---|---|---|---|
| `/chats/:id` | `ChatView` (`pages/chat/Header.tsx`) | `MobileChat`, `MobileChatTarea`, `MobileChatFlujo` | **Keeps its own `.chat-head`**, see below |
| `/chats/new` | `NewChat` | `MobileNuevoChat` | A modal flow: ✕ "Cerrar" to `/chats`, no back arrow. The existing `.new-chat-head` may stay if it meets the target rules. |
| `/orchestration/:id` | `OrchestrationDetail` | `MobileOrquestacion` | Back to `/orchestration`, the orchestration's name, its state as the mono line, and "⋯" with the menu the page already builds (`menu`, line ~836) |
| `/chats/:id/changes`, `/tasks/:key/changes`, `/orchestration/:id/changes`, `/orchestration/:id/tasks/:taskId/changes` | `ChangesReview` | `MobileCambios`, `MobilePasos`, `MobileDiff` | **Keeps its own `.changes-head`** (back to `source.back`, "Changes", meta line, "⋯" through `MoreActions`, and the lens switch and totals under it). Only the route entry, plus the 44 px back target. |
| `/accounts` | `Accounts` | `MobileCuentas` | Back to More, "Accounts", "Refresh usage" as a header action. No "⋯" (the reference has none; per-account menus stay on the cards). |
| `/projects` | `Projects` | `MobileProyectos` | Back to More, "Projects". The FAB stays. |
| `/schedules` | `Schedules` | `MobileProgramaciones` | Back to More, "Schedules" |
| `/schedules/new`, `/schedules/:id/edit` | `ScheduleEditor` | none; follow `MobileNuevaTarea` | A modal flow: "Cancelar" (`dismiss.kind: 'cancel'`) back to `/schedules`, through the page's leave guard |
| `/usage` | `Usage` | `MobileUso` | Back to More, "Usage" |
| `/connectors` | `Connectors` | `MobileConectores` | Back to More, "Connectors", and the reference's "check again" action |
| `/settings` | `Settings` (list and one tab) | `MobileAjustes`, `MobileInstalar` | The list: back to More, "Settings". A tab (`?tab=`): back to the list via the existing `onBack` (the leave guard), with the tab's name as the title |

"Back to More" is `BackButton`'s history back, with a fallback to `/` when the screen was opened
first. There is no More route: More is the tab bar's sheet. `PhoneHeader` has no `onBack` today. If
the Settings tab or the schedule editor needs a guarded back, add an optional `onBack` to `back`
rather than a second header component.

### Screens that keep the app's top bar

These are tab roots, where the top bar carries the scope, search and the bell: `/` without a
project in scope (Home), `/chats`, `/orchestration` (including `?new=1`), and the 404 page. The
reference draws them without a back arrow.

### The chat page

A chat, a task's chat and a flow run's chat are the same page. By the owner's decision in
orchestration 7 it keeps the chat's own header, with the ecosystem's rows under it (the
"Verificación de AGN-26" row and the failed run's banner with "Reintentar"). This job only:

- adds `/chats/:id` to `PHONE_HEADER_ROUTES`, so the app's top bar goes away over it on a phone;
- makes the `.chat-back` link a 44 px target on a phone;
- makes the header's "⋯" (`Menu` today) open as a `Sheet` on a phone (use `MoreActions`, as
  `PhoneHeader` does), with the same entries: export, fork, subagent messages, copy id, and delete
  with its disabled reason.

It does not redraw the chat header as `PhoneHeader`.

### The project scope

On a screen that loses the top bar and filters by the top bar's project scope, move the selector
into the page's header, as Tasks did (`.tasks-phone-head .project-selector`). Screens that do not
read the scope don't need it.

## Tests and docs to update in the same change

- `apps/web/test/shell-design.test.tsx`: flip `/chats/c1`, `/orchestration/o1`, `/projects`,
  `/settings` and `/tasks/AGN-26/changes` to `'page'`. Add every new pattern. Keep `/`, `/chats`,
  `/chats/`, `/orchestration` and `/orchestration/` as `'app'`.
- `e2e/specs/shell.spec.mjs` (the 390 px block, around lines 197–220): add the new routes to the
  "heads itself" loop (no top bar, a 44 px back at the top, `data-phone-header="page"`). The chat
  page and the changes screen may need their own checks, because their back is not
  `lucide-chevron-left` inside `PhoneHeader`. Remove `/projects` from the "top bar stays" loop.
  Keep `/chats` and `/orchestration` in that loop.
- `apps/web/src/components/shell/phone-header.ts`: update the header comment. It will no longer
  be "the ecosystem's screens" only.
- `docs/status.md`: remove the "Phone headers for the rest of the app, a separate job" entry from
  the open list. `docs/plans/project-ecosystem.md`, "Separate job": note that it is done, with a
  link here. Mark this spec `built` in its tags and status line.

## Night Shift checks (from `night-shift-ui-check`)

Tokens only, both themes, `en`/`es` parity for any new string (titles and "Back"/"More" labels reuse
the existing `shell:phoneHeader.*` and page title keys where they exist), touch targets ≥ 44 px,
inputs at 16 px, "⋯" as a `Sheet`, and no new header class when an existing one can be restyled.

## Out of scope

- Redrawing the chat header or the changes header as `PhoneHeader`.
- Moving the tab roots (Home, Chats, Orchestrations) off the app's top bar.
- Any desktop or Electron change. The desktop app keeps its title bar at any width.

## Related

[[status.md]] · [[plans/project-ecosystem.md]] · [[design-system.md]] · [[plans/mobile.md]] · [[plans/redesign-night-shift.md]]
