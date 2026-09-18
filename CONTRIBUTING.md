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
- **Tests carry their reasoning.** Name a test after the behaviour it protects, not the function
  it calls.

## Layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Types shared by every other package |
| `packages/core` | The CLI driver: runs, sessions, accounts, orchestration, config, storage |
| `apps/api` | Fastify REST API and the OpenAPI document |
| `apps/web` | React UI |
| `e2e/` | Browser suite driven over the Chrome DevTools Protocol |
| `docker/` | The single image |

## Commits and pull requests

Write the commit message for whoever bisects into it in a year: what changed and why, not which
files you touched. Keep one concern per pull request, and say in the description how you verified
it — the output of the command counts for more than a claim that it works.
