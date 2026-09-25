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
