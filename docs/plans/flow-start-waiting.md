---
created_at: 2026-09-28T20:30:00Z
updated_at: 2026-09-28T23:30:00Z
tags:
    - spec
    - flow
    - team
    - board
    - CW-9
    - built
---
# Spec (CW-9): switching the flow on offers to start the cards already waiting

Status: **built** (CW-9). Where the build differs from this text:

- The es button reads "Solo las nuevas": the glossary writes *solo* without the accent.
- The e2e walk is its own spec, `e2e/specs/flow-waiting.spec.mjs`, on the fake CLI. `team.spec` and
  `team-gaps.spec` run on the real CLI, where starting the cards would spend real runs. `team.spec`
  meets the prompt when it switches the flow on and answers "Only new ones". The new spec runs axe
  on the open dialog in both themes.
- Its history line reuses the retry's second line ("<Role> started chat <id>" / "queued for
  <Role>"); only the heading is new (`run.startedWaiting.<step>`).

Decision and rejected options:
[flow-start-and-chat-token.md, section 1](flow-start-and-chat-token.md#1-switching-the-flow-on-offers-to-start-the-cards-already-waiting)
(owner, option A, 2026-09-28). Rules it extends:
[team-and-flow.md, "What starts a run"](../team-and-flow.md#what-starts-a-run).

## Why

A run starts only when a card *enters* a column. On 2026-09-28 eight tasks accepted from the
assistant stayed in Backlog after the flow was switched on, because switching it on is not an
entry. Option A keeps "the flow never spends on its own" and still lets the person who just filled
the board start it with one explicit choice.

## What counts as a waiting card

A card of the project **waits** when all of these hold:

1. its type is not `epic`;
2. its status is not `done`;
3. `settings.flow.columns[status]` names a role and `memberOf(settings, role)` finds a member playing
   it (the same test `trigger` uses in `packages/core/src/flow.ts`);
4. it has no flow run `queued` or `running` (one run at a time and one queued run per item);
5. for `todo` only: `refinedAlready(item, 'todo', role)` is false, so a card the Product Owner refined
   and nobody changed since is not checked again (a backlog card costs one refine run).

Rule 5 and rule 4 are the reason the count comes from core and not from the board the web holds.

## Order

The runs are queued in board order: columns left to right (`backlog`, `todo`, `in_progress`,
`in_review`), and inside each column by ascending `rank` (the top card first). This is what "oldest
rank first" means in the decision; the queue (`seq`) then starts them in that order.

## Core (`packages/core/src/flow.ts`)

- `FlowService.waiting(projectId): FlowWaiting` — `{ total, columns: [{ column, role, count }] }`
  with only the columns that have at least one waiting card. Returns `total: 0` when the flow, the
  Team module or the Board module is off.
- `FlowService.startWaiting(projectId): FlowStartWaitingResult` — for each waiting card, in the order
  above, inserts a queued run exactly as `trigger` does (same member, agent, model, stage, column,
  language), inside one `write` transaction; the waiting test is re-run inside it, so two clicks or
  two tabs never queue a card twice. Then it announces each run and calls `dispatch()` once.
  - Refuses with `FlowError` 409 when the flow is off.
  - Returns `{ queued, startingNow, waiting }`: `queued` the runs added, `startingNow` =
    `min(queued, maxParallel − running)` (never below 0), `waiting` = `queued − startingNow`.
    It is the promise made at the moment of the click; the runtime limit may still hold a run back,
    as it does for any other run.
- The run records **who queued it**: a new column `flow_runs.queued_by` (`'person'` for these runs,
  null for runs a card's entry queued; a retry keeps `retry_of` as today), added with the `db.ts`
  migration pattern and exposed as `FlowRun.queuedBy: 'person' | null` and on the `flow.run` event.
  This is what lets the item's history say a person started it.
- Nothing else changes: a queued run whose item leaves its column is still cancelled, switching the
  flow off still cancels them all, `maxParallel` and the runtime limit still apply.

## Shared types (`packages/shared/src/types.ts`)

`FlowWaiting`, `FlowWaitingColumn`, `FlowStartWaitingResult`, and `FlowRun.queuedBy` /
`FlowRunEvent.queuedBy`. Regenerate the schemas with `pnpm --filter @agentry/api openapi:schemas`.

## API (`apps/api/src/routes/flow.ts`)

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/projects/:id/flow/waiting` | the count above (`FlowWaiting`) |
| `POST` | `/projects/:id/flow/start-waiting` | queues them (`FlowStartWaitingResult`); 409 when the flow is off, 404 for an unknown project |

Both in the `Team` tag of `apps/api/src/openapi/routes.ts` with a summary and a description, and a
row each in the README's REST API tables. Access is the one `/projects/:id/flow` already has.

A flag on `PUT /projects/:id/settings` was the other shape in the plan; it is not used, because the
settings PUT replaces a document whole and should not start paid work as a side effect.

## Web (`apps/web/src/pages/team/Flow.tsx`)

- After the save mutation succeeds **and** the saved flow went from `enabled: false` to
  `enabled: true` (compared with the saved flow before the save, not the draft), the screen calls
  `GET …/flow/waiting`. With `total > 0` it opens a `Dialog` (`components/Dialog`), never a native
  `confirm`; with `total === 0` nothing opens.
- Dialog copy (i18n `team.json`, `flow.waiting.*`, en/es parity; es follows the glossary):
  - title — es "{{count}} tarjetas esperan en columnas con responsable" (singular "1 tarjeta
    espera…"), en "{{count}} cards are waiting in columns with a responsible role";
  - body — one line per column: the column's name, the role and the count;
  - primary action (the zone's one `btn-primary`) — es "Ponerlas en marcha", en "Start them";
  - secondary — es "Sólo las nuevas", en "Only new ones"; it closes the dialog and calls nothing.
    Escape and closing the dialog behave as "Sólo las nuevas".
- After "Ponerlas en marcha": a toast with the result — es "{{startingNow}} empiezan ahora y
  {{waiting}} esperan en cola" (en "{{startingNow}} start now and {{waiting}} wait in the queue"),
  pluralised; the runs appear in the Flow screen's running/queued lists through the existing
  `flow.run` events. A 409 (the flow was switched off meanwhile) shows the error toast.
- On a phone the dialog is a `Sheet` with both actions ≥ 44 px, the primary first.
- Design system: tokens only, dark and light, no new gradient surface, no animation (nothing is
  live yet). Reference screens: `docs/design-system/reference/DesktopFlujo.html` and
  `MobileFlujo.html`; the dialog follows the confirm dialogs already on the Team screens
  (`AddMember.tsx`). If a new class is needed it goes into `docs/design-system.md` and
  `agentry-ds.css` in the same PR.

## Item history (`apps/web/src/pages/tasks/item/Activity.tsx`)

A run with `queuedBy: 'person'` reads like a retried one does: "Puesto en marcha · <person> ·
<Role> started chat <id>", or queued while no chat started yet (new `run.startedWaiting*` keys,
en/es).

## Tests

- **Core** (`packages/core/src/flow.test.ts` or its neighbour): counts and queues only waiting cards
  (epic, Done, column without role, role without member, card with a queued or running run, todo card
  already refined all left out); order is board order then rank; `maxParallel` respected and
  `startingNow`/`waiting` right; a second `startWaiting` queues nothing; flow off → 409;
  `queued_by = 'person'` persisted and on the event.
- **API**: both routes, 404 and 409, the OpenAPI drift check green.
- **Web**: the dialog opens only on an off→on save with waiting cards; "Sólo las nuevas" calls
  nothing; "Ponerlas en marcha" posts and toasts the counts; en/es parity test green.
- **e2e** (`e2e/specs/team-gaps.spec.mjs` or `team.spec.mjs`): with the flow off, create cards in
  Backlog, switch the flow on and save, see the dialog with the count, choose "Ponerlas en marcha",
  see the runs queued/running on the Flow screen. The axe pass in `a11y.spec.mjs` covers the open
  dialog.

## Docs

`docs/team-and-flow.md`, "What starts a run": add a bullet — switching the flow on, with a person's
consent in the dialog, queues the waiting cards as if they had entered their columns — and list the
two routes in the Team section.

## Out of scope

- A per-card or per-column "Poner en marcha" (option C, may come later).
- Starting waiting cards when the flow is switched on by any path other than the Flow screen (a raw
  `PUT /projects/:id/settings` starts nothing; a client can call `start-waiting` itself).
- Everything in section 2 of the plan (the chat token) — a separate item.

The whole change stays inside the one rule: runs are started as today, through the CLI.

## Related

[[plans/flow-start-and-chat-token.md]] · [[team-and-flow.md]] · [[design-system.md]] · [[work-items.md]]
