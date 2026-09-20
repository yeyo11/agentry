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
  each under a timeout, with a fixer agent held to rules Agentry writes and a cap on attempts; the
  outcome (`passed`, `fixed`, `failed`) is on the graph before a pull request is offered. Workers run
  only the type check and the unit tests.
- **Chat control** — the CLI's control protocol over stdio: permission prompts, `AskUserQuestion`
  and plan approval answered from the UI, interrupting a turn, switching the permission mode and
  the model mid-chat; attachments (images, PDFs, files) in the composer, cost budgets
  (`--max-budget-usd`), per-chat git worktrees.
- **Tools and servers per chat** — named, editable presets of allowed and disallowed tools
  (`read-only`, `no-network` and `everything` ship as defaults) and a chosen set of MCP servers,
  through `--allowedTools`, `--disallowedTools`, `--mcp-config` and `--strict-mcp-config`; picked
  when a chat starts, resumes or forks, and shown on the chat because it explains a refusal.
- **Agent observability** — what an agent really did, from git and the transcript rather than from
  what it says: a task's or a chat's commits, changed files with `+/−`, a highlighted diff per file,
  uncommitted work, its own checklist and what it is running now, live from a `changes.updated`
  event. A health badge for a hung or repeated command, no progress, a loop, a test bent to pass,
  silence and a budget, measured against the command durations of this machine, with a notification
  and three ways in: cancel one command's process tree, send a hint (prefilled per signal), interrupt.
  Links open a worktree, a file or a changed line in your editor.
- **A suite that cannot hang** — the browser suite has a time limit per spec and per run, and closes
  Chrome and the wrapper on every way out by the pid it started, never by a name match.
- **Configuration, user and project scope** — settings (guided + raw), instructions, MCP servers
  (user / project / local, connection checks), agents, skills, commands, output styles, rules, a
  confined file explorer, memory, plugins and marketplaces, account credential.
- **Security** — none, bearer token or OIDC (a JWT checked against the issuer's JWKS) in front of every
  route, the token stored only as a hash and shown once, a read-only mode, secrets in MCP `env` and
  `headers` never returned by the API, an audit log of every write, and a Security tab to run it all.
  TLS guidance and a proxy profile: see [SECURITY.md](SECURITY.md) and [docs/deploy.md](docs/deploy.md).
- **Multi-account** — several accounts through claude-swap, with usage per window, manual switch,
  proactive rotation at a usage threshold, rotate-and-resume for a chat that hits its limit, and
  per-chat account pinning. Each account can have a config directory of its own (nothing moved or
  copied), a project can have its own rotation policy, and every account's usage is kept as a history.
- **claude.ai connectors** — the Docs, Gmail and Calendar connectors the CLI can see, as `claude mcp
  list` reports them, with prepared prompts that start a chat and what to do to authorise one. What
  has no CLI surface (web artifacts, claude.ai memory) is said plainly on the page.
- **Scheduling** — recurring chats and orchestrations on a cron expression and a time zone, with a
  cron builder that explains itself, run now, and a run history. A slot is claimed by a unique key so it
  never fires twice; one missed while Agentry was down is recorded as skipped, never run late.
- **Usage and cost over time** — per day or week, per project and per model, from the cost the CLI
  reports (never estimated from tokens), a Usage page with an accessible chart, and any transcript
  exported as Markdown or JSON.
- **Persistence** — chats survive wrapper restarts, and one cut off by a restart says so and when it
  stopped; orchestrations, schedules and credentials are in the data volume.
- **Live updates without polling** — one global SSE feed (`GET /api/events`) for chats, prompts
  waiting for a person, tasks, subagents, workflows, orchestrations, changes on disk, health, account
  rotation and sessions on disk, with `Last-Event-ID` resume; the UI keeps its caches fresh from it and
  only polls, slowly, while the stream is down.
- **Notifications** — a notification center in the top bar fed by that feed: chats waiting for an
  answer first (including the ones already waiting when the page loads, and a link that opens the
  prompt), then finished or failed chats and orchestrations, conflicts, rate limits and rotations, a
  worker that looks stuck, and finished tasks, subagents and workflows; toasts, and opt-in browser
  notifications for a hidden tab.
- **Execution detail** — side panels for a subagent, a background task and a workflow agent: prompt,
  status, duration, tokens, the full transcript, the result and the tasks a subagent launched, read from
  the files the CLI writes and updated live from the feed. Every task can show its output, followed while
  it runs, and tasks launched by a subagent are tagged.
- **API reference** — OpenAPI 3.1 generated from the shared types, served with Scalar at `/docs`;
  a test enforces that every route is documented.
- **UI** — command palette (⌘K), light/dark/system themes, English and Spanish, CodeMirror editors,
  unsaved-change guards, toasts and confirmation dialogs, themed form controls (Radix), responsive layout.
- **Tests** — unit (core), API integration (Fastify inject) and an in-repo browser suite (`e2e/`,
  headless Chrome over CDP against an isolated wrapper).
- **Docker and Kubernetes** — single image (non-root, CLI baked in and pinned, healthcheck that restarts a
  wedged server), one volume for the whole account setup; published to ghcr.io for amd64 (`edge` from
  `main`, `latest` and a version tag per release). A compose profile with a TLS-terminating proxy and a
  Helm chart; an in-UI check for a newer Claude Code, on demand and once a day.
- **CI and releases** — typecheck, tests, e2e and an image smoke test on every pull request;
  release-please versioning and changelog.
- **Linux desktop app** — Electron shell running the bundled API, packaged as AppImage and `.deb`
  and attached to every release. See [docs/desktop.md](docs/desktop.md).

## Next

What is still open is either something a task chose not to build, or something Claude Code does not
expose. The plans say why: [docs/plans/roadmap-completion.md](docs/plans/roadmap-completion.md) and
[docs/plans/agent-observability.md](docs/plans/agent-observability.md).

### Not built yet

- **A supervisor agent** — a cheap model (Haiku) that wakes only when a health signal fires, reads the
  worker's last steps and drafts the hint, off by default and approved by a person. Every signal
  already carries a hint text Agentry writes, which covers the same ground without a second model
  to pay for and trust, so this stays open.
- **Answering a permission prompt from the notification.** A waiting notification opens the prompt,
  scrolled into view; the toast still opens the chat.
- **Security, the parts around it** — a sign-in that talks to an identity provider (Agentry only
  validates a JWT; the browser signs in with a token), a way to rotate the token without file access
  (the recovery today is deleting `<data dir>/auth.json`), a method and status filter on the audit log,
  escaping `%` and `_` in its path filter, and a banner on every page while read-only is on.
- **Tools and servers** — a named default preset for new chats, a "restore the shipped presets" action
  (a deleted default stays deleted), and picking up an edited server on a chat that already chose it
  without choosing again.
- **Verification** — a cost limit for the fixer (its attempts are bounded, not its spend), an install
  step Agentry adds itself (a fresh worktree needs one listed among the commands), and an option to
  make a failed verification fail the graph.
- **Orchestration and accounts** — renaming a template without opening its graph, importing an
  existing orchestration into a schedule's form, and rotation policies for chats that belong to no
  project.
- **Scheduling** — an overlap policy (a slot fires whether or not the last run has ended) and a live
  `schedule.*` event, so the list stops refetching every 30 s.
- **Usage** — a project export, and a date picker for the custom range.
- **Editor links** — settings kept on the server, so they follow a person across browsers; today
  they are per browser, because they describe the machine the editor runs on.
- **Health** — end-to-end coverage of the health actions in a browser (they need a live process),
  and translations for the strings the server writes in English: a connector's authorisation steps and
  links, and the reasons a card is out of reach.
- **Packaging** — a Helm Ingress template, the chart's version under release-please, and running the
  image build, the Caddy profile and the chart through a real cluster in CI.
- **Polls kept on purpose** — accounts (10 s: usage has no event) and the detail panels while an agent
  or task runs (2.5 s: neither the output file nor the transcript announces each line), until the CLI
  reports more.

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
