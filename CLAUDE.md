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
