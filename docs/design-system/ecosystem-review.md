# Ecosystem design review: what changed from the drafts

The design pass on the 66 draft screens of `feat/project-ecosystem` (base `e0c24a7`). The reference
in `reference/` is now the official one for the ecosystem: apply it screen by screen with this note.
The decisions behind it are in [design-system.md, "Decisions of the ecosystem design review"](../design-system.md#decisions-of-the-ecosystem-design-review),
and the board's spec page is `reference/DSTablero.html`.

Orchestration 7 of [the plan](../plans/project-ecosystem.md#orchestration-7-ecosystem-design)
(`ecosystem-design`) applied it to the app on 2026-09-28. What it applied, screen by screen, and what
it left are in [Applied in development](#applied-in-development) at the end of this note.

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

## Applied in development

Orchestration 7 (`ecosystem-design`, 2026-09-28) brought the app to this reference, on top of what
orchestration 6 had already built (paging, Team activity, the flow's limits, the assistant button,
phone headers and the model label), which it aligned rather than rebuilt. Its final review captured
56 screens at 1440 × 1024 and 390 × 844, in both themes, each beside its reference screenshot, in a
sandbox seeded with this note's data set (25 items plus 2 epics, 13 open, 12 done).

Two differences hold on every screen and are not drifts: the sandbox's data (keys, ages, the fake
CLI's missing model names), and past moments read as relative times ("hace 3 min"), by the owner's
decision on time in [the plan](../plans/project-ecosystem.md#the-owners-decisions-for-the-questions-the-design-left).

### The two bugs and the smaller slips

- **The merge marker** was in the reference's stylesheet only; the app's stylesheets never had it.
  The app's 44 px minimum comes from `--touch` in `tokens.css`, which it now defines.
- **Epics are not counted** in the app since orchestration 4 (`countsInColumn`), so the corrected
  figures are the ones the app already showed.
- The smaller slips were in the drafts' data set, not in the app: it had the Worktrees tab, and the
  failed runs, their retry and Team activity's "Ver todo" are built (below).

### The stylesheet

Each reference class landed as an app class, in the stylesheet of the screen that uses it. Where the
name differs from the one §2 of `design-system.md` planned, the name below is the app's.

| Reference | In the app |
|---|---|
| New card anatomy | `.workitem-context`, `.workitem-criteria` (`.is-full`) and `.workitem-card-foot` in `board.css`, with the epic bare in the context row |
| The strip | `WorkItemStrip` (`.workitem-strip`) in `pages/tasks/board/`, its state picked by `workItemStrip()` in `lib/work-items.ts` |
| Quiet over-limit column | `.workitem-col-limit` and the column's warn hairline |
| Paging | `.workitem-col-more` and `.workitem-card.is-skeleton` on the board, `.workitem-list-more` on the list, `.list-more` on Team activity |
| Roles | `RoleAvatar` in the `xs` size (18 px, `.role-avatar-xs`) |
| Flow runs | `.flow-run*` in `team.css`, drawn by `pages/team/runs.tsx`; `.run-fail` is `.chat-run-failed` in `chat.css` |
| Model picker | `ModelPicker` (`.model-pick`, `.model-tag`, `.resolved`) in `components/controls` |
| Removed | the card's live line and meta row: `WorkItemStrip` and the context row replace them |
| Phone header (`.m-head`) | `PhoneHeader` (`.phone-head*`) in `components/shell`, switched on by route in `phone-header.ts` |

### Screen by screen

"Matches" means the final review found no difference of structure, hierarchy, spacing or colour
beyond the two above.

| Screen | Applied | Left, and why |
|---|---|---|
| `Sidebar`, `MobileMas` | counts without epics; Proyectos highlighted on a project's tabs, and Más on a phone (orchestration 6) | — |
| `DesktopProyecto` | a ghost "Asistente" before "Nuevo chat aquí"; the Worktrees tab; counts; Ajustes and Recursos carry no header actions | the Resumen tab keeps the app's dashboard widgets rather than the reference's composition |
| `MobileProyecto` | `PhoneHeader` (back, monogram, name with key and path, "⋯" as a sheet); the "Asistente del proyecto" row with the proposals waiting; a Worktrees cell | the milestone card and "En marcha ahora" are not drawn |
| `DesktopProyectoAjustes`, `MobileProyectoAjustes` | the Worktrees tab; "13 abiertas · 25 en total"; a mono figure under every module that is on (members, documents, journal entries); on a phone, its own Save bar with the tab bar stepped aside | on a phone "Límites del tablero" takes two lines instead of one |
| `DesktopTablero`, `MobileTablero` | match: the five-row card with its context line, criteria bar and strip; the quiet over-limit column; "Mostrar N más" in Hecho with two skeleton cards; the assignee left out when the strip starts with it | the desktop header also shows "Sugerir tareas" (its sparkle beside the flow button), which the reference draws only on `DesktopSugerirTareas` |
| `MobileTableroFiltros` | counts; the two epic items and the labels | not reviewed in detail; its `Sheet` shows ✕ where the reference draws a grab handle |
| `MobileTableroSeleccion` | matches: the tab bar steps aside for the selection bar, and the epic is drawn bare | — |
| `DesktopTableroEquipo` | matches: every state as a strip (queued, failed "al comprobarla", implementing, QA's words, "te espera" with "Aprobar y pasar a Hecho", verifying), each column's role in its head, and the flow's button leading the views | — |
| `MobileTableroEquipo` | matches: the flow's state as one row under the view switch ("2 a la vez, 1 en cola"), at 13 px | — |
| `DesktopTableroVacio`, `MobileTableroVacio` | match: the redrawn `board` illustration and the project's own first key; on a phone the page itself, with a full-width action | — |
| `DesktopTareasLista`, `MobileTareasLista` | match: the type glyph leads each row, and the Now column says who runs the item or that its run failed | with no epic filter the list also shows the epic rows, which the count leaves out |
| `DesktopTareasTodos` | matches | — |
| `MobileTareasTodos` | counts; the project, by its monogram, at the head of the context row | the app keeps search, filters and the column jump, which the reference leaves out; the monogram is "CW" by decision 10 where the screenshot still shows "C" |
| `DesktopTarea`, `MobileTarea` | match in structure: "te espera" beside the state, every flow run as a link led by the role's squircle, a failed one with its reason, each opening its chat | the review did not see the run links, since its seeded runs had no chat; `tasks-item-runs.spec.mjs` covers them |
| `DesktopTarea` (activity), `MobileTareaActividad` | a failed run's comment drawn from the run in the person's words, with "Ver el chat"; "Verificación reintentada · <person>"; no repeated "agente" badge | `MobileTareaActividad` was not reviewed in detail |
| `DesktopNuevaTarea`, `MobileNuevaTarea` | match | the header reads "claude-wrapper · AGN", not "será AGN-48": the client does not know the next number |
| `DesktopSugerirTareas`, `DesktopSugerirTareasEnCurso` | the empty state matches | the proposals were not seen: the sandbox's fake CLI proposes none |
| `DesktopHitos` | matches: the rows' actions are ghost buttons | — |
| `DesktopEquipo`, `MobileEquipo` | match: Actividad in the segmented control and "Ver todo" opening it; stage verbs; the Product Owner's failure in words | — |
| `DesktopFlujo` | matches: Actividad; one "Límites" card (bounces, runs at once, cost per run) that leads to the runs; the sent-back list moved to Team activity's "Devueltas"; each role's model as a `ModelPicker` | — |
| `MobileFlujo` | matches: the same "Límites" as cells | the role picker says "Product Owner" where the reference abbreviates to "PO", and "Descartar" is bordered |
| `DesktopMiembro`, `MobileMiembro` | match: the model is a `ModelPicker`, a list on a desktop and a sheet on a phone | — |
| `DesktopEquipoVacio`, `MobileEquipoVacio` | match: the redrawn `team` illustration; the desktop card reaches the status bar; on a phone "La plantilla trae" and the third action in "⋯" | the desktop keeps a quiet "Añadir miembro": it is the only way to add a member by hand |
| `DesktopMemoria`, `DesktopDocumentos`, `DesktopDocumentoEditar`, `DesktopRecursos`, `DesktopRecursoPropuesta`, `DesktopRecursoCrearIA` | the Worktrees tab; Asistente in the header where it has actions; counts; on a phone, `PhoneHeader`, with the folder read in the subtitle of Documentos and Recursos, and an open document's "⋯" holding the desktop pane's menu | `MobileMemoria` matches; the others were compared by the tasks that built them |
| `DSIlustraciones` | `board` and `team` redrawn in `components/illustrations`, the team's stage words through i18n | — |
| `DesktopEquipoActividad`, `MobileEquipoActividad` | match: "Ahora" on top; days ("Hoy", "Ayer · domingo 27") with the bare hour inside them; Todas / En marcha / Fallidas / Devueltas and the member chips; a failed run's reason, raw error, "Ver el chat" and "Reintentar", or what the retry did; today by member and the limits at the side; "Mostrar 50 más · quedan N"; the crumb "Equipo / Actividad". On a phone the member filter is the header's button and the row opens the run's chat | — |
| `DesktopChatFlujo`, `MobileChatFlujo` | the failure banner (`.chat-run-failed`) at the head of the run's chat: the reason from its cause, what did not move, the raw error and "Reintentar", or once retried what the next run did, with its chat | on a phone the chat keeps the chat page's header, by the owner's decision on phone headers; it moves in the separate job, with every chat |
| `DesktopChatTarea` | the chat page, with the item's row under its header | kept as it is, by the same decision |
| Also headed by `PhoneHeader` | `MobileAsistente`, `MobileDocumento`, and `MobileNuevoProyecto` with "Cerrar" (a modal flow) and its step actions pinned to the bottom | — |

### For development

| Item | Applied |
|---|---|
| Routes | `GET /projects/:id/flow/runs` takes `role`, `outcome` (another name for `status`), `before` and `limit`; `GET /work-items/:itemId/runs` came with orchestration 6; `POST /flow-runs/:runId/retry` answers 409 once the item left the run's column or a later run of the step exists, and counts as a person's move. A run knows the run it retries (`retryOf`), the next run of its step (`retriedBy`) and whether it can be retried now (`retryable`) |
| Failure text | a run keeps its `cause` as a code (`FlowRunCause`: `budget`, `no-account`, `rate-limit`, `stopped`, `restarts`, `unreadable`, `no-verdict`… and the cancellations' reasons). The web words it in the person's language with the raw `error` under it in mono; a run stored before reads its cause from its error. The item's activity draws `flow.failed` from the run, not from the English comment |
| Durations | `formatElapsed` reads `m:ss` from the first second ("0:41"); `formatDuration` words an ended run ("3 min 40 s", "11 min") |
| Stage names | a run carries its `step` by column (`FLOW_STEP_OF_COLUMN`, `flowStepOf`): refine in Backlog, check in Por hacer ("Falló al comprobarla"), work, verify |
| Retry | "Reintentar" shows while `retryable`; once `retriedBy` exists, the failed run says what that run did and links its chat |
| Monogram | `projectMonogram`: the first letter of the first two words, or the first two letters of a single word, in any script |
| The strip's actor | `stripNamesAssignee` leaves the assignee out of the foot when the strip starts with the same role, or with the person |

The e2e specs of these screens were updated (`tasks-board`, `tasks-item-runs`, `tasks-review`,
`team`, `team-gaps`, `team-review`, `documents`, `documents-item`, `projects-wizard`, `shell`,
`suggest`); they run once, in the verification of the merged branch.
