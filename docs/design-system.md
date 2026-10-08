---
created_at: 2026-09-25T16:27:30.6668753Z
updated_at: 2026-10-08T22:00:00Z
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
| The tokens the app actually uses | `packages/ui/src/styles/tokens.css` |

The app reached this design in the `night-shift` orchestration. Where the implementation settled a
detail differently from what is written below, the [Landed](#landed) section at the end says so,
and it wins.

The prototypes use Spanish copy because they were designed on the `es` locale. The app keeps every
string in i18n: `en` is the source and `es` follows `apps/web/src/i18n/GLOSSARY.md`.

**Where the code lives.** The design system is implemented in two workspace packages and the app.
`packages/ui` (`@agentry/ui`) holds the tokens, the shared stylesheets, the controls, dialogs,
toasts, icons, illustrations, motion, formatters, Markdown and syntax highlighting.
`packages/chat-ui` (`@agentry/chat-ui`) holds the conversation. `apps/web` holds the screens, the
other components and `styles.css`, the one manifest of the cascade. Paths in this document name
the package when a file is in one (see [plans/web-packages.md](plans/web-packages.md)).

## Idea

The base is near-black neutrals and IDE density. On top of it
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

These live in `packages/ui/src/styles/tokens.css`. Dark sits on `:root` / `[data-theme='dark']`; light
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
| `.empty-state` + `Illustration` | `Empty` (`packages/ui/src/components/ui.tsx`), and the new `packages/ui/src/components/illustrations/` | see §4 |
| `.avatar` (initials) | `.monogram` | a soft tint of the name's hue with letters in that hue; the gradient only on the active one |
| `.fab` | `.fab` (components/shell/Fab.tsx), the round "+" alone on every page, named by `aria-label` | a page's own button for the same action carries `.page-action-fab` and hides wherever the FAB shows |
| `.dv`, `.dv-row`, `.dv-ghost`, `.dv-seam`, `.dv-fold`, `.dv-map` | new: `.diff`, `.diff-row`, `.diff-fold-pill`, `.diff-seam`, `.diff-gap`, `.diff-rail` (`components/changes/`) | see §5 |
| `.fp`, `.fmap`, `.frow`, `.edit-step`, `.scrub`, `.why` | new: `.changes-print`, `.changes-map`, `.changes-file`, `.edit-step`, `.edit-scrub`, `.changes-why` | see §5 |

These keep their behaviour and take the new styling: the controls in
`packages/ui/src/components/controls`, and the primitives in `packages/ui/src/components/ui.tsx` and
`motion.tsx` beside it. Never use native selects, checkboxes or ranges. The prototypes only use
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
- **Status bar.** It is always visible on desktop and shows:
  - the connection dot and the active account,
  - the 5 h and 7 d bars,
  - the number of agents running,
  - today's spend,
  - one dot per enabled provider, at the right end (planned, [plans/multi-provider.md](plans/multi-provider.md)):
    the dot in the status colour, the provider's name and its version, and a word when it is not
    ready ("sin sesión"). Ready is `ok`, signed out or degraded `warn`, and nothing detected a neutral
    `idle` dot. Its tooltip gives the state, the version against the tested range, and the remedy; a
    click opens Settings → Providers. While the first check runs, the braille spinner and "Comprobando
    agentes…". Prototype: `StatusBar.html`.

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
| `.wi-strip.warn`, `.pr-num`, `.pr-link`, `.no-pr`, `.pr-ci` | `WorkItemStrip` states `pr-*` (`.workitem-strip.is-warn`, `.workitem-strip-num`, `.workitem-strip-link`, `.pr-not-ready`, `CiBadge`) | **the card's pull request** (docs/plans/work-item-pull-requests.md). "Preparando la PR" neutral and still: Agentry prepares it, no agent works on it, so no spinner and no `--live`. "Conflicto con main · 2 archivos" in warn. "Aprobada · su PR se abrirá cuando pase la verificación" neutral. "PR #123 · esperando fusión" in idle, the number in mono and tabular, then the CI badge with its word (CI superada ok, CI pendiente neutral with no loop, CI fallida bad) and an icon link to GitHub (`target="_blank" rel="noreferrer"`, 44 px on a phone) that never opens the card. "PR #123 cerrada sin fusionar" in idle and "No se ha podido abrir la PR · motivo" in bad, both with the approval again. In a ready project the approval reads "Aprobar y abrir PR"; otherwise it stays "Aprobar y pasar a Hecho", and a warn line above it says why, "Sin PR: gh no ha iniciado sesión", with gh's own line as its title. A Done card still draws no strip |
| `.pr-remedy`, `.pr-not-ready` | `NotReadyNote`'s remedy and the item page's readiness note (docs/plans/code-hosts.md, reason codes) | **why a project offers no PR or MR, and what to do.** On a card the warn `.no-pr` line reads "Sin MR: glab no ha iniciado sesión en git.inmoseo.net" and the remedy sits under it as one link in `--accent`, underlined, 44 px high on a phone. On the item's page `.pr-not-ready` says it in a sentence with a warn icon and the host's own first line in mono under it, then the same link. The noun follows the host: "MR" and `!12` on GitLab, "PR" and `#12` on GitHub, "PR ni MR" when no host is known. A remedy is a link or an Agentry action (Ajustes → Integraciones), never a command to copy, and `not-git` has none. The reasons and their links are in `reference/DSIntegraciones.html` |
| `.wi-checkout` | new `.workitem-checkout-note` | the project's checkout behind `origin/<default>`: one quiet warn line under the board's toolbar, "La copia de trabajo va 3 commits por detrás de origin/main: tiene cambios sin commit", naming why Agentry did not bring it forward. Never a command to copy |
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
| `.pr-row`, `.pr-num`, `.pr-branch` | new `.item-pr` (`PullRequestRow`) | the item's pull request under its Changes: "PR #123" in mono and tabular, `task/agn-7 → main` in mono, and its state in a badge with its word (the CI badge while open, "fusionada" ok, "cerrada sin fusionar" neutral). The whole row is a plain link to GitHub; on a phone it is 44 px high. Its panel above (`.item-wait.item-pr-wait`) explains waiting for the merge (idle), a conflict with its paths in mono (warn), and a failure with its reason in words and git's or gh's line in mono (bad), with "Aprobar y abrir PR" again. Before any PR exists it is no panel but one quiet line (`.item-wait.is-quiet.item-pr-wait`), since the head already says "Te espera" and carries "Mover a Hecho": the offer beside "Aprobar y abrir PR" or "Abrir PR", or "Sin PR: gh no ha iniciado sesión" in warn (`.pr-not-ready`, gh's line as its title), as on the card |
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
| `.effort-pick` (`.effort-level`, `.effort-costly`), `.effort-tag` | new `EffortPicker` and `EffortTag` (`apps/web/src/components`) | where a run's effort is chosen, wherever a model is: the shared `Select` with levels in mono. Unset reads "medium · recommended" with the reason in a tooltip; `xhigh` and `max` carry a warn "costly" word (never colour alone). Disabled with a tooltip where the provider has no effort or the workflow engine takes the orchestration's. `.effort-tag` is the level a run used, a `.model-tag` beside its model |
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

### Decisions: the "decided" mark, the project override and the Usage line

Drawn for the [decision engine](plans/decision-engine.md) (task `p2` of D0) and waiting for the
owner's validation. Nothing here is live, so nothing takes `--live`, a gradient, the energy border
or motion. The rules are under "Decisions" in [agentry-ds.css](design-system/agentry-ds.css).

- **The mark (`.decided`).** A button whose face (`.decided-face`) is a 20 px mono label:
  "decidido · 0,93", or "sugerido" when the confidence is `null` (the CLI). It carries no status
  colour, since a decision is not a status: `--fg-2` on a `--line-2` hairline, `--fg` when hovered or
  open. It shows only where a decision changed something a person sees, never in shadow and never
  for an invisible act. Its `aria-label` says who decided and what, and ends in "Ver la respuesta".
  - Where it sits: with where the card belongs (the context line) on a board card, since the top
    row is full at a card's width; in the top row of a phone row; in the byline (`.proposal-meta`)
    of a memory proposal.
  - On a phone the button is the 44 px target, with negative margins so the row keeps its height.
- **Its answer (`.decided-pop`, `.decided-sheet`).** A 340 px popover on a desktop, the content of a
  bottom `Sheet` on a phone. In order: the title and the point id in mono, the question, the answer
  (14 px, 500), the probabilities as neutral bars (`.decided-odd`, the chosen one in `--fg`, Jev only),
  then provider, mode, cost and outcome (`.decided-meta`), and "¿Te ha servido?" with "Útil" and
  "No útil" (`aria-pressed`) and a link to the history. The CLI says "— (el CLI no la da)" for the
  confidence.
- **Project override (`.decision-row`, `.decision-group`, `.threshold`, `.decision-card`).** In
  Ajustes of the project, a card under the two columns: the provider (`Heredar · Jev` /
  `Claude Code CLI` / `Jev`), then the points of scope P grouped by area, each group folding.
  - A row: point and id, kind ("Actúa" / "Sugiere"), a mode `Segmented` (Apagado / Sombra / Activo),
    the threshold (act points only, "—" otherwise) and its state.
  - A row that inherits shows the global value dimmed (`.is-inherited`) and says "Heredado". A row
    that was changed shows the control at full strength, "global: sombra" and a ghost
    "Usar la global". "Activo" is disabled, with its reason, for an act point on the CLI.
  - The threshold is the app's `Slider` drawn quiet (`--fg-3` range, no gradient): a dozen sliders
    with a gradient each would break the budget of two gradient surfaces per screen.
  - On a phone the override is its own screen, reached from a cell in Ajustes: a card per point, the
    mode full width at 44 px under its name.
- **Usage line (`.usage-decisions`).** One quiet line under the four figures, "Decisiones · Jev
  0,38 US$ · 37 ejecuciones de Claude ahorradas", over the page's window. It is hidden when no
  decision was recorded in it. On a phone the title leads a line and the link to the history is
  left out.

- **Bulk mode (`.dp-bulk`, `.dp-bulk-list`).** A variant of the Decision points card added at the
  owner's request (2026-09-30). One small "Cambiar modo" button under the card's intro (all points)
  and one on every group head open a menu, Apagado / Sombra / Activo (`MoreActions` with a text
  trigger: a dropdown on a desktop, a sheet of 44 px buttons on a phone). A quiet line below says
  how many were set, were already there or stayed at Sombra (an act point on the CLI cannot be
  active), and to save. When points need consent, one dialog (a `Sheet` on a phone) lists each with
  its name, id, target mode and size, its exact state folded in a `Collapsible`, and one primary
  "Consentir todos y aplicar". No new colour, gradient or motion.

Reference screens: `DesktopProyectoAjustes`, `MobileProyectoAjustes`, `MobileProyectoAjustesDecisiones`,
`DesktopTablero` and `MobileTablero` (marks closed), `DesktopTableroDecidido` and
`MobileTableroDecidido` (answer open, Jev), `DesktopMemoria` (answer open, CLI), `MobileMemoria` and
`MobileMemoriaDecidido`, `DesktopUso` and `MobileUso`. The pieces are generated by
`reference/tools/decision_parts.py`. The other surfaces of the plan's table (item detail, new item,
assistant proposals, orchestration, chat hint, review) reuse the same mark and answer and are not
drawn again.

### Fixing failing checks: the fix panel, its check list and the attempts

Drawn for [code hosts](plans/code-hosts.md) (task `k-p3` of phase 2, P0) and waiting for the owner's
validation before phase 2 builds it. Three screens carry it: `DSChecks` (the rules, the board card, the
item page, the dialog and the decision point, each with its phone counterpart),
`DesktopAjustesDecisionesChecks` and `MobileAjustesDecisionesChecks`, generated by
`reference/tools/checks.py`.

- **The card's strip** says how far the fix is. Developer or QA at work: the live strip (role
  squircle, braille spinner, time, and a mono detail line with `MR !12`, the attempt and who started
  it). Waiting for the person: the idle strip, a `te espera` badge and a neutral "Subir el arreglo".
  Attempts spent: the `warn` strip, "Sin intentos" with its word. A fixing card sits in En curso, one
  awaiting verification or a push in En revisión.
- **The fix panel (`.fix-panel`)** is the item page's zone under the PR row. It borrows `.rail-live` and
  the live wash while the Developer or QA works, and the idle wash while it waits. Its head holds the
  verb (braille only while live), what it means for the person, and the attempts
  (`.fix-attempts` with a neutral `.segbar.attempts`: used segments `--fg-3`, never a status
  colour). Under it, `.fix-checks`: one `.fix-check` per check it received (mono name, `b-bad`
  "fallido", duration in mono), and after the Developer's run a `.verdict` line per check: "Arreglado"
  in ok, or "Sin cambios" when the branch did not cause it.
- **One primary per zone.** "Arreglar N checks" (in the dialog) and "Subir el arreglo" (on the page)
  are the gradient of their zone and never visible together. Neutral on the board card.
- **Who started it decides who pushes.** A fix the person asks for pushes by itself once QA passes
  it (the click was the approval) and moving the card in between drops that; one `checks.fix`
  started always waits for "Subir el arreglo". The panel says which, in plain words.
- **The dialog** (a `Dialog`, a `Sheet` on a phone) lists the checks the Developer receives, the one
  allowed to fail marked `b-warn` "puede fallar" and left out, what the click means, and the attempts
  used. No checkboxes: the checks are not chosen one by one. Past the limit it says the limit stops
  the decision, not the person.
- **`checks.fix` in Settings → Decisions** is an ordinary acting point, per project and off by default,
  in a group of its own (Alojamiento del código) between Revisión and Avisos: 23 points, 10 groups.
  Two `.dp-note` lines carry the question it asks and what else must hold (attempts per commit,
  room in the flow, the cost limit), with a link to the project's settings, where the attempts live.

### Brand marks: the official logo of a program

Every program Agentry names wears **its own official mark**: the code hosts (GitHub, GitLab), the
issue trackers (a tracker on a host wears the host's mark; YouTrack its own) and the agents (Claude
Code, Codex, GitHub Copilot, Gemini, OpenCode). A name with no mark keeps its monogram.

- **The art is the brand's own file**, never redrawn: Simple Icons (CC0) for GitHub, GitLab,
  Claude, GitHub Copilot, Google Gemini and OpenCode; LobeHub's icon set (MIT) for Codex; JetBrains'
  brand resources for YouTrack. `packages/ui/src/components/brand-art.ts` holds the paths and says
  where each came from. A brand's mark is its trademark, used to name the program.
- **A light tile in both themes** (`--brand-tile`, a hairline border, `--radius-sm`), and the mark
  in the brand's colour (`--brand-<id>` in `tokens.css`, the one place a brand's hex lives). The
  tile does not follow the theme: a mark reads as the brand draws it, and GitHub's black or
  YouTrack's gradient would not hold on a dark surface.
- **Where**: the code host and tracker rows of Integrations, the project's host line and tracker
  choice, the import dialog's head, the provider rows and the chat badges (`.prov-mark` keeps its
  class, and the mark sits at 20 px there). Beside its label the mark is decoration (`aria-hidden`);
  alone it is an image named by the label.
- **Component**: `BrandMark` (one mark) and `ProgramMark` (the mark, or the monogram when there is
  none). The reference prototypes under `docs/design-system/reference/` were drawn with monograms and
  are not redrawn for this; the app is the reference for the marks.

### Providers: readiness rows, first run, order and binary

Drawn for [multiple agent providers](plans/multi-provider.md) (task `p1` of P0) and waiting for the
owner's validation before P2 builds it. Nothing here is live: no energy border, no loop, and the
only gradients are the ones a screen already had. The rules are under "Providers" in
[agentry-ds.css](design-system/agentry-ds.css).

- **A row (`.prov-row`).** Handle (`.prov-grip`, desktop only), the provider's `.monogram` (a hue that
  is never red, green or cyan; brand logos are third-party art, so none is drawn), its identity
  (`.prov-id`: name, account, then version and path in mono), the state (`.prov-state`: a badge and
  the reason in plain words under it), the actions (`.prov-actions`) and an enable switch. First run
  uses `.compact`: no handle, no switch, since the person is only reading.
- **A state is a status colour with its word**, one each, and the same word everywhere:

  | State | Badge | Word | The one action | Also offered |
  |---|---|---|---|---|
  | `ready` | `b-ok` | Listo | none | |
  | `degraded` | `b-warn` | Con avisos | Actualizar | Seguir así |
  | `signed-out` | `b-warn` | Sin sesión | Iniciar sesión | |
  | `incompatible` | `b-bad` | Incompatible | Elegir binario | Ver instalación |
  | `used-before` | `b-idle` | Usado antes | Elegir binario | Instalar |
  | `not-installed` | plain `.badge` | No instalado | Instalar | |
  | `unknown` | `b-idle` | Sin comprobar | Reintentar | |

  A provider the person switched off says "Desactivado" in the plain badge and is not checked. A
  check that is running is the plain badge with a braille spinner next to "Comprobando"; the rows
  still waiting are `.skeleton` bars.
- **Actions are neutral buttons.** A row never carries the gradient: the page's one primary is
  "Continuar con Claude Code" on first run, and Settings has none. Sign in, Install, Update and
  See install open the vendor's page and carry the external-link icon; in phase 1 only Claude Code's
  sign-in stays inside Agentry.
- **Default and order.** On a desktop, a "Proveedor predeterminado" select on top of the list
  ("Automático" is the first ready one) and the order by dragging `.prov-grip`; the row being
  dragged is `.lifted` and the drop point a 2 px accent line (`.prov-drop`). On a phone one cell,
  "Predeterminado y orden", opens a `Sheet`: a radio for each provider (a 44 px button around
  `.prov-radio`) and up/down buttons, no handle.
- **Binary override.** On a desktop, "Elegir binario" opens a panel under the row (`.prov-bin`, the row
  gets `.open`): a mono path, "Buscar…", "Comprobar y guardar" and "Usar el del PATH". Agentry reads
  the version before saving. On a phone tapping a row opens its `Sheet` with the switch, the same
  field at 16 px and the one primary, "Comprobar y guardar".
- **First run (`.prov-first`).** A full page with no shell, 760 px wide: brand, title at the display
  size, the providers grouped by state (Listos, Sin sesión, Usados antes, Sin instalar), a note that
  Agentry watches the folders, "Volver a comprobar", "Omitir por ahora" and the primary. Gradients:
  the logo and the primary. On a phone the groups become one card and the actions are pinned in
  `.m-foot`.
- **Nothing found** is an `Empty` with the set's `install` illustration (`il-lg` on a desktop, `il-sm`
  on a phone), never a dead end: the primary opens the install page of the first choice and a row
  of chips links to the others.
- **Copy.** "Comprobar" is the check; the glossary's "Actualizar" for Refresh stays for the button
  that re-detects ("Volver a comprobar") only where it says so, and "Actualizar" on a row means the
  provider's own version.

Reference screens: `DesktopProveedores` (Codex's binary override open), `DesktopProveedoresEstados`
(the states the first machine lacks, and a row being dragged), `MobileProveedores`,
`MobileProveedoresEstados`, `MobileProveedoresOrden`, `MobileProveedoresBinario`,
`DesktopPrimerArranque`, `DesktopPrimerArranqueBuscando`, `DesktopPrimerArranqueVacio` and the three
`MobilePrimerArranque*`. They are generated by `reference/tools/providers.py`.

The setup assistant replaces this first run (see [Setup](#setup-the-assistant-the-sign-in-panel-and-the-secrets-line));
its checking and nothing-found states still draw the Agents step before any sign-in.

### ProviderBadge: the agent a chat runs on

Drawn for phase 3 of [multiple agent providers](plans/multi-provider.md) (task `p1` of
`providers3-prototypes`) and waiting for the owner's validation before the web work starts. It is the
one new variant of the phase: which agent a chat belongs to, wherever a chat is shown.

- **The mark (`.prov-mark`).** The provider's `.monogram` at 20 px: two letters in mono on a tint of
  its `--hue`, worked out like `.proj.monogram` (the same `--hue-fill` and `--hue-ink`, so the
  contrast already measured holds in both themes). The hue is never red, green or cyan, which are
  status and live. No brand art, as in Providers. It has `role="img"` and the provider's label as its
  name, because a list row shows the mark alone.
- **The badge (`.prov-badge`).** A pill: the mark, round, and the label in 12.5 px `--fg-2`. It is
  neutral: no status colour, no gradient, no motion. Whether the agent is working is the header's
  `b-live` badge and the spinner, never the provider's.
- **Where it goes.**
  - Chat header: the badge sits between the project and id and the model, on the mono line under the
    title (`claude-wrapper · 7e41c0 [Codex] gpt-6.1-sol`). On a phone the same line holds the badge and
    the live word; the model is in the details Sheet.
  - Details panel (desktop) and details Sheet (phone): an "Agente" row with the badge, first in the
    chat's rows. A chat whose agent has its own session id, and the id differs from the chat's, gets two
    rows: "Id del chat" and below it "Id nativo", both in mono, the native one `--fg-2` and cut in the
    middle on a desktop (`0197c3a2…4b1d`), whole and wrapping on a phone, with a 44 px copy button each. Claude
    Code's two ids are one, so its row stays "Sesión".
  - Chats list: the mark alone, in its own 20 px column after the state dot on a desktop (header cell
    left empty), and under the time at the right edge of the row on a phone. There is no filter by
    provider.
- **What a provider lacks is not drawn, or says so.** Codex and Copilot report tokens, not cost: the
  cost block says "Sin coste" and the sentence "Codex no informa del coste, solo de los tokens", the
  number's gradient goes, and a list row says "sin coste". Copilot picks its model when the chat
  starts, so the composer's model chip is disabled and reads "Lo elige Copilot", with the reason in
  its `title`. The preset and the CLI's MCP chips are Claude's and are not shown on the others.
- **The working line names the agent**: "Codex está trabajando", with the braille spinner and
  the shimmer, in place of a bare verb. The detail in mono after it is the tool's.
- **Permissions** keep Agentry's own words in the badge (`acceptEdits`, `manual`), as the plan's
  table does; the composer chip says them in plain Spanish ("Aceptar ediciones", "Preguntar").

Reference screens: `DesktopChat` (Claude Code), `DesktopChatCodex`, `DesktopChatCopilot`,
`MobileChat`, `MobileChatCodex`, `MobileChatCopilot`, `MobileChatDetalles` (the details Sheet with
both ids), `DesktopChats` and `MobileChats` (a Claude, a Codex and a Copilot chat in the list). They are
written by `reference/tools/chatproviders.py`; the first run lifted the four older screens into the
shared shell and swapped their pixel radii for tokens.

### Rotation between providers: the limit, the on-limit card, the mapping and the project override

Drawn for phase 4 of [multiple agent providers](plans/multi-provider.md) (task `p1` of
`providers4-prototypes`) and waiting for the owner's validation before W builds it. Nothing here is
live: no `--live`, no loop, no energy border. The only gradient is each screen's one primary
("Guardar los cambios"). The rules are under "Rotation between providers" in
[agentry-ds.css](design-system/agentry-ds.css).

- **The limit block (`.prov-limit`).** Inside a provider's row (`.prov-state`) or cell, under the
  reason: the label "Límite", a state badge, and the age of the reading with where it came from
  ("Lectura de hace 3 min · durante la última ejecución"). Then a row per window (`.lim-row`): the
  window in mono (`5 h`, `7 d`), a usage `.bar`, the percentage and the reset time. Bars follow the
  usage rule: neutral below 60 %, `warn` from 60 %, `bad` from 75 % or on the exhausted window.
  - States, each a word with its colour: **Cerca del límite** (`b-warn`), **Límite alcanzado**
    (`b-bad`), **Sin lectura** (`b-idle`, with a sentence instead of bars). With headroom there is no
    badge. A provider that does not report quota, or whose limit just reset, is "Sin lectura": it is
    never shown as free without a new reading.
  - It is not drawn in the first-run rows (`.compact`). On a phone the reset drops under its bar.
- **Al llegar a un límite (`.rot-row`).** A card in Settings → Providers: a callout saying the
  default is to wait, then rows of title and hint on the left and the control on the right: the action
  (`Segmented`: Continuar con un resumen / Empezar de nuevo / Esperar al reinicio), what a decision may
  choose (`.rot-check`, the action above always on and disabled), the wait cap and the moves cap
  (`.stepper`). On a phone it is its own screen, reached from a cell: radios at 44 px
  (`.rot-radio`), switches and steppers at 44 px.
- **Equivalencias de modelos (`.map-row`).** A card with a source `Segmented` (the provider the models
  come from) and a row per model, a column per target. A cell is a mono select, or one of three
  marks, always with a word: **Sin equivalente** (`b-warn`, with "Sugerir" and the sentence that the
  work waits), **Ya no se ofrece** (`b-warn`) and **Sugerido** (`b-accent`, in a dashed `.map-suggest`
  with Aceptar and Descartar: "No vale hasta que lo aceptes"). A row a waiting job needs is
  `.is-target`, with a `warn` callout above. On a phone each model is a card of cells; a cell opens a
  `Sheet` with radios, "Ninguno" and "Sugerir una equivalencia".
- **Project override.** In the project's Ajustes, a card above Decisiones: the order (`Segmented`
  "Usar el global" / "Orden propio", rows with a handle, up/down on a phone, "Quitar del orden", and
  "Fuera del orden" below with "Añadir") and the on-limit fields (`.ov-field`). A field that
  inherits says "Heredado" and its segment is dimmed (`.seg.is-inherited`); a changed one says
  "global: …" and a ghost "Usar la global", as Decisiones does. On a phone it is its own screen.
- **Copy.** Modes are named in words, never ids: "Continuar con un resumen" (handoff), "Empezar de
  nuevo" (restart), "Esperar al reinicio" (wait).

Reference screens: `DesktopProveedores` and `MobileProveedores` (the limit block),
`DesktopProveedoresRotacion`, `MobileProveedoresRotacion`, `MobileProveedoresEquivalencias`,
`MobileProveedoresEquivalenciasPar`, `DesktopProyectoAjustes` and `MobileProyectoAjustes` (the
override, with `MobileProyectoAjustesProveedores`) and `DSLimites` (every state). They are written by
`reference/tools/providers_rotation.py`, which `providers.py` and `projects.py` import.

### Queued messages over the composer

A message sent while the agent works is a card over the composer (`.chat-queued`) from the moment
the server takes it until the stream says the agent read it ([chat-delivery.md](chat-delivery.md)):
dashed and faded, one row per message (`.chat-queued-item`, an hourglass and two lines of its text,
or "2 archivos"), in the order they will be read. Nothing here is live: the card waits, and the
energy border stays with the working composer under it.

- **Waiting.** The foot says how many wait ("1 mensaje espera al turno en curso") and offers
  **Enviar ahora**, a neutral `.btn-small`, for the oldest message still in the agent's queue. It goes
  away the moment the agent reads it; the server refuses it after that, and nothing shows.
- **Held** for the process that replaces one on its way out: the same row, and the foot says so
  ("1 mensaje espera a que Claude Code vuelva a arrancar"), with no button.
- **Lost** (`.chat-queued-item.is-lost`): the row's icon is the warn triangle in `--warn`, with
  **Devolverlo al cuadro** (an `.icon-btn`), which puts the words and the files back in the box. The
  foot says why in one sentence. When every row is lost the card itself turns warn (`.chat-queued.is-lost`).

### Rotation between providers: the chat at a limit and after a move

Drawn for phase 4 of [multiple agent providers](plans/multi-provider.md) (task `p2` of
`providers4-prototypes`) by `reference/tools/chatrotation.py`, and waiting for the owner's validation
before the web work starts. New classes `.lim-*`, `.mv-*`, `.hand-*` and `.cont-*` in
[agentry-ds.css](design-system/agentry-ds.css); the badge, the buttons, `.seg`, `.dialog`, `.sheet` and
`.bar` are the existing ones.

- **The banner (`.lim`)** sits above the composer of a chat whose provider reached its limit. A warn
  panel: the warn icon, the title ("Claude Code ha llegado a su límite de 5 horas"; the window is
  named in words, "semanal" for the weekly one), the reset in mono ("Se restablece a las 14:05 · en
  2 h 10 min", or "No se sabe cuándo se restablece · última lectura hace 12 min"), the feasible
  actions and, under a hairline, the options that are not offered, each with its reason in the
  person's words (`.lim-out`). The one primary of the zone is the setting's action, the gradient;
  **Continuar en Codex** (handoff), **Empezar de nuevo en Codex** (restart) and **Esperar al
  reinicio** (wait) are neutral, and **Ver el traspaso** is ghost. A person's chat never moves on its
  own (P4-2): nothing here spends on another vendor without a click, and the composer is disabled
  until the person chooses.
- **When nothing can take the work**, wait is the floor and becomes the primary; the banner says why
  ("No hay otro programa…", "Opus 5.5 no tiene equivalente en Codex"), and a missing mapping offers
  **Elegir equivalencia**, which opens the mapping editor on that pair.
- **Waiting.** The same panel titled "Esperando a Claude Code", the reset, and one sentence of what
  happens then. **Mover ahora** (opens the move sheet) and **Dejar de esperar**, both neutral: no
  gradient, since there is no primary, and nothing animates, since a wait is not live work. The
  header badge reads "esperando · 14:05" and the details panel gains a "Límite" row with a warn badge.
- **The move sheet (`.mv-*`)** is a dialog on a desktop and a `Sheet` on a phone. A `.seg` picks
  "Continuar con traspaso" or "Empezar de nuevo"; the candidates are radio rows with the model mapping
  ("Opus 5.5 → gpt-6.1-sol") and a thin neutral usage bar; a candidate that cannot take the work is a
  dashed row with a plain badge and its reason; the facts that carry over (model, permissions,
  folder) each say where they come from; then **Texto que recibirá**, the handoff exactly as it would
  be sent (`.hand-text`, mono, English because it is a prompt, with the pasted block marked and the
  note after it), its size against the 12 KiB cap, and a notice that the session does not move and
  nothing has been sent yet. The one primary is **Continuar en Codex**.
- **The old chat** ends with a divider (`.cont-div`): "Continuado en Codex en «title»", the new
  chat's id, how it began (con un traspaso, de cero) and a link to it. Its header badge reads
  "continuado en Codex", its composer is disabled with the same sentence, and the details panel
  gains a "Continuado" link row.
- **The new chat** keeps one provider (P4-1). Its header carries the `ProviderBadge` and
  "Continuado desde Claude Code" as a link; its first message is the collapsed card (`.hand-card`,
  "Traspaso de Claude Code", or "Petición original" after a restart) with "Ver el chat anterior" and
  Mostrar / Ocultar. Opened, it shows the text the agent received. The chat is live, so it has the
  energy border, and the status bar's limit reading is back to normal.
- **The status bar** of a chat at a limit shows the 5 h bar full, `bad`, with the word "límite".
- **Gradients.** One per screen besides the shell: the setting's action in the banner, or the
  primary of the sheet over the dimmed page. The waiting banner has none. `--live` appears only on
  the new chat, which is working.

Reference screens: `DesktopChatLimite`, `DesktopChatLimiteTraspaso`, `DesktopChatEspera`,
`DesktopChatContinuado`, `DesktopChatContinuadoOrigen`, the five `MobileChat…` twins, and
`DSRotacionChat` (every state of the banner, the card and the divider).

### Integrations: the code hosts' CLIs

Drawn for [code hosts](plans/code-hosts.md) (task `p1` of P0) and waiting for the owner's validation
before P2 builds it. Settings → Integrations is a tab of the Agentry group, after Providers, and it
reuses the provider pieces: `.prov-row.compact`, `.prov-cell`, `.prov-bin`, the badges and the
`Empty`. The only new rule is `.host-known`.

- **A row** is one CLI: the host's `.monogram` (GitHub `GH`, GitLab `GL`; no brand art), its name
  with `PR #12` or `MR !12` in mono (the noun and number follow the host, here and everywhere),
  `gh 2.92.0 · path` in mono, the state and, under it, the reason in plain words.
- **The hosts a CLI knows (`.host-known`)** sit under the reason: a `t-label`, then one line per host
  with its name in mono and the account, or a `b-warn` "Sin sesión" badge when the CLI has none.
- **A state is a status colour with its word**, and the one action of each is neutral:

  | State | Badge | Word | The one action | Also offered |
  |---|---|---|---|---|
  | `ready` | `b-ok` | Listo | none | |
  | `degraded` (version untested) | `b-warn` | Con avisos | Elegir binario | |
  | `signed-out` | `b-warn` | Sin sesión | Cómo iniciar sesión ↗ | |
  | `incompatible` | `b-bad` | Incompatible | Actualizar ↗ | Elegir binario |
  | `not-installed` | plain `.badge` | No instalado | Ver instalación ↗ | Elegir binario |
  | `unknown` | `b-idle` | Sin comprobar | Reintentar | |
  | checking | plain `.badge` with the braille spinner | Comprobando | none | |

  Sign-in, Install and Update open the vendor's page (external-link icon); a remedy is never a
  command to copy. The checking rows show `.skeleton` bars until their turn.
- **Binary override.** "Elegir binario" opens the `.prov-bin` panel under the row on a desktop and a
  `Sheet` on a phone (the field at 16 px, "Comprobar y guardar" as the one primary). Agentry reads the
  version before saving and refuses one below the CLI's minimum.
- **Nothing installed** is an `Empty` with the set's `cli-missing` illustration (`il-warn`), the
  screen's only one and with no rows next to it: the primary opens the install page of `gh`, and
  chips link to `glab` and to the binary override.
- **Gradients.** The list card carries `.grad-border` (it is what the screen is about); the phone's
  Sheet and the empty state each add their one primary. Nothing here is live except the checking
  spinner.

Reference screens: `DesktopIntegraciones` (GitHub ready with `github.com` and an enterprise host,
GitLab degraded with its binary override open), `DesktopIntegracionesEstados` (incompatible, signed
out on a self-managed host, not installed, unknown and checking), `DesktopIntegracionesVacio`,
`MobileIntegraciones`, `MobileIntegracionesEstados`, `MobileIntegracionesSinInstalar`,
`MobileIntegracionesVacio` and `MobileIntegracionesBinario`. They are generated by
`reference/tools/hosts.py`.

### Integrations: the issue trackers

Drawn for [code hosts](plans/code-hosts.md) (task `t-p1` of phase 5 P0) and waiting for the owner's
validation. It is a second card on the same Settings → Integrations page, under the hosts' card, and
it adds no CSS: `.prov-row.compact`, `.prov-cell`, `.prov-bin`, the badges and `.monogram` do all of it.

- **Three rows** (GitHub Issues, GitLab Issues, YouTrack), each with its `.monogram` (`GH`,
  `GL`, `YT`; a hue that is never red, green or cyan, no brand art), its name with an example
  key in mono (`#12`, `PROJ-12`), the CLI it goes through in mono, the state and the reason.
  The card carries `.grad-border` (it is what the screen is about); the hosts' card above it does not.
- **GitHub Issues and GitLab Issues** reuse their host's CLI and readiness, so their state is the
  host's said in the tracker's words, with the same words and badges as the hosts' table. Their one
  action is the host table's: "Elegir binario" is always allowed (ghost when the row is ready), and
  the other states add Cómo iniciar sesión ↗, Actualizar ↗, Ver instalación ↗ or Reintentar. The
  override panel is `.prov-bin`, and its field is empty by default: empty means "the same program as
  the host".
- **A tracker listed before its CLI is recorded** has the plain badge "Aún no disponible" (no
  status colour: there is nothing to colour), an honest sentence, `unknown · not-recorded` in mono
  (on a desktop; the phone drops it) and **no action**. None is listed today.
- **YouTrack** (built 2026-10-07, [trackers.md](trackers.md#youtrack)) has a CLI of its own and the
  access Agentry keeps, so its state is its own: "Sin sesión" (warn) with "Indica a Agentry la
  dirección…" while nothing is saved or the token is refused, "Listo" naming the instance and the
  account once the instance answers. Its remedy is **Conectar**, which opens the access form under
  the row in the same `.prov-bin` panel as the binary override (on a phone, a `Sheet`): the address
  and the permanent token as mono fields, each with its hint, the token a password field that never
  shows the saved value ("Guardado · déjalo vacío para conservarlo"), a line that says whether it is
  kept encrypted or in a 0600 file, "Comprobar y guardar" (the panel's one button, primary only in
  the Sheet), Cancelar and "Olvidar acceso" (`.btn-danger`: it removes something). Once ready the
  same button reads "Cambiar acceso", ghost, before "Elegir binario". No new class.
- **Phone.** The trackers' section as `.prov-cell`s, the override as a `Sheet` with its field at 16 px
  and "Comprobar y guardar" as its one primary; every target is 44 px.
- **Gradients and motion.** One gradient surface per screen (the card's border; the Sheet's primary
  replaces nothing, the card behind it is the other). Nothing is live except the checking spinner.

Reference screens: `DesktopIntegracionesTrackers` (both hosts ready above GitHub Issues and GitLab
Issues ready, YouTrack not available, as drawn before YouTrack was built), `DesktopIntegracionesTrackersEstados` (incompatible
with its override open, signed out, not installed, unknown and checking), `MobileIntegracionesTrackers`,
`MobileIntegracionesTrackersEstados`, `MobileIntegracionesTrackersSinInstalar` and
`MobileIntegracionesTrackersBinario`. They are generated by `reference/tools/trackers.py`.

### Integrations: webhooks

Drawn for [code hosts](plans/code-hosts.md) (task `w-p1` of phase 6 P0) and waiting for the owner's
validation. It is a card on the Settings → Integrations page, under the trackers', one row per project
that has a host. The rows are the providers' (`.prov-row.compact`, `.prov-cell`); three small rules are
new, in `agentry-ds.css`: `.hook-origin` (the strip under the card's head), `.hook-facts` (mono
`label · value` lines under a reason) and `.hook-events` (the list of events in the register dialog).

- **The strip (`.hook-origin`)** says where the hosts deliver: the public address in mono with an
  `ok` "Abierta" badge. With no public address it turns into a warn strip that says why (the tunnel
  only reaches the tailnet), with no button, since there is nothing to open; no row offers Register
  while it is there.
- **A row** is a project: the host's `.monogram`, the project's name with `PR #12` or `MR !12` in
  mono, the repository, the state with its word, a reason in plain words and the facts: the last
  delivery, the host's last response, where a stale hook points, and the pacer's cadence ("lectura ·
  cada 15 min" with a healthy hook, "cada 2 min" without). Every button is neutral.

  | State | Badge | Word | Buttons |
  |---|---|---|---|
  | active | `b-ok` | Activo | Probar · Quitar |
  | failing (the host's last answer was an error) | `b-bad` | Con fallos | Probar · Quitar |
  | stale (it points to an old address) | `b-warn` | Dirección antigua | Apuntar a la dirección actual · Quitar |
  | off | plain `.badge` | Apagado | Registrar… |
  | not available yet (GitLab) | plain `.badge` | Aún no disponible | none |
  | registering (a call to the host is in flight) | plain `.badge` with the braille spinner | Registrando | none |

  An active hook Agentry re-pointed by itself says so in its facts ("apuntado de nuevo · por Agentry ·
  hace 4 min"). With no public address a hook that had one is stale and offers only Quitar, and an off
  row offers nothing.
- **GitLab** has the same row, states and buttons as GitHub: its registration, test, removal and
  re-pointing are recorded (`w0`), so the screen needs nothing of its own. The dialog lists GitLab's four
  events (`merge_requests_events`, `pipeline_events`, `note_events`, `issues_events`) in place of the nine.
- **No redelivery on GitHub.** It needs a scope Agentry does not ask for, so the screen has no button
  for it and never offers a command to copy.
- **The register dialog** lists the address (read-only, with copy), the nine events in mono with what
  each means, and a note on the secret: Agentry generates it, it is shown to nobody, and an existing
  hook with this address is adopted. On a phone it is a `Sheet`, the events as a plain list (no
  checkboxes: they are not chosen), the address wrapped, the copy button 44 px and "Registrar webhook"
  the one primary.
- **A refusal and a removal.** When GitHub refuses the registration (a 404, which is how it answers a
  token without admin rights) the dialog stays open with a `callout-warn` on top saying why, and its
  primary reads "Volver a intentarlo". "Quitar" asks first, in a small dialog (a `Sheet` on a phone)
  whose action is `btn-danger`, the only red in the flow.
- **Gradients and motion.** One gradient surface per screen: the card's border, or the dialog's
  primary while it is open (the card drops its border then). Nothing here is live: a webhook is not a
  running agent.

Reference screens: `DesktopIntegracionesWebhooks` (active, off and GitLab not available),
`DesktopIntegracionesWebhooksRegistrar`, `…SinPermiso`, `…Quitar`, `DesktopIntegracionesWebhooksEstados` (failing, stale and
re-pointed), `DesktopIntegracionesWebhooksSinDireccion`, and on a phone `MobileIntegracionesWebhooks`,
`…Registrar`, `…SinPermiso`, `…Quitar`, `…Estados`, `…Reapuntado` and `…SinDireccion`. They are generated by
`reference/tools/webhooks.py`.

### Host line: where a project's code lives

Drawn for [code hosts](plans/code-hosts.md) (task `p2` of P0) and waiting for the owner's validation
before phase 2 builds it. Nothing here is live: no energy border, no loop, no gradient.

- **One line (`.host-line`), in the project's settings.** The host's `.monogram` (GH, GL; a hue that
  is never red, green or cyan, and no brand logo, which is third-party art), then `hostname/path` in
  mono (`.host-path`, the hostname in the text colour and the path a step lighter), and under it the
  CLI with its version and the account in mono. A host no CLI knows has the `git` icon in a neutral
  square, because there is no host to give a monogram to. The readiness word is a badge to the right.
- **Detected, never chosen.** The host comes from the `origin` remote, so there is no picker and no
  field: the card's header says so, and a hint names what a change request is called there: PR and
  `#12` on GitHub, MR and `!12` on GitLab.
- **The readiness word.** `b-ok` "Listo" when the CLI is signed in on that host; `b-warn` "Sin sesión"
  for `cli-signed-out` and `b-warn` "No disponible" for `unsupported-host`. A word always, never a
  colour alone. The plain reason sits under the row (`.host-line-why`) with **one** action, a link
  or an Agentry action and never a command to copy: "Ir a Integraciones" for an unsupported host,
  "Ver cómo iniciar sesión" (the sign-in docs) for a signed-out CLI. A ready line has no action.
- **Phone.** `.host-line.stacked`: the reason and the action stack under the row, the action is a
  44 px button, and the card is a section called "Repositorio" between General and Modules.

Reference screens: `DesktopProyectoAjustes`, `MobileProyectoAjustes` and the states sheet
`DSIntegraciones` (GitHub ready; self-managed GitLab ready; unsupported host; CLI signed out, each
beside its phone counterpart). Generated by `reference/tools/projects.py` and `hosts.py`.

### The project's tracker

Drawn for [code hosts](plans/code-hosts.md) (task `t-p2` of phase 5 P0) and waiting for the owner's
validation before P2 builds it. Nothing here is live: no energy border, no loop; the page's one
gradient is its Save.

- **A card "Incidencias" in the project's settings**, under the host line, with the choice, the scope,
  the query and the status mapping. It is optional: "Ninguno" is a choice, and the first one a project has.
- **The choice (`.trk-opts`, `.trk-opt`)** is a radio row per tracker: monogram (GH, GL, JI, YT; a hue
  that is never red, green or cyan), name, the readiness badge and one plain line. Only a ready
  tracker can be picked; the others stay in the list with their reason in words, `aria-disabled`, so
  the person sees what exists. GitHub Issues and GitLab Issues reuse the host's CLI and need the
  project's host to be theirs ("No disponible" otherwise). YouTrack works on any project once its
  access is saved, and says so in its own words when it is not. A tracker whose CLI is not recorded would be
  `b-idle` "Sin comprobar" with the reason `not-recorded`, with no action. A saved choice
  that is not ready stays marked and says so with a `.callout-warn` and one action, "Ir a Integraciones".
- **Scope and query** are mono fields. Scope is the repository (the host's own by default), or
  YouTrack's project short name (`PROJ`); the query is the tracker's own search, in GitHub's syntax,
  as free text for GitLab, or in YouTrack's query language.
- **YouTrack's mapping** is a mono text field per column instead of the select, since each project
  names its own States; the placeholders are the names a new YouTrack project has, and the hint says
  every column writes and is read back.
- **The mapping (`.trk-map`)** is one select (`.select` with a chevron, `.trk-sel`) per board column,
  Agentry's side first. GitHub and GitLab have no statuses between open and closed, so In progress and
  In review are disabled "Sin cambios" with the reason beside them, and Done offers one real choice:
  close the issue ("Cerrar como completada" on GitHub, "Cerrar la incidencia" on GitLab, which takes no
  reason). The hint says the change request closes the issue with its closing word, and Agentry only closes
  it afterwards when the base is not the default branch. PR and `#12` on GitHub, MR and `!12` on GitLab.
- **Phone.** The choice is a 64 px cell that opens a Sheet with the same rows; fields are 44 px at 16 px,
  each select is full width with its note under it, and Save is the footer's gradient button.

Reference screens: `DesktopProyectoTracker`, `DesktopProyectoTrackerEstados` (GitLab ready, no tracker,
saved tracker not ready, a tracker saved without a recording), `MobileProyectoTracker`,
`MobileProyectoTrackerElegir`, `MobileProyectoTrackerEstados` and `MobileProyectoTrackerEstados2`.
Generated by `reference/tools/trackers.py` (`t_p2`).

### Checks of a change request

Drawn for [code hosts](plans/code-hosts.md) (task `k-p1` of phase 2 P0) and waiting for the owner's
validation before P2 builds it. The orchestration's checks and the fix states are drawn by `k-p2` and
`k-p3` and join this section.

- **The section** sits under the PR or MR block of the item page: an `h2` "Comprobaciones", the counts
  in mono under it ("2 fallidas · 4 superadas"), and its actions on the right. **Arreglar las
  comprobaciones fallidas** is the zone's one gradient (`.btn-primary`; the page's "Trabajar en ella"
  is the other, so two gradient surfaces); **Repetir las fallidas** and **Cancelar** are neutral and
  appear only when a check failed or is running. A "⋯" holds "Repetir todas" and "Abrir en {host}".
- **Groups** (`.check-group-head`, a button that folds): Fallidas, En marcha, Superadas, Omitidas.
  A failure the pipeline allows (`allow_failure`) is a warning, not a failure: it sits with the
  failures as GitLab lists it, with the `b-warn` word "fallo permitido", and the group count says
  "2 · 1 permitida". A manual job is `b-idle` "manual" (it waits for the person) under Omitidas.
- **A row** (`.check-row`) has two buttons: the main one opens the log, and `.check-more` ("⋯") opens
  the row's menu. Inside the main button: a mark, the name with its stage (GitLab) or workflow
  (GitHub) in mono, the status as a word, and the duration in mono with tabular numbers. Status
  colours: ok "superada", bad "fallida", warn "fallo permitido", idle "manual", neutral "en cola" and
  "omitida". Only a running row is live: the ring spinner, `.rail-live` and `b-live` "en marcha".
- **Menu of a row**: "Repetir esta comprobación" (GitLab manual job: "Ejecutar esta comprobación")
  and "Abrir en {host}". A commit status or another service's check cannot be re-run from Agentry:
  the item is disabled and a line under it says why (`check-not-rerunnable`).
- **The log tail** (`.check-log`): a panel under the list on a desktop and a `Sheet` on a phone. Above
  it, what the host says: GitHub's annotations as a level word (`error` bad, `aviso` warn, `nota`
  neutral) with `path:line` in mono, or GitLab's `failure_reason` and a sentence. Then the tail:
  monospace, dimmed, one line number per line, gaps as "⋯ N líneas omitidas". **No line is coloured
  green or red**; a line an annotation or error marker points to is only brighter, on a neutral fill.
  The foot says the size and that secrets are hidden. The Sheet's one action opens the job on the host.
- **States**: none (`.check-quiet`, "sin CI", no illustration because the page has content), all
  passing, running (Cancelar; nothing to fix), failing with an allowed failure, log unavailable
  (`.pr-not-ready`, the host's line in mono and "Abrir en {host}"), rate-limited (a `callout-warn` with
  the `rate-limited` text and the time, the last list kept with "Lista leída a las 10:42" and every
  action disabled).
- **Phone**: each row is two lines (name, then word, stage and time), 44 px tall, with a 44 px "⋯";
  actions stack as 44 px buttons; the log and the row menu are Sheets.

Reference screens: `DesktopTareaChecks` (GitLab, failing with an allowed failure, the log open and a
row menu), `MobileTareaChecks`, `MobileTareaChecksRegistro` (the log Sheet), `MobileTareaChecksMenu`
(the row's Sheet), and the states sheets `DesktopTareaChecksEstados` and `MobileTareaChecksEstados`
(GitHub: none, passing, running, rate-limited, log unavailable, annotations and another service's
check). Generated by `reference/tools/checks.py`.

### Review block of a change request

Drawn for [code hosts](plans/code-hosts.md) (task `r-p2` of phase 3 P0) and waiting for the owner's
validation before P2 builds it. The threads in the diff (`r-p1`) and Address with an agent (`r-p3`)
join this section. New classes `.rv-*`; badges, `.seg`, `.dialog`, `.sheet` and `.callout` are the
existing ones.

- **The block** sits under the PR or MR panel of the item page: an `h2` "Revisión" with `MR !12 ·
  abierta por @user` in mono, then `.rv-card` with one row per fact (`.rv-row`: a `t-label`, the value,
  the actions on the right) and the person's draft review under it.
- **Rows.** *Decisión*: a badge with its word (`aprobada` ok, `falta aprobación` and `revisión
  necesaria` idle, `cambios pedidos` warn) and the host's count. *Revisores*: one `.rv-person` per
  reviewer (a neutral monogram, never the gradient avatar, the name in mono and a badge: `aprobó`,
  `pidió cambios`, `comentó`, `pendiente`) and "Pedir revisión". *Hilos*: `2 sin resolver` (warn) or
  `todo resuelto` (ok), the resolved count in mono, "Ver en los cambios" and **Atender con un agente**
  (neutral: it opens the dialog of `r-p3`). *Tu aprobación* only on GitLab once approved, with
  "Revocar mi aprobación".
- **The draft review** (`.rv-draft`) is the person's own work in progress: "Tu revisión", a `borrador`
  badge, the counts, and one `.rv-note` per note (path and line in mono, a `sugerencia` badge, its
  text). Its one gradient action is **Enviar revisión**; "Descartar" is a ghost. With the page's
  "Trabajar en ella" that makes two gradient surfaces. With no notes it says how to start one.
- **Host rules.** GitLab offers Comentar and Comentar y aprobar (a `.seg` in the submit dialog); the
  approval is for the head commit shown. GitHub offers Comentar only: approving and asking for
  changes are a link, "Abrir en GitHub" (owner decision 1 of the plan). On one's own PR or MR the
  option is not offered and a `callout` says why, in the words of `own-change-request`; requesting
  reviewers stays.
- **States.** Sending: the button is disabled with the ring and "Enviando", the only live thing.
  `review-partly-posted`: a `callout-warn`, each note marked `guardado` (ok) or `falló` (bad) and the
  choice **Publicar los guardados** (gradient) or **Descartar los guardados**. `pending-review-exists`
  (GitHub): a `callout-warn`, "Abrir en GitHub", and Enviar disabled.
- **The submit dialog** (a `Dialog`, a `Sheet` on a phone): how it is sent, an optional summary, the
  notes that go with it, Cancelar and the gradient Enviar revisión.
- **Phone.** Rows stack (label, value, actions as 44 px buttons), the draft's buttons stack with the
  primary last, and the submit form is a Sheet. No checkboxes.

Reference screens: `DesktopTareaRevision` (GitLab, draft ready), `DesktopTareaRevisionEnvio` (the
dialog), `MobileTareaRevision`, `MobileTareaRevisionEnvio` (the Sheet), and the states sheets
`DesktopTareaRevisionEstados` and `MobileTareaRevisionEstados` (GitHub draft, changes requested, own
PR, a review waiting on GitHub; GitLab sending, partly posted, own MR, approved). Generated by
`reference/tools/reviews.py`.

---

### Merge block of a change request

Drawn for [code hosts](plans/code-hosts.md) (task `m-p1` of phase 4 P0) and waiting for the owner's
validation before P2 builds it. New classes `.mg-*`; the card and its rows are `.rv-card` and
`.rv-row` of the review block, and `.seg`, `.field`, `.checkbox`, badges and `.callout` are the
existing ones. The orchestration's merge (`m-p3`) and the blocked states (`m-p2`) join this section.

- **The block** sits under the review block on the item page and replaces the PR or MR panel: an
  `h2` "Fusión" with `PR #12 · task/agn-26 → main · a81d3f0` in mono (the head the person is
  looking at, the one the head guard sends), a status badge on the right, then one `.rv-card` of
  rows and a footer (`.mg-foot`: a note on the left, the actions on the right).
- **Rows.** *Método*: on GitHub a `.seg` with one button per method the repository allows (Squash,
  Fusión, Rebase) and a line saying what the selected one does; on GitLab the project fixes it, so a
  badge and "Lo fija GitLab para este proyecto", and *Squash* is a checkbox (`.mg-check` around the
  app's `.checkbox`; ticked and dimmed when the project requires it). *Mensaje*: only for a
  squash, a mono subject field and an optional body, prefilled the way the host would. *Rama*: the
  box to delete the remote branch, ticked by the repository's own default, with the note that the
  local branch stays. *Aviso* when a check that is not required failed (`b-warn` with its word).
- **The one action.** **Fusionar** is the gradient only when nothing else leads the page. With a
  draft review, **Enviar revisión** is the zone's gradient and **Fusionar** is a plain button, so the
  page keeps its two gradient surfaces (that and "Trabajar en ella"). When required checks are
  pending, Fusionar is not offered and **Activar fusión automática** takes its place as the action.
- **Armed auto-merge.** `activada` (idle badge), who, when and the method in mono, **Desactivar**
  (plain), what it waits for, and the note that Agentry turns it off before it pushes to the branch
  and says so. No gradient, no motion: it waits on the host, not on an agent.
- **GitLab waiting for the pipeline** is live: the braille spinner stands next to the verb ("Esperando
  a la pipeline", `b-live` badge) and Fusionar stays off until the head's pipeline has finished. While
  the pipeline runs, arming is the action. The ring spinner is only on **Fusionando**, the request in
  flight.
- **Head moved.** A `callout-warn` that nothing was merged, the commit seen and the commit now, **Ver
  los cambios**, Fusionar off and **Volver a leer** as the action.
- **Phone.** Rows stack, the segmented control fills the width, the checkbox row is a 44 px label,
  inputs are 16 px, and the footer stacks with the action first. The checkbox is a form field, never
  a list selection.

Reference screens: `DesktopTareaFusion` and `MobileTareaFusion` (GitHub, squash, no draft: Fusionar
leads), `DesktopTareaFusionBorrador` and `MobileTareaFusionBorrador` (with a draft: Enviar revisión
leads), and the states sheets `DesktopTareaFusionEstados` and `MobileTareaFusionEstados` (GitHub with
a warning, auto-merge offered and armed; GitLab waiting for the pipeline, pipeline running, armed,
squash required; head moved, merging, merged). Generated by `reference/tools/merge.py`.

---

### Review threads in the diff

Drawn for [code hosts](plans/code-hosts.md) (task `r-p1` of phase 3 P0) by `reference/tools/reviews.py`
and waiting for the owner's validation before P2 builds it. The review block of the item page and
the Address with an agent dialog are drawn by `r-p2` and `r-p3` and join this section. Classes
`.rt-*` and `.dv-note-pill`, `.dv-add`, `.dv-review` in §18 of `agentry-ds.css`; nothing is added to
the comparator's own rows: **a thread is a card under its line**, never a new kind of diff.

- **An open thread (`.rt`)** sits under the new-side line it is about, indented to the code. Head:
  the `b-idle` word **sin resolver** (it waits for the person), `path:line` in mono and the comment
  count. Each comment is a 24 px monogram (a hue that is never a status hue; the agent is the
  `agent-mark`), the author, the time in mono and the body in sans, with `code` as small chips.
  Foot: a "Responder…" field and **Resolver** (a phone has two 44 px buttons, **Responder** and
  **Resolver**, and Responder opens the same Sheet as a new note). Replying and resolving act at
  once; they are not part of the draft review.
- **A suggestion** is drawn inside its comment (`.rt-sugg`) as the two lines it is: the line it
  replaces with the removed rail and `--diff-del-bg`, the proposed one with the added rail and
  `--diff-add-bg`, in the muted `--sx-*` syntax. Agentry does not apply suggestions: they feed the
  agent through Address with an agent.
- **A line with a thread** has its number at full strength and, in Reading, a pill at the right
  (`.dv-note-pill`, comment icon and count; violet while a thread is open, neutral otherwise). The
  gutter's "+" (`.dv-add`, accent on `--accent-soft`) appears on the line under the pointer and
  opens the composer. The pill is not drawn on a phone: the card under the line says it.
- **Folds.** A resolved thread folds by default into one row (`.rt-fold`: "Hilo resuelto · marta ·
  2 comentarios" and **Mostrar**); opened, it keeps the `b-ok` word **resuelto** with a check and
  its foot offers **Reabrir**. An outdated thread (its commit is not the head) has no line to
  stand under: it folds at the top of its file ("1 hilo desactualizado"), and opened it shows the
  neutral word **desactualizado**, the comment's own hunk with its original line (`.rt-hunk`, the
  commented line carries the added rail only) and the way it came to be outdated. It can still be
  answered and resolved.
- **The note composer** is inline on a desktop (`.rt.compose`, the `--accent` ring of a focused
  field, never the energy border) and a `Sheet` on a phone with the quoted line above the field.
  **Sugerir un cambio** is a toggle (`aria-pressed`) that adds a mono field with the line to edit.
  Its one action, **Añadir a la revisión**, is the screen's one gradient (`.btn-primary`); Cancelar
  is a ghost. The hint says the note is only visible to the person until the review is sent.
- **A note in the draft** (`.rt.draft`) is the same card with a dashed border, the `b-idle` word
  **borrador**, "solo la ves tú", and **Editar** and **Eliminar**. A posted thread is solid.
- **Reading keeps context readable** in these screens (`.dv-review`: context at 85 % instead of
  58 %, numbers at full strength), because a thread is read against the code around it, and the
  dimmer Reading fails 4.5:1 for keywords and numbers. `check.mjs` passes both themes.
- **The file map** shows a comment icon and the number of threads on a file; the file header has a
  chip "3 hilos · 1 sin resolver". The review's header carries "Tu borrador · 1 nota" and **Abrir
  PR #12 en GitHub** (MR !12 and GitLab by host). No threads are live: no spinner, no `--live`.

Reference screens: `DesktopRevisionHilos` (GitHub: an open thread with a suggestion and a reply,
the resolved and outdated folds, a draft note), `DesktopRevisionHilosNota` (the composer with the
suggestion on), `DesktopRevisionHilosPlegados` (an outdated and a resolved thread opened), and the
phone's `MobileRevisionHilos` (GitLab), `MobileRevisionHilosNota` (the Sheet) and
`MobileRevisionHilosPlegados`.

---

### Orchestration checks: the change request's CI and the fix that waits

Drawn for [code hosts](plans/code-hosts.md), phase 2 (task `k-p2` of P0), by `reference/tools/checks.py`:
`DesktopOrquestacionChecks`, `…ChecksSubir` and the phone pair. New classes `.ochk-*`; the MR row is
`.pr-row`, the badges, `.sheet` and `.grad-border` are the existing ones.

- **A check row (`.ochk-row`)** is one button that opens the log, plus a "⋯" menu: state badge with
  its word (`fallido` bad, `fallo permitido` warn, `en curso` live, `superado` ok, `omitido`
  neutral), the name in mono, the stage in mono and the duration in mono and tabular. Only the
  running row carries `--live` and the ring spinner. Rows group as Fallan / Fallo permitido / En curso;
  Superados and Omitidos fold. On a phone a row is two lines (name and time, then badge and stage),
  44 px high.
- **The log tail (`.ochk-log`)** is a panel beside the list on a desktop and a `Sheet` on a phone.
  Above it, the reason the job failed (`.ochk-why`: GitLab's `failure_reason` and exit code; GitHub
  shows its annotations there). The tail is mono, dimmed (`--fg-3`), never syntax-coloured: the
  error marker lines only take `--fg` on a `--bg-3` stripe with a `--line-3` rail. A note says how
  much of the log is shown and that secrets are hidden.
- **The zone's one gradient action** is **Arreglar los checks** (`btn-primary`). Re-run failed and
  Cancel stay neutral. A line under the actions says the fix is committed on the integration branch
  and that nothing is pushed until **Subir el arreglo**.
- **Push the fix (`.ochk-fix`)**: an orchestration's fix always waits for the person, so the
  screen's one gradient action becomes **Subir el arreglo** and Arreglar disappears. The panel
  takes `.grad-border` (it is what the screen is about) with an idle `te espera` badge; it lists the
  commit, the files, and each check with its cause as a word (`corregido` ok, `sin tocar` neutral)
  and a sentence of why. The checks list below stays on the head the failures were seen on
  (`commit a81d3f0`) until the push.

### Merge blockers: why Merge is not offered

Drawn for [code hosts](plans/code-hosts.md), phase 4 (task `m-p2` of P0), by `reference/tools/merge.py`:
`DSFusion`. New classes `.mb-*`; the badge, the buttons and the ring spinner are the existing ones.

- **One notice (`.mb-note`)** per blocker: the tone's icon, a badge with its word, the Agentry code in
  mono, the sentence in `--fg`, the host's own field and value in mono (`.mb-detail`) and the remedy
  (`.mb-acts`). Tones: `bad` for `conflicts` and `checks-failing`; `warn` for a rule or a missing
  piece; `idle` (`borrador`) for what waits for the person; `live` (`calculando`, `en marcha`) only
  while the host is working, the one tone that moves; neutral for `not-open`; `ok` for a merge that
  can go ahead.
- **The remedy** is a neutral button that acts in Agentry, or an external link to the host. Never the
  gradient, never a command, and never a way round a rule. A blocker with no remedy (`not-yet`)
  shows none.
- **The first blocker that applies is the notice**; the others are `.mb-others`, one line each with
  their code. **Merge** stays on screen, disabled, and takes the gradient only when nothing blocks.
- **Corrections from the recordings.** `calculando` is drawn only for a real `CHECKING`; GitLab's
  `unchecked` is a quiet note with Merge enabled, and an `unchecked` with a `FAILED` check is the
  ordinary blocker it maps to. `ci_must_pass` with no pipeline keeps Merge disabled. `head-moved`
  disables Merge until **Actualizar** shows the new head. A conflict in a GitLab `ff` project reads
  `behind`, with **Rebasar en GitLab**.

### Freshness of a change request: the line in the PR or MR panel

Drawn for [code hosts](plans/code-hosts.md), phase 6 (task `w-p2` of P0), by
`reference/tools/webhooks_fresh.py`: `DSWebhooks`, `DesktopTareaFrescura`, `MobileTareaFrescura`. One new
class family, `.fresh` (`.fresh-state`, `.fresh-text`, `.fresh-why`, `.fresh-t`); the badges, the braille
spinner and `.btn-ghost` are the existing ones.

- **It is the last row of the item's panel** (`.item-pr-wait`), under "Cuando se fusione…", on a
  desktop and on a phone, and appears only while the PR or MR is open. A state badge with its word (or
  the spinner), then one sentence, then **Actualizar** (an icon button of 44 px on a phone).
- **In words, with numbers in mono and tabular.** `Comprobada hace 40 s · la próxima, en 2 min`; with a
  healthy webhook `Al instante` (ok) and `Por webhook · último aviso hace 12 s`, and the safety-net read
  as the second line. The text is renewed; nothing counts down with an animation.
- **`Al instante` needs a healthy webhook** (a delivery or a successful ping in the last 30 min), and is
  ok, never cyan: no agent is working. A registered hook that falls silent says `Webhook sin avisos`
  (warn) and links to Integrations → Webhooks while the line reads at the normal pace.
- **Warn** is also `Sin respuesta` (the read failed: from when the data is, and when the retry is) and
  `En pausa` (the host limits reads: until when). **The braille spinner** is only the read in flight,
  next to the verb, with Actualizar disabled. A plain read has no badge.
- **Actualizar** sets the next read to now, also during a pause: it is the person's action.
- **GitLab** shows the same line from the pacer alone: its webhook is not available yet, so it never
  says `Al instante`, and Integrations says "aún no disponible" instead of offering an action.

### Address with an agent: the thread list, the triage marks and the "Atendido en" follow-up

Drawn for [code hosts](plans/code-hosts.md), phase 3 (task `r-p3` of P0), by `reference/tools/reviews.py`:
`DSRevision`. New classes `.addr-*` (under "Address with an agent" in `agentry-ds.css`); the dialog is
`.dialog` (a `.sheet` on a phone), the marks are the existing `.badge` and `.decided-face`, and the follow-up
is `.fix-panel.wait` with the phase 2 fix path (`fix_state`, the same push rule).

- **The thread list (`.addr-list`, `.addr-thread`)** lists the unresolved threads of the item's PR or MR.
  A row: the path and new-side line in mono, the triage mark, `desactualizado` (neutral, with the commit the
  comment was made on) when the thread is outdated, the first comment as a quote (`.addr-quote`, two lines),
  and the author and comment count. Resolved threads are not listed; one line says how many were left out.
  A desktop row is a `<label>` with the app's `.checkbox`; a phone has no checkboxes, so the whole row is a
  pressed button (`aria-pressed`, the selected-row look, 44 px) that says `Elegido` or `Elegir` in words.
- **The triage marks** are `review.triage`'s answer per thread: `agente` (`b-accent`, a concrete change the
  Developer can make), `persona` (`b-idle`: a question, a design decision or a disagreement, the ones that
  wait for a person) and `sin acción` (neutral). A suggestion is not a status, so only the agent's mark takes
  the accent. A mark **only preselects**: the `agente` threads arrive chosen, a click changes any of them and
  nothing is sent or done because of a mark. The list head says `sugerido · review.triage` (`.decided-face`)
  and offers "Elegir solo los del agente". With the point off the head says `sin triaje`, nothing is chosen, a
  `callout-warn` says why and the primary reads "Elige un hilo" (disabled) until one is.
- **Untrusted comments.** A `.callout` in the dialog says the comments were written by other people and the
  Developer weighs them as requests, not orders, and reports which it addressed and which not, with why. A
  second one repeats the push rule: a person's click pushes after QA, moving the card first withdraws that,
  and nothing is replied to or resolved on the host.
- **One primary per zone.** "Atender N comentarios" is the dialog's gradient; after the push it is "Responder y
  resolver N hilos" in the follow-up. They are never on screen together.
- **While it runs** the item page's panel is the live `.fix-panel` (braille, time, rail in cyan) over the
  chosen threads without checkboxes; waiting for the person afterwards is idle (`te esperan`), never moving.
- **The follow-up (`.addr-done`)** lists, per thread, `atendido` (ok) or `sin atender` (neutral) with the
  Developer's sentence of why, and the state it reached on the host: `respondido`, `resuelto` (ok, each with its
  word). A thread still open offers "Responder «Atendido en a8f3c21»" (the text that will be posted is shown
  under the list) and "Resolver"; one the Developer left alone offers a link to the thread on the host. A
  resolved thread folds its quote. Agentry never replies or resolves by itself.
- **Hosts.** The noun and number follow the host (`PR #12`, `MR !12`); the thread semantics are the same.

### Rotation between providers: the chain chip, a wait, the limit in the status bar and the retirement notice

Drawn for phase 4 of [multiple agent providers](plans/multi-provider.md) (task `p3` of
`providers4-prototypes`), by `reference/tools/rotation_work.py` (with `rotation_flow.py` and
`rotation_decisions.py`), and waiting for the owner's validation before W starts. New classes `.chain*`,
`.wait-line`, `.statusbar .lim` and `.retire*`; the rest is existing (`.prov-mark`, `.decided`, `.callout`,
`.badge`). Nothing here is live except what already ran: waiting does not move.

- **The chain (`.chain`, `.chain-chip`).** One chip per chat of a task or run, oldest first, each the provider's
  mark and name, with the arrow between. The last is the chat that runs now (`.now`, `--fg`); the rest are history.
  On a desktop a chip opens its chat; on a phone chips are read and the card's button opens the newest. `.chain-how`
  says how it moved, in mono: "traspaso", "de nuevo". A chip shows only when the work moved or waits.
- **A wait (`.wait-line`).** A warn-tinted strip with the clock where a running task shows its command: "Esperando a
  Claude Code · vuelve a las 14:05", and why in one line (a limit, no reset time with its cap, no equivalent model,
  the other provider also out, the moves cap). No spinner, no rail, no energy border; the badge says "esperando". The
  task keeps its parallel slot. "Mover ahora" opens the handoff sheet and is disabled, with its reason, when no
  provider can take the work; "Dejar de esperar" is quiet.
- **Status bar (`.lim`).** One dot per provider as in phase 1, with its limit: a neutral bar below 60 %, warn with
  "límite" and the percentage from 60 %, bad with "límite agotado" and when it returns. A provider that reports no
  limit has no bar: an unknown reading is never drawn as good. The title gives the window, the reset and the reading's
  age. claude-swap's account is gone from the bar.
- **Retirement notice (`.retire`).** Neutral, with the idle mark and "Entendido": which account is in force, what
  changed, which projects lost a rotation policy (links to their provider order) and what was left alone. Its one
  destructive action, removing Agentry's own copy, is `btn-danger` and offered only when that copy exists. It sits in
  Home's provider card and at the top of Settings → Providers; no gradient.
- **Decisions.** A Providers group with `provider.on-limit` and `provider.pick` (act, per project) and
  `provider.model-map` (suggest, global): 25 points in 10 groups. Each note says what bounds it.
- **Gradients.** The orchestration page's Coste card loses `.grad-border` so the energy border and the shell's
  primary stay within the budget of two.

Reference screens: `DesktopOrquestacion` and `MobileOrquestacion` (a moved task and two waiting ones),
`DesktopChatFlujoMovido`, `MobileChatFlujoMovido`, `StatusBar`, `Main` and `MobileInicio` (the notice),
`DesktopProveedoresRetirada`, `MobileProveedoresRetirada`, `DesktopAjustesDecisionesProveedores`,
`MobileAjustesDecisionesProveedores` and `DSRotacion` (rules, every wait and cause, the status bar states).

### Merging an orchestration, and the board card's auto-merge line

Drawn for [code hosts](plans/code-hosts.md), phase 4 (task `m-p3` of P0), by `reference/tools/merge.py`:
`DesktopOrquestacionFusion`, `MobileOrquestacionFusion`, `DesktopTableroFusion` and `MobileTableroFusion`.
New classes `.omrg-*` and `.pr-auto`; everything else is an existing control (`.seg`, `.checkbox`, `.field`,
`.pr-row`, `.btn-primary`).

- **The merge block (`Fusionar`)** sits in the orchestration's "Su merge request" card, under the MR row,
  once the MR is open: the method as a `.seg` radio group (Squash, Merge commit, Rebase, only those the
  repository allows, the first allowed preselected), the branch box as a `.checkbox` with the integration
  branch's name in mono, and the squash message as two `.field`s (subject, body). A line says which commit
  is merged (`a81d3f0`, the head the person sees) and that a moved head merges nothing.
- **The one gradient action** is **Fusionar MR !14** (`btn-primary`; on a phone, the foot). Merging is the
  person's click on this page, never a run's. The state line above the form (`CI superada · sin
  conflictos con main · …`) is mono and neutral; the MR row's badges keep their words.
- **After the merge.** What is specific to an orchestration is said under the form: the orchestration is
  marked merged and its worktrees are removed; the local branch stays.
- **The board card's auto-merge line (`.pr-auto`)** is a second line of the PR or MR strip, under the
  number, the verb, the CI badge and the link: a neutral `fusión automática` badge with the clock icon, and
  "se fusiona sola al pasar la CI · squash". It is a waiting state, not a live one: no `--live`, no spinner,
  no motion. On a phone the strip drops the 22 px host link (the item page has it).

### Tracker issues: the import, the issue chip and the card's key

Drawn for [code hosts](plans/code-hosts.md), phase 5 (task `t-p3` of P0), by `reference/tools/trackers_import.py`:
`DesktopImportarIssues`, `MobileImportarIssues`, `MobileImportarIssuesLista`, `DesktopTareaIssues`,
`MobileTareaIssues`, the states sheets `DesktopTareaIssuesEstados` and `MobileTareaIssuesEstados`, and
`DesktopTableroIssues` / `MobileTableroIssues`. Drawn with GitHub Issues and GitLab Issues; YouTrack uses the same
screens with its own keys (`PROJ-12`) and its State as the issue's state. New classes `.iss-*` (under "Tracker issues" in `agentry-ds.css`); the list is
the thread list of "Address with an agent" and the item panel is `.fix-panel`.

- **Import** is a `.dialog` opened from "Importar issues" on the board (a `.sheet` on a phone, whose board header
  has an icon button). The query field is prefilled with the scope and open issues (`is:open` on GitHub; GitLab
  searches text); a hint says what the tracker's query accepts. Each result: the bug icon when it will import as a
  bug, `#41` in mono, the `issue.triage` mark, the title, author, age and labels.
- **The marks** are `lista` (`b-accent`), `por refinar` (`b-idle`) and `no es para agentes` (neutral): a suggestion,
  not a status, so nothing is chosen because of one. The head says `sugerido · issue.triage` and offers "Elegir las
  listas". An issue already imported shows `ya importada` and its item's key, has no checkbox and cannot be chosen.
- **Selection on a phone is a mode**: before it, rows are plain text and the foot offers "Seleccionar issues";
  in it, each row is a pressed button that says `Elegido` or `Elegir` (44 px), never a checkbox.
- **One gradient action**: "Importar N issues" (disabled as "Elige un issue" with none chosen). Issue text is
  untrusted: a `.callout` says it is imported as a quoted source and read as data.
- **The issue chip (`.iss-chip`)** under the item's title: the key, the sync state as a dot and a word
  (`pendiente` idle, `sincronizada` ok, `falló` bad, `sincronizando` with the braille spinner, `cerrada fuera` with
  no colour) and a link to the tracker (44 px on a phone). The panel under it lists each issue with its state, why,
  and, when it failed, the reason code in mono, **Sincronizar de nuevo** (neutral) and a documentation link.
- **The card's key (`.iss-fact`)** is `#31` with the issue icon in the facts line, `+1` for more; a done card whose
  sync failed carries a `wi-strip fail` with `Falló` and the reason.

### The graph's shape, in the launch form and the graph editor

Built for [CW-16](plans/graph-shape.md) and [the orchestrations guide](orchestrations.md). Under the
task list of the launch form, the relaunch panel and the graph editor, one quiet line says how many
stages the graph runs in and names its longest chain; nothing on it is live or coloured.

- **`.graph-shape`** holds it, a `stack-tight`. **`.graph-shape-line`** is a `form-hint` with the
  count in mono and tabular figures ("4 stages in series"), then ` · ` and **`.graph-shape-chain`**:
  the task ids of the longest chain in mono, joined by `→`, as a `role="group"` named "Longest chain
  of dependencies" so a screen reader reads it as one thing. Each id is a **`.graph-shape-id`** that wraps anywhere rather
  than widen the form on a phone.
- **Over four stages** a `.alert.alert-info` **`.graph-shape-note`** says the longest chain sets how
  long the orchestration takes, and how to shorten it (fold a types-only task into the first
  implementation task; make docs depend on the implementation, not on the review). It is advice, not a status: info, no
  action, and it does not animate in (`animation: none`).
- A graph of one stage says "1 stage, all in parallel" and names no chain.

### The Agentry assistant: the entry, the greeting and the host prompt of a write

Drawn for the umbrella CW-30 ([plans/agentry-assistant.md](plans/agentry-assistant.md): CW-18, the entry and its
confined chat, then CW-17, the write tools), by `reference/tools/assistant_entry.py`, in `DesktopAsistenteAgentry`,
`DesktopAsistenteAgentryChat`, `MobileAsistenteAgentry`, `MobileAsistenteAgentryChat` and `MobileAsistenteAgentryMas`. The
decisions the drawing takes (criterion 1 of CW-18, candidate 1 of the spec):

- **Where it lives.** A sidebar item "Asistente" with the sparkle, in the first group under Inicio (route
  `/assistant`), and on a phone the same item as the first row of Más. The tab bar keeps its four tabs and Más is the one
  lit while the screen is open. The palette's "Asistente de Agentry" action is always present and is not drawn. The sparkle is the
  plain nav icon on desktop and the neutral `.ai-mark` tile (28 px inside a `.cell`) on the phone: never the gradient, so the entry
  costs no gradient slot on any screen. `.nav-item.on` keeps the shell's own rail.
- **The entry screen is content, not an `Empty`.** The mark, the greeting (34 px on desktop, 24 on a phone), one line saying
  what the assistant does and that it asks before writing, the live figures in mono (the counts of what is running in
  `--live`, today's spend neutral: they are live things, and the line is optional if the build stays small), "Para
  empezar" with the starters, and the composer. The page has one gradient surface, the send button. The composer is **not**
  energy-bordered: nothing runs yet. Once the first turn runs it is the chat's working composer and takes the screen's one
  energy border, as on any chat.
- **Starters** are buttons that fill the composer, never send. Each shows what it is about and the sentence it fills in
  guillemets. The ones that write carry `.badge.b-warn` "pide permiso" (warn means needs authorisation, and says it in
  words). On a phone three starters show, one column, 44 px at least.
- **The context** is a chip in the composer's row, "Con <project> como contexto" with an × to clear it (a 44 px target on a phone,
  where the label ends in an ellipsis to leave room for the × and the model chip). With no project the chip is absent.
- **The chat** of an assistant (`DesktopAsistenteAgentryChat`) starts with the greeting as its first message, dimmed
  (`.as-greeting`), then the person's first prompt, which is the chat's title, never the greeting. Tool lines say what was read in
  the person's words ("Tablero de AGN", "AGN-12"), never an identifier of the wire. While a write waits for permission nothing
  moves: the badge says "necesita tu permiso" in `--warn`, the braille spinner and the energy border are off, and the one
  gradient surface is **Permitir**; the send button is disabled.
- **The host prompt of a write** (`.permission`) is the app's existing `.permission`, `-head`, `-input` and `-actions`, drawn here
  for the first time. A write tool is titled in the person's words ("Crear tarea en AGN", not the tool's name), with the plug icon
  that `icons.tsx` gives to `mcp__` tools; under it the input in mono (`.permission-input`, keys dimmed with `.k`), one line saying
  what happens on each answer (`.permission-note`), **Permitir** (primary) and **Denegar** (`btn-danger`) and the reason field.
  There is no "allow and always": a write has no suggestions to offer. On a phone the buttons are 44 px, side by side, and the
  reason field takes the next row with the short placeholder "¿Por qué no? (opcional)" because the app's sentence does not fit a
  phone's input; the build can keep the app's string if it truncates acceptably.

| Reference class | App class or component | Rule |
|---|---|---|
| `.as-hello`, `.as-hello-sub`, `.as-figures` (`.live`) | new, on `/assistant` | the greeting block. `.as-hello` makes the `.ai-mark` 40 px; the figures are mono, tabular, and only the live counts are cyan |
| `.as-starters`, `.as-starter` (`-body`, `-title`, `-ask`) | new, the entry's suggestion chips | a two-column grid on desktop and one column on a phone; the button fills the composer. A `.badge.b-warn` on the right when it writes |
| `.as-context` (`.x`) | `.chip` with a clear button | "Con <project> como contexto"; × is a 44 px target on a phone |
| `.as-greeting` | the first message of an assistant chat | the sparkle on `.ai-mark.sm` and one dimmed line; the same at the top of a reopened assistant chat |
| `.cell > .ai-mark` | the Más row | the sparkle tile at the size of the other rows' `.proj` |
| `.permission` (`-head`, `-input` with `.k`, `-note`, `-actions`, `-reason`) | `.permission`, `.permission-head`, `.permission-input`, `.permission-actions`, `.permission-reason` of `PermissionPrompts` | warn-tinted card, never gradient; the title is the readable name of the tool, the mono block is the input, Permitir is the screen's primary |

### The editable Home: edit mode, the add-widget picker and the Documents and Flow widgets

Drawn for CW-34 (a Home kept per project, with Documents and Flow widgets) by `reference/tools/home_edit.py`, in
`DesktopInicioEditar`, `DesktopInicioAnadirWidget`, `DesktopInicioWidgetsNuevos` and `MobileInicioEditar`. `Main` and
`MobileInicio` stay as the All projects Home. The decisions the drawing takes:

- **Entry and exit.** The page head gains a quiet **Editar inicio** button (pencil, no gradient) beside "Nueva
  orquestación"; the phone gets it in the "⋯" Sheet of the head. In edit mode the head says "Editando el inicio de
  <project>" and swaps its buttons for **Añadir widget**, **Restablecer** and **Listo**. Listo is the zone's primary action
  but wears `.edit-done` (accent on `--accent-soft`), not the gradient: the logo and the top bar's New chat already are the
  screen's two gradient surfaces. The hero loses its `.grad-text` while editing for the same reason.
- **The head in the app** (`.home-editbar`: eyebrow, title, the sentence, then the three buttons). On All projects
  it takes the hero's place, as drawn: the page's `h1` in `.text-display` with the hero's halo. A project's Home keeps
  the project's own header and tabs above it (they are how the page is reached and the mode belongs to Resumen), so
  there the same head heads the tab: an `h2` at 24 px. Restablecer is a quiet button with its arrow, disabled while the
  Home is still the default (there is nothing to reset). On a phone the head is the project's name as eyebrow,
  "Editar inicio" and Listo as a tall button; the assistant row and the tab cells step aside, and the FAB goes.
- **Each change saves at once.** There is no Save and no Cancel; Listo only leaves the mode. **Restablecer** returns this
  project's Home to the default layout and answers with a toast, "Inicio restablecido", with **Deshacer**; it never asks
  first, so reset costs one tap and is reversible. The stored layout is the project's own: another project is untouched.
- **A widget in edit mode** (`.widget-edit`) keeps its content (same text, same contrast) and changes its frame: a dashed
  `--line-3` border, and its head becomes `.widget-editbar` with the **handle** (`.widget-handle`, a grip, 32 px on
  desktop), the name, the **sizes** (`.widget-sizes`, a `.seg` of S, M, L and Todo, only the sizes the type allows, so
  Cifras and Límites show one) and **Quitar** (an ×, `--bad` on hover; no confirmation, the picker brings it back). The
  live energy border and rail of En marcha are off while editing: editing is not a live thing, and the spinners that are
  live keep spinning. The handle is a button: a pointer drags it, and the keyboard lifts it with Space, moves it with the
  arrow keys, drops it with Space and cancels with Escape, announcing each step in an `aria-live` region.
- **Carrying a widget.** The lifted one is `.widget-lifted` (accent border, `--shadow-pop`) and the place it will land is
  `.widget-slot` (dashed accent on `--accent-soft`, the words "Suéltalo aquí"). The accent marks a position, never the brand.
  Nothing animates: the slot appears where the pointer is and the neighbours do not glide.
- **Añadir widget** appears twice on desktop: in the head, and as a dashed `.widget-add` tile after the last widget. Both open
  the same picker, a dialog (`.dialog`, 640 px) on desktop and a Sheet on a phone. The picker lists only the types that
  fit the scope (a project's Home never offers Proyectos) and are **not on the page yet**: each type appears once, so the
  rest are shown as check chips under "Ya están en tu inicio" on desktop. A row is the type's icon in `.pick-ico`, its name,
  the `nuevo` badge on Documentos and Flujo, one sentence, the sizes it allows in mono, and **Añadir**. A widget is added
  at the end of its area, at its default size, and the picker stays open so several can be added; Cancelar closes it.
  On a phone a row is the icon, the name and a 44 px Añadir; the description and sizes stay on desktop.
- **Phone edit mode** (`MobileInicioEditar`) is a list, not the page: one `.move-row` per widget with **Subir**, **Bajar**
  and **Quitar** as 44 × 44 px buttons (the first Subir and the last Bajar are disabled, in words through their
  `aria-label`), so no control needs a drag. There is no size control because a phone stacks every widget; the line under
  the title says so. Listo sits in the head as a `btn-lg`; **Añadir widget** and **Restablecer** close the list. The tab
  bar stays; the FAB goes.
- **The Documents widget** (`w_docs`: `.doc-row`) is a card headed with the docs icon, "Documentos", the document count in
  a `.count-pill` and "Ver todos". Each row is the file name in mono, its folder and its author in mono below
  ("docs/specs · Arquitecto"), the kind as a plain `.badge` (SPEC, ADR, DOC) and the age; it opens the document. The foot
  line (`.widget-foot`) says how many documents there are and how many are tied to tasks. Sizes M, L and Todo; an empty
  project uses the card's compact empty line, never an illustration (design system §4: a widget beside content).
- **The Flow widget** (`w_flow`: `.flow-row`) is headed with the flow icon, "Flujo", `.badge.b-ok` "activado" and "Ver el
  flujo"; with the flow off it says "desactivado" in `.badge` and keeps its rows. It lists what the flow is doing, in this
  order: runs in progress (`.rail-live` and the ring spinner, the key and title, the role and verb in mono, the clock), cards
  that wait for the person (`.dot-idle`, "Hecho · espera tu aprobación", `.badge.b-idle` "te espera") and cards QA sent back
  (`.dot-warn`, "rebote 1 de 3", `.badge.b-warn` "devuelta"). The foot line gives the concurrency and the queue. Status
  colours keep their meaning and always come with a word.
- **Gradient count** (the status bar's thin usage bars are the shell and are not counted): Editar 2 (logo, New chat), Añadir
  widget 2, Widgets nuevos 2, phone 0. None of the new surfaces is a gradient and the energy border stays on the one
  working widget of the screen that is not editing.

| Reference class | App class or component | Rule |
|---|---|---|
| `.home-grid` (`.w-s`, `.w-m`, `.w-l`, `.w-full`) | the dashboard's 12-column grid | s = 4, m = 6, l = 8 and full = 12 columns, as `SIZE_SPANS`; a phone stacks them |
| `.widget`, `.widget-body`, `.widget-foot` | `WidgetCard` | the card of every widget: head, rows, an optional foot line in mono |
| `.widget-edit`, `.widget-editbar` | new, edit mode of `WidgetCard` | the dashed frame and the head that holds the handle, sizes and Quitar |
| `.widget-edit-note` | new | in edit mode, the line a widget shows when its project has the modules it reads off (Documents, Team, Board) instead of an empty frame |
| `.widget-handle`, `.widget-sizes`, `.widget-remove` | `IconButton`, `Segmented`, `IconButton` | the sizes use the app's `Segmented`; every control has an `aria-label` that names the widget |
| `.widget-lifted`, `.widget-slot` | new | the widget in hand and its landing place; no motion |
| `.widget-add` | new, the end of the grid | a dashed tile that opens the picker |
| `.edit-done` | `Button` with a variant | Listo: accent on `--accent-soft`, not the gradient |
| `.pick-list`, `.pick-row` (`.pick-ico`, `.pick-text`, `.pick-name`, `.pick-desc`, `.pick-sizes`, `.pick-have`) | the picker's body in `Dialog` and `Sheet` | one row per type not yet on the page; rows are 64 px at least on a phone |
| `.move-row` | new, the phone's edit list | icon, name and three 44 px buttons |
| the strip of Cifras in edit mode | `.kpi-strip` inside `.widget-edit-body` | one row of three plain cells (no tile borders, no gradient hairline); the top row aligns to the start so Límites keeps its own height |
| `.doc-row`, `.flow-row` in a widget | scoped as `.widget .doc-row`, `.widget .flow-row` | the Documents and Team pages use the same names for their own rows; the widget's rule is scoped so theirs never reaches the card |
| `.doc-row`, `.doc-name` | the Documents widget's rows | mono name, folder and author, kind badge, age |
| `.flow-row` (`.flow-what`) | the Flow widget's rows | live, waiting and returned, in that order |

### Setup: the assistant, the sign-in panel and the secrets line

Drawn for [the in-app setup](plans/in-app-setup.md) (step 4, "Design") by `reference/tools/setup.py`, before the web
builds it (step 5). It reads the API of [setup.md](setup.md): `GET /setup`, the sign-in sessions (`LoginSession`,
`LoginState`, `LoginErrorCode`), the methods per tool (`SetupToolMethods`) and `SecretStorageStatus`. The styles are under
"Setup" in [agentry-ds.css](design-system/agentry-ds.css).

**Screens.**

| Screen | What it shows |
|---|---|
| `DesktopConfiguracionAcceso`, `MobileConfiguracionAcceso` | Step 1: the auth mode (Ninguno / Token) and the token shown once, with Copiar; on a desktop the secrets line too |
| `DesktopConfiguracionAgentes`, `MobileConfiguracionAgentesCodigo` | Step 2: Codex's device-code panel waiting, with the Código / Clave choice and the ChatGPT note |
| `DesktopConfiguracionAgentesClave`, `MobileConfiguracionAgentesClave` | Step 2: Claude Code's key panel (`claude setup-token`); Codex's row just after a sign-in succeeded |
| `DesktopConfiguracionAgentesFallo`, `MobileConfiguracionAgentesFallo` | Step 2: Copilot's code expired, with Pedir otro código |
| `MobileConfiguracionAgentes` | Step 2 on a phone with no Sheet open: a Sign in button per cell |
| `DesktopConfiguracionIntegraciones`, `MobileConfiguracionIntegraciones`, `MobileConfiguracionIntegracionesClave` | Step 3: GitHub ready, GitLab's key panel with its host, YouTrack's Conectar |
| `DesktopConfiguracionListo`, `MobileConfiguracionListo` | Step 4: the summary, with step 3 skipped |
| `DesktopAjustesSeguridad`, `MobileAjustesSeguridad` | Settings → Security with the new Secretos card |
| `DSConfiguracion` | Every state of the panel: the step bar, a key in the environment (Gemini), a key on stdin with both methods (Copilot), several variables (OpenCode), starting, every failure code, and the three secrets states |

**The assistant** replaces the first run (`DesktopPrimerArranque*`, which stays as the drawing of the Agents step's
checking and nothing-found states) while `GET /setup` says `seen: false`. It is the first run's page (`.prov-first`, no
shell, 760 px) with the wizard's `.steps` on top: Acceso → Agentes → Código y tareas → Listo.

- **The foot (`.setup-foot`)**: Volver (ghost, not on step 1), the step's count ("1 de 5 listo"), Omitir (ghost), and
  Continuar, the one primary. Listo has Volver and "Empezar a usar Agentry". A step the person skipped is `.step.skipped`:
  a dotted bar and "omitido" under its name, no status colour. On a phone the bar keeps only the bars
  (`.steps-bare`, the names stay for screen readers) and the header says "2 de 4 · Agentes"; the foot is `.m-foot` with
  Continuar full width and Volver and Omitir under it.
- **Gradient surfaces**: the logo and Continuar, two. Nothing else carries the gradient: no `.grad-border` on the
  cards, and every button inside a panel is neutral. On a phone the Sheet's own action may be primary (as YouTrack's access
  Sheet does), since the page's Continuar sits under the scrim.
- **Rows** are the first run's `.prov-row.compact` on a desktop and `.prov-cell` on a phone, for agents, `gh`, `glab` and
  YouTrack alike (their monograms from `providers.py`, `hosts.py`, `trackers.py`). The badges and words are the
  providers' table. A row that is not signed in offers **Iniciar sesión** (neutral, no external-link icon: it stays in
  Agentry); a ready row offers **Cerrar sesión** (ghost), except Copilot, whose vendor documents no sign-out.
- **Listo** is the one screen with an illustration: the set's `welcome` (`il-md` beside the title on a desktop, `il-sm`
  on a phone), next to a summary and no live data. Each line (`.setup-sum-row`) has the tool, its account or why not, a
  badge (Listo `ok`, Sin sesión `warn`, or the plain "Omitido": skipping is not a state to colour) and where to change it,
  as a link in mono ("Ajustes → Proveedores"), 44 px high on a phone.

**The sign-in panel** opens under the row (`.prov-bin.signin`, the row gets `.open`) on a desktop, and as a `Sheet` on a
phone with the same pieces. One open at a time. It is the same panel in Settings → Providers and Settings →
Integrations, so nothing is assistant-only.

- **Methods.** A tool with both (`device` and a key: Codex, Copilot, gh, glab) heads the panel with the `Segmented`
  control of `packages/ui/src/components/ui.tsx`, "Código / Clave", code first. A tool with one shows no choice. A tool
  whose key may go in several variables (`variables`, Claude Code's "Token de OAuth / Clave de API", OpenCode's four
  providers) chooses with a second Segmented; the field's label is the variable's name when it is a variable.
- **Key**: a write-only field (`type="password"`, mono, never prefilled), the vendor's page to make one as a link with
  the external-link icon, a hint that says where it goes (`env`: "Se guarda cifrada y solo la reciben los procesos de
  …"; `stdin`: "… lo guarda en su configuración; Agentry no se queda con una copia"), then **Guardar y comprobar** and
  Cancelar. `gh` and `glab` add the host field (`defaultHost` prefilled); YouTrack keeps its access form.
- **Claude Code's token.** The vendor offers no sign-in a program can drive, so the panel says so and names
  `claude setup-token` as inline code inside the sentence, on **the person's own computer** (bold), with a link to the
  vendor's page. See the decision below.
- **Device code, starting**: the braille spinner next to "Pidiendo un código a …" and Cancelar. No energy yet.
- **Device code, waiting** (`waiting-for-person`): the box `.signin-device`, two numbered lines (open the URL, a
  `.signin-url` link in mono; type the code), the code in `.signin-code` (Geist Mono, 34, tabular) with **Copiar**
  (`CopyButton`, 44 px on a phone), and under a hairline the braille spinner, "Esperando a que lo apruebes" and the time
  left in mono ("caduca en 14:12", from `expiresAt`). The box carries `.energy`: it is the screen's one live surface,
  and nothing else on the screen moves. Cancelar (ghost) under it. Codex adds a note above it: device login may have to be
  turned on in ChatGPT's security settings first, with the link.
- **Succeeded**: the panel closes and the row turns `ok` ("Listo"), its reason "Sesión iniciada con un código hace un
  momento". No toast is needed; the row is the answer.
- **Failed** (`.signin-result`, `role="alert"`): the sentence and the API's code under it in mono, then the action.
  `bad` for `cli-refused`, `not-signed-in`, `no-code` (its action is "Usar una clave"), `cli-missing` ("Ver instalación"
  ↗), `spawn-failed` and `timeout`; the others retry. `expired` is `warn` with the clock icon: nothing broke, the code
  only ran out, and the action is "Pedir otro código". `cancelled` says nothing: the panel closes and the row keeps its
  state. The copy of each is in `DSConfiguracion` and `FAIL` in `setup.py`.

**Settings → Security** gains a **Secretos** card first, from `SecretStorageStatus`: a `b-ok` "cifrados" badge and one
sentence on where secrets go and who receives them. With `keyBeside`, a `.callout-warn` "La clave está junto a los
datos" names the key's path, says it protects a copy of the files and not the volume, and recommends passing
`AGENTRY_SECRET_KEY` in the environment, with a link to how. With no key (`sealed: false`) the badge is `b-warn` "sin
cifrar" and the callout says values are kept plain at 0600. The Access and Token cards follow, as the app has them.

**Decisions.**

- **`claude setup-token` is named, not handed out.** The rule "a remedy is never a command to copy" keeps Agentry from
  sending a person to a shell on the machine Agentry runs on. This command is different: it is the vendor's only
  documented way to get a token for a program, and it runs on the person's own computer, where they already use Claude.
  So the panel names it inside a sentence, as inline code, says where to run it in bold, and links to the vendor's page;
  there is no copy button and no code block, so it reads as an explanation and not as a remedy to paste. Everything that
  can be done in Agentry (pasting the token) is.
- **Expired is warn, failed is bad.** The status colours keep one meaning each: a code that ran out needs the person
  again (warn), a CLI that refused or broke failed (bad).
- **The panel's Save is neutral on a desktop.** With the logo and Continuar the screen already has its two gradient
  surfaces.

**In the app** (built in step 5; `apps/web/src/components/setup/`, `styles/setup.css`). Two reference names collide with
the app's: `.signin` and `.signin-head` are the sign-in screen's, and `.steps` / `.step` the stepper's. So the panel under a
row is `.prov-bin.signin-panel` with `.signin-panel-head`, and the step bar is `.setup-steps` / `.setup-step` with the marks
`.is-done`, `.is-current`, `.is-skipped` and `.is-pending` (`.setup-steps-bare` on a phone). The energy border is the app's
`.live-energy`; the token shown once in the Access step is `.token-once` (a neutral box, since nothing went wrong); the
Copy beside a code or a token is `CopyButton` with `shown`, a neutral button that reads "Copiar". The other classes keep
the reference's names (`.signin-device`, `.signin-steps`, `.signin-url`, `.signin-code`, `.signin-wait`, `.signin-result`,
`.setup-foot`, `.setup-sum-row`, `.setup-where`). Quiet actions (Volver, Omitir, Cerrar sesión, Cancelar) are the providers'
`.btn.prov-quiet`. Two additions the reference does not draw: "Omitir la configuración" in the assistant's header on a
desktop, which finishes it at once (`POST /setup/seen`), and, under a code host's row in Settings → Integrations, a quiet
Iniciar sesión or Cerrar sesión at the end of each known host's line.

**Copy.** Steps: Acceso, Agentes, Código y tareas, Listo. Buttons: Volver, Omitir, Continuar, Iniciar sesión, Cerrar
sesión, Guardar y comprobar, Cancelar, Copiar, Reintentar, Pedir otro código, Usar una clave, Conectar, Empezar a usar
Agentry. Methods: Código, Clave. Waiting: "Esperando a que lo apruebes", "caduca en m:ss". Skipped: "omitido" on the
step, "Omitido" on a summary line. The `en` source follows the same structure ("Back", "Skip", "Continue", "Sign in",
"Code", "Key", "Waiting for you to approve").

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

- One React component per illustration under `packages/ui/src/components/illustrations/`, plus an
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
- Every bar that counts items by status is one `ProgressBar`; what each variant draws, and why the
  rest stay apart:
  - `.progress` / `.progress-seg` (`variant="bar"`): the share bar, one run per status. It also
    draws a workflow card's agents (`size="sm"`; it was a separate `.wf-progress` fill).
  - `.progress-segbar` / `.progress-segbar-cell` (`variant="segments"`): a cell per item.
    `.orch-timings-swatch` borrows the cell only as a legend swatch.
  - `.progress-blocks` / `.progress-cell` (`variant="blocks"`): the same thing in mono glyphs, for
    a row where no bar fits.
  - `.board-col-progress` and `.chat-part-of-progress` are not bars of their own: they are the
    layout (flex basis, hidden on a phone) that a screen hands to `ProgressBar` as `className`.
  - `.meter-track` / `.meter-fill` stay separate on purpose: they draw one quantity against a
    limit (usage, context, a probability) in a single fill whose tone is ok, warn or bad by
    threshold, not a count split by status.
- A chat that is a task of an orchestration opens with a context row, `.chat-part-of` (`.part-of`
  in `agentry-ds.css`): "Part of orchestration *name* · stage N of M", with the graph's
  `ProgressBar variant="segments"` at its end. The row is neutral: it is context, not the live
  surface, so it takes no gradient and no energy; the segments carry the only live colour. The
  name is the link and its box covers the row, so the whole line is the touch target. A chat that
  works for the graph without a task reads its role instead of a stage: "· integration",
  "· verification" or "· synthesis" (`ChatOrchestration.role`).
- Settings → Remote access offers nothing about the tunnel until Tailscale is ready. Not installed is
  `Empty` with the `cli-missing` illustration and the install link as the one primary action; every
  other way it is not ready (too old, service down, signed out, not connected, no HTTPS) is an
  `alert-warn` with the server's reason, the command to run or the admin page to open, and "Check
  again", with no illustration.
- The orchestration page ends with **"Where the time went"** (`.orch-timings`, `.timings` in
  `agentry-ds.css`), a card with a `Collapsible` whose trigger is the Geist Mono 11 label and at
  least 44 px tall. It is closed while the graph runs and open once it has ended. It is history, not
  a live surface: no gradient, no energy border, no motion. Its phase bar is the one segmented bar,
  `ProgressBar variant="segments"` with `cells`, cut by each phase's share (at least one cell each)
  in two **neutral** tones that alternate from phase to phase (`is-skipped`, and `is-pending`
  restyled to `--text-muted` inside `.orch-timings-bar`, since the bar's empty tone is too faint to
  read as time spent); the legend's swatches (`.orch-timings-swatch`) are the same cells. Durations are mono tabular
  figures. Status colours appear only on waits and failed checks, always as a `Tag` with its word:
  a slot or a limit wait is warn ("waiting for a slot", "waiting on a limit"), a retry wait is idle,
  and a failed run of a check (`.orch-timings-run.is-failed`) carries a bad "failed". On a phone the
  figures, the critical path links and the checks stack at full width, and the bar keeps it.
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
  table, `PHONE_HEADER_ROUTES` in `phone-header.ts`: every phone detail screen, the tab roots keeping
  the top bar ([phone-headers-rest-of-app.md](plans/phone-headers-rest-of-app.md)). A page built on
  `PageHeader` heads itself on a phone through its `phone` prop; the chat (`.chat-head`) and the
  review of changes (`.changes-head`) keep their own headers, with 44 px targets on a phone.
- `.sheet-action-reason`: under a `MoreActions` sheet, a disabled entry's reason written out (a
  finger has no hover to read a title by); `.sheet-action-gap` keeps an unchecked toggle's label in
  line with a checked one's. A download entry stays a real link in the sheet.
- `.phone-head-sub .badge`: a state under a phone head's title (the orchestration's) is the mono line
  itself, in its tone and with its icon, not a boxed badge. `.orch-phone-head` names the
  orchestration at 16 px, as MobileOrquestacion does.
- Time follows decision 10 with the owner's rule for past moments: a relative time everywhere, and
  the bare hour ("17:44") only inside a list grouped by day, such as Team activity.

Variants the app drew where the reference had no class, mirrored in §19 of
[agentry-ds.css](design-system/agentry-ds.css) under the app's names:

- `.phone-head.is-modal`: a modal flow's header (new task, the wizard, editing a document), its
  title centred at 17 px between "Cancelar" or "Cerrar" and what the flow creates.
- `.model-pick-sheet` / `.model-pick-option`: `ModelPicker` on a phone opens a sheet of 48 px
  options, the current model checked (`.model-pick-check`), instead of a popover.
- `.chat-back`, `.chat-more` (CW-8): the chat's own header on a phone, which keeps its rows instead
  of `PhoneHeader`: the way back to Chats and the "⋯" that opens the chat's actions as a `Sheet`
  (`MoreActions`), both 44 px.
- `.work-link-retried`, `.work-link-acts` / `.work-link-retry` (CW-20): under a failed run's reason
  on the item's link, what its retry did ("Reintentada: pasó hace 10 min", the outcome in its own
  status word and colour) or, while the run can still be queued again, a small neutral "Reintentar"
  raised above the row's open-the-chat overlay; 44 px on a phone.
- `.workitem-strip-verb.is-quote` (CW-20): QA's words on a sent-back card, clamped to three lines;
  the whole text is on the item.
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
