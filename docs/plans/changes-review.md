---
created_at: 2026-09-27T20:00:00Z
updated_at: 2026-09-27T20:00:00Z
tags:
    - plan
    - ui
    - web
    - api
    - core
    - diff
---
# Plan: review changes inside Agentry, without an editor

Redesign the Changes screen around a diff comparator of our own, and remove Agentry's dependency on
the person's editor. This plan is the source of truth for the `changes-review` orchestration,
together with CLAUDE.md, CONTRIBUTING.md and [docs/design-system.md](../design-system.md) (§5 is the
comparator). Where a task prompt and this plan disagree, the plan wins; where the plan and the
design system disagree on a visual detail, the design system wins.

The target look is in `docs/design-system/reference/`. Open `index.html`, section **Changes**:

| Prototype | What it shows |
|---|---|
| `DSComparador` | the rules, the three modes, the tokens, every piece and state |
| `DiffView` | the comparator on its own (the Tweaks of the live canvas switch file and mode) |
| `DesktopCambios` | the review screen, Result lens, Reading mode, while the agent still works |
| `DesktopCambiosLado` | the same screen in Side by side, with the file list folded into a rail |
| `DesktopCambiosPasos` | the Step by step lens |
| `DesktopChatCambios` | the chat page: the inspector's Changes tab, and the edit chips in the transcript |
| `MobileCambios`, `MobileDiff`, `MobilePasos` | the same on a phone |

Each has `<Screen>.html` (add `#light` for the light theme) and `screenshots/<Screen>-dark.webp` and
`-light.webp`. The sample data is a real diff: a branch that adds `?context=` to the per-file diff.
Its structure, hierarchy, spacing, colour use and motion are the spec; the data is illustrative.

## Why

An audit of `main` at `6ef0aec` (1440 px and 390 px, seeded with a worktree of three commits and
two uncommitted files) found this:

- **A diff is raw `git diff` text.** The file opens in an 820 px drawer as a highlighted code
  block: `diff --git`, `index` and `---`/`+++` headers, no line numbers, long lines wrapped into
  the next row, and the block capped at 60 vh, so half the drawer stays empty.
- **Reviewing sends you out of Agentry.** Every file and every hunk carries a `vscode://` link,
  the summary has "Open the worktree in the editor", and a button copies `code --diff …` for a
  terminal. All of it needs Settings → Editor (a link template, a diff command and a
  container-to-host path map, stored on the server as `editor.json` behind `/settings/editor`), and
  none of it works when the wrapper runs in a container, on another machine, through the tunnel or
  on a phone.
- **On a phone the diff is invisible.** Tapping a file opens the drawer behind the inspector sheet
  (the sheet sits at `z-index: 1160`, the drawer at `auto`).
- **The inspector tab is cramped.** Each file takes three or four lines (path, badge, counts, a
  link icon), and the commits take a third of the panel before the first file.
- **A chat outside a worktree shows nothing to read**: a list of touched files, although its
  transcript holds the patch of every edit (`toolUseResult.structuredPatch`).
- **Nothing says why a file changed**, although the agent wrote it in the conversation right
  before each edit.

## Direction

One review screen for a chat, a task and the integration branch, with two lenses:

- **Result** (`Resultado`): the net change against the branch's base, file by file, in three
  modes. **Reading** (`Lectura`, the default) shows the file as it is now, with a 3 px rail on what
  is new, and folds what was removed into a pill (`−2`) on the rail that opens it in place.
  **Unified** interleaves before and after with both line numbers. **Side by side** puts matched
  lines face to face and hatches the padding of the shorter side.
- **Step by step** (`Paso a paso`): every edit the agent made, in order, each with its own patch
  and the sentence it wrote just before it.

The rules that keep it quiet are in design system §5: only what changed carries colour (syntax is
muted and never uses green, red or cyan; context is dimmed; the changed words of a line share one
mark), what was removed folds away, one line gets one rail, and every change carries its why.

Around it: a **change fingerprint** (one segment per file, as wide as its churn), a **file map**
(the tree, with seen, uncommitted and "Claude is editing it now"), a **block rail** (the file to
scale, a mark per block, the viewport as a box) and keyboard navigation. Everywhere else
(inspector, task panel, integration card) shows a **compact summary** that opens the review.

Decisions already taken, not to be reopened by a task:

1. **The editor integration goes away, entirely.** `EditorLinks`, `lib/editor`, `lib/editor-sync`,
   Settings → Editor, `GET`/`PUT /settings/editor`, core's `editor-settings`, the
   `EditorSettings*` types, their OpenAPI entries, tests and e2e. An `editor.json` left on disk is
   ignored: no migration and no deletion. `/settings?tab=editor` opens the first tab on a desktop
   and the settings list on a phone, as any unknown tab does.
2. **No diff library.** The browser parses the unified diff git already prints (`lib/diff.ts`), and
   the word diff is our own token LCS (`lib/word-diff.ts`). The existing highlighter
   (`components/highlight`) colours the code, through a new export that returns its roles instead
   of hex: the comparator maps them onto the muted `--sx-*` tokens, and a language only shiki knows
   stays plain inside a diff.
3. **One screen, three routes**: `/chats/:id/changes`, `/orchestration/:id/tasks/:taskId/changes`
   and `/orchestration/:id/changes` (the integration branch). `?file=`, `?mode=`, `?lens=steps` and
   `?step=` are deep links. The screen hides the phone's tab bar, like a chat.
4. **Reading is the default mode.** The mode is remembered per browser (`agentry-diff-mode`).
   Side by side needs 1100 px of diff; below that it falls back to Unified. A phone offers Reading
   and Unified, and wraps long lines instead of scrolling sideways.
5. **"Seen" is a per-browser convenience**, kept in `localStorage` per source and file, keyed with
   a hash of the file's diff, so a file that changes again is unseen again. It is never sent to the
   server and a failed read or write of the storage is ignored.
6. **Step by step comes from the transcript, not from a model.** A step is a successful `Edit`,
   `MultiEdit`, `Write` or `NotebookEdit` call of the chat's main transcript (not its sidechains),
   its patch is the `structuredPatch` the CLI stored with the result, and its intent is the last
   assistant text before the call, clipped to 280 characters. A step's path is relative to the git
   top level when the chat works in a checkout (so it matches `ChangedFile.path`), and to the chat's
   directory otherwise. A chat outside a worktree opens on this lens, with Result disabled and
   saying why.
7. **The API only grows, and only optionally**: `context`, `commit` and `uncommitted` query
   parameters, a `steps` route per chat and per task, `FileDiff.full`, `ChangedFile.binary` and
   `ChangeSummary.working`. Clients that send none of it get what they get today.

## Not in this orchestration

- Comments on lines, staging, reverting, committing or editing files from the UI, blame, and
  syntax-aware (AST) diffs.
- The edits of a chat's subagents (sidechains) in Step by step.
- Syncing "seen" across browsers or people.
- A diff of two arbitrary commits, or of a chat against anything but its own base.

## Rules every task follows

1. **Work only inside your worktree, on your branch.** Commit with Conventional Commits subjects
   (`feat(web): …`, `feat(api): …`, `refactor(core): …`), in English, with a body that explains
   why. Never push. Never merge another task's branch yourself.
2. **No AI attribution in commits.** No `Co-Authored-By` and no "Generated with" trailer, ever.
3. **Code, comments and docs are in English.** UI strings live in `apps/web/src/i18n/locales/en`
   and `es` with parity; the `es` copy follows `apps/web/src/i18n/GLOSSARY.md`. The prototypes show
   the intended `es` copy; write the `en` equivalent. The lens and mode names are Result / Step by
   step and Reading / Unified / Side by side in `en`.
4. **Checks you run:** `timeout 600 pnpm typecheck` and `timeout 600 pnpm test`.
   - You may write or update e2e specs, but **do not run `pnpm e2e`**, except in the
     `consistency` task, which runs alone. Running it in parallel with other workers hangs it.
5. **Every long command runs under `timeout`.** If a command hits its timeout twice, stop and
   report it.
6. **TypeScript strict and no `any`.** Respect `noUncheckedIndexedAccess`. Comments explain why.
   The diff and word-diff logic is pure and unit-tested; components stay thin.
7. **The design system applies in full** (CLAUDE.md, "Design system"): tokens only, dark first and
   both themes, one energy border per screen (the review screen has none: the live rail on the
   file being edited is enough), status never by colour alone, UI controls from
   `components/controls`, icon-only buttons with an `aria-label`, `a11y.spec.mjs` green.
8. **New components take prefixed classes, not the reference's short names.** The reference draws
   the comparator with `.dv-*`, `.fp`, `.fmap`, `.frow`, `.step` and `.why`; the app uses the
   names in design system §2 (`.diff-*`, `.changes-*`, `.edit-step*`). `.change`, `.change-list`,
   `.change-added` and `.change-removed` already exist in `styles/editors.css` for Settings: don't
   reuse or restyle them.
9. **Keep the e2e hooks that survive, and give the new ones stable names.**
   - `observability.spec.mjs` reads `.obs-changes` (and its text: the branch, the base, "1 commit
     ahead", the commit's subject, "Not committed yet"), `.obs-file`, `.obs-file-name`, `.obs-add`,
     `.obs-del`, `.obs-file-row .sr-only` and `[role=dialog] .obs-diff pre.code[data-lang="diff"]`.
   - The compact summary keeps `.obs-changes`, `.obs-file`, `.obs-file-name`, `.obs-add`, `.obs-del`
     and the counts' sentence for a screen reader. The base, the commits and "Not committed yet"
     move to the review screen's header and scope menu, and the dialog goes away: `remove-editor`
     moves those assertions to the review screen.
   - `chat-page.spec.mjs` (around line 91) opens the inspector's Changes tab: it stays.
   - New hooks, used by both `summary` and `review`: `.changes-review-link` (the "Review the
     changes" link), `.changes-review` (the screen), `.changes-file`, `.diff`, `.diff-row`,
     `.diff-fold-pill`, `.diff-gap` and `.edit-step`.
10. **A long diff never freezes the page.** Rows are virtualised with `@tanstack/react-virtual`
    (already a dependency) past 400 rows; word diffs are computed per visible block and cached by
    the block's text; a diff over 5 000 lines is never requested with `context=full`.
11. **Compare with the reference before you finish.** Don't use `e2e/run.mjs` for this: it is
    `pnpm e2e`, on a fixed port. Run your own instance: the API with `PORT` set to a free port,
    `AGENTRY_DATA_DIR` and `CLAUDE_CONFIG_DIR` on scratch directories, and Vite with `--port` on
    another free port and `VITE_API_TARGET` pointing at your API. Seed a worktree chat like
    `e2e/specs/observability.spec.mjs` does. Screenshot your screens at 1440 × 1024 and 390 × 844,
    dark and light, with headless Chrome (`CHROME_BIN`), and fix what drifts from the reference.
12. **Don't touch files outside your scope** (ownership below). If you need something from another
    task's file, say so in your result instead of editing it.
13. If something in your scope turns out to be impossible, or much larger than it looks, **do the
    rest and say what you left out**. Don't silently narrow the scope.

## File ownership

| Task | Owns |
|---|---|
| `api` | `packages/shared/src/types.ts` (the change types only: `DiffContext`, `FileDiff.full`, `ChangedFile.binary`, `EditStep`), `packages/core/src/git.ts`, `packages/core/src/changes.ts`, `packages/core/src/edit-steps.ts` (new), `packages/core/src/sessions.ts` (the new `editSteps` reader only), `packages/core/test/changes*.test.ts`, `packages/core/test/edit-steps.test.ts` (new), the changes routes in `apps/api/src/routes/chats.ts` and `orchestrations.ts`, `apps/api/src/openapi/routes.ts` and `schemas.json` (additions), `apps/api/scripts/generate-schemas.ts`, `apps/api/test/changes*.test.ts`, `apps/web/src/api.ts` (the change functions and `keys`) |
| `diff-lib` | `apps/web/src/lib/diff.ts` (new), `apps/web/src/lib/word-diff.ts` (new), `components/highlight.ts` (a new export with roles, and the language of a path), `apps/web/test/diff.test.ts`, `word-diff.test.ts` and `diff-view.test.tsx` (new), `apps/web/test/fixtures/*.diff` (new), `apps/web/src/components/changes/DiffView.tsx`, `BlockRail.tsx` and `Fingerprint.tsx` (new), `apps/web/src/styles/diff.css` (new) and its import in `styles.css`, the `--diff-*` and `--sx-*` tokens in `styles/tokens.css` |
| `review` | `apps/web/src/pages/ChangesReview.tsx` (new), `components/changes/**` (except the three files of `diff-lib` and `steps/**`), `App.tsx` (the three routes only), `lib/shell-live.ts` (`hidesTabBar`) and `apps/web/test/shell-live.test.ts`, `lib/review-state.ts` (new: mode and seen), `i18n/locales/*/changes.json` (new namespace) and its registration in `i18n/resources.ts`, `e2e/specs/changes-review.spec.mjs` (new) |
| `summary` | `components/observe/Changes.tsx` (rewritten as the compact summary), `components/observe/Work.tsx`, `pages/chat/Inspector.tsx` (the Changes tab), `components/Transcript.tsx` (the edit chips and the props they need), `pages/ChatView.tsx` (the steps query and what it passes to `Transcript`), `observe.css` (the change rules), `i18n/locales/*/observe.json` (`changes.*`) and `chat.json` (the chips) |
| `steps` | `components/changes/steps/**` (new), the Step by step mount point in `pages/ChangesReview.tsx`, `pages/ChatView.tsx` (the `?at=` jump only, after `summary`), `i18n/locales/*/changes.json` (`steps.*`) |
| `remove-editor` | deletes `components/observe/EditorLinks.tsx`, `lib/editor.ts`, `lib/editor-sync.ts`, `pages/config/EditorTab.tsx`, `apps/web/test/editor.test.ts`, `packages/core/src/editor-settings.ts`, `packages/core/test/editor-settings.test.ts`, `apps/api/src/routes/editor.ts`, `apps/api/test/editor.test.ts`; edits `pages/Settings.tsx`, `apps/web/src/api.ts` (the editor functions and `keys.editor`), `lib/observe.ts` (`Hunk`, `hunksOf`) and `apps/web/test/observe.test.ts`, the editor rules left in `observe.css` (`.obs-map*`, `.obs-hunks`, the header comment), `i18n/index.ts` (its comment), `i18n/locales/*/observe.json` (`editor.*`), `packages/core/src/index.ts`, `apps/api/src/app.ts`, `packages/shared/src/types.ts` (`EditorSettings*`), the OpenAPI routes and schemas and `apps/api/scripts/generate-schemas.ts`, `e2e/specs/observability.spec.mjs`, `scripts/record-media.mjs` (it opens the old diff dialog), and the editor-link lines of `README.md` and `ROADMAP.md` |
| `consistency` | any web file, for cross-screen fixes only, after every other task has landed |
| `docs` | `docs/**`, `README.md` (except the editor lines, which `remove-editor` takes), `CONTRIBUTING.md` |

Web paths are under `apps/web/src/` unless they say otherwise.

## Stage 0: the data and the comparator, in parallel

### `api` (context, a commit or the uncommitted work, and the steps)

- **Types** (`packages/shared`).
  - `type DiffContext = number | 'full'`.
  - `FileDiff.full: boolean`: true when the diff carries the whole file.
  - `ChangedFile.binary?: boolean`: true when `--numstat` printed `-` for both counts.
  - `ChangeSummary.working?: ChangedFile[]`: every file that differs between the base and the
    working tree (committed or not, untracked included), with those counts. It is what the default
    diff of a file shows, so the review's "All the work" lists these files with these counts;
    `files` and `uncommitted` stay as they are for the scopes and for today's clients.
  - `EditStep`: `id` (the `tool_use` id), `index` (1-based order), `at` (ISO or null), `tool`
    (`Edit` | `MultiEdit` | `Write` | `NotebookEdit`), `path` (relative to the chat's directory
    when inside it, absolute otherwise), `additions`, `deletions`, `diff` (unified text, `''` when
    the transcript kept no patch), `created` (a `Write` that created the file), `intent` (string or
    null), `entryIndex` (the 0-based index, in the space `GET /chats/:id` pages with sidechains off,
    of the entry that holds the `tool_use`; null when unknown) and `pending` (the call has no result
    yet).
- **Context** (`git.ts`, `changes.ts`). `fileDiff` takes a `context`: a number of unchanged lines
  (clamped to 0–500) or `'full'`, which is `--unified` with a line count above the file's. The
  three diff routes accept `?context=`; anything unparseable is the default of 3. `full` is true
  only when `context=full` was honoured: a file over 20 000 lines gets the default context and
  `full: false`.
- **A commit, or the uncommitted work.** The three summary routes and the three diff routes accept
  `?commit=<sha>` (the files and diff of that commit alone, `<sha>^..<sha>`) or `?uncommitted=1`
  (the working tree against `HEAD`, untracked files included, as today's `uncommitted` list). A
  `commit` that is not on the branch since its base is refused with 400: check it with
  `git merge-base --is-ancestor` both ways (base before it, it before the branch's head), not
  against `commitsBetween`, which stops at 200 commits. A root commit diffs against the empty tree.
- **Binary and oversized files.** `diffFiles` marks `binary` from numstat; a binary file's diff is
  git's one line and the client says so. `fileDiff` already cuts a long diff with
  `… diff truncated` and answers `… diff too large to show` on overflow; keep both markers.
- **Steps** (new `edit-steps.ts`, a reader in `sessions.ts`).
  - `GET /chats/:id/changes/steps` and `GET /orchestrations/:id/tasks/:taskId/changes/steps`
    (through the task's chat) answer `EditStep[]`, oldest first.
  - Read the JSONL once, streaming: keep the last assistant `text` block, each `tool_use` of the
    writing tools, and for each result the line's `toolUseResult` (its `structuredPatch`, and
    `type`/`content` for a `Write`; drop `originalFile` at once). `toolUseResult` is a string, not
    an object, when the call failed or was refused. Count entries the way `getSession` counts them
    (`normalizeMessage`, main view only, 0-based) to fill `entryIndex`.
  - Keep what a pass learned in a `JsonlCache` of its own, so the next request reads only what was
    appended. It can't reuse `toolEntries`' fold: that one only parses lines that mention
    `tool_use`, and the intent is on text-only lines. Cap the transcripts it keeps, like
    `TOOL_ENTRIES_FILES` does.
  - Turn a `structuredPatch` (`oldStart`, `oldLines`, `newStart`, `newLines`, `lines`) into a unified
    diff with `@@ -a,b +c,d @@` headers. A `Write` that created a file with no patch becomes an
    all-added diff of its `content`. A `NotebookEdit` without a patch keeps `diff: ''`.
  - Leave out calls whose result is an error. A call still waiting for its result is the last step,
    with `pending: true`, only while the chat has an execution; in a chat nobody runs, an
    unanswered call is stale and is left out.
  - A chat with no transcript on disk yet is read from what its process streamed: steps without
    patches (`diff: ''`), so the lens still lists them.
- **OpenAPI** (`routes.ts`, `schemas.json`, `generate-schemas.ts`): the new parameters, route and
  types, described like their neighbours.
- **Web client** (`api.ts`): `chatDiff`, `taskDiff` and `integrationDiff` take
  `{ context?, commit?, uncommitted? }`; the summaries take `{ commit?, uncommitted? }`; add
  `chatSteps` and `taskSteps`. A task's steps and changes sit under `keys.orchestration(id)`,
  which `changes.updated` refreshes; `changes.updated` never names a chat, so a chat's changes and
  steps sit under `keys.chatScope(id)`, refreshed by the chat's own events and, while it works, the
  8 s timer the panel already uses.
- **Tests**: context and `full`; `working`; commit and uncommitted scopes, and the refusal of a
  foreign commit; binary; steps from a fixture transcript (a patch, a created file, an error left
  out as a string result, a pending call with and without an execution, the intent, the path
  relative to the top level and the entry index); the streamed fallback.
- **Done when** the routes answer as above, existing clients see no change, and typecheck and tests
  pass.

### `diff-lib` (parse, pair, word-diff, fold and draw)

References: `DiffView`, `DSComparador`.

- **`lib/diff.ts`** (pure):
  - `parseUnified(text)`: the hunks with every line numbered on the side it exists on, the file
    header dropped, and binary, "no newline at end of file", `… diff truncated` and
    `… diff too large to show` recognised.
  - `blocksOf(hunk)`: context lines and change blocks (a run of removals, then of additions). Pair
    each removed line with the most similar added line after the last pair (similarity over 0.45),
    so a line that moved down a row still faces its old self.
  - `readingRows(diff, opened)`, `unifiedRows(diff)` and `splitRows(diff)`: the rows each mode
    draws, with the gaps between hunks as fold rows that know their size and the function the next
    hunk is in (git's hunk header context).
  - `foldFull(diff)`: for a `full` diff, collapse unchanged runs longer than 8 lines to 3 lines of
    context each side, so "Show" opens a gap without asking the server again.
  - `statsOf(diff)`, `blockStarts(diff)` (for the rail and `j`/`k`) and `diffHash(text)` (for
    "seen").
- **`lib/word-diff.ts`**: tokens are words, whitespace runs and single punctuation; an LCS over
  them marks the changed tokens of each side; whitespace alone never counts; lines over 400
  characters or pairs over 200 tokens fall back to a whole-line mark.
- **`DiffView`** (`components/changes/DiffView.tsx`): draws one file in `reading`, `unified` or
  `split`, with props for the opened pills, `onOpenGap`, `wrap` (phone), the current block and a
  hunk filter (Step by step shows one patch).
  - Rows are 20 px (19 px wrapped on a phone), the line numbers tabular, the rail 3 px.
  - Reading: context at reduced opacity; the pill sits on the rail of the first new line of a
    block (a dashed seam when nothing replaced the removed lines); an opened block shows its
    removed lines in place, tinted.
  - The changed words of a line are one mark spanning their syntax runs.
  - Syntax comes from `components/highlight`, painted with `--sx-*` through classes; no hex in the
    component.
  - Every row says what it is to a screen reader ("line 9 added", "2 lines removed, collapsed"),
    and a pill is a `<button>` with `aria-expanded`.
- **`BlockRail`**: the file to scale, one mark per block (add, del or both), the viewport as a
  box, click to jump. **`Fingerprint`**: one segment per file, as wide as its churn, split into
  added and removed, the current file ringed and the seen ones dimmed; each segment is a link with
  an `aria-label`.
- **`styles/diff.css`** ports §15 of `docs/design-system/agentry-ds.css` to the app names of design
  system §5, and **`tokens.css`** gains the `--diff-*` and `--sx-*` tokens for both themes.
- **Syntax roles** (`components/highlight.ts`): export a variant of `highlight` that returns runs
  of `[text, Role | null]` for the TanStack languages (the roles of `highlight/paint.ts`) and
  `null` for a language only shiki knows, and a helper that picks the language from a file's
  extension. Map the roles onto `--sx-*` through classes: `keyword` → `--sx-kw`, `string` →
  `--sx-str`, `constant` → `--sx-num`, `entity` → `--sx-type`, `function` → `--sx-fn`, `comment` →
  `--sx-com`, and `tag` and `deleted` to the plain foreground (they are green and red).
- **Tests**: parsing (numbers, headers, binary, no-newline, the two cut markers), pairing, word
  diff, the rows of each mode for the sample diffs in `docs/design-system/reference/samples/`
  (copy them to `apps/web/test/fixtures/`; `git.ts.diff` has five blocks and gaps of 21 and 19
  lines), `foldFull`, the roles mapping, and a render test of `DiffView` in each mode
  (`diff-view.test.tsx`).
- **Done when** `DiffView` draws the three modes like `DSComparador` and `DiffView` in both themes,
  and typecheck and tests pass.

## Stage 1: the screen and the summary, in parallel (both depend on `api` and `diff-lib`)

### `review` (the review screen, Result lens)

References: `DesktopCambios`, `DesktopCambiosLado`, `MobileCambios`, `MobileDiff`, and
`DSComparador` for the states.

- **Routes and page** (`pages/ChangesReview.tsx`). The three routes of decision 3 build a
  `ReviewSource` (summary loader, diff loader, steps loader or none, live flag, back link) and draw
  one page. Deep links: `?file=`, `?mode=`, `?lens=steps`, `?step=`.
- **Header.** Back to the chat, the task or the orchestration; the chat's title (first prompt) in
  small print; "Changes" with the branch, base, commit and file counts and the totals in mono; "updates
  by itself" with the braille spinner while the source is live; the lens switch (Result / Step by
  step); the scope menu (All the work · each commit by subject · Not committed yet); copy the whole
  patch. Under it, the fingerprint.
- **File map** (288 px, `bg-1`). Count and "N of M seen" with a thin bar; a filter field (`/`);
  the tree grouped by directory; each file a row with its status letter (M/A/D/R, and B for binary),
  name, counts, a hollow dot when not committed yet, a check when seen, and the live rail plus the
  braille spinner on the file the agent is editing right now (from the chat's activity: the
  running call's `target`, which is relative to the chat's directory and cut at 80 characters,
  resolved against the top level; no spinner when it doesn't resolve to a listed file).
- **Scopes.** "All the work" lists `working` (falling back to `files` plus `uncommitted` by path
  when the server is older); a commit lists its own files; "Not committed yet" lists
  `uncommitted`. The diff of a file is asked for in the same scope. The selected row has the gradient indicator. A legend and the `j k` / `n p`
  hints at the bottom. `[` folds the map into a 48 px rail of status letters (always folded in Side
  by side).
- **File header.** The path (directory dimmed, name bright), counts, a status badge only for added,
  deleted, renamed or binary files, the mode switch (icons, the active one labelled), the block
  counter with previous/next, "Seen" (`v`, a checkbox chip) and a `⋯` menu (copy the path, copy
  this file's diff).
- **Why line.** The intent of the latest step that touched this file, "latest of N steps · time"
  and "See the steps" (opens the lens on that step). Hidden when the source has no steps.
- **The diff**: `DiffView` with the block rail. Gaps open with "Show": first try the loaded diff;
  otherwise request `context=full` once (unless the file is over 5 000 lines) and keep it.
- **Keyboard** (never while typing in a field): `j`/`k` blocks, `n`/`p` files, `v` seen and next,
  `m` mode, `o` open or fold the current block's removed lines, `[` the map, `/` filter. Listed in
  the `⋯` menu and on `DSComparador`.
- **Live.** While the source is live, re-read on the existing events and the 8 s timer, keep the
  scroll position and the opened pills, and never reorder the files under the person's pointer.
- **States** (as `DSComparador`): no worktree (Result disabled with its reason, the page opens on
  Step by step); nothing changed yet (compact `Empty`, no illustration); binary; a diff over 5 000
  lines (blocks only, no `context=full`); added file (all rail); deleted file (one pill with its
  line count; Side by side not offered); renamed without changes ("only renamed").
- **Entry point.** The summary's `.changes-review-link` opens this screen; `summary` builds it in
  parallel, so the spec below finds it by that class.
- **Phone.** `/chats/:id/changes` lists the files as cells (status, name, directory, counts, seen,
  live), under the lens switch, the totals and the fingerprint. A file opens as its own screen:
  header with name, directory, counts and "Seen"; Reading/Unified; the why line; the diff wrapped;
  a bottom bar with the previous and next file and the block counter with 44 px buttons.
- **e2e** (`changes-review.spec.mjs`, written, not run): seed the worktree of
  `observability.spec.mjs`; open the review from the summary; the file map, the Reading rows and a
  pill that opens; Unified and Side by side; `?file=` and `?mode=`; a gap that opens with
  `context=full`; seen survives a reload; a phone viewport opens a file and moves with the bottom
  bar; axe on the page.
- **Done when** the screen matches its references on desktop and phone, dark and light, with
  typecheck and tests green.

### `summary` (the compact summary everywhere else)

References: `DesktopChatCambios`, and the task panel and integration card for the same component.

- **`ChangesSummary`** (rewrites `components/observe/Changes.tsx`): "Changes" label and totals,
  branch · commits · files in mono, the fingerprint, the files as one-line rows (status letter,
  name, counts, uncommitted dot, live spinner), the latest step (time, tool, file, intent) when the
  source has steps, and **Review the changes** (primary) plus "See step by step · N steps". A chat
  outside a worktree shows its steps count and opens the review on Step by step.
- It replaces the inspector's Changes tab, the task panel's Changes section (`TaskWork`) and the
  integration card (`IntegrationChanges`). No drawer, no dialog, no editor link: this fixes the
  phone bug, since nothing opens behind the sheet any more. `EditorLinks.tsx` and `lib/editor*`
  stay on disk, unused, until `remove-editor` deletes them.
- **Edit chips in the transcript** (`Transcript.tsx`): a tool group that holds `Edit`/`Write`
  calls shows one chip per file (its name, and its +/− once the chat's steps are in the query
  cache), linking to `/chats/:id/changes?lens=steps&step=<id>`. `Transcript` has no chat id
  today and is also drawn by `DetailPanel`: add optional props (the chat id and the steps), pass
  them from `ChatView`, and draw no chips where they are absent. `ChatView` reads the steps once,
  after first paint, and refreshes them with the chat.
- **Done when** the three places show the summary as `DesktopChatCambios` draws it, the old
  `.obs-*` hooks listed in rule 9 still hold, and typecheck and tests pass.

## Stage 2: the steps lens and the removal

### `steps` (Step by step; depends on `review` and `summary`)

References: `DesktopCambiosPasos`, `MobilePasos`.

- **List** (340 px): each step with its dot on a vertical line, time, tool badge, file, counts and
  the intent clamped to two lines; the selected one raised; the pending one with the live dot and
  the braille spinner. A file filter chip ("All files ▾").
- **Detail**: "Step N of M", time and how long ago, tool, path and counts; previous and next; the
  intent as the heading, large, with "What Claude wrote just before this edit · See it in the
  conversation" (`/chats/:id?at=<entryIndex>`); the patch in Unified in a card titled with its
  lines and "as it was at that moment"; and "This file, step by step": the other steps on the same
  file as three cards around the current one.
- **Scrubber** under the header: one dot per step, the current one wide in the gradient, the
  pending one live. `←`/`→` move between steps.
- **Phone**: the scrubber, the step's heading, path, intent and patch (wrapped), and big
  Previous/Next buttons; swiping moves between steps.
- **`?at=`** (`pages/ChatView.tsx`): read once, jump to that entry the way a search hit is reached
  (reading back to its page when needed), and highlight it briefly. `entryIndex` counts the main
  view, so turn the sidechain toggle off before jumping.
- **Done when** the lens matches its references and a step opens its place in the conversation.

### `remove-editor` (depends on `review` and `summary`)

- Delete the files listed in the ownership table, and every import, route, type, schema, i18n key
  and test of the editor integration (decision 1). `rg -n "editor-sync|EditorLink|OpenWorktree|DiffCommandButton|settings/editor|EditorSettings|editorLink|diffCommand|hunksOf|LEGACY_EDITOR_KEY|agentry-editor" apps packages e2e scripts`
  ends empty. The CodeMirror editors of Settings (`CodeEditor*`, `config.json`'s `editor` labels)
  are a different thing and stay.
- Settings loses the Editor tab from the Agentry group, and the tab count in its comment follows;
  `?tab=editor` behaves like any unknown tab.
- `observability.spec.mjs` drops its editor half (the settings round trip, the links, the
  migration of the old browser key) and keeps the branch, commits, counts and diff assertions,
  now against the review screen.
- `scripts/record-media.mjs` opens the review screen where it opened the diff dialog, so
  `pnpm media` keeps working for the `docs` task.
- The README and `ROADMAP.md` stop mentioning editor links.
- **Done when** nothing in the tree mentions the editor integration and typecheck and tests pass.

## Stage 3: consistency (depends on `steps` and `remove-editor`)

### `consistency`

Runs alone, so it may run `pnpm e2e`.

- Build and start the sandbox with a seeded worktree chat, a task with commits and an integration
  branch, and a chat outside git with edits. Screenshot the review in both lenses and three modes,
  the summary in its three places, and the phone screens, in dark, light and `motion=subtle`.
  Compare with the reference and fix drift.
- Check the quiet rules on real diffs: no full-row tint in Reading, one mark per changed phrase,
  syntax never green, red or cyan, one live rail and no energy border.
- Performance: a 20 000-line generated diff scrolls without jank and never asks for
  `context=full`.
- `pnpm e2e` is green, apart from the known baseline below.
- Put before/after pairs under `docs/media/changes-review/` for the docs task.

## Stage 4: documentation (depends on `consistency`)

### `docs`

- A **Landed** note in `docs/design-system.md` for whatever the implementation settled
  differently, and an **Outcome** section in this plan.
- `docs/status.md`, the README (features and screenshots with `pnpm media`), and the API docs if
  they list routes by hand.
- Store the new and changed documents in the knowledge base with `kb_add_document`, following
  `docs/knowledge-base.md`.

## Launch settings

```json
{
  "name": "changes-review",
  "engine": "graph",
  "worktree": true,
  "model": "opus",
  "permissionMode": "bypassPermissions",
  "permissionPrompts": "none",
  "concurrency": 3,
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
| `api` | — |
| `diff-lib` | — |
| `review` | `api`, `diff-lib` |
| `summary` | `api`, `diff-lib` |
| `steps` | `review`, `summary` |
| `remove-editor` | `review`, `summary` |
| `consistency` | `steps`, `remove-editor` |
| `docs` | `consistency` |

### Before launching

- **Commit the docs to `main` first**: this plan, `docs/design-system.md` (§5 is new),
  `docs/design-system/agentry-ds.css` (the diff tokens and §15) and `docs/design-system/reference/`
  (the new prototypes and screenshots), and the CLAUDE.md addition. Workers start in worktrees of
  that commit and can only read what it contains.
- **Known baseline.** On 2026-09-27, on `main` at `cadea39` (0.22.0) plus this docs commit, on the
  development machine with headless Chrome, `pnpm build` succeeded and `pnpm e2e` passed all 37
  spec files. The four failures seen earlier on `6ef0aec` in a Linux sandbox (`chats.spec.mjs`,
  `orchestration-v2.spec.mjs`, `remote-access.spec.mjs` and the `.live-chip-text` contrast in
  `schedules.spec.mjs`) did not reproduce there, so the verification phase starts from a green
  suite: a failing spec is this orchestration's to explain or fix.

## What "done" means

- **Changes are read in Agentry.** No link, button, setting, route or type of the editor
  integration is left, and `/settings/editor` answers 404.
- **Every source has the review screen** (chat, task, integration), with Result in three modes and
  Step by step where there is a transcript, matching the references on desktop and phone, dark and
  light.
- **Quiet by rule**: Reading by default, removed lines folded, one rail per line, one mark per
  changed phrase, muted syntax, the why of each change one click away.
- **A chat outside git** shows its edits, patch by patch.
- **On a phone** a file's diff is readable without scrolling sideways, and nothing opens behind the
  inspector sheet.
- **`pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm e2e` are green**, apart from the
  baseline failures if they still reproduce.

## Related

- [Design system](../design-system.md), §5
- [The Night Shift redesign](redesign-night-shift.md): the look this screen follows.
- [Agent observability](agent-observability.md): where the Changes panel and the editor links came
  from; this plan replaces its "open in the editor" part.
