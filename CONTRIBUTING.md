# Contributing to Agentry

Thanks for taking the time. This is a small project with a couple of strong opinions, and knowing
them up front saves everyone a round of review.

## The one rule

**Agentry talks to Claude Code only through its CLI.** No SDK, no HTTP calls to Anthropic, no
scraping a terminal. If a feature cannot be expressed as a documented CLI surface — a flag, a
subcommand, a stream-json event, a file the CLI writes — it does not belong here yet. The table in
[README.md](README.md#how-it-talks-to-claude) lists every surface currently in use.

This is what keeps the project honest: whatever Claude Code does, Agentry does, and nothing more.

## Getting set up

You need Node >= 22, pnpm, and the Claude Code CLI on your `PATH`.

```bash
pnpm install
pnpm dev          # API on :8787, Vite on :5173
```

The API serves the built UI too, so `pnpm build && pnpm start` gives you the production shape on
`:8787` alone.

For the Linux desktop app in `apps/desktop`, `pnpm desktop:dev` builds the UI and the API bundle and
opens Electron, and `pnpm desktop:dist` produces the AppImage and `.deb` in `apps/desktop/release/`.
See [docs/desktop.md](docs/desktop.md).

## Before you open a pull request

```bash
pnpm typecheck    # all four packages
pnpm test         # unit (core) + API integration (Fastify inject)
pnpm build
pnpm e2e          # headless Chrome over CDP, against an isolated instance
```

CI runs exactly these, plus a Docker image build. It also regenerates the OpenAPI component
schemas and fails if they differ from what you committed, so if you touched a shared type:

```bash
pnpm --filter @agentry/api openapi:schemas
```

Every route must carry a summary and a tag — there is a test that enforces it.

A feature or a decision that is worth remembering is worth a document: write it under `docs/`
(plans in `docs/plans/`) in the same pull request that builds it. Where the project stands today is
[docs/status.md](docs/status.md), and how the documents are indexed for semantic search is
[docs/knowledge-base.md](docs/knowledge-base.md).

Read them the same way: any question about this project starts with a `kb_search_documents` over
`docs/`, before `git log` and before opening the file that looks like the answer. Documents nobody
searches are documents nobody wrote.

## House style

- **TypeScript, strict, no `any`.** `noUncheckedIndexedAccess` is on; respect it rather than
  casting around it.
- **Comments explain why, not what.** If a line needs a comment to say what it does, rewrite the
  line. The ones worth writing are the ones that record a constraint you discovered the hard way.
- **Shared types live in `packages/shared`** and are the single source of truth: the API schemas
  and the web client are both generated from or typed against them.
- **Persistence:** a settings-shaped document belongs in a JSON file; anything that is a stream
  (events, history, records that accumulate) belongs in the SQLite store in `packages/core/src/db.ts`.
  Rows, not blobs — two processes share one data dir.
- **UI controls come from `apps/web/src/components/controls`** (Select, Combobox, Checkbox,
  Switch, Slider, NumberInput, Tooltip, Collapsible, Menu, Sheet), not from native `<select>`, `<datalist>`,
  checkbox/range/number inputs, `<details>` or `title=` on interactive elements: the native ones
  render with the operating system's look and ignore the theme. Plain text inputs and textareas
  stay native. Use a Switch for a setting that turns something on or off and a Checkbox for filters
  and multi-choice lists. In e2e specs, `page.select(trigger, optionText)` drives a Select.
  Pages import from the `controls` barrel; modules loaded on first paint (App, Dialog…)
  import the file they need, or the barrel pulls the lazy form controls into the initial bundle.
- **Styles live one file per area** under `apps/web/src/styles/` (tokens, base, shell, primitives,
  lists, transcript, chat, orchestration, dashboard…), imported in cascade order by `styles.css`. A
  rule goes in the file that defines its selector, with its responsive and reduced-motion variants
  next to it. `--live` (cyan) means "an agent is doing this right now" and the brand orange means
  "you can press this"; never swap them. Decorative motion follows the motion level
  (`apps/web/src/lib/motion.ts`): at `subtle` nothing loops, at `off` nothing moves.
- **Lazy routes go through `lazyPage()`** (`apps/web/src/components/ReloadOffer.tsx`), never a bare
  `React.lazy`: a page that outlived a deploy asks for a chunk the new build no longer has, and
  `lazyPage()` turns that into the reload offer instead of a broken route. An e2e spec that needs a
  script in every page it loads uses `page.onNewDocument(source)` and calls the function it returns
  before it finishes, so the next spec starts clean.
- **Accessibility is checked, not asserted.** `e2e/specs/a11y.spec.mjs` runs axe-core over every
  page in both themes and at phone width, over the overlays that open above them, and walks the
  keyboard; a violation fails the build. Status is never colour alone (words and an icon: reuse
  `StatusBadge` and `Tag`), every control is reachable and operable from the keyboard with a visible
  focus ring, icon-only buttons carry an `aria-label`, `aria-label` goes only on elements whose role
  can be named, and text uses the colour tokens, which pass 4.5:1 on every surface in both themes.
  Use `Tabs` with a `TabPanel`, never a hand-written `role="tablist"`.
- **Tests carry their reasoning.** Name a test after the behaviour it protects, not the function
  it calls.

## Layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Types shared by every other package |
| `packages/core` | The CLI driver: runs, sessions, accounts, orchestration, config, storage |
| `apps/api` | Fastify REST API and the OpenAPI document |
| `apps/web` | React UI |
| `apps/desktop` | Electron shell and packaging for the Linux desktop app |
| `e2e/` | Browser suite driven over the Chrome DevTools Protocol |
| `docker/` | The single image |

## Commits and pull requests

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org), because they
drive the release: `feat:` bumps the minor version, `fix:` the patch, and `feat!:` (or a
`BREAKING CHANGE:` footer) the major. Anything else — `docs:`, `refactor:`, `test:`, `chore:`,
`build:`, `perf:` — ships without a version bump.

```
feat: answer permission prompts from the UI
fix: stop counting pre-warmed spare processes as live sessions
docs: explain the rotation policy in the accounts section
```

Below the subject, write for whoever bisects into it in a year: what changed and why, not which
files you touched. Keep one concern per pull request, and say in the description how you verified
it — the output of the command counts for more than a claim that it works.

## How a release happens

You do not tag anything by hand. [release-please](https://github.com/googleapis/release-please)
reads the commits on `main` and keeps a pull request open with the next version's changelog and
every version number already bumped in the six `package.json` files. The running version is read
from `packages/core/package.json`, so no source file carries it.

Merging that pull request tags the commit and creates the GitHub release as a draft, builds the
image as `X.Y.Z`, `X.Y`, `X` and `latest`, attaches the Linux AppImage and
`.deb` to the draft, and only then publishes it. Releases are immutable once published, so nothing
can be attached afterwards: if a step fails, the draft stays unpublished until it is fixed and the
workflow is re-run for that tag. Between releases, every push to `main` publishes `edge`. Images
are amd64 only.
