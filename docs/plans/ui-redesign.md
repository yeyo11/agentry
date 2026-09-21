# Plan: the UI redesign

Status: **planned**. Written on 2026-09-21 on top of `main` at `0598aea` (v0.15.0), to be run as one
orchestration. It redesigns the web UI (which is also what the desktop app shows) after a review of
the running app at 1440×900 and 390×844.

This document is the source of truth for every task of the orchestration that runs it. Where a task
prompt and this plan disagree, this plan wins. Where this plan and
[CONTRIBUTING.md](../../CONTRIBUTING.md) disagree, CONTRIBUTING wins.

## Why

What the review found, and what every task is fixing:

- **The chat page spends its height on chrome.** The header carries the title, up to four badges,
  eight buttons (Search, Subagent messages, Interrupt, Stop, Export Markdown, Export JSON, Fork,
  Delete) and a metadata line with the raw UUID: ~170 px on desktop, ~300 of 844 px on a phone. The
  footer of a resumable chat adds Permissions, Model, Tool preset and MCP servers selects with
  helper text under each: ~280 px, half of the transcript.
- **On a phone the chat is broken.** Under 1100 px `.run-stage` becomes `height: 62vh` and the page
  scrolls instead, so the composer is below the fold; the nine side cards end up under everything.
- **The transcript is noisy.** Every tool call repeats "Claude · model · time", so a turn with twenty
  tool calls reads as twenty identical rows.
- **Nothing shows what an agent is doing.** A working chat shows three bouncing dots and "Claude is
  working…". The live state uses the same orange as primary buttons, so what is alive does not
  stand out.
- **The top bar is crowded.** Project, search, notifications, language, theme, Run workflow and New
  chat on every page; on a phone that is seven squeezed icons ("All …", "E…"). Language and theme are
  set once and belong in Settings. "New chat" is also repeated in the Chats page header.
- **Lists overload each row.** A chat row carries six to eight badges; on a phone rows overflow to
  the right and get cut. The origin chips all look "on", so it is unclear they are filters. The
  filter block takes ~200 px on a phone. The Orchestrations page puts an empty "Templates (0)" card
  above the list, and every progress bar has the same gradient whether it completed or failed.
- **An orchestration's page hides its progress.** The full objective sits above the board and pushes
  it down; at 1440 px the fourth stage column is already cut off. There is no single place that says
  "11 of 17 done, on stage 3, this is what it is doing".
- **Home with a project selected is a tab strip** (Activity, Settings, Memory, Resources, Worktrees).
  It is going to be the project's dashboard, where documents, flows and other customisations are
  added later; its structure has to allow that now.

## Direction: OpenCode-like, alive

The chosen style is close to OpenCode's: a sober, terminal-flavoured tool for developers.

- **Little chrome.** Fewer cards, shadows and fills; thin 1px separators; a **coloured rail on the
  left** of a block instead of a box around it. Glass and gradients only where they already carry
  meaning (the brand mark, the primary button).
- **Monospace for data.** Tool names, paths, ids, branches, models, tokens, costs and durations are
  set in `--mono` with tabular numbers. Prose stays in `--sans`.
- **A status line.** Model · mode · tokens · cost, in one mono line, instead of labelled form fields.
- **Keyboard first.** The command palette reaches every action; lists move with `j`/`k`/`Enter`.
- **Motion says what is alive, in terminal terms:** braille spinners (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), text that
  types in, block progress (`▰▰▰▱▱`), a left rail that pulses while an agent works, numbers that
  count up. One new colour, `--live` (electric cyan), is reserved for "an agent is doing this right
  now"; the brand orange stays for actions.
- **Motion is a preference.** `full` (default), `subtle` (transitions only, no looping decoration),
  `off`. `prefers-reduced-motion: reduce` forces `off`. Loops pause while the tab is hidden. Only
  `transform` and `opacity` are animated.

## The one rule, again

Agentry reaches Claude Code **only through its CLI**: flags, subcommands, stream-json events, files
the CLI writes. No SDK, no HTTP call to Anthropic, no terminal scraping. Everything "live" below
comes from the stream-json events Agentry already reads. If a piece of a feature cannot be expressed
that way, leave it out and say so in your result instead of inventing a surface.

## Not in this orchestration

- **Editing the dashboard** (add, remove, reorder, resize widgets) and **persisting a layout per
  project.** This orchestration builds the widget registry and a fixed default layout generated from
  it, so editing and persistence are a later, additive step (see `dashboard`).
- **Documents and Flows widgets.** Same: they are future widget types for the registry. No
  placeholder or "coming soon" tile is shown for them.
- **A new visual identity.** The brand mark, the name, the orange accent and Inter/JetBrains Mono
  stay.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects,
   in English, body explaining why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with" trailer, ever.
3. **Code, comments, docs and UI strings in English** (Spanish goes only in the `es` locale files).
4. **Checks you run:** `pnpm typecheck` and `pnpm test`. You may *write or update* e2e specs, but
   **do not run `pnpm e2e`**: the verification phase runs the suite once on the integrated branch.
   Running it in parallel with other workers hangs it. The one exception is the `media` task, which
   drives a single sandboxed browser through the e2e driver, never the suite.
5. **Every long command under `timeout`**, e.g. `timeout 300 pnpm test`. If a command hits its
   timeout twice, stop retrying it and report it in your result.
6. **After touching `packages/shared/src/types.ts`**, run
   `pnpm --filter @agentry/api openapi:schemas` and commit the regenerated schemas. CI fails on
   drift.
7. **Every new route** needs a summary and a tag in `apps/api/src/openapi/routes.ts` and a row in
   the README REST API tables, which you add yourself.
8. **TypeScript strict, no `any`**, respect `noUncheckedIndexedAccess`. Comments explain why.
9. **Persistence:** settings-shaped documents in JSON files; streams and accumulating records as rows
   in SQLite (`packages/core/src/db.ts`). UI preferences (theme, motion, inspector open) stay in
   `localStorage`, like the theme does today.
10. **UI controls come from `apps/web/src/components/controls`**, never native
    `select`/`checkbox`/`range`/`date`/`details`/`title=`. Status is never colour alone: a state
    always has a word or an accessible name next to its colour, rail or spinner. Icon-only buttons
    carry an `aria-label`. Spinners and decorative motion are `aria-hidden`; what they mean is said
    once in text or with `role="status"`. Keep `e2e/specs/a11y.spec.mjs` green.
11. **Nothing is lost.** Every action and every piece of information the page has today stays
    reachable (in an overflow menu, the inspector, a sheet, the command palette). Moving it is the
    point; dropping it is a regression. Existing deep links (`?tab=…`, `?detail=…`, `?project=…`)
    keep working; where a query parameter is renamed, the old one redirects.
12. **Mobile is part of your task, not a later pass.** Check your pages at 390×844 and 768×1024:
    nothing scrolls sideways, touch targets are ≥ 44 px where a finger is the pointer
    (`@media (pointer: coarse)`), sticky bars respect `env(safe-area-inset-*)`.
13. **Do not touch files outside your scope.** Shared primitives land once, in `foundation`; shared
    types land once, in `live-activity`. Every other task builds on them. `README.md` (except the
    REST rows of rule 7), `ROADMAP.md`, `docs/*.md` and `docs/plans/*` are edited by the `docs`
    task: put your documentation notes in your result and let it write them. If you need a small
    change in a primitive, make it minimal, backwards compatible, and say so in your result.
14. **Every UI string has a key in `apps/web/src/i18n/locales/en` and `es`**, with parity; the
    untranslated-text guard in the web tests must stay green. Add keys to your own area's namespace
    (new namespaces are fine: `dashboard.json`, `shell.json`…) to keep merges clean.
15. **Update the e2e specs your change breaks** (selectors, labels, moved buttons) and add specs for
    what you build, without loosening an assertion to make it pass. Say in your result which specs
    you touched.
16. If something in your scope turns out to be impossible over the CLI, or much larger than it
    looks, **do the rest and say what you left out** in your result. Do not silently narrow the
    scope.

## Stage 0 — foundations, in parallel

### `live-activity` (types, core, API)

What an agent is doing right now, for every surface that is not the chat's own stream: list rows,
Home widgets, orchestration tasks, the top bar.

Add to `packages/shared/src/types.ts`, exactly this shape (the web's `foundation` task builds a
presentational component against the same shape in parallel):

```ts
/** What a live execution is doing right now, from its latest stream-json events. */
export interface ChatActivity {
  /** `tool`: a tool call without its result yet; `writing`/`thinking`: a text or thinking block is streaming; `waiting`: blocked on a permission prompt */
  kind: 'tool' | 'writing' | 'thinking' | 'waiting';
  /** The CLI's tool name (`Edit`, `Bash`, `Grep`, `Task`…) when `kind` is `tool` */
  tool?: string;
  /** A short human label for the tool's input: a path relative to the chat's cwd, a command's description or its first 80 characters, a pattern, a subagent's description, a URL's host */
  target?: string;
  /** When this activity started (ISO) */
  since: string;
}
```

- `ChatSummary.activity?: ChatActivity | null` — set while the chat has a live execution, `null`
  otherwise.
- `OrchestrationTaskState.activity?: ChatActivity | null` — the running task's worker.
- Core derives it from the stream-json events of the live execution (read how `packages/core` turns
  events into `RunEvent`s and chat state). Deriving `target` from the tool input is a pure,
  unit-tested function.
- **Delivery:** list pages and Home stay current through the event feed (`apps/web/src/lib/events.ts`
  and its server side). Publish activity changes on the feed **throttled to at most one event per
  chat per second**, carrying the new `ChatActivity`, so the web can patch it into the query cache
  instead of refetching lists. Document the event in the feed's types.
- Tests: the derivation (tool call → activity, result → cleared, permission prompt → `waiting`,
  streaming text → `writing`), the throttle, and that the fields appear in the chat list and
  orchestration responses.

### `foundation` (web: styles, tokens, motion, primitives)

Everything the page tasks share. Page tasks must not re-implement any of it.

1. **Split `apps/web/src/styles.css` (4 200 lines) by area**, as a first, separate commit that
   changes no rendered pixel: `styles/tokens.css`, `base.css`, `shell.css`, `primitives.css`,
   `feedback.css`, `lists.css`, `transcript.css`, `chat.css`, `orchestration.css`, `editors.css`,
   `overlays.css`, `motion.css`, and the area rules of today's "Responsive" and "Reduced motion"
   sections moved next to their area. Keep the existing `chats.css`, `observe.css`, etc. Import
   order preserved. This is what lets five page tasks run in parallel without conflicting on one
   file: each page task edits its own area file.
2. **Tokens for the direction above**, dark and light with parity: flatter surfaces (less shadow,
   border-first), `--live` / `--live-soft` (electric cyan, WCAG AA on both themes for text use),
   `--rail-w`, a slightly tighter radius scale, `--statusbar-h`, motion tokens (durations, easings,
   spinner frame time). Restyle `StatusBadge`/`Tag`/`.badge` to the quieter look (dot + word, mono
   small caps-free text, no heavy fill) keeping their API.
3. **Motion preference** `full | subtle | off`, built like the theme (`apps/web/src/lib/theme.tsx`):
   stored in `localStorage`, stamped as `data-motion` on `<html>`, forced to `off` by
   `prefers-reduced-motion`. `useMotionLevel()` for `motion/react` code. CSS: `off` behaves like
   today's reduced-motion block; `subtle` stops every infinite decorative animation (rails, energy
   border, particles, spinner falls back to a static glyph) and keeps transitions. Loops are paused
   while `document.hidden`. The controls to change it are built by `shell` (Settings → Appearance);
   this task exports what they need.
4. **Primitives**, each with a unit test where it has logic, all respecting the motion level:
   - `Spinner`: braille frames in mono, `aria-hidden`.
   - Live surfaces: a `.live-rail` class (left rail in `--live` that pulses) and a `.live-energy`
     class (a thin rotating `conic-gradient` border, for the one most important live surface of a
     page; use sparingly).
   - `ProgressBar`: segmented by status counts (`done`, `running`, `failed`, `pending`, `skipped`),
     `variant: 'bar' | 'blocks'` (`▰▰▰▱▱` in mono for compact places), accessible name like
     "11 of 17 tasks done, 1 failed".
   - `Stepper`: steps with `done | current | pending | failed | skipped | waiting` states, a label
     and an optional meta line; horizontal when its container is wide, vertical (a timeline) when
     narrow (container query); steps are buttons when `onSelect` is given; the current step shows
     the spinner. A `compact` variant for widgets.
   - `AnimatedNumber`: counts from the previous value to the new one, tabular numbers, formatting
     passed in.
   - `ActivityTicker`: renders a `ChatActivity`-shaped value (declare a local structural type with
     exactly the shape given in `live-activity`, so both tasks can land independently): spinner,
     a verb from the tool (`Edit`/`Write` → "Editing", `Read` → "Reading", `Bash` → "Running",
     `Grep`/`Glob` → "Searching", `Task`/`Agent` → "Delegating", `WebFetch`/`WebSearch` →
     "Browsing", `writing` → "Writing", `thinking` → "Thinking", `waiting` → "Waiting for you"),
     the target in mono, and the elapsed time; the text changes with a short slide/fade; one line,
     ellipsis. `aria-live="polite"`, rate-limited so a screen reader is not flooded.
   - `Menu` in `components/controls` (Radix dropdown menu, like the other controls): items, groups,
     separators, destructive items, disabled items with a reason.
   - `SplitButton`: a primary action with a menu of related ones.
   - `Sheet` in `components/controls`: a bottom sheet on narrow screens and a side panel on wide
     ones, focus-trapped, Escape and scrim close it, focus returns to the opener, drag-to-dismiss on
     touch where cheap.
   - `ListToolbar`: search field; status tabs with counts (the `Segmented` control); a "Filters"
     button with the number of active filters that opens a popover on desktop and a `Sheet` on
     mobile, whose facet sections the caller supplies; a sort select; the active filters as
     removable chips ("Origin: Terminal ×"); "Reset". URL state stays with the caller.
5. Tests for every primitive with logic (step state derivation, progress segments, ticker verb
   mapping) and an a11y pass over a page that renders them.

## Stage 1 — the pages, in parallel

### `shell` (deps `foundation`)

`apps/web/src/App.tsx`, the sidebar, the top bar, navigation on mobile, Settings → Appearance, the
command palette.

- **Top bar**, one row: page crumb; project selector; search (opens the palette); notifications; a
  **live chip** when something runs ("⠹ 2 working · post-roadmap 11/17") that opens a small menu of
  what is live and links to it; and a `SplitButton` "New chat ▾" (New chat · Run workflow · New
  orchestration). Language and theme leave the top bar.
- **Settings → Appearance**, a new first tab: theme, language, motion level (full/subtle/off), with
  the reduced-motion override explained when it applies.
- **Sidebar, OpenCode-like:** the navigation, then a **Live** section listing working and waiting
  chats and running orchestrations (title, spinner or "waiting" word, ticker line from
  `ChatSummary.activity` when there is room, progress blocks for orchestrations), each a link. The
  rail (collapsed) mode keeps working and shows the live count.
- **Mobile (< 900 px):** a **bottom tab bar** (Home · Chats · Orchestrations · ＋ New · More) replaces
  the hamburger; "More" opens a `Sheet` with the rest of the navigation, API reference and the
  connection status. Badges for working/waiting counts on the tabs. The top bar keeps crumb, project,
  search and notifications. The bottom bar hides on `/chats/:id` and `/orchestration/:id`, which have
  their own back button and sticky footer.
- **Desktop shell hook** (for the `desktop` task): when `window.agentryDesktop` exists, stamp
  `is-desktop` and `desktop-<platform>` on `<html>`; the top bar becomes the window's drag region
  (`app-region: drag`, interactive children `no-drag`) and leaves room for the window controls
  using `env(titlebar-area-x/width)` when available.
- The command palette gains: theme, language, motion level, "New orchestration", and a "Live" group
  with what is running.
- The page headers of other pages no longer repeat "New chat"; the page tasks remove their own
  duplicates.

### `chat` (deps `foundation`, `live-activity`)

`ChatView`, `pages/chat/*`, `Transcript`, `NewChat`, the chat CSS.

- **Header, one line (~48 px):** back · title · one **state pill** that merges state, control mode
  and stream connection (spinner + "Working · live"; the reconnecting state only shows after 3 s
  disconnected, so it does not flap) · Search (icon) · the contextual primary (`SplitButton` "Stop ▾"
  with Interrupt while interactive and working) · `ⓘ` inspector toggle · `⋯` `Menu` with Export
  Markdown, Export JSON, Fork, Subagent messages (toggle), Copy id, Delete (disabled with its reason,
  as today). The metadata line and the UUID move into the inspector.
- **Composer, a pill:** attach icon · auto-growing textarea · icon send button. Under it a **status
  line** in mono: `opus-5 · bypassPermissions · no preset · MCP: CLI default ⌄`. Clicking it opens a
  popover (a `Sheet` on mobile) with what `LiveSettings`/`StartOptions` offer today (permission mode,
  model, tool preset, MCP servers); helper texts become tooltips or short hints inside the popover.
  While the chat works and the box is empty, the send button becomes an interrupt button (■).
  The composer gets `.live-energy` while the agent works.
- **Inspector** instead of nine stacked cards: tabs Summary (context and cost with `AnimatedNumber`,
  facts, metadata), Activity (the checklist as a vertical `Stepper` from
  `api.chatChecklist`, executions, activity card), Changes, Environment (branches, health, tools,
  environment). Open/closed remembered. A collapsible right panel ≥ 1100 px, a `Sheet` below.
- **Transcript:** the author line only when the author changes; timestamps on hover/focus; runs of
  consecutive tool calls grouped into a **step** block ("7 tools · 42 s", collapsed once done,
  expanded and `.live-rail` while current); tool rows in mono with a rail coloured by outcome;
  "Claude is working…" replaced by the `ActivityTicker`, fed by the chat's own stream (the
  `RunEvent`s `useChatStream` already receives), falling back to `ChatSummary.activity`. The
  streaming block gets a glowing caret. Where a `Task`/`Agent` call's sidechain messages are
  available to the page, clicking the call opens them in the inspector (OpenCode's subagent pane);
  if the data is not there without a new route, say so and leave it out.
- **Checklist progress** in the header area when the chat has one: `ProgressBar` blocks "3/7" with
  the current item on hover/focus.
- **Mobile:** the page is `100dvh`: sticky 44 px header, the transcript scrolls, the composer is
  sticky at the bottom with `safe-area-inset-bottom` and follows the on-screen keyboard
  (`visualViewport`). This removes the `62vh` rule and its comment's problem: `.run-scroll` stays
  the scroller at every width (the windowed log must measure a real viewport).
- **New chat:** the prompt first and large, the attach control inside it; working directory, model,
  permission mode, system prompt and the rest under an "Advanced options" `Collapsible`, closed by
  default, open if any of them is set.

### `orchestration` (deps `foundation`, `live-activity`)

`Orchestration.tsx` (list and form), `OrchestrationDetail.tsx`, `OrchestrationBoard.tsx`,
`WorkflowCard`, `VerificationCard`, `RelaunchPanel`, their CSS.

- **Detail as a stepper.** A sticky summary: name, status pill with spinner, live elapsed clock,
  cost (`AnimatedNumber`), a segmented `ProgressBar` of the tasks, and the contextual primary (Stop
  while running, "Edit and relaunch" when finished) with the rest (Save as template, Delete…) in a
  `Menu`. The objective collapses to three lines with "Show more".
- **Steps** = the stages of the dependency graph (today's `layerTasks`: "Stage 1 · 2/2"), then
  Verification (when the spec has one), Integration (worktree graphs), Pull request (when there is
  one or it can be opened), Synthesis (when `synthesize`). Each step's state is derived from its
  tasks and phases, in a pure, unit-tested function. The stepper **follows the current step**;
  selecting another step stops following and shows "Back to live".
- **The selected step's panel:** for a stage, its tasks as rows with `.live-rail` and
  `ActivityTicker` (from `OrchestrationTaskState.activity`) while running, live duration, cost,
  attempts, outcome, and every action `TaskCard` has today (re-run, work, chat, fork, hint, waiting
  notice, failed-by-checks notice). Clicking a task opens its chat in the existing detail panel
  (`?detail=…`) instead of navigating away. For Verification, Integration, Synthesis: today's cards.
- **Graph view:** today's board stays as `?view=graph`, with dependency connectors that flow while
  their downstream task runs and task nodes that fill with progress; it scrolls horizontally inside
  its own box instead of being cut.
- **Workflow engine** orchestrations keep their `WorkflowCard`, placed in the same summary + panel
  frame; build steps from the workflow's phases if the data has them, otherwise show it as one step.
- **List page:** `ListToolbar` (status tabs with counts, search, sort); rows with the segmented
  `ProgressBar` and, while running, spinner and "stage 3 · web-chats-tools: Editing src/…"; templates
  move to a "Templates" tab of the page (with its count) instead of a card above the list. The
  "New orchestration" form keeps every field; on mobile it is one column with advanced options
  collapsed.
- **Mobile:** the stepper is the vertical timeline with only the current step expanded.

### `lists` (deps `foundation`, `live-activity`)

`Chats.tsx`, `Schedules.tsx` (list part), `Projects.tsx`, `Accounts.tsx` (list part),
`Connectors.tsx`, `lib/chat-model.ts`, the lists CSS.

- **Chats:** `ListToolbar` with state tabs and counts (All · Working · Waiting for you · Idle), search,
  sort, and Filters: origin, project (when All projects), model, orchestration workers, internal. Active
  filters as removable chips. When sorted by activity, **grouped by day** (Today, Yesterday, This week,
  Earlier) with sticky group headers.
- **Chat rows, two lines:** a state rail/dot + title + time on the first; the first prompt (muted),
  project, and at most two tags (control mode when it matters, fork/worktree) on the second; on the
  right a small context ring and the cost. The model and branch show on hover/focus and in the chat.
  Working rows show the `ActivityTicker` from `ChatSummary.activity` in place of the first prompt.
  No row overflows sideways at 390 px.
- **Keyboard:** `j`/`k` move, `Enter` opens, `x` selects; **multi-select** with a bulk bar (Export
  Markdown, Delete). Bulk delete confirms once, calls the existing delete per chat, skips live or held
  chats and says which and why. No new route.
- Replace "Show more" with the existing `VirtualList` if it fits the grouped list; otherwise keep
  paging and say why.
- **Schedules, Projects, Accounts, Connectors:** the same `ListToolbar` where the page has a list
  with filters or search, and the same row language (rail, two lines, mono data). Remove the
  duplicated "New chat" from the Chats header (the top bar has it).

### `dashboard` (deps `foundation`, `live-activity`)

`Home.tsx`, `pages/home/*`, a new `pages/dashboard/*`, their CSS.

Home becomes a **dashboard of widgets**, built so that editing and persisting a layout later is
additive:

- **Registry** (`pages/dashboard/registry.ts`):
  `WidgetDefinition { type, titleKey, sizes: ('s'|'m'|'l'|'full')[], defaultSize, scope: 'project'|'global'|'both', component (lazy where heavy) }`
  and a layout as data: `DashboardLayout { version: 1; widgets: Array<{ id: string; type: string; size: WidgetSize; config?: Record<string, unknown> }> }`.
  `defaultLayout(scope)` returns the fixed layout this orchestration ships. The page renders any
  layout, validating unknown types away, so a stored layout can replace the default later. Unit
  tests for the registry and the validation.
- **Grid:** 12 columns on desktop, 6 on tablet, 1 on phones; `s/m/l/full` map to spans.
- **Widgets for a project:** Now (working and waiting chats with `ActivityTicker`; a waiting
  permission is answerable from its notification as today), Orchestration (the running or latest one:
  compact `Stepper` + `ProgressBar`), Pick up again, Limits (today's rings), Upcoming schedules,
  Worktrees (compact; opens the full view), Memory (the project's instructions excerpt; opens the
  editor), Resources (counts per kind; opens the full view), Quick start (a prompt box that starts a
  chat in the project, with the same status-line options as the chat composer, collapsed).
- **All projects:** Now, Orchestrations, Pick up again, Limits, Upcoming schedules, Projects (each
  project's live count and last activity).
- The project page header: name, path (mono, copy), git branch if known, a ⚙ that opens the project
  settings. **Settings, Memory, Resources and Worktrees stay as full views** at
  `/?view=settings|memory|resources|worktrees`, reached from the ⚙ and from their widgets; the old
  `?tab=` values redirect to them. Unsaved-changes guarding (`lib/dirty`) keeps working.
- Today's `pages/home/Activity.tsx` content is redistributed into widgets; nothing it shows is lost.
- In your result, write a short "how to add a widget" note for the `docs` task.

## Stage 2 — the desktop shell

### `desktop` (deps `shell`)

`apps/desktop/src/*`, `docs/desktop.md` notes in the result (the `docs` task writes them).

- **Integrated title bar:** `titleBarStyle: 'hidden'` with `titleBarOverlay` on Linux and Windows
  (traffic lights on macOS), colours following the theme: expose `setTitleBarTheme` through the
  preload (keep the preload surface minimal and typed) and call it from the web when the theme
  changes (`shell` stamped `is-desktop`; add the small web call yourself in `lib/theme.tsx`, guarded
  by `window.agentryDesktop`).
- **Tray:** an icon whose tooltip says what is live ("2 working · 1 waiting"), with a menu: Open
  Agentry, New chat, the live items (open them), Quit. Data from the local server the app started
  (`/api/overview` and the event feed), never from Claude directly.
- **Progress:** `win.setProgressBar()` with the running orchestrations' combined fraction (cleared
  when none), and `app.setBadgeCount()` with chats waiting for a person, where the platform supports
  them.
- Tests for whatever logic is pure (building the tray menu and tooltip from an overview, the
  progress fraction).

## Stage 3 — media and docs

### `media` (deps `chat`, `orchestration`, `lists`, `dashboard`, `desktop`)

Re-record the README media with `scripts/record-media.mjs` (`pnpm build && pnpm media`), adapting
the script's navigation to the new UI (bottom tab bar on its mobile stills if it has any, the
dashboard as Home, the stepper on the orchestration still, a working chat showing the ticker). Add a
mobile still of the chat. Commit the regenerated files under `docs/media`.

### `docs` (deps `media`)

README (screens, the new Home/dashboard, Appearance settings, keyboard shortcuts, desktop tray),
`ROADMAP.md` (move this work to Done; add "Dashboard: editable layout persisted per project;
Documents and Flows widgets" to Next), `docs/desktop.md`, and this plan's **Outcome** section:
what each task delivered, what it left out and why, from their results.

## Launch settings

```json
{
  "name": "ui-redesign",
  "engine": "graph",
  "worktree": true,
  "model": "opus",
  "permissionMode": "bypassPermissions",
  "permissionPrompts": "none",
  "concurrency": 4,
  "maxAttempts": 2,
  "synthesize": true,
  "limits": { "maxMinutes": 150 },
  "verification": {
    "commands": ["pnpm install --frozen-lockfile", "pnpm build", "pnpm e2e", "node --test e2e/harness.test.mjs"],
    "fixer": true,
    "maxAttempts": 2,
    "timeoutMinutes": 25
  }
}
```

Tasks and dependencies:

| Task | Depends on |
| --- | --- |
| `live-activity` | — |
| `foundation` | — |
| `shell` | `foundation` |
| `chat` | `foundation`, `live-activity` |
| `orchestration` | `foundation`, `live-activity` |
| `lists` | `foundation`, `live-activity` |
| `dashboard` | `foundation`, `live-activity` |
| `desktop` | `shell` |
| `media` | `chat`, `orchestration`, `lists`, `dashboard`, `desktop` |
| `docs` | `media` |

## What "done" means

`pnpm typecheck`, `pnpm test`, `pnpm build` green on the integration branch; `pnpm e2e` (including
`a11y` and `mobile`) and `e2e/harness.test.mjs` green once at the end; the OpenAPI schemas
regenerated; the media regenerated from the script; every page usable at 390×844 without sideways
scrolling; and every task's result saying plainly what it delivered, what it left out, and how it
verified it.

## Outcome

Written by the `docs` task when the orchestration ends.
