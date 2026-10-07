---
created_at: 2026-09-29T21:00:00Z
updated_at: 2026-09-29T21:00:00Z
tags:
    - report
    - qa
    - CW-8
    - web
    - phone
---
# QA report (CW-8): phone headers for the rest of the app

Branch: CW-8's worktree (`e4d62e03`, `c6e7a152`, `b052a801` on top of `main`).

## Verdict: fail (checks not run)

A static review of the diff found **no defect**. The QA session could not run anything: Bash was
denied for `pnpm` in "don't ask" mode, for a delegated QA agent too. `pnpm typecheck`,
`pnpm test` (including the web token guard and `shell-design.test.tsx`) and
`pnpm build && pnpm e2e` (shell, a11y and mobile specs, in dark and light) have **not run**. The
criteria that ask for a passing run stay unmet until someone runs them. The Mobile* screenshots
have not been compared either.

## What the diff does (read, not run)

- `phone-header.ts`: `phoneHeader: 'page'` entries for `/chats/new`, `/chats/:id`, the four changes
  routes, `/orchestration/:id`, `/accounts`, `/projects`, `/schedules`, `/schedules/new`,
  `/schedules/:id/edit`, `/usage`, `/connectors` and `/settings`, all with an optional trailing
  slash. The header comment no longer says the table holds only the ecosystem's screens.
- `PageHeader` gains a `phone` prop. It renders `PhoneHeader` where `useOwnPhoneHeader()` is true,
  on Accounts (refresh, add, cswap "⋯"), Projects (new project), Schedules (with `ProjectSelector`),
  ScheduleEditor ("Cancelar" through its `back`), Usage (the range switch moves under the header)
  and Connectors (refresh).
- `OrchestrationDetail` renders `PhoneHeader` in place of `.orch-summary`: back to `/orchestration`,
  name as the h1, the status badge, and the page's menu as "⋯" (relaunch joins the menu).
- Settings: the list uses `PhoneHeader` (back with fallback `/`). A tab uses `PhoneHeader` with
  `onBack` = `guard().then(ok && setParams({}))`, so it goes back through the leave guard.
- The chat keeps `.chat-head`. Its `Menu` becomes `MoreActions` (a Sheet on a phone), and the back
  link and "⋯" are 44 px (`--touch`). `MoreActions` now keeps download entries as `<a download>`,
  shows toggles as checked, and writes out a disabled entry's reason.
- The changes screen keeps `.changes-head`. Its icon buttons are 44 px on a phone, and its existing
  `MoreActions` opens as a Sheet.
- `/chats/new`: the existing narrow ✕ `Link` to `/chats` gets a 44 px target.
- The project-pill styles move from `.tasks-phone-head` to every `.phone-head`, all in tokens. No
  i18n key is added (every label reuses an existing en/es key). The new `.sheet-action-*` classes
  are documented in `design-system.md` and `agentry-ds.css`.
- Docs: `status.md` drops the open entry, `project-ecosystem.md` says it is done and links the
  spec, and the spec is marked built.
- Tests: `shell-design.test.tsx` and `shell-live.test.ts` are updated. `shell.spec.mjs` checks the
  new routes at 390 px (back ≥ 44 × 44 at top < 80, `data-phone-header=page`, no top bar), the
  titles, the orchestration's head, the Schedules project selector, the Settings tab's back, the
  chat's Sheet, `/chats/new`'s ✕, the schedule editor's Cancel, `.is-desktop` and 1440 px. It keeps
  `/chats` and `/orchestration` (and adds `?new=1` and `/nowhere`) under "the top bar stays", and
  drops `/projects` from it.

## Minor notes (not blocking)

- The e2e does not visit `/orchestration/:id/tasks/:taskId/changes` or `/schedules/:id/edit`. Both
  are covered by the unit test only.
- The chat Sheet check does not assert the subagent-messages toggle or the delete entry's written
  reason.

## To pass

Run on this branch and attach the output: `pnpm typecheck`, `pnpm test`, `pnpm build && pnpm e2e`
(the shell, a11y and mobile specs in both themes). Then compare the changed screens with the
Mobile* reference screenshots in dark and light.
