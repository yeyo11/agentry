---
created_at: 2026-09-25T16:29:53.447735844Z
updated_at: 2026-09-25T18:55:39Z
tags:
    - plan
    - design-system
    - ui
    - web
    - mobile
    - illustrations
---
# Plan: the Night Shift redesign

Move the whole web UI (desktop and phone, both themes) to the Night Shift design system. This plan
is the source of truth for the `night-shift` orchestration, together with CLAUDE.md,
CONTRIBUTING.md and [docs/design-system.md](../design-system.md). Where a task prompt and this plan
disagree, the plan wins; where the plan and the design system disagree on a visual detail, the
design system wins.

The target look is in `docs/design-system/reference/`. Open `index.html`: every screen has a
static prototype (`<Screen>.html`, add `#light` for the light theme) and screenshots in
`screenshots/<Screen>-dark.webp` and `-light.webp`. Desktop screens are 1440 × 1024; phone
screens are 390 × 844. The illustrations are in `docs/design-system/illustrations/` (13 standalone
SVGs), with the catalogue on `DSIlustraciones` and the pattern in use on `DSEstados`.

## Why

An audit of the running app (1440 px and 390 px) found these problems, besides the feedback that
the UI reads as flat and dull:

- **Home contradicts itself.** A large "Nothing is running and nothing is waiting" block takes the
  top half of the page while two orchestrations are running below it.
- **The Home widgets crash on some browsers.** They fail with `Invalid language tag: en-US@posix`:
  `intlLocale()` in `apps/web/src/i18n/language.ts` passes a POSIX-style browser tag straight to
  `Intl`.
- **The top bar is crowded, and the live state appears twice**, in the top bar and in the sidebar.
- **Chat rows lead with an id** (`claude-wrapper-b67aa3`) instead of what the chat is about, and
  put three rows of metadata on the right.
- **The phone layout wastes and truncates.**
  - The project selector is cut to "Todos los p…".
  - "Orquestaciones" is truncated in the tab bar.
  - Status filters, search, filters and sort take three rows.
  - Checkboxes are always visible, and titles are cut to 15 characters.
  - Orchestration stages stack vertically.
- **Accounts reads "Se Reinicia En"** (`text-transform: capitalize` in `feedback.css`). Its usage
  bars are red at 5 %, because bars are coloured by account and not by threshold.
- **Settings has 20 tabs in one row**, which overflows.
- **The sidebar is flat**: nine items, no grouping.

## Direction

The base is near-black neutrals with Geist / Geist Mono, IDE density, hairline borders, mono labels
and a status bar, as in Orca. On top of it we keep what makes Agentry recognisable: the terracotta →
rose gradient, the energy border on what is alive, the braille spinner, the live rail, and cyan
reserved for live work. The design system has the tokens, the component map and the rules.

Decisions already taken, not to be reopened by a task:

1. **Dark is the default theme.** With nothing stored, the preference is `dark`. "System" becomes a
   stored value (`'system'`) instead of the absence of one. The light theme is fully supported.
2. **v1 token names stay.** The v1 variables (`--bg-elev`, `--text-muted` …) get the new values,
   and the v2 names (`--bg-2`, `--fg-2` …) are added as aliases. No mass rename of the 10 000 lines
   of CSS.
3. **Restyle, don't duplicate.** Style the classes and components the app already has (the map is
   §2 of the design system). The reference's short class names are not added to the app.
4. **A status bar on desktop.** It shows the connection, the active account, the 5 h / 7 d bars,
   the agents running, today's spend and the CLI version. It replaces what the sidebar footer
   showed.
5. **Four tabs and a FAB on the phone.**
   - The tabs are Home, Chats, Orchestrations and More, and "New" stops being a tab.
   - New chat is a gradient FAB. On Orchestrations the FAB is New orchestration.
   - "Run workflow" and "New orchestration" stay reachable from a "Start" group in the More sheet.
6. **No API changes.** Everything the new screens show is already served. The status bar and the
   Home KPIs reuse the queries of the existing widgets, pulled into a shared hook; they are never
   fetched twice.
7. **Illustrations are our own SVG set, not a library.** Thirteen illustrations, drawn in the
   interface's language (hairlines, nodes, terminal windows, one gradient element), coloured by
   tokens so they follow the theme. No unDraw, Storyset, Lottie or icon-pack art: no runtime
   dependency, no licence to track, and nothing that looks borrowed. They go on empty, error and
   system states, on New chat and on Install, never next to live data (design system §4).

## Not in this orchestration

- New features, endpoints or data. If the reference shows something the API doesn't serve (a
  figure, a template), leave it out or use what exists, and note it in your result.
- Renaming the v1 CSS variables, or moving CSS between files beyond what a task's ownership says.
- The dashboard layout editor, new widget types, and changes to the Electron app's behaviour (only
  its colours change).
- New languages. Copy keeps `en`/`es` parity.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects
   (`feat(web): …`, `fix(web): …`, `style(web): …`), in English, with a body that explains why.
   Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By` and no "Generated with" trailer, ever.
3. **Code, comments and docs are in English.** UI strings live in `apps/web/src/i18n/locales/en`
   and `es` with parity. The `es` copy follows `apps/web/src/i18n/GLOSSARY.md`. The prototypes show
   the intended `es` copy; write the `en` equivalent.
4. **Checks you run:** `timeout 600 pnpm typecheck` and `timeout 600 pnpm test`.
   - You may write or update e2e specs, but **do not run `pnpm e2e`**, except in the
     `consistency` task, which runs alone. Running it in parallel with other workers hangs it.
5. **Every long command runs under `timeout`.** If a command hits its timeout twice, stop and
   report it.
6. **TypeScript strict and no `any`.** Respect `noUncheckedIndexedAccess`. Comments explain why.
7. **UI controls come from `apps/web/src/components/controls`.** Never use native select, checkbox
   or range.
   - Icon-only buttons carry an `aria-label`.
   - Status is never colour alone.
   - `e2e/specs/a11y.spec.mjs` must keep passing.
8. **Tokens only.** Once `foundation` lands, no stylesheet other than `tokens.css` may contain a
   hex, `rgb()`/`hsl()` colour, pixel radius or millisecond duration. The web test added by
   `foundation` enforces it; `#fff` on the gradient is the only exception.
9. **Motion.** Loops only for live work. One energy border per screen. Everything respects
   `data-motion` (`subtle`, `off`), `prefers-reduced-motion` and hidden tabs.
10. **Keep the e2e hooks.** Specs select these classes; keep them on the element that plays the
    same role, or update the spec in the same commit without loosening the assertion:

    `.topbar`, `.topbar-new` (with `.split-btn-main` and `.split-btn-more`), `.bell`,
    `.bell-badge`, `.notif-panel`, `.notif-item`, `.project-selector`, `.palette`, `.tabbar`,
    `.tabbar-more`, `.more-sheet`, `.sidebar-foot` (`events.spec.mjs` reads its text), `.crow`,
    `.crow-group-head`, `.bulk-bar`, `.filter-chip`, `.list-toolbar-popover`, `.field`, `.badge`,
    `.strong`, `.chat-head`, `.chat-inspector`, `.composer-status`, `.transcript`,
    `.transcript-earlier`, `.find-input`, `.find-count`, `.run-scroll`, `.run-side`,
    `.task-actions`, `.schedule-card`, `.scard`, `.usage-tile`, `.usage-tile-value`,
    `.date-picker-panel`, `.obs-*`, `.signin`, `.tab-dirty`, `.cm-content`.

    Before renaming anything, grep `e2e/specs`.
11. **Compare with the reference before you finish.** Build the app (`pnpm build`) and run it in the
    isolated sandbox that `e2e/run.mjs` builds, or with `pnpm dev` and `CLAUDE_CONFIG_DIR` pointing
    at a scratch directory. Seed data with `e2e/specs/transcript-seed.mjs` where it helps.
    - Screenshot your screens at 1440 × 1024 and 390 × 844, in dark and light, with headless Chrome
      (`CHROME_BIN`).
    - Look at your screenshots next to the matching reference screenshots, and fix what drifts.
    - The reference's data is illustrative; its structure, hierarchy, spacing, colour use and
      motion are not.
12. **Don't touch files outside your scope** (see ownership below). If you need something from
    another task's file, say so in your result instead of editing it.
13. If something in your scope turns out to be impossible, or much larger than it looks, **do the
    rest and say what you left out**. Don't silently narrow the scope.
14. **Empty, error and system states use `Empty` with an illustration** where your task's
    "Illustrations" list says so. Everything else keeps the compact icon version (inside dialogs,
    editors, settings panels and cards that sit next to other content). Never draw a new SVG inside
    a page: a missing illustration is reported in your result, not improvised.

## File ownership

| Task | Owns |
|---|---|
| `foundation` | `styles/tokens.css`, `styles/base.css`, `styles/primitives.css`, `styles/feedback.css`, `styles/overlays.css`, `styles/motion.css`, `controls.css`, `palette.css`, `notifications.css`, `components/ui.tsx`, `components/motion.tsx`, `components/Spinner.tsx`, `components/controls/*`, `components/Toast.tsx`, `components/Dialog.tsx`, `lib/theme.tsx`, `i18n/language.ts`, `main.tsx` (fonts), `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/test/design-tokens.test.ts` (new) |
| `illustrations` | `components/illustrations/**` (new), `styles/illustrations.css` (new) and its import in `styles.css`, and, after `foundation` has landed, `Empty` in `components/ui.tsx` and the `.state*` rules in `styles/feedback.css`; `apps/web/test/illustrations.test.tsx` (new) |
| `shell` | `App.tsx`, `styles/shell.css` (except the `.appearance*` rules), `components/shell/*` (new `StatusBar.tsx`, `Fab.tsx`), `components/SignIn.tsx`, `components/CommandPalette.tsx` (trigger placement only), `components/ProjectSelector.tsx`, `components/SplitButton.tsx`, `components/Notifications.tsx`, `components/icons.tsx`, `i18n/locales/*/shell.json` and `components.json` |
| `home` | `pages/Home.tsx`, `pages/dashboard/**`, `pages/home/**`, `styles/dashboard.css`, `i18n/locales/*/home.json` |
| `chats` | `pages/Chats.tsx`, `components/ListToolbar.tsx`, `components/ChatBadges.tsx`, `components/ChatDelete.tsx`, `styles/lists.css`, `i18n/locales/*/chats.json` |
| `chat` | `pages/ChatView.tsx`, `pages/chat/**`, `pages/NewChat.tsx`, `components/Transcript.tsx`, `components/ContextRing.tsx`, `components/Attachments.tsx`, `styles/chat.css`, `styles/transcript.css`, `chats.css`, `observe.css`, `components/observe/**`, `i18n/locales/*/chat.json` and `observe.json` |
| `orchestration` | `pages/Orchestration.tsx`, `pages/OrchestrationDetail.tsx`, `components/OrchestrationBoard.tsx`, `components/WorkflowCard.tsx`, `components/Stepper.tsx`, `components/ProgressBar.tsx`, `components/TaskEditor.tsx`, `components/OrchestrationTemplates.tsx`, `components/RunWorkflowDialog.tsx`, `styles/orchestration.css`, `i18n/locales/*/orchestration*.json` and `work.json` |
| `workspace` | `pages/Projects.tsx`, `pages/Accounts.tsx`, `pages/accounts/**`, `pages/Connectors.tsx`, `pages/Schedules.tsx`, `pages/ScheduleEditor.tsx`, `pages/schedules/**`, `pages/Usage.tsx`, `components/BarChart.tsx`, `insights.css`, `usage-history.css`, `i18n/locales/*/{projects,accountsConfig,connectors,schedules,usage}.json` |
| `settings` | `pages/Settings.tsx`, `pages/config/**`, `styles/editors.css`, the `.appearance*` rules (move them from `shell.css` into `editors.css`), `components/CodeEditor*.tsx`, `i18n/locales/*/config.json` |
| `desktop-pwa` | `apps/desktop/src/{main,pages,title-bar}.ts`, `apps/web/index.html`, the PWA manifest and colours in `apps/web/vite.config.ts` and `apps/web/public` |
| `consistency` | any web file, for cross-screen fixes only, after every other task has landed |
| `docs` | `docs/**`, `README.md`, `CONTRIBUTING.md`, `docs/media` |

All paths are under `apps/web/src/` unless they say otherwise.

## Stage 0: foundation

### `foundation` (tokens, fonts, primitives, motion, theme and locale fixes)

- **Tokens.**
  - `tokens.css` takes the values in design system §1 for dark and light: new values under the v1
    names, the v2 aliases, and the new `--bg-4`, `--line-3`, `--accent-rose`, `--grad-border`,
    `--grad-text` and `--glow-top`.
  - `--gradient-accent` becomes the darker v2 gradient, so white text passes AA.
  - Move every hard-coded colour now in `chat.css`, `feedback.css`, `lists.css`, `primitives.css`,
    `transcript.css`, `controls.css` and `notifications.css` into tokens.
- **Guard test.** Add `apps/web/test/design-tokens.test.ts`. It scans `apps/web/src/**/*.css` and
  fails on colours, px radii or ms durations outside `tokens.css`, with the exceptions in rule 8.
- **Fonts.** Replace `@fontsource-variable/inter` and `jetbrains-mono` with
  `@fontsource-variable/geist` and `geist-mono` (`main.tsx`, `--sans`, `--mono`), and update the
  lockfile. The service worker must still precache a `.woff2`: `pwa.spec.mjs` checks it.
- **Primitives.** Restyle to the component map in design system §2:
  - buttons, including a gradient primary with an inner highlight and a warm shadow;
  - fields and focus rings, chips, badges (mono uppercase), dots with a ping, counters;
  - cards (`radius-xl`, hairline and shadow), `grad-border`, meters, gauges and rings (threshold
    colours);
  - toasts (the draining gradient bar), dialogs, menus, sheets, select, checkbox, switch, slider,
    tooltip, the date picker, the command palette, and the bell and notification panel.
- **Tabs and segmented control** (in `components/ui.tsx`). The active tab gets a gradient
  underline, and the segmented control a raised `--bg-4` "on" state.
- **Motion.**
  - Keep the braille `Spinner`, and add the ring and dots variants plus a `shimmer` text utility.
  - The energy border's conic gradient becomes live → rose.
  - Every loop respects the motion levels, and `motion.spec.mjs` still passes.
- **Theme** (`lib/theme.tsx`). With nothing stored, the default is `dark`. Store `'system'`
  explicitly. Keep the pre-paint script free of flashes, and add a test of the preference resolution. There is
  no theme test yet; `apps/web/test/` is where it goes.
- **Sentence case.** Remove `text-transform: capitalize` from `.gauge-name` and `.meter-head`, and
  from anything else that capitalises sentences.
- **Locale fix** (`i18n/language.ts`). `intlLocale()` drops POSIX suffixes (`@posix`, `.UTF-8`),
  validates with `Intl.getCanonicalLocales` inside `try/catch`, and falls back to
  `en-US` / `es-ES`. Add a case with `['en-US@posix']` to `apps/web/test/i18n.test.ts`.
- **Done when:** every existing screen already looks Night Shift through tokens and primitives
  alone, in both themes; typecheck and tests pass; and the reference's `DSComponentes` and
  `DSFundamentos` screenshots match the primitives as rendered in the app.

## Stage 1: illustrations (depends on `foundation`)

### `illustrations` (the SVG set and the `Empty` pattern)

References: `DSIlustraciones`, `DSEstados`, `Illustration`, and the files in
`docs/design-system/illustrations/`.

- **Components.** Port the 13 standalone SVGs to TSX under `components/illustrations/`, one file
  each, plus an `index.ts` that exports `Illustration` and the `IllustrationName` union:
  `welcome`, `chats`, `orchestrations`, `schedules`, `projects`, `no-results`, `not-found`,
  `install`, `cli-missing`, `signed-out`, `connector`, `offline`, `quota`.
  - `<Illustration name size tone className />`: `size` is `sm` (160 × 107), `md` (240 × 160,
    the default) or `lg` (300 × 200); `tone` is `accent` (default), `warn`, `bad` or `live` and
    sets the class that drives `--il-tone`.
  - Every instance takes its gradient, pattern and mask ids from `useId()` (strip the characters
    that aren't `[A-Za-z0-9_-]` before using them in `url(#…)`). Two illustrations on one page must
    not share an id.
  - The root `<svg>` carries `aria-hidden="true"` and `focusable="false"`, and no `<title>`.
  - Drop the standalone files' `<style>` blocks and their `var(--x, #hex)` fallbacks: in the app,
    colour comes only from `illustrations.css`. Keep the drawings' geometry exactly.
- **Styles.** `styles/illustrations.css` ports §14 of `docs/design-system/agentry-ds.css` (the
  `.il` block, the fill and stroke classes, the gradient stops, the `a-*` animations and their
  keyframes) onto the app's tokens.
  - Scope every rule under `.il` (`.il .c1`, `.il .ln-grad` …): the short class names must not leak
    into the rest of the app (decision 3).
  - The animations stop under `data-motion='subtle' | 'off'`, `prefers-reduced-motion` and hidden
    tabs, like every other loop.
  - Import it in `styles.css` right after `feedback.css`. It passes the guard test (tokens only).
- **`Empty`** (`components/ui.tsx`). Restyle it into the `.empty-state` pattern of `DSEstados`:
  illustration, title, one or two sentences, a primary action and at most one secondary.
  - Add an optional `illustration?: IllustrationName` prop, plus `tone` and `size`. With an
    illustration, the icon is not rendered; without one, the compact icon version stays as it is
    today (restyled), so no existing call site changes behaviour.
  - Keep the `.state`, `.state-empty`, `.state-icon` and `.state-action` classes; `action` keeps
    accepting any node.
- **Test.** `apps/web/test/illustrations.test.tsx`: every name renders; two instances of the same
  illustration on one page have no duplicated ids; the root is `aria-hidden`; an unknown size or
  tone falls back to the defaults.
- **No placements here.** The screen tasks put the illustrations on their own pages (see the
  "Illustrations" item in each task below).
- **Done when:** the components render like `DSIlustraciones` in both themes, `Empty` renders like
  `DSEstados`, and typecheck and tests pass.

## Stage 2: the screens, in parallel (all depend on `foundation` and `illustrations`)

### `shell` (sidebar, top bar, status bar, phone tab bar)

- **Sidebar** (reference: `Sidebar`, and every desktop screen).
  - Brand, then the command palette trigger styled as a search field with `⌘K`.
  - Two labelled groups: Work (Home, Chats, Orchestrations, Schedules) and Space (Projects,
    Accounts, Connectors, Usage, Settings).
  - The "Live" section: rail, braille spinner, a segmented bar per orchestration, and the waiting
    state in warn.
  - The API reference link.
  - The gradient left indicator on the active item. The icon rail keeps working.
- **Top bar** (reference: `Topbar`).
  - Project scope and crumb on the left.
  - On the right: the live chip ("N agentes trabajando", pinging dot), the bell with an accent dot,
    and the "New chat" split button in the gradient.
  - The palette trigger moves to the sidebar on desktop and stays as an icon in the top bar under
    900 px.
- **Status bar** (new `StatusBar.tsx`, reference: `StatusBar`, 30 px, mono 11 px).
  - Left: the connection dot and the account, then the 5 h and 7 d bars with their percentages.
  - Right: "N en marcha" with the braille spinner, today's spend, and the CLI version.
  - Pull the queries the Home limits/usage widgets use into one hook, shared by both.
  - Keep the connection text reachable under `.sidebar-foot` (or update `events.spec.mjs` to read
    it from the status bar, same assertion).
  - Hidden under 900 px.
- **Phone** (references: `TabBar`, `MobileInicio`, `MobileMas`).
  - Four tabs: Home, Chats, Orchestrations (live counter badge) and More.
  - A gradient `Fab`: "New chat" with a label on Home, icon only on Chats and Projects, and New
    orchestration on Orchestrations. It is hidden where `hidesTabBar()` is true.
  - The More sheet: the account and limits card first, then the rest of the navigation, a "Start"
    group (Run workflow, New orchestration), the API reference and the connection.
  - Update `shell.spec.mjs` (line ~72 expects New chat in the tab bar), `mobile.spec.mjs` and
    `a11y.spec.mjs` for the FAB, without loosening them.
- **Desktop app.** The `.is-desktop` drag regions and the macOS inset keep working.
- **Illustrations.**
  - The 404 route (`path="*"` in `App.tsx`): `not-found`, `md`, with "Ir a Inicio" as the primary
    action.
  - `SignIn.tsx` (reference `DesktopAcceso`): `signed-out` in `warn` above the form. Keep `.signin`.
  - The sidebar footer and the status bar stay text and dots: no illustration.

### `home` (the dashboard)

References: `Main` (desktop) and `MobileInicio`.

- **Hero header.**
  - A mono date label.
  - An h1 built from the live state, with one gradient phrase:
    - running > 0 and nothing waiting: "Todo en marcha, nada te espera";
    - something waiting: "N esperan tu respuesta";
    - nothing running: "Nada en marcha".
  - A one-line summary.
  - Actions: New orchestration and New chat (primary).
- **KPI strip.** Agents running (braille), waiting (dot), today's spend (`grad-border` and
  `grad-text`) and the 5 h limit (gradient ring with the weekly %).
- **"En marcha".** The live widget in a card with the page's one energy border. For each
  orchestration: its initials badge, name, meta, cost and elapsed time, a segmented bar per task,
  the done / running / pending counts, and the current tool line (`$ command`, spinner). Working
  chats follow.
- **Right column:** today's usage by model, Projects (the pinging dot on the active one) and
  Schedules (a compact empty state with "Crear programación").
- **Empty state.** When nothing is running, the "En marcha" card collapses to a compact empty state
  with Start a chat and the quick start. It must never push live data below the fold.
- **Illustrations.**
  - In the "En marcha" card (`pages/dashboard/widgets/live.tsx`), all `sm`:
    - nothing running and nothing waiting: `welcome`, in the compact empty state above;
    - the CLI is not detected, when that is all the card has to say: the `Empty` pattern with
      `cli-missing` in `warn` instead of the attention row (`activity.cliMissing`);
    - Claude Code is not logged in, in the same way: `signed-out` in `warn`;
    - the widget's error when the API is unreachable: `offline` in `bad`.
  - When anything is running or waiting, there is no illustration on the page. The Schedules card
    in the right column keeps the compact version.
  - `pages/home/ProjectWorktrees.tsx`, no worktrees: `projects`.
- **Project dashboard.** Scoped to a project, the page uses the same components. The project views
  (settings, memory, resources, worktrees) take the new tabs.
- **Phone:**
  - the hero is two lines;
  - three KPI tiles;
  - "En marcha" cards;
  - "Retomar" as cells in a card;
  - the account ring card at the bottom.

  Leave bottom padding so the FAB never covers content.

### `chats` (the list)

References: `DesktopChats` and `MobileChats`.

- **Desktop table.** Columns: status dot or spinner, Chat, Project, Origin badge (agentry /
  terminal), Context (thin bar with threshold colours), Cost and Activity. Rows are grouped by day
  under mono `t-label` heads with counts.
  - The **title is the first prompt**, clamped to one line. Under it go the id, "Interactivo" and
    the model and message count, in mono.
  - A working row gets the live rail and a live-tinted background.
  - Checkboxes appear on hover or in select mode, and the bulk actions come up in a floating
    `toast` bar.
- **Toolbar.** Segmented status filters with counts, then search with a `/` hint, then Filters,
  then Sort, all in one row.
- **Phone.**
  - Title "Chats 197" and a project chip.
  - One row with the search field and a filter/sort button.
  - A horizontally scrolling chip row.
  - Rows with the title clamped to 2 lines and one mono meta line.
  - No checkboxes: long press enters select mode.
  - The FAB.
- **Illustrations.**
  - No chats at all: `chats`, `lg`, full page (reference `DesktopChatsVacio`), with New chat as the
    primary action.
  - Filters or search without matches: `no-results`, `md`, with "Restablecer filtros".

### `chat` (a conversation and New chat)

References: `DesktopChat`, `MobileChat`, `DesktopNuevoChat` and `MobileNuevoChat`.

- **Header.**
  - Back.
  - The title (first prompt), with a mono sub-line: project · id · model.
  - A live badge ("trabajando · 15s", spinner).
  - Search and a "⋯" menu.
- **Transcript.**
  - The user message as a right-aligned bubble.
  - Tool groups as a mono line: check, count, duration, the tool names as badges, and an expand
    chevron.
  - An orchestration the chat launched as a `grad-border` card with a segmented bar and Open.
  - The current action as spinner + shimmer verb + mono detail.
  - Fix the message timestamp overlapping the end of the paragraph (seen at 1440 px).
- **Composer.**
  - A 16 px card that takes the energy border while the chat works, with Detener (danger) next to
    Send (gradient).
  - Model / permissions / preset / MCP as chips below it, the permission chip in the accent tone.
  - A keyboard hint on the right.
  - On the phone: a 24 px pill with 40 px round buttons and 16 px text, following `visualViewport`
    as today.
- **Inspector.**
  - Underlined tabs.
  - A context ring in the gradient with the token count.
  - Cost in `grad-text` with the per-model table in mono.
  - Chat facts as hairline rows; the permission mode as an accent badge.
- **New chat.**
  - A halo (`glow-top`) hero: "¿Qué construimos hoy?" with a gradient word.
  - A segmented Chat / Orchestration switch (Orchestration navigates to the existing new
    orchestration path).
  - A `grad-border` composer card with the project / model / permission chips and "Empezar"
    (primary), and a mono line saying where it runs.
  - Examples as three cards with a tinted icon.
- **Illustrations.**
  - New chat: `welcome` above the hero, `md` on desktop and `sm` on the phone (references
    `DesktopNuevoChat` and `MobileNuevoChat`).
  - A chat that doesn't exist (`view.notFound`): `not-found`.
  - "Nothing written yet" inside the transcript keeps the compact version: it sits next to the
    composer.

### `orchestration` (list and detail)

References: `DesktopOrquestaciones`, `DesktopOrquestacion`, `MobileOrquestaciones` and
`MobileOrquestacion`.

- **List.**
  - Two columns of cards: initials badge, name and mono meta, a status badge (braille spinner when
    running), a one-line objective, a segmented bar per task (ok / bad / live / pending), then
    tasks · stage and cost.
  - The first running card takes the page's energy border; the others take the live rail.
  - A stopped card shows its failed and unrun counts, with "Ver fallos" and "Reanudar" (primary).
  - Segmented status filters with counts.
- **Detail.**
  - Header: back, name, badge, "Ver worktree" and "Detener" (danger).
  - An objective card with its settings as badges.
  - KPI tiles: tasks, time (mono), cost (`grad-border`) and parallel.
  - A seven-step pipeline (Etapa 1..n, Integración, Verificación, Síntesis, Pull request) of bars
    and labels, the current one live.
  - The stage's tasks in two columns. The most active task takes the energy border; the others take
    rails. Each task shows its command in a mono box, and actions (Enviar pista, Abrir chat, Hacer
    fork, Ver resultado).
  - The graph view keeps working, restyled.
- **Phone.** Chips for the steps, three KPI tiles, and compact task cards. The "⋯" sheet holds
  Detener.
- **Illustrations.**
  - No orchestrations: `orchestrations`, with New orchestration (primary) and the templates
    (secondary).
  - Filters without matches: `no-results`.
  - An orchestration that doesn't exist: `not-found`.
  - The empty task list in the editor, and the template and workflow dialogs, keep the compact
    version.

### `workspace` (Projects, Accounts, Connectors, Schedules, Usage)

References: the matching `Desktop*` and `Mobile*` screens.

- **Projects.**
  - Cards: a 40 px initials badge (gradient for the active project), name and mono path, three
    stats (chats, worktrees, activity with the live dot), "Nuevo chat aquí" and Abrir.
  - Rename / remove / purge in a menu (a sheet on the phone); purge asks for confirmation.
  - "N more directories have chats" as a dashed callout.
  - Phone (`MobileProyectos`): no subtitle, one "Nuevo chat aquí" per card, and Abrir joins
    rename / remove / purge in the "⋯" sheet. The search and sort show from five projects on.
- **Accounts.**
  - The active account first, as a `grad-border` card with the "en uso" gradient badge and a
    gradient free-quota figure. Accounts that are exhausted come last.
  - Bars are neutral, turn warn from 60 % and bad from 75 % or exhausted, with badges "agotado" /
    "va alto". Resets read "vuelve en 19 min" / "en 2 d 10 h" in sentence case.
  - "Usar esta cuenta" is primary. It is disabled when the account is exhausted.
  - Add account moves to a dialog behind a primary button.
  - Automatic rotation is one card: threshold slider, strategy segmented, interval, windows, and a
    resume toggle.
  - Usage history keeps working, restyled.
  - Phone (`MobileCuentas`): an exhausted account that is not in use is one row (avatar, name,
    "5h agotado" and any window running high as tags, "vuelve en …"), with hold-out and removal
    behind its "⋯" sheet. Automatic rotation is a cell ("detenida · umbral 90%") that opens
    `/accounts?view=rotation`, a screen with the rotation card and a way back. A desktop ignores
    `?view=` and keeps every account a card.
- **Connectors.**
  - A connected connector: status dot and the "Probar" prompt button.
  - A connector that needs authorisation: a warn-tinted card with the numbered steps once (drop the
    duplicated how-to).
  - "La CLI no lista …" as a callout, and the out-of-scope notes in a side column.
  - Phone (`MobileConectores`): the header is the title, "consultado …" and a refresh icon. The
    callout and the out-of-scope notes become one footnote under the cards.
- **Schedules.**
  - Empty state: the `schedules` illustration, a headline, and three template cards (every
    morning, every Monday, every 15 min) that open the editor preset where it already supports it
    (otherwise `/schedules/new`).
  - The two rules as callouts.
  - The list and editor restyled.
  - Phone: a card keeps its on/off switch; run now, edit and delete go behind a "⋯" `Sheet` titled
    with the schedule, as on Projects and Accounts. Desktop keeps them as buttons on the card.
- **Usage.**
  - The period as a segmented control.
  - KPI tiles that act as the metric selector (Cost, Tokens, Chats; the selected one
    `grad-border`), plus a "busiest day" tile.
  - The per-day bar chart: gradient bars, the peak highlighted with a glow, and a tooltip on hover.
    Keep the table view and the chart's accessible description. The table is a "Ver tabla" toggle
    button (`aria-pressed`) in the chart card's header, next to Día/Semana, that puts the table in
    the chart's place.
  - Phone (`MobileUso`): one big figure ("Coste · 30 días") instead of the tiles, with the other two
    metrics under it as buttons that move them into the figure and the chart; the chart card says
    the peak above the bars.
  - By project / by model as gradient bars.
- **Illustrations.**
  - Projects: none yet → `projects`; no match → `no-results`.
  - Accounts: claude-swap not installed (`accounts.notInstalled`) → `cli-missing` in `warn`; no
    accounts registered → `signed-out` in `warn`. The rotation and history cards keep the compact
    version.
  - Connectors: none → `connector`. When no connector is connected and every one needs
    authorisation, the page leads with `connector` in `warn` (as on `DSEstados`).
  - Schedules: the empty state above; no match → `no-results`; a schedule that doesn't exist
    (`ScheduleEditor`) → `not-found`.
  - Usage: nothing in the range → `no-results`, inside the chart card.
  - `quota` has no placement: the app has no "every account is exhausted" state, and adding one is
    out of scope. `DSEstados` shows it as a proposal.

### `settings`

References: `DesktopAjustes` and `MobileAjustes`.

- **Desktop.** The 20 tabs become a grouped side nav: Agentry (Appearance, Notifications, Editor,
  Account), Claude Code (Instructions, Settings, Memory, Rules, Output styles), Extensions (MCP
  servers, Plugins, Skills, Agents, Commands, Workflows, Tool presets) and System (Files, Install,
  Supervisor, Security). Deep links `?tab=` keep working.
- **Phone.** The same groups as grouped cells in cards. A tab opens as its own screen with a back
  button.
- **Appearance.**
  - Theme as three thumbnail cards (System, Light, Dark), the selected one `grad-border`.
  - Language select.
  - Motion segmented, with a live preview card (energy, braille, a live bar, ring, dots, shimmer).
- **Restyle every tab's content:** master-detail editors, code editors, key-value editors, and the
  save bar with its gradient primary.
- **Illustrations.**
  - The Install tab (reference `MobileInstalar`): `install` at the top, `sm` on the phone and `md` on
    desktop, above the install steps and the push notifications card.
  - The empty lists inside tabs (MCP servers, plugins, presets, memory …) keep the compact version:
    they sit inside a master-detail panel.

### `desktop-pwa` (colours outside the web CSS)

- **Electron.**
  - `main.ts` `backgroundColor`, the `pages.ts` splash and error pages, and the `title-bar.ts`
    colours, all in the v2 dark palette.
  - The splash spinner in the brand gradient, respecting reduced motion.
- **Web.**
  - `index.html` `theme-color`: `#09090b` dark, `#fafaf9` light.
  - `public/manifest.webmanifest` `background_color` and `theme_color`: `#09090b`.
- **Illustrations.** The Electron error page (`pages.ts`, shown when the server doesn't start) may
  inline `docs/design-system/illustrations/offline.svg` as is: the standalone file carries its own
  styles and dark fallbacks.
- `pwa.spec.mjs` must stay green.

## Stage 3: consistency (depends on every Stage 2 task)

### `consistency`

Runs alone, so it may run `pnpm e2e`.

- **Screenshot everything.**
  - Build and start the isolated sandbox with seeded chats, orchestrations and accounts.
  - Screenshot every route at 1440 × 1024 and 390 × 844, in dark, light and `motion=subtle`.
  - Compare against the reference.
- **Fix drift across screens.** Page headers, gaps, card radii, label style, badge casing, empty
  states, one energy border per screen, at most two gradient surfaces, threshold colours, and
  sentence case.
- **Illustrations.** At most one per screen, never next to live data, the right tone for the state,
  no duplicated SVG ids (check the DOM on a page with two), and they stop moving under
  `motion=subtle`.
- **Checks.**
  - `rg -n "#[0-9a-fA-F]{3,8}\b|rgba?\(" apps/web/src --glob '*.css' --glob '!**/tokens.css'` is
    empty, apart from the allowed exceptions.
  - `pnpm e2e` is green, with the known pre-existing failures noted below.
- Put before/after pairs of the main screens under `docs/media/night-shift/` for the docs task.

## Stage 4: documentation (depends on `consistency`)

### `docs`

- Update `docs/design-system.md` with whatever the implementation settled differently (in a
  **Landed** note, as the other plans do).
- Add an **Outcome** section to this plan.
- Update `docs/status.md`, and the README screenshots with `pnpm media`.
- In `CONTRIBUTING.md`, add one line pointing UI work at the design system.
- Store the new and changed documents in the knowledge base with `kb_add_document`, following
  `docs/knowledge-base.md`.

## Launch settings

```json
{
  "name": "night-shift",
  "engine": "graph",
  "worktree": true,
  "model": "opus",
  "permissionMode": "bypassPermissions",
  "permissionPrompts": "none",
  "concurrency": 4,
  "maxAttempts": 2,
  "synthesize": true,
  "limits": { "maxMinutes": 240 },
  "verification": {
    "commands": ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm test", "pnpm build", "pnpm e2e"],
    "fixer": true,
    "maxAttempts": 2,
    "timeoutMinutes": 30
  }
}
```

| Task | Depends on |
| --- | --- |
| `foundation` | — |
| `illustrations` | `foundation` |
| `shell` | `foundation`, `illustrations` |
| `home` | `foundation`, `illustrations` |
| `chats` | `foundation`, `illustrations` |
| `chat` | `foundation`, `illustrations` |
| `orchestration` | `foundation`, `illustrations` |
| `workspace` | `foundation`, `illustrations` |
| `settings` | `foundation`, `illustrations` |
| `desktop-pwa` | `foundation`, `illustrations` |
| `consistency` | `shell`, `home`, `chats`, `chat`, `orchestration`, `workspace`, `settings`, `desktop-pwa` |
| `docs` | `consistency` |

### Before launching

- **Launch from a `main` that already has `spanish-copy` and `app-updates` merged.** Both touch the
  `es` locale files and the shell. Started earlier, this orchestration's integration branch would
  fight theirs.
- **Commit the design system and this plan to `main` first:** `docs/design-system.md`,
  `docs/design-system/**`, `docs/plans/redesign-night-shift.md`, and the new "Design system"
  section of `CLAUDE.md`. Workers start in worktrees of that commit and can only read what it
  contains.
- **Known baseline.** On 2026-09-25, on `main` at `fa2bab0`, in a Linux sandbox with headless
  Chromium, `pnpm e2e` passed 31 specs and failed 2: `chats.spec.mjs` ("the context of a chat with
  no known window is shown in tokens, without a percentage") and `orchestration-v2.spec.mjs`
  ("timed out waiting for the graph to stop running").
  - Re-run the suite on your machine before launching, so the verification phase is not blamed for
    failures that were already there.
  - If they reproduce, the `consistency` task reports them but doesn't have to fix them.
  - On 2026-09-25, on the launch machine, on `main` at `d6269c4` plus these docs, `pnpm e2e` passed
    both of those and failed 3 others in the full run: `config.spec.mjs` ("project-scope
    instructions shown"), `home.spec.mjs` ("every widget names itself with a heading") and
    `observability.spec.mjs` ("the worktree link uses the template and the host path"). All three
    passed when re-run on their own (`pnpm e2e config home observability`), so treat them as flaky
    under the full suite, not as breakage: re-run them alone before blaming the redesign.

## What "done" means

- **Every screen matches its reference**, on desktop and phone, in dark and light: structure,
  hierarchy, spacing, colour use and motion. The data is whatever the instance has.
- **Dark is the default** for a new install, and light and system still work.
- **No colour, radius or duration lives outside `tokens.css`**, and the guard test proves it.
- **The phone:** nothing scrolls sideways at 390 px, touch targets are ≥ 44 px, there are four tabs
  and a FAB, and no label is truncated in the tab bar.
- **The Home widgets render** on a browser whose language tag is POSIX-style.
- **Accounts reads in sentence case**, and its bars follow the thresholds.
- **Empty, error and system states** show their illustration as listed in each task, in both
  themes, with no duplicated ids, and still under reduced motion.
- **`pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e` are green**, apart from the baseline
  failures if they still reproduce.

## Outcome

Every task landed on 2026-09-25 (orchestration `e9acede9`). The details the implementation settled
differently are in the design system's [Landed](../design-system.md#landed) section. Before/after
pairs of the main screens are in [`docs/media/night-shift/`](../media/night-shift/README.md), and
the README's stills were re-recorded with `pnpm media`.

| Task | What landed |
| --- | --- |
| `foundation` | Geist and Geist Mono; the Night Shift tokens under the v1 names with v2 aliases; dark as the default and `system` stored explicitly; restyled primitives, a ring and dots `Spinner`, `.shimmer`; the token guard test; `intlLocale()` drops POSIX suffixes and validates the tag, so Home no longer crashes on `en-US@posix`; no more capitalised sentences in gauges and meters |
| `illustrations` | The 13 SVGs as React components behind `<Illustration name size tone />`, coloured by `styles/illustrations.css`, ids from `useId()`; `Empty` takes an illustration and keeps its compact version |
| `shell` | Grouped sidebar with a Live section, a leaner top bar with the live chip, the desktop status bar, four phone tabs and a FAB, the More sheet with a Start group; 404 and sign-in illustrated |
| `home` | Live hero, `kpis` and `limits` widgets in a top area, "In progress" with the page's one energy border, a compact state instead of the large empty block |
| `chats` | Table rows led by the first prompt, grouped by day; phone cards from a container query; no always-visible checkboxes on touch; bulk actions in a floating toast |
| `chat` | Header, transcript, composer with the energy border while working, inspector and New chat restyled; a workflow the chat started shows as a card under its step |
| `orchestration` | Card list, detail with KPI tiles, a pipeline stepper and task cards; `ProgressBar` segments and `Stepper` pipeline variants |
| `workspace` | Projects as cards, Accounts in sentence case with threshold-coloured bars, Connectors, Schedules with templates, Usage with KPI tiles as the metric picker |
| `settings` | 20 tabs in four groups: a side nav on desktop, cells on a phone; Appearance and Install redesigned |
| `desktop-pwa` | Electron splash, error page and title bar in the dark palette; `theme-color` and the PWA manifest |
| `consistency` | Cross-screen fixes (limits read the same in the status bar and Home, "no cost" wording, initials badges, calm bars, one primary per zone, FAB duplicates), `theme-color` follows the stored theme, `pnpm media` serves its own build |

**How it was checked.** The consistency task shot 31 routes at 1440 × 1024 and 390 × 844, in dark,
light and `motion=subtle` (186 screenshots) against a seeded sandbox and an empty one. It compared
them with the references and checked from the page itself:

- no duplicated SVG ids;
- no sideways scroll;
- no loop under `subtle`;
- no console errors;
- at most one illustration and one energy border per screen, and at most two gradient surfaces.

`pnpm typecheck` and `pnpm test` passed on every task branch. One core test ("two commands running
at once…", `processes.test.ts`) failed once under the full parallel run and passed alone, so it is a
timing flake unrelated to the redesign, which does not touch `packages/`. `pnpm e2e` runs once, in
the orchestration's verification phase on the merged branch.

**Follow-up pass.** A second pass on the merged branch closed what the tasks had left:

- Every place that shows a chat (sidebar Live, Home, the chat page, the palette, notifications)
  titles it by its first prompt through `displayTitle()` (in `@agentry/shared`, so the server's
  event and notification titles use it too); `ChatRef` gained an optional
  `firstPrompt` for that (additive, no route changes).
- One segmented bar: `ProgressBar variant="segments"` replaces `.segbar`, `.live-segbar` and
  `.chat-launch-bar`. Unused meter styles and account strings are gone.
- The inspector drawer is 344 px so its tab labels fit; Home's spend note wraps; the favicon and
  icons use the Night Shift gradient; sign-in uses the mono section label and opens without the
  skeleton flash.
- Orchestrations: Templates is a header button, the detail's phone `⋯` is a `Sheet` through the
  shared `MoreActions`, phone task cards are one line, the pipeline uses the reference's words, and
  the phone header sticks.
- Workspace on a phone: Schedules' actions in a `⋯` sheet, Usage's table toggle in the chart card
  and one big figure, exhausted accounts as one-line rows, rotation as its own screen, and the
  Connectors and Projects phone headers.
- Shell on a phone: the More sheet shows counts and problems, and `/chats` holds the project chip in
  its header (one `.project-selector` in the DOM).
- Schedule timetables are said in the UI language ([schedule words](../schedule-words.md)).
- A live chat lists its workflows from the stream and the CLI's files, and a chat that is a task of
  an orchestration links back to it. The flaky `processes.test.ts` case is deterministic now.

**Left for later**

- The `quota` illustration has no state to show on yet.

## Related

- [Design system](../design-system.md)
- [UI redesign (v1)](ui-redesign.md): the previous redesign; this plan keeps its live-activity model
  and motion rules.
- [Mobile](mobile.md): the PWA and the phone layout this plan restyles.

[[design-system.md]] · [[plans/ui-redesign.md]] · [[plans/mobile.md]]
