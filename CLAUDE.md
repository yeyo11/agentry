# Agentry

REST API, web UI and multi-agent orchestration around the Claude Code CLI. pnpm monorepo, Node >= 22.
[CONTRIBUTING.md](CONTRIBUTING.md) is the source of truth for the rules below; read it before
changing code.

## The one rule

Agentry reaches Claude Code **only through its CLI** (flags, subcommands, stream-json events, files
the CLI writes). No SDK, no HTTP calls to Anthropic, no terminal scraping.

## Layout

- `packages/shared` — types shared by every package (`src/types.ts` is the API contract)
- `packages/core` — the CLI driver: runs, sessions, accounts, orchestration, config, SQLite store
- `apps/api` — Fastify REST API; route docs in `src/openapi/routes.ts`
- `apps/web` — React + Vite UI
- `apps/desktop` — Electron shell for the Linux desktop app
- `e2e/` — headless Chrome over CDP, against an isolated wrapper

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build && pnpm e2e
```

After changing `packages/shared/src/types.ts`, regenerate the OpenAPI schemas (CI fails if they
drift): `pnpm --filter @agentry/api openapi:schemas`. Every new route needs a summary and a tag in
`apps/api/src/openapi/routes.ts`, and a row in the README's REST API tables.

## Conventions

- TypeScript strict, no `any`, respect `noUncheckedIndexedAccess`.
- Comments explain why, not what.
- Settings-shaped documents go in JSON files; streams and accumulating records go in SQLite
  (`packages/core/src/db.ts`), as rows.
- UI controls come from `apps/web/src/components/controls`, never native select/checkbox/range.
- Commits follow Conventional Commits: release-please builds `CHANGELOG.md` from them, so never
  edit the changelog by hand. Pull requests are squash-merged.
- Locally the wrapper uses the real `~/.claude`; set `CLAUDE_CONFIG_DIR` to experiment safely.

## Design system

Every UI change in `apps/web` (and the Electron shell's colours) follows the Night Shift design
system in [docs/design-system.md](docs/design-system.md). The reference is in
`docs/design-system/`: `agentry-ds.css`, and `reference/` with a static prototype and dark and
light screenshots of every screen. Before changing a screen, open its reference, and compare the
result against it before you finish.

A change that breaks one of these rules is not done:

- **Tokens only.** Colours, radii, shadows, fonts, durations and easings come from
  `apps/web/src/styles/tokens.css`. No hex, `rgb()`, pixel radius or millisecond value in any other
  stylesheet; the web test that guards this must pass. `#fff` on the brand gradient is the only
  exception.
- **Dark first, both themes.** Dark is the default theme, and every screen also works in
  `[data-theme='light']`. Contrast is ≥ 4.5:1 for text and ≥ 3:1 for large numbers, in both themes.
- **Type.** Use Geist for the UI and Geist Mono for ids, paths, commands, counts, times and section
  labels, on the scale in the doc (34 / 24 / 15 / 14 / 13 / 12 / 11 label). Numbers are
  tabular.
- **The gradient is the brand, used sparingly.**
  - `--grad` goes on the one primary action of a zone, the FAB, the logo and the active-account
    avatar.
  - `.grad-border` and `.grad-text` go on what the screen is about.
  - At most two gradient surfaces per screen, and never as a page background (`--glow-top` is the
    only halo).
- **Only live things move.**
  - `--live` (cyan) and loops mean an agent is working now.
  - Use the braille spinner next to a verb, the ring spinner on task rows, dots and a shimmering
    "Pensando" while thinking, the live rail on live rows, and segmented bars for orchestration
    progress.
  - The energy border goes on **one** surface per screen: the working composer, or the running
    orchestration or stage.
- **Motion levels.** Every animation stops under `[data-motion='subtle']`, `[data-motion='off']`,
  `prefers-reduced-motion` and in a hidden tab. `motion.spec.mjs` stays green.
- **Status colours mean one thing each.**
  - ok: done or connected.
  - warn: near a limit, needs authorisation, or stopped.
  - bad: failed, interrupted, exhausted or destructive.
  - idle: waiting for the user.

  Always pair a status colour with a word or an icon. Usage bars are neutral below 60 %, warn from
  60 % and bad from 75 % or when exhausted.
- **Layout.**
  - Desktop: Sidebar (256) + [Top bar 52 · page · Status bar 30], with page padding 28 × 32.
  - Phone: top bar + page + a tab bar with four tabs (Home, Chats, Orchestrations, More), and New
    chat as a gradient FAB.
  - On a phone: touch targets ≥ 44 px, inputs at 16 px, "⋯" menus as a `Sheet`, and no
    always-visible checkboxes.
- **Illustrations.**
  - Empty, error and system states, New chat and Install use `Empty` with an illustration from
    `apps/web/src/components/illustrations` (design system §4). Use at most one per screen, never
    next to live data, and never as filler on a page that has content. Dialogs, editors and panels
    beside other content keep the compact icon version.
  - Colour comes from the classes in `styles/illustrations.css`, never from hex in the SVG, and
    ids from `useId()`. Illustrations are `aria-hidden`: the title and text next to them carry the
    meaning.
  - Don't add a library or third-party art. A new illustration joins the set, and its reference
    SVG goes into `docs/design-system/illustrations/`, in the same PR.
- **Restyle, don't duplicate.** Style the classes the app already has (the doc maps each design
  component to them) and the controls in `apps/web/src/components/controls`. A new variant goes
  into `docs/design-system.md` and `agentry-ds.css` in the same PR. Keep the classes the e2e specs
  select.
- **Copy.** Every string goes through i18n with `en`/`es` parity. The `es` copy follows
  `apps/web/src/i18n/GLOSSARY.md`: Spanish from Spain, infinitive buttons, sentence case, and no
  `text-transform: capitalize` on sentences. A chat's title is its first prompt; its id is
  secondary, in mono.

## Knowledge

Write every feature and every decision as a document under `docs/` (plans in `docs/plans/`), in the
pull request that builds it. [docs/knowledge-base.md](docs/knowledge-base.md) has the format, the
tools and the re-sync.

`docs/` is also a searchable knowledge base, and the source is indexed by symbol.

**Search it first.** When you are asked anything about this project — what it does, how it works,
where it stands, why something was decided, where something lives — the **first tool call of the
turn is `kb_search_documents`**, followed by `code_hybrid_search` when the answer is in the source
rather than in the docs. Not after a `git log`, not after opening the file that looks like the
answer: first. Reading files and running git is how you *verify* what the search returned, or what
you fall back to when it returned nothing.

Do not decide whether the question is "conceptual" enough to deserve a search — that judgment is
what gets skipped. Search unless one of these holds: the user named the exact file, you are looking
for a literal string or a known identifier (that is grep's job), or the turn is pure editing with no
question in it. A search that returns nothing costs one call.

`code_*` results are only as fresh as the last pass, so check the project's `indexing_status` is
`completed` and look at `last_indexed_at` before trusting them against recent commits.
