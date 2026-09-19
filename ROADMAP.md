# Roadmap

## Done

- **Core over the CLI only** — detection, auth status, multi-turn runs over stream-json with
  transparent `--resume`, token streaming, background tasks, subagents, effective environment.
- **Sessions & projects** — history from the CLI transcripts, grouped by project with every
  session attributed to its origin (CLI, wrapper run, orchestration worker); the wrapper's own
  housekeeping runs leave no transcript; resume into a run, delete, create or clone projects.
- **Orchestration** — task DAG with parallelism, dependency context, synthesis and an auto-planner;
  per-task git worktrees merged into one integration branch (an integrator agent resolves
  conflicts), pull request on request, resume with corrected settings, delete.
- **Run control** — the CLI's control protocol over stdio: permission prompts, `AskUserQuestion`
  and plan approval answered from the UI, interrupting a turn, switching the permission mode and
  the model mid-run; attachments (images, PDFs, files) in the composer, cost budgets (`--max-budget-usd`), per-run
  git worktrees.
- **Configuration, user and project scope** — settings (guided + raw), instructions, MCP servers
  (user / project / local, connection checks), agents, skills, commands, output styles, rules, a
  confined file explorer, memory, plugins and marketplaces, account credential.
- **Multi-account** — several accounts through claude-swap, with usage per window, manual switch,
  proactive rotation at a usage threshold, rotate-and-resume for a run that hits its limit, and
  per-run account pinning.
- **Persistence** — runs survive wrapper restarts; orchestrations and credentials in the data volume.
- **API reference** — OpenAPI 3.1 generated from the shared types, served with Scalar at `/docs`;
  a test enforces that every route is documented.
- **UI** — command palette (⌘K), light/dark/system themes, CodeMirror editors, unsaved-change
  guards, toasts and confirmation dialogs, themed form controls (Radix), responsive layout.
- **Tests** — unit (core), API integration (Fastify inject) and an in-repo browser suite (`e2e/`,
  headless Chrome over CDP against an isolated wrapper).
- **Docker** — single image (non-root, CLI baked in, healthcheck), one volume for the whole account
  setup; published to ghcr.io for amd64 and arm64 (`edge` from `main`, `latest` and a version tag
  per release).
- **CI and releases** — typecheck, tests, e2e and an image smoke test on every pull request;
  release-please versioning and changelog.
- **Linux desktop app** — Electron shell running the bundled API, packaged as AppImage and `.deb`
  and attached to every release. See [docs/desktop.md](docs/desktop.md).

## Next

- **Agent observability (top priority)** — see what every agent really does and step in on time:
  per-task progress, commits, changed files and diffs (and the files a plain run touched); links
  that open a worktree or a changed line in VS Code (or another editor); stuck-agent detection
  (hung or repeated commands, busy without progress, loops, tests bent to pass, silence, budgets)
  shown as a health badge with notifications and one-click actions (cancel the command, send a
  hint, interrupt); an e2e harness that times out and always closes Chrome. Full plan in
  [docs/plans/agent-observability.md](docs/plans/agent-observability.md).
- **Security (required before exposing the port)** — API token / OIDC in front of every route,
  TLS guidance, secret redaction in `GET /config/mcp` (env and headers), audit log of writes,
  optional read-only mode.
- **Live updates without polling** — one global SSE feed for runs, tasks, orchestrations and
  sessions; the UI currently polls every 2–3 s.
- **Richer run control** — per-run MCP config and allowed-tools presets.
- **Orchestration v2** — re-run a single task, edit and relaunch a finished graph, reusable
  templates.
- **claude.ai connectors panel** — surface Docs / Gmail / Calendar connectors with guided
  "ask Claude" actions. Web artifacts and claude.ai memory stay out of reach: there is no public
  API or CLI command for them.
- **Multi-account, continued** — a config volume per account (today they share `~/.claude`), rotation
  policies per project, and usage history per account.
- **Scheduling** — cron-like recurring runs and orchestrations with history.
- **Observability** — usage and cost over time, per project and per model; export of transcripts
  (Markdown / JSON).
- **Packaging** — pinned CLI version with an in-UI update check, Helm chart / compose profiles,
  healthcheck-driven restarts.
