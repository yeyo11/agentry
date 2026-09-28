# Ecosystem design review: what changed from the drafts

The design pass on the 66 draft screens of `feat/project-ecosystem` (base `e0c24a7`). The reference
in `reference/` is now the official one for the ecosystem: apply it screen by screen with this note.
The decisions behind it are in [design-system.md, "Decisions of the ecosystem design review"](../design-system.md#decisions-of-the-ecosystem-design-review),
and the board's spec page is `reference/DSTablero.html`.

## Two bugs in the drafts

1. **A merge marker in the stylesheet.** `agentry-ds.css` carried a stray `=======` on the line
   before `@media (pointer: coarse)` (after the end of §17). It made the rule invalid, so the 44 px
   minimum of every phone control that comes from the stylesheet was silently lost. Removed.
2. **Epics were counted.** The data set counted the two epics as open items and inside the column
   limits, against `countsInColumn` in `work-items.md`: "15 abiertas", En curso "5 de 3", All
   projects 18. The right figures are 13 open (Backlog 4, Por hacer 3, En curso 4 of 3, En revisión
   2) and 12 done, 25 items plus 2 epics, the list "11 de 25", and 16 open with All projects. Every
   count on every screen is corrected, the sidebar, the tab strip, the jump control and the
   project's settings included.

Smaller slips fixed on the way:

- The Worktrees tab was missing from the project's tab strip (the app has it).
- The empty board on a phone showed `AGN-1` on `pagos-api` (now `PAG-1`).
- The Flow screen had no controls for `flow.maxParallel` and `flow.maxCostUsd` (gap 5).
- Nothing showed a failed flow run (gaps 2 and 8, finding "a failed run's reason shows on the Team
  screens"), and "Ver todo" in the team's activity led nowhere (gap 6).
- The data set drew "Móvil" and "Coste y uso" as epics with no epic item behind them; they are
  labels now (`#móvil`, `#uso`, `#coste`). AGN-47 claimed "0/6 tareas" with no task under it; it is a
  new epic, "sin tareas todavía".
- AGN-26 read differently on the team board (QA as assignee, 5/5) and on its own page (yeyo, 4/5,
  tags `core` and `api` only there). One item now: yeyo's, with its tags everywhere, 5/5 since QA
  checked criterion 5, and a page that shows the whole story (the failed run, the retry, the pass).
- AGN-35: the Developer's run passed with both criteria done and QA sent it back over criterion 2,
  so the card reads 1/2; the Developer's resume waits for a place (2 of 2 running) instead of
  "se reanudó el chat".
- The team screens' live list named the Developer's chat on AGN-28 "Trabaja en AGN-28", the title of
  the person's chat; it is "Desarrollador implementa AGN-28" there, and AGN-28 moved to En curso 4
  min ago, not 18, to match its 4:12 clock.

## The stylesheet (`agentry-ds.css`)

| Change | Classes | App name |
|---|---|---|
| New card anatomy | `.wi-card-ctx`, `.wi-epic.bare`, `.wi-tag`, `.wi-crit` (`.full`); `.wi-card` gets `gap: 7px`, `overflow: hidden`, a 13.5 px title; `.wi-card-foot` wraps and ends in the assignee; `.wi-card.done` keeps two rows | `.workitem-context`, `.workitem-criteria`, `.workitem-card*` |
| The strip | `.wi-strip` (`.live`, `.wait`, `.fail`, neutral), `.verb`, `time`, `.detail`, `.segbar`, `.actor-orch`; phone rows `.wi-mrow .wi-strip` | `WorkItemStrip` |
| Quiet over-limit column | `.wi-col-limit` is one line of warn text; `.wi-col.over` a 2 px warn hairline on top | `.workitem-col*` |
| Paging | `.wi-col-more`, `.wi-card.skeleton-card`, `.list-more` | `.workitem-col-more`, `.list-more` |
| Roles | `.role-av.xs` (18 px), `.wi-assignee.xs`, `.wi-col-head .role-av` | `RoleAvatar` |
| Flow runs | `.run-day`, `.run-row` (`.rail-live`), `.run-main`, `.run-title`, `.run-side`, `.run-now`, `.run-why`, `.run-fail`, `.run-sum`, `.chip .role-av.xs` | `.flow-run*` |
| Model picker | `.model-pick`, `.resolved` | `ModelPicker` |
| Removed | `.wi-card-live` (`.two`) and `.wi-card-meta`: the strip and the context row replace them | — |
| Fixed | the merge marker before `@media (pointer: coarse)` | — |

## Screen by screen

The generated screens changed through their generators (`reference/tools/`); the team screens
without a generator were edited as HTML. "Counts" means the figures of bug 2.

| Screen | What changed | Why |
|---|---|---|
| `Sidebar`, `MobileMas`, `DesktopChatTarea`, `DesktopHitos`, `DesktopNuevoProyecto` | counts (Tareas 13, All projects 16) | bug 2 |
| `DesktopProyecto` | a ghost "Asistente" (sparkle) before "Nuevo chat aquí"; the Worktrees tab; counts; the board card reads En curso 4 de 3; AGN-28 moved 4 min ago | decision 3; the tab the app has |
| `MobileProyecto` | an "Asistente del proyecto · 3 propuestas por revisar" row above the sections; a Worktrees cell; counts | decision 3 |
| `DesktopProyectoAjustes`, `MobileProyectoAjustes` | Worktrees tab; "13 abiertas · 25 en total" | bug 2 |
| `DesktopTablero`, `MobileTablero` | the new card (five rows, context line with `#tags`, criteria bar, strip); the over-limit column is a hairline and a line of text, not a tinted box; Hecho ends in "Mostrar 9 más"; counts; a live card's assignee is not repeated when the strip names it; Móvil and Coste y uso as labels, AGN-47 "sin tareas todavía", AGN-35 1/2, AGN-26 5/5 with its tags | decisions 1, 2 and 6 |
| `MobileTableroFiltros`, `MobileTableroSeleccion` | counts; the filter sheet's epics are the two epic items (Ecosistema de proyectos, Asistente de proyecto) and its labels gain `coste` and `uso` | bug 2 and the epics without items |
| `DesktopTableroEquipo` | each state the team can leave a card in, as a strip: the Product Owner queued (AGN-45) and failed checking a card in Por hacer (AGN-36, "Falló al comprobarla"), the Developer implementing (AGN-28), QA's words on a card it sent back (AGN-35), a card that waits for the person after three bounces (AGN-31), QA verifying (AGN-29) and a card QA passed with "Aprobar y pasar a Hecho" (AGN-26); the role that answers for each column in its head | decisions 1, 2 and 8 |
| `MobileTableroEquipo` | now generated (`team.py`) with the same anatomy and states; jumped to En curso (4 of 3) with En revisión under it; the flow's state ("2 a la vez, 1 en cola · activado") is one row under the view switch, and the header carries the selection button as on the board | the hand-drawn draft had the old card and "5 de 3" |
| `DesktopTableroVacio`, `MobileTableroVacio` | the new `board` illustration; `PAG-1` on the phone | decision 9 |
| `DesktopTareasLista`, `MobileTareasLista` | "11 de 25"; the type glyph leads every row; the "Ahora" column leads with who runs it (your monogram or the orchestration glyph) | bug 2, decision 2 |
| `DesktopTareasTodos`, `MobileTareasTodos` | 16 open; the project at the head of the context row; epics out of the counts; "Mostrar N más" in Hecho | bug 2, decision 6 |
| `DesktopTarea`, `MobileTarea` | AGN-26 after QA passed it: "te espera" next to its state, criteria 5/5 (the fifth checked by QA), and four links: the draft's interrupted chat became QA's failed run of yesterday (its reason under it, opens `ChatFlujo`), plus today's run that passed; a flow run's link leads with the role's squircle. The sidebar is the team's live list | decision 8, gap 2 |
| `DesktopTarea` (activity), `MobileTareaActividad` | QA's comment for the failed run ("fallida", "Ver el chat", a 44 px button on the phone), "Verificación reintentada · yeyo" and QA's comment for the pass; the agent's comment loses its repeated "agente" badge; Comentarios 4, Historial 5, Actividad 9; the relation reads "Hecho", the column's word | decision 8 |
| `MobileTareaCambios` | Actividad 9 | — |
| `DesktopNuevaTarea`, `DesktopSugerirTareas`, `DesktopSugerirTareasEnCurso` | counts; the board behind the overlay uses the new context row | bug 2 |
| `DesktopEquipo` | Team's segmented control gains Actividad; "Ver todo" opens it; the members at work say their stage verb (Implementando, Verificando); the Product Owner's "now" line says its last run failed; the activity says "devolvió" (the glossary's word) and that the Developer will resume when there is a place; Asistente and Worktrees in the header | decisions 2, 7 and 8 |
| `MobileEquipo` | Actividad in the segmented control; stage verbs; the Product Owner's failure in its row | same |
| `DesktopFlujo` | Actividad in the segmented control; one "Límites" card with bounces, runs at once (stepper, 2) and cost per run (field, "Sin límite"); the list of bounced items moved to Team activity's "Devueltas" filter; each role's model is a `.model-pick` ("[opus] Opus 5.5") | gap 5, decision 10 |
| `MobileFlujo` | Actividad in the segmented control; the same "Límites" card as cells | gap 5 |
| `DesktopMiembro` | the model control is a `.model-pick` | decision 10 |
| `MobileMiembro` | the model row is a `button` that opens a sheet (it was a `div`) | a control must be one |
| `DesktopEquipoVacio`, `MobileEquipoVacio` | the new `team` illustration; Asistente and Worktrees in the header | decision 9 |
| `DesktopMemoria`, `DesktopDocumentos`, `DesktopDocumentoEditar`, `DesktopRecursos`, `DesktopRecursoPropuesta`, `DesktopRecursoCrearIA` | Worktrees tab; Asistente in the header where the header has actions; counts | decision 3 |
| `DSIlustraciones` | `board` and `team` redrawn, captions updated | decision 9 |
| **New** `DesktopEquipoActividad`, `MobileEquipoActividad` | every flow run, newest first, by day with "Ahora" on top (2 running, 2 queued); member chips and outcome filter; failed runs with their reason, "Ver el chat" and "Reintentar", or what the retry did once it ran; a run whose item was deleted (AGN-43, cancelled); today by member and the flow's limits at the side; "Mostrar 50 más · quedan 112". The phone shows the "Fallidas" filter; there the whole row opens the run's chat | gap 6, decision 7 |
| **New** `DesktopChatFlujo`, `MobileChatFlujo` | a failed run's chat (QA on AGN-26, yesterday): the item it was for, the `.run-fail` banner with the reason, the raw error and, since it was retried, "Reintentada hoy: pasó hace 12 min" with the new run's chat; the flow's prompt marked as the flow's; the three restarts as dividers; the composer says the person can take the chat over | gap 2, decision 8 |
| **New** `DSTablero` | the board's spec page | — |

## For development

- **Routes the new screens need.** Only `GET /projects/:id/flow` (running and queued) exists on the
  branch. Team activity needs the ended runs too, paged and filtered:
  `GET /projects/:id/flow/runs?role=&outcome=&before=&limit=50`. An item's runs are gap 2's
  `GET /work-items/:itemId/runs`. "Reintentar" needs `POST /flow-runs/:runId/retry`: it queues the
  same stage again for the item while the item is still in the run's column (409 otherwise), and
  counts as a person's move.
- **Failure text.** A run's `error` and the comment the core writes on its item are English ("This
  verification run failed and moved nothing: …"). Show the reason in Spanish from the run's cause
  (budget, rate limit with no account left, a stopped chat, a restart past `MAX_FLOW_RESTARTS`, an
  unreadable result), with the raw `error` under it in mono. In the item's activity, draw the
  `flow.failed` entry from the run rather than printing the English comment body.
- **Durations.** A running clock is `m:ss`; an ended run's duration is words ("3 min 40 s").
- **Stage names.** The core's `refine` covers Backlog and Por hacer. Name it by the column: refinado
  in Backlog, comprobación in Por hacer ("Falló al comprobarla"), where the Product Owner only
  checks the item is ready.
- **Retry.** "Reintentar" shows until a later run of the same stage exists for the item; then the
  failed run shows what that run did and links it.
- **Monogram.** First letter of the first two words; one word, its first two letters.
- **The strip's actor.** Do not repeat the assignee in the card's foot when the strip starts with
  the same person or role.

## Checks run

- `lint.py` on the 48 changed and new screens: no new violation (the three in `DSIlustraciones`'s
  page script were there before).
- `check.mjs` on the same screens, both themes: no text under 4.5:1 and no phone control under
  44 × 44 px.
- Every changed screen captured again in both themes; `index.html` and `manifest.json` list the five
  new pages.
