---
created_at: 2026-09-25T16:27:30.6668753Z
updated_at: 2026-09-29T12:00:00Z
tags:
    - design-system
    - web
    - ui
    - convention
---
# Agentry design system: Night Shift (v2)

The reference for every screen of the web UI, the PWA and the Electron shell. The redesign that
brings the app to it is planned in [plans/redesign-night-shift.md](plans/redesign-night-shift.md).

| What | Where |
|---|---|
| Reference stylesheet (tokens and every component class, as designed) | [`design-system/agentry-ds.css`](design-system/agentry-ds.css) |
| Static prototypes of every screen (open `index.html`) | [`design-system/reference/`](design-system/reference/index.html) |
| Screenshots, dark and light, 1440 px desktop and 390 px phone | [`design-system/reference/screenshots/`](design-system/reference/screenshots) |
| The 15 illustrations as standalone SVG | [`design-system/illustrations/`](design-system/illustrations) |
| The diff comparator: its rules, modes, pieces and states (§5) | `DSComparador` and the **Changes** section of the reference |
| The tokens the app actually uses | `apps/web/src/styles/tokens.css` |

The app reached this design in the `night-shift` orchestration. Where the implementation settled a
detail differently from what is written below, the [Landed](#landed) section at the end says so,
and it wins.

The prototypes use Spanish copy because they were designed on the `es` locale. The app keeps every
string in i18n: `en` is the source and `es` follows `apps/web/src/i18n/GLOSSARY.md`.

## Idea

The base is near-black neutrals and IDE density; the reference was Orca (onorca.dev). On top of it
sits what makes Agentry recognisable, carried over from v1:

- the terracotta → rose **gradient** on what matters,
- the **energy border** that turns on whatever is alive,
- the terminal's **braille spinner**, the **live rail** that breathes, and cyan reserved for live
  work.

Things that are not working stand still.

**Dark is the default theme.** A new install starts dark. "System" and "Light" are still offered
in Settings → Appearance, and every screen must work in both themes.

---

## 1. Tokens

These live in `apps/web/src/styles/tokens.css`. Dark sits on `:root` / `[data-theme='dark']`; light
sits on `[data-theme='light']`, and under `prefers-color-scheme: light` only when the preference is
"System".

### Surfaces and text

| v2 token (alias) | v1 name kept | Dark | Light | Use |
|---|---|---|---|---|
| `--bg` | `--bg` | `#09090b` | `#fafaf9` | page |
| `--bg-1` | `--bg-sunken` | `#0f0f12` | `#f3f2ef` | sidebar, panels, status bar, callouts |
| `--bg-2` | `--bg-elev` | `#151518` | `#ffffff` | cards, menus, inputs |
| `--bg-3` | `--bg-hover` | `#1c1c21` | `#f0efeb` | hover, secondary buttons, code |
| `--bg-4` | new | `#26262c` | `#e6e4df` | selected, bar tracks |
| `--line` | `--border` | white 7 % | ink 8 % | hairlines |
| `--line-2` | `--border-strong` | white 12 % | ink 14 % | control borders |
| `--line-3` | new | white 20 % | ink 24 % | hover borders |
| `--fg` | `--text` | `#f4f4f5` | `#0c0b0a` | primary text |
| `--fg-2` | `--text-muted` | `#a1a1aa` | `#56534d` | secondary text |
| `--fg-3` | `--text-faint` | `#8b8b95` | `#6b6760` | tertiary text and labels, still ≥ 4.5:1 on `--bg-2` |

Keep both names during the migration: the v1 names hold the values, and the v2 names are
`var()` aliases of them. There are 10 000 lines of CSS written against the v1 names, and renaming
them is not part of the redesign.

### Brand

| Token | Value | Use |
|---|---|---|
| `--grad` (alias of `--gradient-accent`) | `linear-gradient(135deg, #b35a36, #b04a5e 55%, #9c3f77)` | primary button, FAB, logo, active-account avatar. White text on it passes 4.5:1 |
| `--grad-border` | accent 75 % → rose 35 % → line | `.grad-border`: the surface the screen is about |
| `--grad-text` | `#f3a07c → #e8708f` (dark), `#a4502f → #a8406a` (light) | hero numbers, one word of a heading |
| `--glow-top` | radial accent 16 % from the top | the halo behind hero headers and featured cards |
| `--accent` | `#ec8a66` (dark), `#9c4d32` (light) | links, focus ring, active indicators |
| `--accent-rose` | `#e0668f` (dark), `#a8406a` (light) | the second stop of the brand gradient, the energy border |

`--accent-2` stays the violet it is in v1, because it is used as a tone. The rose has its own name.

### Status (reserved)

| Token | Dark | Light | Means |
|---|---|---|---|
| `--live` | `#22d3ee` | `#0e7490` | an agent is working **now**. Never an action colour |
| `--ok` | `#4ade9a` | `#166534` | done, connected, healthy |
| `--warn` | `#f0b95c` | `#854d0e` | near a limit, needs authorisation, stopped |
| `--bad` | `#f87b7f` | `#b91c1c` | failed, interrupted, exhausted, destructive |
| `--idle` | `#a78bfa` | `#6d28d9` | waiting for the user |
| `--info` | `#6cb6ff` | `#1d4ed8` | neutral notices |

Every status token has a `-soft` background at 9–13 %. Status colour always comes with a word or an
icon.

### Shape, type, motion

- Radii: `--radius-xs 4` · `--radius-sm 6` · `--radius 8` (controls) · `--radius-lg 12` ·
  `--radius-xl 16` (cards) · pill 999.
- Spacing is in multiples of 4. Page padding is 28 × 32; card padding is 18; gaps are 8, 12, 16 or 22.
- Control height: `--control-h 36` for fields, selects, comboboxes, buttons, segmented groups and
  the list search, and `--control-h-sm 30` for small buttons and icon buttons in dense places. Under
  `(pointer: coarse)` both are 44, the touch target. A small button inside a row of controls
  (`.list-toolbar-row`, `.filter-bar`, `.toolbar`, `.search-box`) takes `--control-h`, so nothing
  in a row stands out of line. Set heights with these tokens, never with a padding and a font size.
- Fonts: `--sans` Geist and `--mono` Geist Mono, from `@fontsource-variable/geist` and
  `@fontsource-variable/geist-mono`. They replace Inter and JetBrains Mono.
- Type scale:

  | Class | Size | Other |
  |---|---|---|
  | display | 34 px | weight 600, tracking -0.035em |
  | h1 | 24 px | weight 600 |
  | h2 | 15 px | weight 600 |
  | body | 14 px | |
  | small | 13 px | |
  | xs | 12 px | |
  | label | 11 px | mono, uppercase, +0.08em |

  Numbers use `tabular-nums`.
- Durations: `--dur-fast 120`, `--dur-base 200`, `--dur-slow 360`, `--spin-cycle 800`,
  `--pulse-cycle 1800`, `--energy-cycle 3600`. Easing is `--ease-out` to enter and `--ease-spring`
  to pop in.
- The only hard-coded colours outside `tokens.css` are `#fff` for text on `--grad`, the Electron
  splash and error page, which cannot read CSS variables, and the two `theme-color` metas in
  `apps/web/index.html`.

### Tokens the project ecosystem added

The fixes of the ecosystem's prototypes (the audit in
[plans/project-ecosystem-audit.md](plans/project-ecosystem-audit.md)) took the last raw values out of
sections 15 to 17 of `agentry-ds.css`. The app gains these when orchestration 2 builds the screens.

| Token | Value | Use |
|---|---|---|
| `--on-accent` | `var(--bg)` | what sits on a solid accent fill: the knob of a checked switch, the tick of a checkbox, the dot of a radio. The app's `controls.css` already draws them this way. `#fff` stays only on the gradient |
| `--hue-base`, `--hue-fill`, `--hue-ink`, `--hue-mark` | worked out from `--hue` on `.proj.monogram`, `.wi-epic` and `.role-av` | a project's, an epic's or a role's own colour: the tint, the letters and the diamond mark. They sit on the element that carries `--hue`, because a custom property resolves where it is declared. No rule writes `hsl()` itself |
| `--sel-bg`, `--sel-mark` | `var(--bg-3)`, a 2 px accent inset | the one selected-row look, for every list, tree and master column (`.list-row.sel`, `.wi-row.sel`, `.wi-mrow.sel`, `.tree-row.on`, `.doc-row.sel`, `.res-item.sel`). A chosen card or tile takes the accent ring instead |
| `--touch` | `44px` | the smallest target on a phone. Segmented controls, chips, buttons, the column jump, steppers, fields and the part-of row get it as `min-height` from the stylesheet, which wins over any inline height |

**Validated in the design review.** The four additions stay, with these measured values:

| Check | Dark | Light |
|---|---|---|
| `--on-accent` (the knob of a checked switch) on `--accent` | 7.95:1 | 5.71:1 |
| The letters of a `--hue` monogram, role or epic (`--hue-ink` on `--hue-fill`), worst of the nine hues in use on any surface | 7.91:1 | 5.24:1 |
| `--live` text on a card's live strip | 9.24:1 | 6.09:1 |
| `--live` text on `--live-soft` over `--bg-1` (the live chip, a `.b-live` badge in a panel) | 8.64:1 | 5.04:1 with `#0b6680`, 4.19:1 with the app's `#0e7490` |

**Light `--live` is `#0b6680` everywhere, not only on the board.** The old `#0e7490` failed on the
soft tint the strips, the live chip and the running rows sit on. The app's `tokens.css` already
carries `#0b6680` on this branch (it came in with the merge of `main`), so the stylesheet and the
app agree; keep it, and don't bring the old value back in a board-only override.

### Reference stylesheet names vs app names

`agentry-ds.css` was written for the design canvas, so a few of its names differ from the app's.
Translate them as follows. Where the stylesheet gives a value, it is right; where it gives a name,
use the app's.

| In `agentry-ds.css` | In the app |
|---|---|
| `--r-xs`, `--r-sm`, `--r`, `--r-lg`, `--r-xl` | `--radius-xs` … `--radius-xl` |
| `--dur` | `--dur-base` |
| `--accent-2` (rose) | `--accent-rose` (`--accent-2` stays violet) |
| `--glow` (radial halo) | `--glow-top` (`--glow` stays the v1 accent tint) |
| `.app`, `[data-theme]` on any element | `:root`, `:root[data-theme]` |

---

## 2. Components

The reference stylesheet names each component with a short class (`.btn`, `.chip`). The app
already has its own class for almost all of them. **Restyle the app's class; don't add the
reference's class next to it.** The e2e specs select several of the app's classes.

| Reference class | App class(es) to restyle | Rule |
|---|---|---|
| `.btn`, `-primary`, `-ghost`, `-danger`, `-sm`, `-icon` | `.btn`, `.btn-primary`, `.btn-danger`, `.btn-small`, `.icon-btn`, `.link-btn`, `.split-btn` | one primary per zone. Destructive actions are danger and ask for confirmation |
| `.kbd` | `.palette-kbd` | keyboard hints |
| `.field`, `.select` | `.field`, `.select-trigger`, `.search-box`, `.list-toolbar-search` | focus shows the accent border and a 3 px `--accent-soft` ring |
| `.chip`, `.on` | `.chip`, `.chip-on`, `.filter-chip`, `.chip-toggle` | filters, and the model/permission pickers under the composer |
| `.badge`, `.b-live`, `.b-ok`, `.b-warn`, `.b-bad`, `.b-idle`, `.b-accent`, `.b-grad` | `.badge`, `.badge-active`, `.badge-ok`, `.badge-warn`, `.badge-bad`, `.badge-idle`, `.badge-info`, `.badge-project` | mono uppercase state labels |
| `.dot`, `.dot-ping` | `.dot`, `StatusDot` (components/motion) | the ping is only for live presence |
| `.count-pill` | `.nav-count`, `.count`, `.tabbar-badge` | nav counters. Live counts in `--live` |
| `.seg` | the segmented controls and status filters in `components/ui` and `.list-toolbar-chips` | 2–5 mutually exclusive options |
| `.tabs`, `.tab.on` | `Tabs` in `components/ui` | a gradient underline on the active tab |
| `.nav-item.on` | `.nav-link`, `.nav-pill` | a gradient indicator on the left |
| `.card`, `.grad-border`, `.energy`, `.rail-live`, `.glow-top` | `.card`, `.widget`, `.live-energy`, `.live-rail` | the surface for anything grouped |
| `.kpi` | `.usage-tile`, `.usage-hero` (Usage on a phone), the widget headline figures | big-number tiles. A phone shows one figure, not a row of tiles |
| `.bar`, `.segbar`, `.ring` | `.meter-*`, `.gauge*`, `.progress`, `.ring*`, `.ctx-bar`, `.slice-*`, `.board-task-fill` | see the thresholds below |
| `.list-row`, `.sel` | `.crow`, `.list-row`, `.master-item`, `.now-row`, `.widget-row`, `.account-row`, `.rotation-cell`, `.settings-cell` | clickable rows. The selected row gets an accent inset. A cell that opens a screen of its own ends in a chevron |
| `.menu`, `.menu-item`, `.danger` | `.menu`, `.menu-item` (controls.css) | desktop overflow menus. On a phone, use `Sheet`: `MoreActions` (components/controls) is the `⋯` that is a menu on a desktop and a `.sheet-actions` column of buttons on a phone |
| `.tooltip` · `.toast` · `.callout` | `Tooltip`, `.toast*`, `.alert*` | the toast drains a gradient bar |
| `.spin-braille` · `.spin-ring` · `.spin-dots` · `.shimmer` · `.skeleton` · `.caret` | `Spinner`, `.ticker*`, `.skeleton`, `.caret` | see §3 |
| `.empty-state` + `Illustration` | `Empty` (`components/ui.tsx`), and the new `components/illustrations/` | see §4 |
| `.avatar` (initials) | `.monogram` | a soft tint of the name's hue with letters in that hue; the gradient only on the active one |
| `.fab` | `.fab` (components/shell/Fab.tsx), the round "+" alone on every page, named by `aria-label` | a page's own button for the same action carries `.page-action-fab` and hides wherever the FAB shows |
| `.dv`, `.dv-row`, `.dv-ghost`, `.dv-seam`, `.dv-fold`, `.dv-map` | new: `.diff`, `.diff-row`, `.diff-fold-pill`, `.diff-seam`, `.diff-gap`, `.diff-rail` (`components/changes/`) | see §5 |
| `.fp`, `.fmap`, `.frow`, `.edit-step`, `.scrub`, `.why` | new: `.changes-print`, `.changes-map`, `.changes-file`, `.edit-step`, `.edit-scrub`, `.changes-why` | see §5 |

These keep their behaviour and take the new styling: the controls in
`apps/web/src/components/controls`, and the primitives in `components/ui.tsx` and
`components/motion.tsx`. Never use native selects, checkboxes or ranges. The prototypes only use
them as mockups.

**Usage thresholds.** A bar or ring for context, limits or quota is neutral below 60 %, turns warn
from 60 % and turns bad from 75 % or when exhausted.

### The shell

Desktop is the sidebar (256 px) next to a column that holds the top bar (52 px), the page and the
status bar (30 px).

- **Sidebar**
  - Brand, then the command palette trigger ("Buscar o ejecutar… ⌘K").
  - Two labelled nav groups:
    - Work: Home, Chats, Orchestrations, Schedules.
    - Space: Projects, Accounts, Connectors, Usage, Settings.
  - "Live": the running and waiting chats and orchestrations, with braille spinners and segmented
    progress.
  - The API reference link.
  - The icon-rail mode is kept.
- **Top bar.** Project scope and crumb, the live chip ("N agentes trabajando"), the bell, and the
  "New chat" split button.
- **Status bar.** Its style comes from Orca. It is always visible on desktop and shows:
  - the connection dot and the active account,
  - the 5 h and 7 d bars,
  - the number of agents running,
  - today's spend,
  - the CLI version.

  It takes over the sidebar footer's job, and `e2e/specs/events.spec.mjs` now reads the connection
  from `.statusbar-conn`.

The phone is the top bar, the page and a tab bar.

- **Tab bar.** Four tabs: Home, Chats, Orchestrations (with a live counter) and More.
- **New chat** moves to a gradient FAB: the same round icon on every page that has one ([phone-layout.md](phone-layout.md)).
  It sits 16 px above the tab bar (the prototype's 100 px is measured from the bottom of the
  frame) and respects safe areas. On Orchestrations it starts a new orchestration instead.
- **More.** A sheet that opens with the account and limits card, then the rest of the navigation
  and the connection.
- **Detail screens** (chat, new chat, orchestration detail) hide the tab bar and put the composer
  or the main action at the bottom.

### Projects, board and work items

The project ecosystem ([plans/project-ecosystem.md](plans/project-ecosystem.md)) is drawn in
section 15 of `agentry-ds.css` and on the `Desktop*`/`Mobile*` screens whose names start with
`NuevoProyecto`, `Proyecto`, `Tablero`, `Tarea`, `TareasLista`, `TareasTodos`, `NuevaTarea`,
`Hitos` and `ChatTarea` (the phone also draws the wizard's steps one by one, `TableroSeleccion`,
`TableroFiltros`, `TareaActividad` and `TareaCambios`). `DSTablero` is the spec page of the board: the
card's anatomy, the eight states of the strip, the column states and the colour rules. The app has
none of these classes yet: orchestration 2 builds them, and the right-hand column is the name each
one should take there. The reference classes start with `wi-` because `.board` and `.board-task`
already belong to the orchestration board.

| Reference class | App class or component | Rule |
|---|---|---|
| `.switch`, `.switch-lg`, `.checkbox`, `.radio` | `Toggle` in `components/controls` (`.switch`, `.checkbox`) | drawn so prototypes stop mocking native inputs. Checked is the rose, and what sits on it is `--on-accent` |
| `.btn[aria-pressed="true"]` | the pressed state of a toggle button | a view filter or "Seleccionar" while selection mode is on: the chosen segment's fill (`--bg-4`), never the accent or the gradient |
| `.scrim`, `.dialog`, `.dialog-head`, `-body`, `-foot` | `.dialog*` (overlays.css) | New task is a dialog on a desktop and a full screen on a phone |
| `.form-row`, `.form-hint`, `.field-area` | `.field` and the form rows of the editors | mono section label above the control, hint under it |
| `.module-card` (`.on`), `.module-ico`, `.module-note` | new `.module-card` | one module, its switch, and what switching it off means ("oculto · 14 documentos conservados"). Off hides, never deletes |
| `.tpl-card` (`.on`), `.tpl-mods`, `.tpl-mod` | new `.template-card` | a radio card. The chosen one takes the accent ring, never the gradient: the wizard's gradient is its primary action |
| `.steps`, `.step` (`.on`, `.done`) | `Stepper` | a neutral stepper; nothing in a wizard is live or failed |
| `.proj-head`, `.proj-tabs` | the project page header and `Tabs` | a tab exists only while its module is on. On a phone the tabs become a card of cells |
| `.wi-board`, `.wi-col` (`.over`), `.wi-col-head`, `.wi-col-count`, `.wi-col-limit`, `.wi-col-slot` | new `.workitem-board`, `.workitem-col*` | five fixed columns. The count leaves epics out. Over its limit a column takes a 2 px warn hairline on top and one line of warn text, "Sobre el límite: 4 de 3", with no box around it; the move is never blocked. The head carries the role that answers for the column (`.role-av.sm`, the person's monogram on Hecho). The board fills the page and a long column scrolls on its own, so no card sits under the status bar or the selection bar (`.page.selecting` keeps room for the bar) |
| `.wi-col-more`, `.wi-card.skeleton-card` | new `.workitem-col-more` | Hecho shows its newest cards and "Mostrar 9 más" at its foot; the button loads the next page in place, and two skeleton cards hold the page's place while it arrives. The same for any column that pages |
| `.list-more` | new `.list-more` | the foot of a paged list (the task list, the Team activity): "Mostrar 50 más" and, beside it, "quedan 112". No infinite scroll: the person asks for the next page |
| `.wi-status` (`.s-done`) | new `WorkItemStatusIcon` | a column is told by shape; only done is coloured (ok) and it is always named |
| `.wi-card` (`.done`, `.sel`, `.rail-live`), `.wi-card-top`, `-title`, `-ctx`, `-foot`, `.wi-fact`, `.wi-card-epic` | new `.workitem-card*` | a card is read in five rows: what it is (type, key, priority), the title, where it belongs (`-ctx`), its facts (`-foot`: bounces, criteria, blockers, comments, then the assignee) and the strip. A card at rest is still and has no strip. The title and the context wrap, never cut. A done card keeps only its first two rows. Selection mode gives the chosen cards the accent ring and a checked box, and never shows a box on a phone. The live line that sat inside the card (`.wi-card-live`) is gone: the strip replaces it |
| `.wi-card-ctx`, `.wi-epic.bare`, `.wi-tag` | new `.workitem-context` | one quiet line: the epic by name with its hue only on the diamond, then the labels as `#tags` in mono. No pills: a board of one epic with a pill on every card was the loudest thing on screen. `.wi-label` stays for filters and the detail page |
| `.wi-crit` (`.full`) | new `.workitem-criteria` | a 28 × 4 bar and "2/5"; complete is the one ok on a card |
| `.wi-strip` (`.live`, `.wait`, `.fail`, neutral), `.actor-orch`, `.detail`, `.verb` | new `WorkItemStrip` (`.workitem-strip`) | **what happens to the card now, at its foot, led by who does it.** One strip per card, never two. Live: the actor (a role's squircle, the person's round monogram or the orchestration glyph), the braille spinner, the stage verb, the running clock and, on its own line, the detail in mono; the card takes `.rail-live`. Waiting for the person: an idle "te espera" and why, with "Aprobar y pasar a Hecho" when QA passed it. Failed: the actor, an ✕ and "Falló al refinar · ninguna cuenta tenía cupo". Neutral: queued ("En cola: la refinará cuando quede sitio") or QA's last words when it sent the card back; a card sent back that also waits for a place keeps QA's words, and its queued run shows in Team activity. When the strip's actor is the assignee, the foot does not repeat it |
| `.wi-proj` | new `.workitem-project` | on Tasks with All projects selected, each card names its project at the head of its context row, and no column shows a limit (each project has its own) |
| `.wi-key` (`.boxed`) | new `.workitem-key` | `AGN-12` in mono, tabular |
| `.wi-type` | new `WorkItemTypeIcon` | epic, story, task and bug by shape, all neutral |
| `.wi-prio` (`.p-low`, `.p-medium`, `.p-high`, `.p-urgent`) | new `PriorityMark` | priority is not a status: three neutral bars, and urgent the only mark with a colour, the accent. Always with its word in `aria-label` |
| `.wi-epic`, `.wi-label`, `.wi-assignee` (`.none`) | new `.workitem-epic`, `.workitem-label`, `.monogram` | the epic is neutral, with its own `--hue` only on the diamond, so a board of one epic does not turn the brand's colour |
| `.select-bar` | new `.selection-bar` | floats over the board while cards are chosen; holds "Orquestar" |
| `.wi-group`, `.wi-row`, `.wi-row-title` | `.list-row` variants | the list view, grouped by column. On a phone the title wraps instead of being cut |
| `.wi-jump`, `.wi-mrow` | `.seg` variant, `.list-row` variant | the phone board: columns are sections of one list, and the jump control shows each column's glyph and count, the chosen one with its name |
| `button.wi-mrow[aria-pressed]` (`.sel`) | `.list-row` variant | selection on a phone: the whole row is a pressed button with the selected-row look and says "Elegida" in words. An epic cannot be chosen and says why ("las épicas no se orquestan"). No checkbox |
| `.ms-bar` (`.done`, `.doing`), `.ms-name`, `.ms-legend` | `ProgressBar` variant | done in ok, the ones in flight in a neutral tone, the rest as track. No dates anywhere |
| `.prop-row` | the chat inspector's rows | the work item's properties |
| `.ac-row` (`.on`), `.ac-by` | new `.criterion-row` | each criterion checked on its own, with who checked it (the person or an agent's chat). **The one place a check mark is always visible, a phone included**: the whole row is the control (`label` or `button role="checkbox"`, at least 44 px on a phone) and the box only shows its state |
| `.rel-row`, `.rel-kind` | new `.relation-row` | `blocks` and `blocked by` only |
| `.link-row` (`.rail-live`), `.link-ico` | new `.work-link-row` | a chat or orchestration task that worked on the item, the role it played, and its state as a badge with its word |
| `.diff-file`, `.diffstat`, `.path.wrap` | the Changes tab of the chat | what changed in the item's worktree. The diffstat has no status colours. In a narrow column the path wraps (`.path.wrap`) instead of losing its file name |
| `.activity`, `.hist`, `.hist-ico`, `.cause` | new `.history-entry` | automatic history interleaved with comments; an automatic move names its cause |
| `.comment` (`.agent`), `.comment-body`, `.agent-mark` | new `.comment` | the person's comment carries their monogram; an agent's carries the `›_` mark and the chat it came from |
| `.part-of` with a `.wi-key` | `.chat-part-of` | a chat that works on an item names it under its header: "Trabaja en AGN-28 *title* · En curso". On a phone the row is the link itself (`a.part-of`), 52 px high |
| `.cell.stacked` | `.settings-cell` variant | a phone cell whose content stacks in lines (a relation, a changed file, a flow row, a journal entry), so nothing in it is cut |
| `.stack`, `.m-foot` | layout helpers | a column whose cards keep their height; a phone detail's bottom action bar |

The sidebar gains **Tareas** between Chats and Orchestrations, with the open count of the selected
project. On a phone it lives in the More sheet, and the board, the list and the milestones share a
three-way segmented control under the title. A new task on a phone is the gradient FAB.

### Team, flow, memory and documents

The Team, Memory and Documents modules of the ecosystem are drawn in section 16 of
`agentry-ds.css` and on the `Desktop*`/`Mobile*` screens named `Equipo`, `EquipoVacio`,
`Miembro`, `Flujo`, `EquipoActividad`, `ChatFlujo` (a failed run's chat), `Memoria`, `Documentos`,
`DocumentoEditar`, `Documento` (phone only) and `TableroEquipo` (the board while a team works it). The phone draws Memory's three tabs as
`Memoria`, `MemoriaDiario` and `MemoriaCLI`. Orchestration 3 builds them; the right-hand column
is the name each class should take in the app.

| Reference class | App class or component | Rule |
|---|---|---|
| `.role-av` (`.xs`, `.sm`, `.lg`) | new `RoleAvatar` (`.role-avatar`) | a role is a neutral squircle with its initials in mono; a person stays a round `.monogram`, so a board never mixes them up. The role's `--hue` is only on the corner diamond, as on the epic label. `.xs` (18 px) leads a card's strip and a filter chip |
| `.model-tag` (`.opus`) | new `.model-tag` | the model of a role, neutral: a model is a choice, not a state |
| `.model-pick` (`.resolved`) | new `ModelPicker` (`.model-picker`) | where a role's model is chosen (Flow, a member, the assistant's proposal): the alias as a `.model-tag`, then the model it resolves to today, "[sonnet] Sonnet 5", then the chevron. The alias is what the agent file stores |
| `.run-day`, `.run-row` (`.rail-live`), `.run-main`, `.run-title`, `.run-side`, `.run-now`, `.run-sum` | new `.flow-run*` (`components/team/`) | one flow run: the member's squircle, "QA · verificación" (the stage by what it does: refinado in Backlog, comprobación in Por hacer, where the Product Owner only checks the item is ready, implementación, verificación), the outcome as a badge with its word, the item, and what it did or is doing; on the right when it ended, how long it took and what it cost. Outcomes keep one meaning each: en marcha (live), pasó (ok), fallida (bad); devuelta, en cola and cancelada are neutral because none is a fault. On a phone the whole row is the target and opens the run's chat |
| `.run-why` | new `.flow-run-why` | why a run failed, under it: the reason in Spanish in bold, what it left behind, the run's own `error` in mono, "Ver el chat" and "Reintentar" |
| `.run-fail` (`.acts`) | new `.flow-run-failed` | the same failure as a banner at the head of the run's chat and nowhere else on that page: what failed, what did not move, the error, and "Reintentar la verificación". Once a later run of the same stage exists, the retry gives way to what that run did ("Reintentada hoy: pasó hace 12 min") and a link to its chat. The same holds for "Reintentar" in `.run-why` |
| `.scope` (`.deny`) | the chips of `StringListEditor` | a path a role may write; `.deny` is one it may never write, dashed and struck through |
| `.member-card`, `.member-head`, `-name`, `-file`, `-desc`, `-facts`, `-now` | new `.member-card*` | one role: its agent file under `.claude/agents/`, its model, the columns it answers for, where it writes, and what it does now. A member at work carries `.rail-live` and the braille spinner next to its verb; at rest it says its last work, still |
| `.flow-strip`, `.flow-node` (`.person`), `.flow-back`, `.flow-back-note` | new `.flow-strip` | the five columns in order with the role that acts in each, and the way back from In review to In progress. Neutral: the flow is configuration |
| `.flow-row`, `.flow-col`, `.flow-role` (`.fixed`), `.flow-does` | new `.flow-row`; the role is a `Select` | the responsible role of a column, what it does there and when it moves the card on. The row for Done is the person's, dashed and locked: agents never move a card to Done |
| `.stepper` | `NumberInput` (components/controls) | the flow's limits: bounces (3) and runs at once (`flow.maxParallel`, 2). 44 px buttons on a phone. The cost per run (`flow.maxCostUsd`) is a field whose placeholder reads "Sin límite", which is the default |
| `.bounce` | new `.bounce` | on a card: "rebote 1 de 3", neutral. The item that used its last bounce waits for the person and says so with an idle badge ("te espera") |
| `.proposal`, `-text`, `-meta`, `-to`, `-actions` | new `.memory-proposal` | a memory entry a role proposed: where it will be written, the text, who proposed it and from which work item. The idle rail and the card's "N esperan tu aprobación" badge say it waits for the person. Approve, edit or discard each one; nothing is written before |
| `.tree`, `.tree-row` (`.on`), `.tree-size` | `.tree-row`, `.tree-row-on`, `.tree-size` (editors.css) | the documents folder and the CLI's memory directory. On a phone, folders and files are 48 px cells |
| `.code-edit`, `.code-bar` around `.code-ed` | `CodeEditor` (`.code-edit` is `.code-editor`) and `.editor-meta` | the existing editor framed with its path bar; its lines are the one editor body, `.code-ed` (below). Unsaved changes are the app's warn `Tag` with its word, "cambios sin guardar" (`shared.unsaved`), next to the zone's Save. An agent file or a document is edited there, never in a new editor |
| `.doc-view` | `Markdown` (`.md`) | a document rendered at reading width |
| `.doc-origin` | new `.doc-origin` | a generated document names the role, the work item and the chat it came from |
| `.doc-row` (`.sel`), `.doc-kind` | `.list-row` variant | a document tied to a work item: its kind (SPEC, ADR, DOC), title, key and author role |

The tab strip of a project carries **Documentos** between Equipo and Memoria, as the plan orders
the tabs. The Memory tab counts the proposals waiting, in idle. On the board, each column's head
shows the role that answers for it (the person's monogram on Done), a card's assignee can be a
role, and a card a role works carries a strip led by the role's squircle and its stage verb.
A card that QA passed waits in In review with an idle "te espera" and a plain "Aprobar y pasar a
Hecho": the move to Done is always the person's.

Team has three views in its segmented control: **Miembros, Flujo and Actividad**. Actividad
(`EquipoActividad`, the "Ver todo" of the team's activity card) lists every flow run of the
project, newest first, grouped by day with the running and queued ones under "Ahora", filtered by
member (chips) and outcome (Todas, En marcha, Fallidas, Devueltas), and paged with `.list-more`. A
side column sums today by member and repeats the flow's limits with a link to edit them. A failed
run opens its own chat (`ChatFlujo`), which says why at its head. The member card of a role whose
last run failed says so in its "now" line, in bad with its word.

The empty team uses the **`team`** illustration (`illustrations/team.svg`): the three roles of the
flow in order (refinar, implementar, verificar), the Product Owner arriving with the gradient
border and the other two as dashed places.

### Assistant, suggestions and resources with AI

The project assistant, "Suggest tasks" and the resources with AI (decisions 35 to 38 of
[plans/project-ecosystem.md](plans/project-ecosystem.md)) are drawn in section 17 of
`agentry-ds.css` and on the screens `Asistente`, `AsistentePropuestas`, `SugerirTareas`,
`Recursos`, `RecursoPropuesta` and `RecursoCrearIA`, desktop and phone, plus `AsistenteVacio` (a
project with nothing to read: no run, no cost, the template's roles offered one by one) and
`SugerirTareasEnCurso` (a suggestion while it runs). The phone draws the Team and Resources
proposals as `AsistenteEquipo` and `AsistenteRecursos`. Orchestration 4 built them: the shared
parts are `components/assistant/run.tsx` with `styles/suggestion.css`, and the screens are described
in [assistant.md](assistant.md#the-screens).

Every suggestion is a CLI chat run with `--json-schema`, so **a run always shows its model, its
time, its cost and the chat it ran in** (`.ai-facts`). The same cost also counts in Usage and in the
status bar's "today", like any chat. A run in progress is live: the braille spinner next to its
verb, the energy border on its one surface, and the caret of the text it writes. A finished run and
every proposal it left stand still, and a section that waits for the reading is a dashed, still
slot.

| Reference class | App class or component | Rule |
|---|---|---|
| `.ai-mark` (`.sm`) | new `AssistantMark` | the assistant's sparkle on a neutral tile. Cyan only inside a live run; never the gradient |
| `.ai-run` (`.live` + `.energy`, `.done`), `.ai-run-head`, `-title`, `-now` | new `.suggestion-run` | the run's header. Live: the verb with the braille spinner, the elapsed time and "Detener", and it takes the screen's energy border. Done: one still line with what it produced |
| `.ai-facts` (`.cost`) | new `.suggestion-facts` | model · time · cost · chat link, in mono. The cost is the one fact in `--fg-2`; while running it reads "0,03 US$ hasta ahora" |
| `.ai-steps`, `.ai-step` (`.now`, `.todo`), `.ai-found` | new `.suggestion-steps` | what the assistant read, one line per source with a count; the one being read has the braille spinner. What it found are neutral `.wi-label` tags |
| `.sug-wait` | `.wi-col-slot` variant | a section waiting for the reading: dashed and still, with "en espera" in words |
| `.sug-row` (`.accepted`, `.discarded`), `.sug-main`, `.sug-title`, `.sug-meta`, `.sug-reason`, `.sug-acts`, `.sug-done`, `.sug-like` | new `.suggestion-row` | one proposal and its reason, quoted under it. Accepted says what it became (`creada · PAG-1`, `guardada`); discarded is struck through with "Deshacer". A proposal like an existing item says "Parecida a AGN-45" and starts unselected |
| `.sug-card`, `.sug-pick[aria-pressed]` | `.suggestion-row` on a phone | a phone never shows checkboxes: each proposal has an "Incluir" / "Incluida" button, 44 px, with the accent ring when included |
| `.code-ed` (`.cur`), `.ln`, `.tx`, `.tk-*` | `CodeEditor` (`.code-editor`, CodeMirror) | the one editor body of every prototype, bare or inside `.code-edit`. One row per line so a wrapped line keeps its number, as CodeMirror's `lineWrapping`; syntax neutral. `.cur` is the line holding the person's cursor |
| `.editor-meta` | `.editor-meta` of `ResourcesTab` | a proposal opened in the editor names the path it will be written to and carries the warn badge "aún sin guardar" (the app's `resources.notSavedYet`); a file that exists says "cambios sin guardar" (`shared.unsaved`) instead |
| `.res-item` (`.sel`) | `.master-item`, `.master-item-on` | the resources tab's master list, with the proposals on top under their own label |

Where the gradient goes: on the assistant's finished screen, "Ir al proyecto" and the first-tasks
card; in "Suggest tasks", only "Crear las seleccionadas"; on the resources tab, the proposals card;
in the editor, "Crear agente". The live screens (`Asistente`, `RecursoCrearIA`) hold the one energy
border on the run, and their primary action stays disabled until the run ends.

### Rules shared by the ecosystem screens

The three sets above were drawn by three tasks in parallel. These rules hold across all of them, and
the index (`reference/index.html`) lists every screen under its module: projects, board and work
items; team, flow, memory and documents; assistant, suggestions and resources with AI.

- **One tab strip.** A project page has eight tabs, in the plan's order: Resumen, Tablero, Equipo,
  Documentos, Memoria, Recursos, Worktrees, Ajustes. Worktrees is not a module and is always there:
  the app already has it, and the drafts had dropped it. Counts are neutral `.count`s (13 open
  items, 5 members, 23 documents, 12 resources, 15 worktrees), except Memoria, which counts the
  proposals waiting for the person in idle ("3 esperan tu aprobación"). A module's tab exists only
  while the module is on: Ajustes draws the strip without Documentos because that screen shows the
  module switched off. On a phone the same tabs are the cells of the project card, with the same
  figures, under an "Asistente del proyecto" row.
- **A role is always a `.role-av`, and its model a `.model-tag`**, wherever it appears: the team,
  the board, the flow, the memory proposals, and the team the assistant proposes. Proposals never
  borrow the project `.monogram`. A role keeps its hue on every screen (Product Owner 300,
  Arquitecto 215, Desarrollador 90, QA 330, Redactor técnico 45; Investigador 250 and Revisor 275
  in the app); a role the assistant invents takes one that is free, and never a status hue (red,
  green or cyan, which say bad, ok and live): the prototype's "Seguridad de pagos" at 160 reads as
  ok, so the app gives such a role one of 240, 262, 288, 315, 65 or 105.
- **Models.** A role's model is the alias its agent file stores (`opus`, `sonnet`). Where a control
  picks it, it is a `.model-pick`: the tag, then the model it resolves to today ("[sonnet] Sonnet 5").
  A tag alone, with no resolved name, is for reading (a member card, a list). A run's `.ai-facts`
  names the resolved model, since that is what the CLI reported.
- **One editor.** Every file shown for editing (an agent file, a resource, a document, a memory
  file) is `.code-ed`, framed by `.code-edit` when it has its own path bar. Unsaved is the warn
  badge with its word: "cambios sin guardar" for a file that exists, "aún sin guardar" for one the
  assistant proposed.
- **Gradients.** The top bar's "Nuevo chat" split button is shell and is not counted. On top of it a
  screen has at most two gradient surfaces: the zone's primary action and one `.grad-border` card
  (its `.grad-text` figure is part of the same surface). The project header's "Nueva tarea" is the
  gradient only on Resumen; on a tab with a primary of its own it is plain.
- **Copy.** Buttons are infinitive and short enough for half a phone's width ("Pedir propuesta",
  "Añadir miembro"). The same figure reads the same everywhere: 23 documents, a journal of 86
  entries, 3 proposals waiting. Outcomes use the glossary's words ("completada", "interrumpida",
  "Crear un fork"; for a flow run "en marcha", "en cola", "pasó", "devuelta", "fallida",
  "cancelada"), and the copy never names a colour: it says "el color de aviso". A run's `error`
  arrives in English from the core; the screen leads with the reason in Spanish, mapped from its
  cause (budget, rate limit with no account left, a stopped chat, a restart, an unreadable result),
  and shows the raw text under it in mono.
- **One data set.** Every prototype of `claude-wrapper` draws the same 25 work items and 2 epics.
  **Epics are not counted** (`countsInColumn` in `work-items.md`): 13 open and 12 done, with the
  columns adding up to it (Backlog 4, Por hacer 3 plus an epic, En curso 4 over its limit of 3 plus
  an epic, En revisión 2, Hecho 12, of which the board shows 3 and "Mostrar 9 más"), and milestones
  v0.20 (7 of 15), v0.21 (0 of 3), two closed ones (3 and 2) and 4 open items without one. The list
  says "11 de 25" with its filter on. `pagos-api` is the empty project and shows no counts. With All
  projects selected, Tasks adds `google-docs-mcp` for 16 open items. The drafts counted the epics
  (15 open, En curso 5 of 3); every figure is corrected. The project's epics are its two epic items,
  Ecosistema de proyectos (AGN-12, 3 of 11) and Asistente de proyecto (AGN-47, just created, "sin
  tareas todavía"); the drafts' "Móvil" and "Coste y uso" had no item and are labels now. The
  prototypes show two moments of the same day: with yeyo working AGN-28 in a chat (Tablero, Lista,
  Hitos, the chat of a task) and with the flow on (the team screens, Tarea, the runs), where the
  Developer implements AGN-28, QA verifies AGN-29 and has passed AGN-26, and two runs wait.
- **Breadcrumb.** Every project tab reads `Proyectos / <project> / <tab>` in the top bar, and a
  page inside a tab adds its own part (`Equipo / Flujo`, `Equipo / Actividad`, `Equipo / <role>`,
  `Recursos / <name>`).
  Tasks reads `Tareas` on the board, the list and the milestones (the segmented control says which
  view), and `Tareas / <key>` on a work item.
- **Titles.** A page title is `.t-h1`, 24 px, on both sizes. A full-screen form on a phone
  ("Cancelar · Nueva tarea") keeps its 17 px header.
- **No bulk accept.** Suggested work items, team members and resources are accepted one by one
  (decision 36 of the plan): there is no "Aceptar todas". Discarding says "Descartar" in words.
- **Nothing that carries the meaning is cut**, and nothing sits under the FAB, the selection bar or
  a toolbar: titles, epics, flow descriptions and module notes wrap; a phone list ends above the
  FAB.

### Decisions of the ecosystem design review

The design pass on `feat/project-ecosystem` settled the ten questions the drafts left open. Each
answer is drawn in the reference; the change note for development is
[design-system/ecosystem-review.md](design-system/ecosystem-review.md).

1. **Card and column.** The card is read in five rows (what, title, where, facts, strip) and its
   state lives in the strip at its foot, never in the middle. A column over its limit is quiet: a
   2 px warn hairline and one line of warn text, with no tinted box and no warn border on the cards.
2. **A role at work vs "Trabajar en ella".** The shape of the strip's first mark says who acts
   before the words do: a role's squircle with its stage verb (Refinando, Implementando,
   Verificando), the person's round monogram with the chat's verb (Ejecutando), or the
   orchestration glyph with "nodo 3 de 9". Refine and verify are live like work (gap 1).
3. **The project assistant.** A ghost "Asistente" with its sparkle in the project header, before
   "Nuevo chat aquí"; also in the command palette. On a phone, an "Asistente del proyecto" row in
   the project card, above the sections.
4. **Phone detail headers.** A screen pushed from another has a back arrow, its title and a "⋯"
   that opens a sheet; there is no app top bar on a phone. A modal flow (new task, the wizard,
   editing a document) has "Cancelar" or "Cerrar" instead of a back arrow.
5. **Sidebar on project tabs.** Proyectos is highlighted on every project tab; Tareas only on the
   board, the list and the milestones reached from it. The phone tab bar highlights Más.
6. **Paging.** Hecho shows its newest cards and "Mostrar N más", which loads the next page in place
   with two skeleton cards while it arrives. A long list ends in `.list-more` ("Mostrar 50 más ·
   quedan 112"; Team activity pages by 50). No "y N más" text that cannot be clicked, no infinite
   scroll.
7. **Team activity.** A third Team view, Actividad, drawn as `EquipoActividad` (gap 6).
8. **Failed runs.** Everywhere a run shows, a failure is bad with its word and its reason: the
   card's strip ("Falló al refinar · ninguna cuenta tenía cupo"), a link row on the item that opens
   the run's chat, the member's comment in the item's activity, the member card on Team, a row in
   Team activity, and a banner at the head of the run's chat (`ChatFlujo`) with the retry. The item
   never moves on a failure.
9. **Tokens and illustrations.** `--on-accent`, the hue tokens, `--sel-*` and `--touch` stay, with
   the measurements in §1; light `--live` stays `#0b6680`, as the app already has it. `board.svg`
   now draws the five fixed columns (the draft had three) and `team.svg` the flow's three roles;
   both drop the "+" disc, which read as a button that did nothing.
10. **Details.** A model is picked with `.model-pick`: "[sonnet] Sonnet 5". Time: a running clock
    in `m:ss` ("4:12", "0:41"), a finished duration in words ("3 min 40 s", "11 min"), a past moment
    as a relative time ("12 min") or, before today, the hour ("17:44"). A project's monogram is the
    first letter of its first two words (`claude-wrapper` → CW, `pagos-api` → PA); a one-word name
    takes its first two letters (`notas` → NO).

---

## 3. Live states and motion

| Situation | Pattern |
|---|---|
| Agent running a tool | braille spinner, a live verb ("Ejecutando"), the mono detail and the elapsed time as a running clock (`m:ss`) |
| A role working on a work item | the card's live strip: the role's squircle, the braille spinner, the stage verb, the clock, and the detail on its own line |
| Agent thinking, no tool | three bouncing dots and a shimmering "Pensando" |
| Task row in progress | ring spinner, plus the live rail on the row |
| Progress of an orchestration | segmented bar, one segment per task: ok, bad, live (partial fill), empty = pending |
| The one surface that matters now | **energy border**, one per screen: the composer of a working chat, or the running orchestration or stage |
| Something is live somewhere | a pinging dot in the top bar chip or on the project row |

Every loop respects the motion setting:

- **`[data-motion='subtle']`:** transitions only. No loops, no energy, no ping, no shimmer, and the
  braille glyph holds still.
- **`[data-motion='off']`** and **`prefers-reduced-motion`:** nothing animates.
- **Background tab:** paused (`data-hidden`).

`e2e/specs/motion.spec.mjs` checks this.

---

## 4. Illustrations

Agentry has its own set of 15 SVG illustrations, drawn in the interface's language: hairline
strokes, nodes and graphs, terminal windows, and the brand gradient on one element. `board` and
`team` are drawn for the project ecosystem and are not in the app yet. There is no library
dependency and no third-party licence. The reference is `design-system/illustrations/*.svg` (each
file carries its styles, with dark fallbacks, so it previews on its own). The catalogue is on the
reference's `DSIlustraciones`, and the pattern in use is on `DSEstados`.

| Name | Use | Tone |
|---|---|---|
| `welcome` | New chat hero, first run, a compact Home when nothing is running | accent |
| `chats` | empty chat list, empty transcript | accent |
| `orchestrations` | empty orchestration list, no templates | accent |
| `schedules` | no schedules, a schedule that never fired | accent |
| `projects` | no projects, a project without worktrees | accent |
| `board` | a project's board without work items, the task list without items. The five fixed columns and the first card floating into Por hacer with the project's key | accent |
| `team` | a project whose Team module is on but has no members yet. The flow's three roles in order, the first arriving | accent |
| `no-results` | search or filters without matches, an empty usage range | accent |
| `not-found` | 404, a chat or orchestration that no longer exists | accent |
| `install` | Settings → Install, turning push on | accent |
| `cli-missing` | the CLI is not detected, or claude-swap is not installed | warn |
| `signed-out` | the CLI is not logged in, or the wrapper asks for a credential (sign-in screen) | warn |
| `connector` | a connector needs authorisation, push is blocked | warn |
| `offline` | the API is unreachable | bad |
| `quota` | every account is exhausted (reserved: the app has no such state yet) | bad |

**How they are built in the app**

- One React component per illustration under `apps/web/src/components/illustrations/`, plus an
  `<Illustration name size tone />` entry point.
- **Colour comes only from classes.** SVG presentation attributes don't resolve `var()`, so the
  classes (`.c1`, `.ln-grad`, `.f-tone` …) live in `styles/illustrations.css` and use tokens. The
  standalone SVGs' fallbacks are for previewing only; they never go into the app.
- The gradient, pattern and mask ids go through `useId()`. Several illustrations can share a page,
  and duplicated ids break silently.
- Sizes: `sm` 160 × 107 (phone, cards), `md` 240 × 160, `lg` 300 × 200 (full-page empty states).
- Tone: `tone="warn" | "bad" | "live"` sets `--il-tone`.
- Motion: `float` (4 px), `blink` (caret), `dash` (flowing links), `pulse` (the live node), and
  `orbit` (24–36 s). Everything stops under `data-motion='subtle' | 'off'` and
  `prefers-reduced-motion`.
- Always `aria-hidden`: the title and text next to it say everything.

**The pattern.** An `Empty` with an illustration is:

1. the illustration,
2. a title,
3. one or two sentences on what happened and why,
4. the action that fixes it (primary), plus at most one secondary.

It goes inside a card when it takes the place of a list, and full page when there is nothing else
to show.

Rules:

- At most one per screen.
- Never next to live data.
- Never decorative filler on a page that has content.

---

## 5. Diff comparator

Changes are reviewed inside Agentry. Nothing links to an editor or hands out a command to copy:
the comparator draws the unified diff the API already serves. The reference is `DSComparador`, the
`DiffView` component and the screens of the reference's **Changes** section; the classes are §18
of `agentry-ds.css`.

**Four rules**

1. **Only what changed carries colour.** Syntax is muted (`--sx-*`) and never uses green, red or
   cyan. Context lines are dimmed in Reading. The changed words of a line are one mark
   (`--diff-*-word`) that spans their syntax runs, not a mark per token.
2. **What was removed folds away.** In Reading the file reads as it is now. A pill on the rail of
   the first new line of a block (`−2`) opens the removed lines in place; when nothing replaced
   them, the pill sits on a dashed seam between the lines they were between.
3. **One line, one rail.** A 3 px rail in `--diff-add` or `--diff-del` marks a changed line, and its
   number takes the same colour. A whole row is tinted, very lightly (`--diff-*-bg`), only in Unified
   and Side by side.
4. **Every change carries its why.** Where there is a transcript, the file header shows the intent
   of the latest step that touched the file, and each step shows the sentence Claude wrote just
   before the edit. One click reaches that place in the conversation.

**Modes**

| Mode | Draws | When |
|---|---|---|
| Reading (default) | the new file, rails, pills for what was removed, context dimmed | reading an agent's work top to bottom |
| Unified | old and new interleaved, both line numbers, a sign column | the familiar view; Step by step uses it for each patch |
| Side by side | matched lines face to face, the shorter side's padding hatched | from 1100 px of diff; the file list folds into a rail |

Removed and added lines are paired by similarity (over 0.45), not by position, so a line that moved
down a row still faces its old self. A phone offers Reading and Unified, and wraps long lines at 19
px rows instead of scrolling sideways.

**Pieces**

- **Rows** are 20 px, mono 12.5 px, line numbers tabular in a 54 px column (46 px in Unified, 40 px
  per side in Side by side).
- **Gaps** between hunks are one row: "21 unchanged lines · in `aheadCount()`" (the function comes
  from git's hunk header) and a ghost "Show". Opening one asks for the whole file once
  (`context=full`) unless it is over 5 000 lines.
- **Change fingerprint**: a 6 px strip, one segment per file as wide as its churn, split into added
  and removed; the current file ringed, the seen ones at 18 %. It is also navigation. A segment is
  never under 4 px: past what the strip's width holds, the smallest files share one neutral
  segment at the end (`.fp > i.rest`), which opens the first of them and is ringed when the
  current file is among them.
- **Block rail**: 14 px at the right of the diff, the file to scale, a mark per block (added,
  removed, or both halves), the viewport as a box, the current block ringed.
- **File map**: the tree by directory; a row is a status letter (M, A, D, R, B for binary), the
  name, the counts, a hollow dot when not committed yet, a check when seen, and the live rail with
  the braille spinner on the file the agent is editing right now. The selected row takes the
  gradient indicator, like the sidebar.
- **Steps**: a vertical line of dots, the selected one in the gradient, the pending one live; the
  intent clamped to two lines. A scrubber of dots sits under the header.
- **Keyboard**: `j`/`k` blocks, `n`/`p` files, `v` seen and next, `m` mode, `o` open the block's
  removed lines, `[` the file map, `/` filter, `←`/`→` steps. None fires while typing in a field.

**Tokens**

| Token | Use |
|---|---|
| `--diff-add`, `--diff-del` | rails, line numbers, signs, pills (they are `--ok` and `--bad`) |
| `--diff-add-bg`, `--diff-del-bg` | row tints in Unified and Side by side; removed lines opened in Reading |
| `--diff-add-word`, `--diff-del-word` | the mark on changed words |
| `--sx-kw`, `--sx-str`, `--sx-num`, `--sx-type`, `--sx-fn`, `--sx-com` | muted syntax, for code inside the comparator and the editor (`CodeEditor`, whose keys, punctuation and headings are the greys of `.code-ed .tk-*`) |

**States.** No worktree: Result is disabled with its reason and the screen opens on Step by step.
Nothing changed yet: compact `Empty`, no illustration (it sits next to the conversation). Binary:
said, not drawn. Over 5 000 lines: blocks only. Added: all rail. Deleted: one pill with its line
count, and no Side by side. Renamed without changes: "only renamed".

**Where it lives.** One screen for a chat, a task and the integration branch
(`/chats/:id/changes`, `/orchestration/:id/tasks/:taskId/changes`, `/orchestration/:id/changes`);
everywhere else, the compact summary opens it. The screen has no energy border: the live rail on
the file being edited is its only moving part.

---

## 6. Content rules

- Every string goes through i18n with `en` and `es` parity. The `es` copy follows `GLOSSARY.md`:
  - Spanish from Spain, with infinitive buttons ("Guardar", "Reanudar").
  - Sentence case everywhere. Never apply `text-transform: capitalize` to sentences: it is why the
    accounts page reads "Se Reinicia En".
- A chat's title is its first prompt. The id, model and message count are secondary, in mono.
- Money is `1.145,86 US$` in `es` and `$1,145.86` in `en`, with tabular numbers. Durations read
  `20:32` or `4 h 49 min`. Relative times are short.
- An empty state offers a next step: templates, examples or a primary action. A large empty block
  never sits above live data.
- Don't invent data. When the CLI doesn't report something, say so ("sin coste", "sin datos").

---

## 7. Checklist for every UI change

1. The diff has no raw colours, radii or durations: all go through tokens. The web test that
   guards this passes.
2. The screen works in dark, light, `motion=subtle` and `motion=off`.
3. At most one energy border and at most two gradient surfaces per screen, and one primary action
   per zone.
4. Status colour is paired with a word or icon, and the usage thresholds are 60 % and 75 %.
5. On a 390 px phone: touch targets are ≥ 44 px, inputs use 16 px text, and nothing scrolls
   sideways.
6. Icon-only buttons have an `aria-label`, interactive elements are real `<button>` or `<a>`, focus
   is visible, and the `a11y-*.spec.mjs` specs stay green.
7. An empty, error or install state uses `Empty` with the matching illustration (§4), and uses at
   most one illustration per screen.
8. A new variant or illustration is added to this document and to `agentry-ds.css` in the same PR.
9. A diff is drawn with `DiffView` and follows the four rules of §5: nothing links to an editor.

## Landed

> **Landed** in the `night-shift` orchestration (2026-09-25), in full. The notes below are where the
> app settled something this document did not say, or said differently. The before/after pairs are
> in [`media/night-shift/`](media/night-shift/README.md).

**Tokens and theme**

- The v1 names hold the values and the v2 names are aliases, as planned. Besides the tokens in §1,
  `tokens.css` gained `--il-*` durations for the illustrations' loops and fixed `--swatch-*`
  colours for the theme thumbnails in Settings → Appearance, which show their own theme whichever
  one is on.
- The theme preference is always stamped on `<html data-theme>`, `system` included. Light tokens
  follow the OS only under `[data-theme='system']`. The pre-paint script in `index.html` resolves
  the same way, and a test runs it against every stored value.
- The browser's `theme-color` follows the stored theme, not the OS: under `system` the two metas go
  back to their media queries.
- `test/design-tokens.test.ts` fails on any hex, `rgb()`/`hsl()`, pixel radius or millisecond
  duration outside `tokens.css`, `#fff` on the gradient excepted.
- `.monogram` works out its colours per element from `--hue`, in `tokens.css`: a 14 % tint and
  letters mixed with `--text`, which keeps 4.5:1 in both themes from one rule.

**Components**

- `Empty` without an illustration is the compact version, restyled as a neutral tile (no violet
  halo). With `illustration`, it renders the §4 pattern under `.state-illustrated`.
- `ProgressBar` has a `segments` variant (one cell per task: ok, bad, live partly filled, empty).
  Past 32 tasks a cell would be thinner than the gap, so it falls back to drawing by share.
- `Stepper` has a `pipeline` form: a row of bars with the state in words under each label, which
  turns into chips when the box is narrow.
- There is one segmented bar, `ProgressBar variant="segments"` (`.progress-segbar`, in
  `primitives.css`), and Home, the sidebar's Live rows, a workflow started from a chat and the
  orchestration screens all draw it. `cells` passes the cells in an order of their own (one per
  agent, or Home's done-first order), `size="sm"` is the 4 px bar, `maxCells` lowers the point
  where it draws by share (12 in the sidebar), and `decorative` hides it from a screen reader where
  its numbers are already written beside it.
- A chat that is a task of an orchestration opens with a context row, `.chat-part-of` (`.part-of`
  in `agentry-ds.css`): "Part of orchestration *name* · stage N of M", with the graph's
  `ProgressBar variant="segments"` at its end. The row is neutral: it is context, not the live
  surface, so it takes no gradient and no energy; the segments carry the only live colour. The
  name is the link and its box covers the row, so the whole line is the touch target. The
  synthesis chat reads "· synthesis" instead of a stage.
- Settings → Remote access draws a tunnel's open address as `.tunnel-address` (`.tunnel-address` and
  `.qr` in `agentry-ds.css`): the URL in mono with copy, beside a QR code drawn in-house
  (`components/QrCode.tsx`). The block takes `.grad-border` while the tunnel is open, because it is
  what the screen is about; the start button is the gradient action only while there is no address.
  The QR code is dark on light in both themes (`--qr-ink`, `--qr-paper`), since not every camera
  reads an inverted one.
- Badges are mono uppercase through CSS, so specs that read a badge's word match it
  case-insensitively or read it from the DOM.

**Shell**

- Desktop groups the nav as **Work** and **Space**, with **Live** under them. Under 900 px the
  palette trigger moves into the top bar as an icon.
- The status bar and Home read the 5 h and 7 d windows the same way: claude-swap's reading of the
  active account first, then the CLI's last rate-limit event (`swapUsageWindows`). Both come from
  one shared hook (`useUsageNow`), so nothing is fetched twice.
- The FAB shows on Home, Chats and Projects (New chat), Orchestrations (New orchestration) and
  Tasks (New task), always the icon alone, and nowhere else (`fabFor`); it hides while the page
  scrolls down and steps aside where the page offers the same action (`FabStandIn`). A page header's
  button for the same action takes `.page-action-fab`.
- The More sheet opens on the account and limits card, then the sections, a **Start** group (Run
  workflow, New orchestration), the API reference and the connection.
- Each section of the More sheet says its figure (`.more-cell-note`, mono): the projects, the
  accounts, the schedules and today's cost. A problem replaces the count with a badge and its word:
  exhausted accounts in bad ("2 agotadas"), connectors waiting for authorisation in warn ("1
  pendiente"). The figures come from the queries the pages use (`useMoreNotes`), and the lists only
  the sheet needs (accounts, schedules, connectors) are read while it is open.
- The project scope lives in the top bar on every page and every screen, a phone included: the
  chip MobileChats drew beside the Chats title, and `pageHoldsScope`, are gone
  ([persistent-filters.md](persistent-filters.md)). A page has exactly one `.project-selector`.

**Screens**

- **Home** draws its widgets in three areas (`top`, `main`, `side`). Two new widget types sit in
  `top`: `kpis` (agents running, waiting, today's spend) and `limits` (the 5 h ring with the weekly
  share, the account card at the bottom on a phone). "In progress" folds the orchestrations into the
  live widget and holds the page's one energy border while anything runs.
- **Settings** has 20 tabs in four groups (Agentry, Claude Code, Extensions, System): a vertical side
  nav on desktop that is still one ARIA tablist, and cells in cards on a phone, where a tab opens as
  its own screen. The `?tab=` ids did not change.
- **Chats** folds each row into a phone card with a container query on the list, not the window.
  On touch, checkboxes appear only after a long press.
- **Usage** picks its metric with the KPI tiles themselves (pressed buttons, the chosen one
  `grad-border`), next to a busiest-day tile.
- **Schedules** offers three templates on its empty state. They open the editor preset through a
  new `?cron=` parameter.
- **Sign-in**: the field's label is the mono uppercase section label, as on `DesktopAcceso`. The app
  asks the guard once (`GET /api/security/auth`) before it draws anything, so a guarded wrapper
  opens on the sign-in screen instead of flashing the shell's skeleton first; past 1.5 s without
  an answer the shell draws anyway.
- **Chat**: the inspector drawer is 344 px wide, not the reference's 320, so the English tab
  labels ("Environment" the longest) fit beside the collapse button without being cut.
- **Orchestrations** open their templates from a secondary "Templates (n)" button in the page
  header, as the reference draws it, not from a tab. It keeps `?tab=templates` and reads as pressed
  while the templates are shown.
- **Orchestration detail**: on a desktop the header scrolls with the page, because its figures moved
  into the KPI tiles and the reference does not pin it. On a phone the header (back, name, state,
  `⋯`) sticks, as the phone reference keeps it above the scrolling body, and its `⋯` opens a
  `Sheet`. The pipeline says its states in its own lowercase words after the count ("1/1 ·
  hecha", "pendiente"), passed to `Stepper` as `stateLabels`; other steppers keep the shared
  words. On a phone every task but the one with the energy border is a one-line card (name, where
  it stands, time and cost), and its box, prompt and actions open under its chevron.
- Primary actions: when a list is empty, its empty state holds the one gradient button, and the
  header's button for the same action goes plain.

**Copy**

- Cost reads "sin coste" / "no cost" everywhere the CLI reported none, Home included.
- A running filter reads "En marcha" / "Running", never "En directo".
- The three words drawn in Spanish inside the illustrations go through i18n.

**Still open**

- The API's schedule `description` stays English; the web says the timetable itself in the UI
  language from the shared parser (see [schedule words](schedule-words.md)).

- The observability "stuck" badge stays bad (red): stuck is a problem, not a warning.
- `quota` is still reserved: the app has no "every account exhausted" state yet.

### The diff comparator (§5)

> **Landed** in the `changes-review` orchestration (2026-09-28), as
> [plans/changes-review.md](plans/changes-review.md) planned it. The notes below are where the app
> settled a detail of §5 differently or said something §5 did not. The before/after pairs of its
> consistency pass are in [`media/changes-review/`](media/changes-review/README.md).

**Where the code is**

- `lib/diff.ts` (parse, pair, fold, the rows of each mode) and `lib/word-diff.ts` (the token LCS)
  are pure and unit-tested against the reference's sample diffs. `components/changes/` holds
  `DiffView`, `BlockRail`, `Fingerprint`, `FileMap`, `FileReview`, `Intent` and the review's rules
  (`review-model.ts`); Step by step is `components/changes/steps/`, its rules in `steps-model.ts`.
- `styles/diff.css` is the comparator (§18 of `agentry-ds.css`, after the project ecosystem's §15 to §17; its step list is `.edit-steps`/`.edit-step` there, because the wizard's stepper is `.steps`/`.step`); the review screen's own styles
  sit beside its components (`changes.css`, `steps/steps.css`) and every rule is scoped under
  `.changes-review`, because the compact summary reuses some of the class names (`.changes-file`)
  and the review's stylesheet stays loaded once the page has been visited.
- The comparator's strings live in the `components:diff` namespace, the screen's in `changes`.

**The comparator**

- Operators stay in the foreground: the GitHub themes paint them as keywords, the reference does
  not. A language only shiki knows stays plain inside a diff (`highlightRoles` returns `null`).
- Side by side is offered neither for a deleted file nor for an added one: with one side empty it
  only doubles the width. Both fall back to Unified, as a narrow window does.
- A file with no text to compare (binary, too large, only renamed) drops the mode switch and the
  block counter.
- A patch shown on its own (a step's) starts at its change: `DiffView` takes `trimEdges`, which
  drops the gaps before the first hunk and after the last and keeps the ones between hunks.
- Past 400 rows the rows are virtualised and measure from a box of their own. The block rail merges
  the blocks that land on the same stretch of it into one tick and keeps the viewport box in its
  own state, so a 20 000-line diff scrolls at 17–33 ms a frame and is never asked for with
  `context=full` (`changes-large.spec.mjs`).
- **Contrast.** The diff's dimmed context and its line numbers sit under 4.5:1 by design (rule 1:
  only what changed carries colour). The review's chrome (header, file map, file header) is held to
  the full contrast rule; axe scans the diff itself without `color-contrast`. Everything else on the
  screen follows the global rule.
- The fingerprint's segments draw 6 px but take a 24 px hit area in the header, which axe's
  target-size rule asks for.

**The review screen**

- `?scope=` (a commit's sha, or `uncommitted`) joins the deep links of §5, so a scope survives a
  reload and can be shared.
- "Seen" is keyed by the file's status and counts (so the map can tell before a diff is read) and
  by the hash of its diff once read; a browser keeps the seen files of the last 60 sources.
- The why line and Step by step's heading quote the intent through one `Intent` component: what
  Claude put between backticks is drawn as code, in the language's quotes («» in `es`, “” in `en`).
  The why line says the step's time as hours and minutes and is hidden when the source has no
  steps; on a phone it follows the sentence.
- The file map's legend draws the braille spinner's resting glyph beside "Claude is editing": only
  the row of the file being edited moves.

**Everywhere else**

- **Review the changes** takes the gradient only in the chat's inspector, where it is the zone's
  one action. The task panel and the integration card draw it as a plain button: an orchestration's
  page already spends its gradient on relaunching and the pull request.
- A chat outside a repository lists, in its summary, the files its steps wrote, and opens the
  review on Step by step.
- The transcript's edit chips share the folded step's line, as `DesktopChatCambios` draws them; an
  opened step takes the row and pushes them under it.
- "See it in the conversation" opens `/chats/:id?at=<entryIndex>`: the chat drops `?at=` from the
  address, turns subagent messages off (the index counts the main view) and marks the entry for a
  moment in the accent, where a search hit takes the warning colour.

**Fixed after landing** (2026-09-28, `fix/changes-review-polish`)

- The fingerprint measures its strip and folds the smallest files into one neutral segment once
  the 4 px minimum per file stops fitting: with 87 files it was 520 px wide inside the 308 px
  inspector, and 904 px on a phone for an integration branch, and the panel scrolled sideways.
- The compact summary's file rows bleed only into the panel's left padding: bleeding right as well
  made every summary 8 px wider than its panel.
- The Result / Step by step switch is the app's `Segmented` control, so it takes the arrow keys and
  the tab order like every other one; a lens out of reach is dimmed and says why.

### The ecosystem design review

> **Landed** in orchestration 7 of the [project ecosystem](plans/project-ecosystem.md)
> (`ecosystem-design`, 2026-09-28). Screen by screen, what the app applied and left is at the end of
> [the review's note](design-system/ecosystem-review.md#applied-in-development).

Where §2 planned an app name and the app settled on another:

- `.model-pick` is `ModelPicker` with the reference's own `.model-pick` class, not `.model-picker`.
- `.run-fail`, the failed run's banner at the head of its chat, is `.chat-run-failed` in
  `chat.css`, since the chat page draws it; `.flow-run-failed` does not exist.
- `.flow-run*` lives in `pages/team/` (`runs.tsx`) and `team.css`, not in `components/team/`.
- The skeleton cards are `.workitem-card.is-skeleton`, and the task list's foot is
  `.workitem-list-more`; Team activity's foot is `.list-more`.
- `.m-head` is `PhoneHeader` (`.phone-head*`, `components/shell/`). Which routes it heads is one
  table, `PHONE_HEADER_ROUTES` in `phone-header.ts`: the ecosystem's screens now, the rest of the app
  in a separate job ([status.md](status.md#what-is-open)).
- Time follows decision 10 with the owner's rule for past moments: a relative time everywhere, and
  the bare hour ("17:44") only inside a list grouped by day, such as Team activity.

Variants the app drew where the reference had no class, mirrored in §19 of
[agentry-ds.css](design-system/agentry-ds.css) under the app's names:

- `.phone-head.is-modal`: a modal flow's header (new task, the wizard, editing a document), its
  title centred at 17 px between "Cancelar" or "Cerrar" and what the flow creates.
- `.model-pick-sheet` / `.model-pick-option`: `ModelPicker` on a phone opens a sheet of 48 px
  options, the current model checked (`.model-pick-check`), instead of a popover.
- `.flow-limit-cost`: the cost limit of a flow run in the Límites card, a field with its currency
  inside; full width, 44 px and a 16 px input on a phone.
- `.board-flow-row`: the phone board's flow state under the views, the whole row a link to the
  flow, at 13 px so "2 a la vez, 1 en cola" is not cut on a 390 px phone.
- `.project-assistant-row`: decision 3's "Asistente del proyecto" row, a card above the project's
  sections on a phone.
- `.workitem-msection-over`: a phone board section over its limit, one line of warn text at the
  end of its head (decision 1 on a phone).
- `.comment-run-chat`: a failed run's comment in the item's activity links to the run's chat; on a
  phone it is a 44 px target of its own under the sentence.
- `.flow-log-sheet` / `.flow-log-sheet-option`: Team activity's view picker as a sheet on a phone.
- `.flow-waiting` (`.flow-waiting-list`, `.flow-waiting-row`, `.flow-waiting-col`,
  `.flow-waiting-role`, `.flow-waiting-count`, `.flow-waiting-sheet`): the Flow screen's prompt after
  a save switched the flow on while cards wait in columns with a responsible member
  ([spec](plans/flow-start-waiting.md)). One row per column with its status icon, the role's squircle
  and the count in mono; "Ponerlas en marcha" is the one primary button, "Solo las nuevas" the other.
  Neutral and still: nothing is live until the person starts them. A `Dialog` on a desktop, a bottom
  `Sheet` on a phone with both actions 44 px tall, the primary first.
- `.chat-run-failed-quiet`: the failed run banner's secondary action, a ghost button; a phone hides
  it, since the item row above the banner already opens the item.
- `.doc-origin-phone`: a phone document's byline (MobileDocumento), one touch-sized link to the task
  with a chevron, no chat and no time; the desktop keeps the key and chat links.
- `PhoneViewHead` (`.project-phone-head`, no rules of its own): a project tab opened as its own
  screen on a phone is headed by the tab's name and the project, with the folder it reads when it
  reads one (`docs/`, `.claude/`). Its "⋯" always leads to the assistant; on Ajustes and Recursos,
  where the reference draws no "⋯", it holds "Asistente" alone, since Ajustes has its own Save and
  Recursos its "+" in the toolbar.


## Related

[[plans/redesign-night-shift.md]] · [[plans/changes-review.md]] · [[plans/ui-redesign.md]] · [[plans/mobile.md]] · [[desktop.md]]
