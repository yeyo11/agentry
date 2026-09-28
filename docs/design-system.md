---
created_at: 2026-09-25T16:27:30.6668753Z
updated_at: 2026-09-28T12:00:00Z
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
| The 13 illustrations as standalone SVG | [`design-system/illustrations/`](design-system/illustrations) |
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
| `.fp`, `.fmap`, `.frow`, `.step`, `.scrub`, `.why` | new: `.changes-print`, `.changes-map`, `.changes-file`, `.edit-step`, `.edit-scrub`, `.changes-why` | see §5 |

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
- **New chat** moves to a gradient FAB. The FAB has a label on Home and only an icon on the lists.
  It sits 16 px above the tab bar (the prototype's 100 px is measured from the bottom of the
  frame) and respects safe areas. On Orchestrations it starts a new orchestration instead.
- **More.** A sheet that opens with the account and limits card, then the rest of the navigation
  and the connection.
- **Detail screens** (chat, new chat, orchestration detail) hide the tab bar and put the composer
  or the main action at the bottom.

---

## 3. Live states and motion

| Situation | Pattern |
|---|---|
| Agent running a tool | braille spinner, a live verb ("Ejecutando"), the mono detail and the elapsed time |
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

Agentry has its own set of 13 SVG illustrations, drawn in the interface's language: hairline strokes,
nodes and graphs, terminal windows, and the brand gradient on one element. There is no library
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
`DiffView` component and the screens of the reference's **Changes** section; the classes are §15
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
| `--sx-kw`, `--sx-str`, `--sx-num`, `--sx-type`, `--sx-fn`, `--sx-com` | muted syntax, for code inside the comparator only |

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
   is visible, and `a11y.spec.mjs` stays green.
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
- The FAB shows on Home (with its label), Chats and Projects (icon only, New chat) and
  Orchestrations (icon only, New orchestration), and nowhere else (`fabFor`). A page header's
  button for the same action takes `.page-action-fab`.
- The More sheet opens on the account and limits card, then the sections, a **Start** group (Run
  workflow, New orchestration), the API reference and the connection.
- Each section of the More sheet says its figure (`.more-cell-note`, mono): the projects, the
  accounts, the schedules and today's cost. A problem replaces the count with a badge and its word:
  exhausted accounts in bad ("2 agotadas"), connectors waiting for authorisation in warn ("1
  pendiente"). The figures come from the queries the pages use (`useMoreNotes`), and the lists only
  the sheet needs (accounts, schedules, connectors) are read while it is open.
- On a phone, Chats carries the project scope as a chip beside its title, as MobileChats draws it,
  and the top bar leaves its selector out there (`pageHoldsScope`, decided with the `NARROW` media
  query, not hidden in CSS), so the page has exactly one `.project-selector`. A desktop keeps it in
  the top bar on every page.

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
- `styles/diff.css` is the comparator (§15 of `agentry-ds.css`); the review screen's own styles
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


## Related

[[plans/redesign-night-shift.md]] · [[plans/changes-review.md]] · [[plans/ui-redesign.md]] · [[plans/mobile.md]] · [[desktop.md]]
