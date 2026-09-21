# Roadmap

## Done

- **Core over the CLI only** — detection, auth status, multi-turn chats over stream-json with
  transparent `--resume`, token streaming, background tasks, subagents, effective environment.
- **Chats and projects** — Agentry's own model of a conversation: a chat is a session id, and every
  time a process works on it that is an execution with its own outcome, cost and turns. Chats are read
  from the CLI's transcripts, whoever started them (a terminal, Agentry, an orchestration worker), and
  what only Agentry knows lives in a record next to them. Projects are directories you import, with
  their worktrees and every chat under them; the wrapper's own housekeeping chats leave no transcript;
  resume, fork into a copy, delete, and create or clone projects.
- **Orchestration** — task DAG with parallelism, dependency context, synthesis and an auto-planner;
  per-task git worktrees merged into one integration branch (an integrator agent resolves
  conflicts), pull request on request, resume with corrected settings, delete; a second engine that
  runs the graph as a Claude Code workflow.
- **Orchestration v2** — re-run one task of a finished graph with everything that depends on it,
  edit and relaunch a graph as a new one that records where it came from, reusable templates, and a
  time and cost limit per task or per graph.
- **Verification phase** — the checks (build, the browser suite) run once on the integration branch,
  each under a timeout, after an install step worked out from the lockfile (or given, or turned off),
  with a fixer agent held to rules Agentry writes and a cap on its attempts and on what it may spend
  (`--max-budget-usd` with what is left after each attempt); the outcome (`passed`, `fixed`,
  `failed`) is on the graph before a pull request is offered, and `failGraph` makes failed checks end
  the graph as failed with no pull request. Workers run only the type check and the unit tests.
- **Chat control** — the CLI's control protocol over stdio: permission prompts, `AskUserQuestion`
  and plan approval answered from the UI, interrupting a turn, switching the permission mode and
  the model mid-chat; attachments (images, PDFs, files) in the composer, cost budgets
  (`--max-budget-usd`), per-chat git worktrees.
- **Tools and servers per chat** — named, editable presets of allowed and disallowed tools
  (`read-only`, `no-network` and `everything` ship as defaults, restorable one by one) and a chosen
  set of MCP servers, through `--allowedTools`, `--disallowedTools`, `--mcp-config` and
  `--strict-mcp-config`; picked when a chat starts, resumes or forks, and shown on the chat because
  it explains a refusal. One preset can be the default a chat with no tools of its own takes, a fork
  inherits its source's tools and servers, and a resume rewrites the config file from the servers'
  current definitions, so an edited one is picked up.
- **Agent observability** — what an agent really did, from git and the transcript rather than from
  what it says: a task's or a chat's commits, changed files with `+/−`, a highlighted diff per file,
  uncommitted work, its own checklist and what it is running now, live from a `changes.updated`
  event. A health badge for a hung or repeated command, no progress, a loop, a test bent to pass,
  silence and a budget, measured against the command durations of this machine, with a notification
  and three ways in: cancel one command's process tree, send a hint (prefilled per signal), interrupt.
  An optional supervisor (Haiku, off by default) wakes once per signal per chat, reads the worker's
  last steps through a read-only housekeeping chat and proposes the hint, to send, edit, dismiss or
  have sent on its own; what it costs lands on the graph. Every reason and hint carries a stable code
  and the figures behind it, so a client says them in its own language. Links open a worktree, a file
  or a changed line in your editor, from settings kept on the server.
- **A suite that cannot hang** — the browser suite has a time limit per spec and per run, and closes
  Chrome and the wrapper on every way out by the pid it started, never by a name match.
- **Configuration, user and project scope** — settings (guided + raw), instructions, MCP servers
  (user / project / local, connection checks), agents, skills, commands, output styles, rules, a
  confined file explorer, memory, plugins and marketplaces, account credential.
- **Security** — none, bearer token or OIDC (a JWT checked against the issuer's JWKS) in front of every
  route, the token stored only as a hash and shown once, a read-only mode, secrets in MCP `env` and
  `headers` never returned by the API, an audit log of every write, and a Security tab to run it all.
  TLS guidance and a proxy profile: see [SECURITY.md](SECURITY.md) and [docs/deploy.md](docs/deploy.md).
  The audit log narrows by path (matched literally), method and status code or class, a tool
  permission is answered from the notification without opening the chat, and a lost token is replaced
  from the environment with `AGENTRY_AUTH_TOKEN_RESET=1`, audited with actor `env`.
- **Multi-account** — several accounts through claude-swap, with usage per window, manual switch,
  proactive rotation at a usage threshold, rotate-and-resume for a chat that hits its limit, and
  per-chat account pinning. Each account can have a config directory of its own (nothing moved or
  copied), a project — or the chats that belong to no project — can have its own rotation policy, and
  every account's usage is kept as a history.
- **claude.ai connectors** — the Docs, Gmail and Calendar connectors the CLI can see, as `claude mcp
  list` reports them, with prepared prompts that start a chat and what to do to authorise one. What
  has no CLI surface (web artifacts, claude.ai memory) is said plainly on the page.
- **Scheduling** — recurring chats and orchestrations on a cron expression and a time zone, with a
  cron builder that explains itself, a form that can be filled from an orchestration that already ran,
  run now, and a run history. A slot is claimed by a unique key so it never fires twice; one missed
  while Agentry was down is recorded as skipped, never run late; and one that arrives while the last
  run is still going follows the schedule's overlap policy — start anyway, skip it, or queue it as a
  row that survives a restart. `schedule.changed` and `schedule.fired` keep the lists fresh without
  polling.
- **Usage and cost over time** — per day or week, per project and per model, from the cost the CLI
  reports (never estimated from tokens), a Usage page with an accessible chart and a date picker of
  Agentry's own for a custom range, and any transcript — or a whole project's chats, streamed —
  exported as Markdown or JSON.
- **Persistence** — chats survive wrapper restarts, and one cut off by a restart says so and when it
  stopped; orchestrations, schedules and credentials are in the data volume.
- **Live updates without polling** — one global SSE feed (`GET /api/events`) for chats, prompts
  waiting for a person, tasks, subagents, workflows, orchestrations, changes on disk, health, the
  supervisor's proposals, schedules, account rotation and sessions on disk, with `Last-Event-ID`
  resume; the UI keeps its caches fresh from it and only polls, slowly, while the stream is down.
- **Notifications** — a notification center in the top bar fed by that feed: chats waiting for an
  answer first (including the ones already waiting when the page loads, and a link that opens the
  prompt, or answers a plain tool permission with Allow and Deny without opening it), then finished
  or failed chats and orchestrations, conflicts, rate limits and rotations, a worker that looks stuck
  and the hint the supervisor proposes for it, and finished tasks, subagents and workflows; toasts,
  and opt-in browser notifications for a hidden tab.
- **Execution detail** — side panels for a subagent, a background task and a workflow agent: prompt,
  status, duration, tokens, the full transcript, the result and the tasks a subagent launched, read from
  the files the CLI writes and updated live from the feed. Every task can show its output, followed while
  it runs, and tasks launched by a subagent are tagged.
- **API reference** — OpenAPI 3.1 generated from the shared types, served with Scalar at `/docs`;
  a test enforces that every route is documented.
- **UI** — command palette (⌘K), light/dark/system themes, English and Spanish (the strings the
  server writes included, by code), CodeMirror editors, unsaved-change guards, toasts and
  confirmation dialogs, themed form controls (Radix, plus a date picker of our own), responsive layout.
- **Tests** — unit (core), API integration (Fastify inject) and an in-repo browser suite (`e2e/`,
  headless Chrome over CDP against an isolated wrapper). The actions that need a live CLI process —
  cancelling a hung command, sending a hint, interrupting — are covered against a fake `claude` that
  speaks just enough stream-json, put first on `PATH` only for the specs that ask for it.
- **The README's media, reproducibly** — `pnpm media` boots an isolated wrapper against that same
  fake CLI, invents the projects, chats, graph, schedules and accounts in frame and records the tour
  and the stills from one headless Chrome; the GIF is encoded in pure JavaScript, so no `ffmpeg` and
  no native binary is needed to rebuild them.
- **Docker and Kubernetes** — single image (non-root, CLI baked in and pinned, healthcheck that restarts a
  wedged server), one volume for the whole account setup; published to ghcr.io for amd64 (`edge` from
  `main`, `latest` and a version tag per release). A compose profile with a TLS-terminating proxy and a
  Helm chart; an in-UI check for a newer Claude Code, on demand and once a day.
- **CI and releases** — typecheck, tests, e2e and an image smoke test on every pull request;
  release-please versioning and changelog.
- **Linux desktop app** — Electron shell running the bundled API, packaged as AppImage and `.deb`
  and attached to every release. See [docs/desktop.md](docs/desktop.md).

## Next

What is still open was decided against rather than left undone. The plans say why:
[docs/plans/post-roadmap.md](docs/plans/post-roadmap.md),
[docs/plans/roadmap-completion.md](docs/plans/roadmap-completion.md) and
[docs/plans/agent-observability.md](docs/plans/agent-observability.md).

### Decided against, for now

- **A banner on every page while read-only is on.** The Security tab already says the mode is on,
  and a person who turned it on knows: a strip across every screen buys nothing for the noise.
- **A sign-in through an identity provider.** Agentry validates a JWT and nothing more. A browser
  login flow (authorization code with PKCE, a callback route, refresh) is a product of its own, not
  a field on the security settings; in `oidc` mode clients bring a JWT, or an identity-aware proxy
  adds it.
- **Packaging, taken separately** — a Helm Ingress template, the chart's version under
  release-please, and running the image build, the Caddy profile, the chart and the e2e harness's
  own test through a real cluster in CI. All of it is release plumbing rather than product, and it
  wants its own change.
- **Polls kept on purpose** — accounts (10 s: usage has no event) and the detail panels while an
  agent or task runs (2.5 s: neither the output file nor the transcript announces each line), until
  the CLI reports more.

### Noticed and not fixed

- **A chat Agentry starts is titled with the name the wrapper generated** (`my-project-ce007b`)
  until its transcript is on disk; after that its first prompt becomes the title. Seen while
  recording the README's media, and left alone: the fix belongs to how a chat is named, not to a
  recorder.

### Out of reach of the CLI

- **Web artifacts and claude.ai chat memory** — no public API, no CLI command.
- **Authorising a claude.ai connector from Agentry** — it happens in an interactive session (`/mcp`) or in
  claude.ai's connector settings; the page links the instructions.
- **Plugin and claude.ai connector servers in a chat's own MCP selection** — they are in no file
  Agentry can read, and `--strict-mcp-config` drops them.
- **A time limit as a CLI flag** — the cost limit is `--max-budget-usd`; the time limit is Agentry's
  own clock.
- **Per-model cost for chats started from a terminal, or run before Agentry recorded it** — the CLI
  reports it in the result of a process Agentry drove, so such a cost is "not reported", never estimated.
- **Cancelling one command on every platform** — finding a command's process tree reads `/proc`, so it
  works on Linux; elsewhere Agentry refuses rather than guess.
