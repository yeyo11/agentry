// OpenAPI documentation for every route, kept in one place and attached through an `onRoute`
// hook. Schemas are documentation only: validation stays in @agentry/core, so behaviour is unchanged.

type Json = Record<string, unknown>;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const list = (name: string): Json => ({ type: 'array', items: ref(name) });
const obj = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, required });
const str = (description?: string, extra: Json = {}): Json => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const OK = obj({ ok: { type: 'boolean', const: true } }, ['ok']);

const PROJECT = str("Project id from `GET /projects`. Omit for the user scope (the Claude config dir).");
const VARIANT = str('`local` selects settings.local.json / CLAUDE.local.md (project scope only).', { enum: ['shared', 'local'], default: 'shared' });
const scopeQuery = (extra: Json = {}): Json => obj({ project: PROJECT, ...extra });
const KIND = str('Resource kind', { enum: ['agents', 'skills', 'commands', 'output-styles', 'rules', 'workflows'] });
const ROOT = str("`user` or a project id (see `GET /config/files/roots`)");

export const TAGS = [
  { name: 'System', description: 'CLI detection, health and the dashboard overview.' },
  { name: 'Account', description: 'Credential used by every `claude` process. The secret is never returned.' },
  { name: 'Accounts', description: 'Several Claude accounts through claude-swap (`cswap`), with usage per window and rotation when one runs out.' },
  { name: 'Projects', description: 'Directories imported by hand. A chat belongs to the project whose directory holds it, worktrees included; under none it is loose.' },
  { name: 'Projects & sessions', description: 'Read from the transcripts Claude Code writes under `<configDir>/projects`.' },
  { name: 'Events', description: 'One Server-Sent Events stream announcing every change, so clients do not have to poll.' },
  { name: 'Chats', description: 'Claude Code conversations, one per session id: resumed in place, forked into copies, each with the executions Agentry ran on it.' },
  { name: 'Orchestration', description: 'A DAG of tasks, each executed by its own Claude worker.' },
  { name: 'Schedules', description: 'Cron-like recurring chats and orchestrations, with the history of what each run produced. A slot missed while Agentry was down is skipped, never replayed.' },
  { name: 'Configuration', description: 'Settings, instructions, MCP servers and markdown resources, per user or per project (`?project=`).' },
  { name: 'Config files', description: "Generic editor confined to a scope's Claude dir; secrets and runtime state are refused." },
  { name: 'Memory', description: "Claude Code's per-project file memory." },
  { name: 'Plugins', description: 'Delegated to `claude plugin`; actions return the CLI output.' },
  { name: 'Connectors', description: 'The claude.ai connectors (Docs, Gmail, Calendar) as the CLI reports them. Read-only: Agentry cannot authorise one.' },
  { name: 'Uploads', description: 'Files to attach to a message. Images and PDFs reach Claude as content blocks, any other file by its path.' },
  { name: 'Security', description: 'Who may call this API, whether it accepts changes, and the trail every change leaves.' },
  {
    name: 'Push',
    description:
      'Web Push over VAPID, signed and sent by this server: a chat that stops for a permission prompt reaches a phone whose app is closed. There is no third-party push account — the payload goes out to whatever endpoint the browser handed us. A subscription belongs to an install, not to a person, so every install that registered gets the same notifications.',
  },
];

interface RouteDoc {
  tags: [string];
  summary: string;
  description?: string;
  params?: Json;
  querystring?: Json;
  body?: Json;
  /** 200/201 response schema */
  ok?: Json;
  created?: boolean;
  /** Non-JSON response content type (SSE) */
  produces?: string;
}

const d = (tag: string, summary: string, rest: Omit<RouteDoc, 'tags' | 'summary'> = {}): RouteDoc => ({ tags: [tag], summary, ...rest });

/** Keyed by `METHOD /path` without the `/api` prefix. */
export const ROUTE_DOCS: Record<string, RouteDoc> = {
  // ---- System
  'GET /health': d('System', 'Liveness and readiness', { ok: obj({ ok: { type: 'boolean' }, cli: { type: 'boolean' }, loggedIn: { type: 'boolean' } }) }),
  'GET /system': d('System', 'CLI installation, auth status and paths', { querystring: obj({ refresh: str('`1` bypasses the 30s cache') }), ok: ref('SystemInfo') }),
  'GET /system/cli-version': d('System', 'Claude Code version in use and the newest published', { description: 'What the last check learned; it never reads the registry itself. `checkedAt` says how old the answer is.', ok: ref('CliVersionInfo') }),
  'POST /system/cli-version/check': d('System', 'Check for a newer Claude Code now', { description: 'Reads the npm registry metadata of `@anthropic-ai/claude-code`. The server also does it once a day unless `AGENTRY_CLI_UPDATE_CHECK=off`. A failure keeps the previous answer and reports `error`.', ok: ref('CliVersionInfo') }),
  'GET /overview': d('System', 'Everything the dashboard needs in one call', { ok: ref('Overview') }),

  // ---- Account
  'GET /auth': d('Account', 'Fresh auth status', { ok: ref('AuthStatus') }),
  'PUT /auth/credentials': d('Account', 'Store the account credential', { description: 'Exactly one of `oauthToken` (from `claude setup-token`) or `apiKey`. Stored in the data volume (mode 600) and applied to every new process; overrides the container environment.', body: ref('SetCredentialsRequest'), ok: ref('AuthStatus') }),
  'DELETE /auth/credentials': d('Account', 'Remove the stored credential', { description: 'Falls back to the credential from the container environment, if any.', ok: ref('AuthStatus') }),
  'POST /auth/verify': d('Account', 'Verify the credential with a real request', { description: '`claude auth status` only reports what is configured; this sends a minimal prompt to prove it works. Costs a few tokens.', ok: ref('AuthVerification') }),

  // ---- Accounts
  'GET /accounts': d('Accounts', 'Accounts, usage and rotation state', { description: 'Reports `cswap.installed === false` when claude-swap is not available; everything else is then empty.', querystring: obj({ refresh: str('`1` bypasses the 30s cache and re-reads the usage') }), ok: ref('AccountsOverview') }),
  'POST /accounts/switch': d('Accounts', 'Switch the active account', { description: 'Without a target it rotates: `best` picks the most headroom, `next-available` the next account that still has quota. The credential file is swapped under Claude Code\'s own locks; runs already in flight keep the account they started with.', body: ref('SwitchAccountRequest'), ok: ref('SwitchResult') }),
  'POST /accounts/token': d('Accounts', 'Register an account from a token', { description: 'Body carries a token from `claude setup-token` (or an API key). It is passed to `cswap add-token` over stdin and never returned.', body: ref('AddAccountTokenRequest'), ok: ref('AccountsOverview'), created: true }),
  'DELETE /accounts/:number': d('Accounts', 'Remove an account', { ok: OK }),
  'POST /accounts/:number/enable': d('Accounts', 'Return an account to the rotation', { ok: OK }),
  'POST /accounts/:number/disable': d('Accounts', 'Hold an account out of the rotation', { ok: OK }),
  'PUT /accounts/:number/alias': d('Accounts', 'Set or clear the account alias', { body: ref('SetAccountAliasRequest'), ok: OK }),
  'PUT /accounts/:number/config': d('Accounts', 'Give an account its own config directory, or take it back', { description: 'Sets `CLAUDE_CONFIG_DIR` for every process started for the account; `null` goes back to sharing the wrapper\'s. Nothing is moved or copied: the directory is created empty and `projects/` (plus, with `shareSettings`, the shared settings) is symlinked into it. Clearing it removes only the symlinks Agentry made. A chat on such an account runs `claude` directly against the directory, so the login is whatever it holds.', body: ref('UpdateAccountConfigRequest'), ok: ref('AccountConfig') }),
  'GET /accounts/policies': d('Accounts', 'Rotation policies of projects and of chats without one', { description: 'A project with no policy, and a chat under no project when no policy has `looseChats`, keep the global auto-switch.', ok: list('RotationPolicy') }),
  'POST /accounts/policies': d('Accounts', 'Create a rotation policy', { description: 'Which accounts the chats of some projects may use, in which order, and the usage threshold past which the next one is taken. With `looseChats` it also governs the chats that belong to no project, and `projects` may then be empty. A project is governed by at most one policy, and so are the chats without one.', body: ref('RotationPolicyRequest'), ok: ref('RotationPolicy'), created: true }),
  'PUT /accounts/policies/:id': d('Accounts', 'Replace a rotation policy', { body: ref('RotationPolicyRequest'), ok: ref('RotationPolicy') }),
  'DELETE /accounts/policies/:id': d('Accounts', 'Delete a rotation policy', { ok: OK }),
  'GET /accounts/usage': d('Accounts', 'Usage history per account', { description: 'Readings of the 5h and 7d windows as claude-swap reported them, kept as rows, oldest first: one series per account and window.', querystring: obj({ account: str('Slot number'), window: str('`5h` or `7d`'), since: str('ISO-8601 lower bound'), until: str('ISO-8601 upper bound'), limit: str('Max readings (default 5000, keeps the newest)') }), ok: list('UsageHistoryPoint') }),
  'GET /accounts/events': d('Accounts', 'Rotation history', { description: 'Every poll, switch and failure claude-swap reported, persisted across restarts. `GET /accounts` carries only the last 200.', querystring: obj({ limit: str('Max events to return (default 200, max 5000)'), since: str('ISO-8601 timestamp; only newer events are returned') }), ok: list('AutoSwitchEvent') }),
  'GET /accounts/autoswitch': d('Accounts', 'Auto-rotation settings', { ok: ref('AutoSwitchSettings') }),
  'PUT /accounts/autoswitch': d('Accounts', 'Change the auto-rotation settings', { description: 'Enabling it supervises a `cswap auto --json` process that rotates before the active account reaches `threshold`. `rotateOnLimit` also rotates and resumes a run that died against its limit.', body: ref('AutoSwitchSettings'), ok: ref('AutoSwitchSettings') }),

  // ---- Projects
  'GET /projects': d('Projects', 'Imported projects', { description: 'Only directories that were imported. Each carries its worktrees and the number of chats under it or them.', ok: list('Project') }),
  'GET /projects/candidates': d('Projects', 'Directories worth importing', { description: 'Directories chats have run in that are not projects yet, the busiest first, with scratch and missing directories left out. What a first start offers instead of an empty screen.', ok: list('ProjectCandidate') }),
  'POST /projects/import': d('Projects', 'Import a directory as a project', { description: 'Every chat under the directory belongs to it from then on, retroactively. A git worktree is refused: it belongs to its repository.', body: ref('ImportProjectRequest'), ok: ref('Project'), created: true }),
  'POST /projects': d('Projects', 'Create a project in the workspace', { description: 'Creates an empty directory, or clones `gitUrl` into it, and imports it.', body: ref('CreateProjectRequest'), ok: ref('Project'), created: true }),
  'PATCH /projects/:id': d('Projects', 'Rename a project', { params: obj({ id: str('Project id') }), body: ref('UpdateProjectRequest'), ok: ref('Project') }),
  'GET /projects/:id/export': d('Projects', 'Export a project\'s chats as Markdown or JSON', {
    description:
      'A download, streamed a chat at a time. `markdown` (default) opens with the project, the dates its chats span, the models that answered, the cost as the CLI reported it (chats started outside Agentry report none, and the header counts them) and a numbered list of the chats, then every chat oldest first as a section rendered like `GET /chats/:id/export`. `json` is a `ProjectExport`: the project and a `ChatExport` per chat. Housekeeping chats are left out.',
    params: obj({ id: str('Project id') }),
    querystring: obj({ format: str('Output format', { enum: ['markdown', 'json'] }) }),
    ok: ref('ProjectExport'),
  }),
  'DELETE /projects/:id': d('Projects', 'Remove a project from Agentry', { description: 'Harmless: nothing on disk changes, and importing the directory again adopts its chats again. Distinct from `DELETE /projects/:id/state`.', params: obj({ id: str('Project id') }), ok: OK }),
  'DELETE /projects/:id/state': d('Projects', 'Purge everything Claude Code keeps about a project', { description: 'Transcripts, tasks, file history and the config entry, through `claude project purge`. Irreversible; the project stays imported.', params: obj({ id: str('Project id') }), ok: obj({ detail: str('What the CLI reported') }) }),

  // ---- Events
  'GET /events': d('Events', 'Live feed of everything that changes (Server-Sent Events)', {
    description:
      'One stream for the whole app. Every message has an SSE `id`, an `event:` line naming its `type` and `data: <AgentryEvent JSON>`: run created/updated/ended/removed, prompts waiting for a person (`run.waiting`, `permission.*`), rate limits and account rotation, background tasks, subagents and workflows starting and ending, orchestration, task and merge-conflict changes, what each chat is doing right now (`chat.activity`), schedules created, edited, switched, rescheduled or deleted (`schedule.changed`) and every run row a schedule writes (`schedule.fired`), and `sessions.changed` when the CLI writes under its projects directory. Events describe what changed and carry the ids to refetch it; `run.updated` and `workflow.progress` are coalesced to about one per 250 ms, and `chat.activity` to at most one per chat per second. The stream opens with `stream.hello` (no id) carrying the server `bootId`. Reconnect with `Last-Event-ID` (or `since`) to receive what was missed from a bounded in-memory buffer; when that id has fallen out of it, or belongs to a previous server process, `stream.resync` is sent instead and the client must refetch everything it shows. A `: ping` comment is sent every 15 s.',
    querystring: obj({ since: str('Last event id already received; the `Last-Event-ID` header wins') }),
    ok: ref('AgentryEvent'),
    produces: 'text/event-stream',
  }),

  // ---- Chats
  'GET /chats': d('Chats', 'Chats, newest first', {
    description:
      'One entry per Claude Code conversation, whoever started it and however many times it was resumed: the id is the session id. Workers of an orchestration and housekeeping chats are left out unless asked for with `origin`. `state` says what is happening (`working`, `waiting` for a person, `idle`), `control` what can be done now and why not when it cannot.',
    querystring: obj({
      project: str('Only chats of this project'),
      loose: str('`1` for chats under no project'),
      origin: str('Comma-separated origins to include: `agentry`, `external`, `orchestration`, `internal` (default `agentry,external`)'),
      workers: str('`0` leaves out the workers of orchestrations and keeps their syntheses, which share the `orchestration` origin', { enum: ['0', '1'] }),
      state: str('Only chats in this state', { enum: ['working', 'waiting', 'idle'] }),
      limit: str('Max chats to return'),
    }),
    ok: list('ChatSummary'),
  }),
  'GET /usage': d('Chats', 'What the chats spent, per day, per project and per orchestration', {
    description:
      'Tokens come from the transcripts, so they cover every chat, subagents included, and are kept per model with the variant suffix whole. The cost is what the CLI reported (`total_cost_usd`), which exists only for chats Agentry launched: nothing is estimated from a price table, `costUsd` is `null` when nothing reported one, and `chatsWithoutCost` counts the chats a total leaves out. A day is a calendar day where the server runs; a cost is put on the day its execution ended.',
    querystring: obj({ from: str('First day, `YYYY-MM-DD` (inclusive)'), to: str('Last day, `YYYY-MM-DD` (inclusive)') }),
    ok: ref('UsageReport'),
  }),
  'GET /usage/series': d('Chats', 'Cost and tokens over time, by day or by week', {
    description:
      'One point per bucket from `from` to `to`, empty buckets included so a chart has no gaps; without a range it spans the days that have something, up to today. A week starts on Monday and is named by that day. Days are cut by the range before they are bucketed, so the first week of a range that starts mid-week holds only the days asked for. `costUsd` is what the CLI reported and is `null` for a bucket where no chat reported one: nothing is estimated from token counts. At most 1000 points.',
    querystring: obj({ bucket: str('Width of a point', { enum: ['day', 'week'] }), from: str('First day, `YYYY-MM-DD` (inclusive)'), to: str('Last day, `YYYY-MM-DD` (inclusive)') }),
    ok: ref('UsageSeries'),
  }),
  'GET /usage/breakdown': d('Chats', 'What the chats spent, per project and per model', {
    description:
      'The same range cut two ways, most spent first. Tokens come from the transcripts and cover every chat. The cost per model is the CLI\'s own (`modelUsage[model].costUSD` of each result); an execution recorded before Agentry kept that split is put on the model it ran. `costUsd` is `null` for a slice no chat reported a cost for. Chats under no project are the slice `loose`; messages that named no model are the slice `unknown`.',
    querystring: obj({ from: str('First day, `YYYY-MM-DD` (inclusive)'), to: str('Last day, `YYYY-MM-DD` (inclusive)') }),
    ok: ref('UsageBreakdown'),
  }),
  'GET /chats/:id/export': d('Chats', 'Export a chat\'s transcript as Markdown or JSON', {
    description:
      'A download. `markdown` (default) is for a person: a header with the project, models, cost as the CLI reported it and tokens, then the turns, each tool call folded into a `<details>` block with its result (results over 4000 characters are cut) and subagent messages left out. `json` is a `ChatExport`: the chat and every transcript entry in order, subagents included, nothing cut.',
    querystring: obj({ format: str('Output format', { enum: ['markdown', 'json'] }) }),
    ok: ref('ChatExport'),
  }),
  'POST /chats': d('Chats', 'Start a chat', { description: 'Spawns `claude -p` with stream-json I/O under a session id Agentry chooses. With `keepAlive` (default) the process stays up for follow-up turns.', body: ref('NewChatRequest'), ok: ref('ChatSummary'), created: true }),
  'GET /chats/:id': d('Chats', 'A chat and a window of its transcript', {
    description:
      'The chat with its branches (subagents, background tasks, workflows), environment and `health` — computed when it is read, so a chat that is working should be read again: a command that has run too long sends no event — and the newest `limit` transcript entries by default — a long conversation runs to tens of megabytes, which nobody reads at once. `from` is the index the window starts at and `total` what the transcript holds, so passing the `from` of a page back as `before` reads the one before it. A chat with no transcript (housekeeping, or one that has not written its first line) is read from what its process streamed.',
    querystring: obj({ sidechains: str('`1` includes subagent messages'), limit: str('Entries per page (default 200, max 1000)'), before: str('Index to read backwards from: the `from` of the previous response') }),
    ok: ref('ChatDetail'),
  }),
  'GET /chats/:id/search': d('Chats', 'Search the whole transcript', { description: 'Case-insensitive plain-text match over what the transcript view shows of each entry: text, thinking, tool names and inputs, tool results. Any run of whitespace in `q` matches any run in the text. One hit per matching entry, `index` in the same space as a page\'s `from` and `total`, so a hit on a page not loaded yet is reached by reading back to it. At most 500 hits, the newest; `truncated` says older ones were left out.', querystring: obj({ q: str('Text to find (required, up to 200 characters)'), sidechains: str('`1` includes subagent messages, as the page read with it does') }, ['q']), ok: ref('TranscriptSearchResult') }),
  'GET /chats/:id/changes': d('Chats', 'What a chat changed on disk', {
    description: 'For a chat in a git worktree, the branch, its base, the commits and the files it changed against that base, and what it has not committed yet. Any chat also gets the files its `Write`/`Edit`/`NotebookEdit` calls touched, read from the transcript, so a chat outside git still answers. A worker of an orchestration is measured from where its own branch was cut.',
    ok: ref('ChatChanges'),
  }),
  'GET /chats/:id/changes/diff': d('Chats', 'The diff of one file of a chat in a worktree', {
    description: "Everything the branch did to the file since its base, committed or not. A file created and not yet added shows as all new. Refused for a chat with no worktree of its own.",
    querystring: obj({ path: str('File to diff, relative to the checkout (required)') }, ['path']),
    ok: ref('FileDiff'),
  }),
  'GET /chats/:id/checklist': d('Chats', "The chat's own checklist", {
    description: 'The plan the agent kept with its `TaskCreate`/`TaskUpdate` or `TodoWrite` calls, as of its last update. Empty for one that never planned.',
    ok: ref('Checklist'),
  }),
  'GET /chats/:id/stream': d('Chats', 'Live event stream (Server-Sent Events)', {
    description:
      'Replays buffered events with `seq > since` (or `Last-Event-ID`), then streams live ones. Each message is `data: <RunEvent JSON>`. Ephemeral `partial` events carry the text generated so far (token streaming); they have no SSE id and are never replayed. Only a chat Agentry has driven has a stream; to follow one, take the last event\'s `seq` from the page you hold and pass it as `since`.',
    querystring: obj({ since: str('Last seq already received') }),
    ok: ref('RunEvent'),
    produces: 'text/event-stream',
  }),
  'POST /chats/:id/resume': d('Chats', 'Continue a chat in place', { description: 'Adds an execution to the same chat, which keeps its id: it never creates one. Whether something else holds the session is checked on the server at this moment, from the CLI\'s own list and the process table, whatever the client last saw. A chat from a terminal that nothing holds is adopted and stays `external`; one a terminal holds, or that belongs to an orchestration, is refused with 409 and the reason, and `fork` is the way forward. The chat keeps its tools and MCP servers unless the request picks others; with no `mcp`, the config file the CLI reads is written again from the current definitions of the same servers, so a server edited since starts as it is now (one removed since is left out).', body: ref('ResumeChatRequest'), ok: ref('ChatSummary') }),
  'POST /chats/:id/fork': d('Chats', 'Continue a chat in a copy', { description: 'Creates a new chat with the same history that records where it came from (`derivedFrom`), and leaves the original untouched. Available on any chat, held or not. The copy runs with the source\'s tools and MCP servers (preset, allowed and disallowed tools, server selection, the servers as they are defined now) unless the request picks others.', body: ref('ForkChatRequest'), ok: ref('ChatSummary'), created: true }),
  'POST /chats/:id/messages': d('Chats', 'Send another turn', { description: 'To a chat with a live execution. `attachments` are upload ids from `POST /uploads`; with attachments the text may be empty. A chat without one is refused with 409: resume it.', body: ref('ChatMessageRequest'), ok: ref('ChatSummary') }),
  'POST /chats/:id/stop': d('Chats', 'Stop what is working on the chat', { description: 'The execution Agentry runs, or for a background session the CLI itself holds, `claude stop`, so no pid is signalled directly. The conversation is kept and can be resumed.', ok: ref('ChatSummary') }),
  'POST /chats/:id/interrupt': d('Chats', 'Interrupt the current turn', { description: 'Ends the turn in progress and keeps the process, which waits for the next message. Any prompt the chat was holding is withdrawn.', ok: ref('ChatSummary') }),
  'POST /chats/:id/hint': d('Chats', 'Send a hint to a chat that is working', { description: 'A nudge: the text reaches the worker as its next user message. For a chat whose process is up; one with none is refused with 409, and a message resumes it. The suggested text for each signal of the chat\'s health is on the signal (`hint`).', body: ref('HintRequest'), ok: ref('ChatSummary') }),
  'POST /chats/:id/commands/:toolUseId/cancel': d('Chats', 'Cancel one command without ending the turn', { description: 'Kills the process tree of one shell command the chat is running, found under the CLI process by the tree and by when each process started, never by matching a command line. The CLI hands the worker a failed result for that call and the turn goes on; the worker is told a person did it. Refused with 409 when the call is not a command that is running, or its process cannot be told apart from another. Needs `/proc`, so Linux only. Which call to cancel is on the health signal (`toolUseId`).', body: ref('CancelCommandRequest'), ok: ref('CancelCommandResult') }),
  'GET /settings/supervisor': d('Chats', 'Supervisor settings', { description: "The optional supervisor: a housekeeping chat of the CLI (`haiku` by default) that wakes once per signal per chat when a worker's health turns `bad`, reads the signal and the worker's last steps, and proposes a hint of a line or two. Off by default. Read from `supervisor.json` in the data directory; absent, the defaults.", ok: ref('SupervisorConfig') }),
  'PUT /settings/supervisor': d('Chats', 'Change the supervisor settings', { description: 'Replaces the whole document. `model` is what the housekeeping chat is started with (`--model`), `maxCostUsd` its `--max-budget-usd` (above 0, at most 5), and `autoSend` sends each proposal to the worker without waiting for a person.', body: ref('UpdateSupervisorConfigRequest'), ok: ref('SupervisorConfig') }),
  'POST /chats/:id/supervisor/:proposalId/send': d('Chats', "Send the supervisor's proposal", { description: "Delivers the proposed hint through the hint route (the task's, for a worker of an orchestration) and marks it `sent`. 409 when it was already sent or dismissed, or the chat has no live process to take it. The proposal is on the chat's `health.proposal` and in the `supervisor.proposed` event.", params: obj({ id: str(), proposalId: str() }), ok: ref('SupervisorProposal') }),
  'POST /chats/:id/supervisor/:proposalId/dismiss': d('Chats', "Dismiss the supervisor's proposal", { description: 'Marks it `dismissed`; nothing reaches the worker. 409 when it was already sent or dismissed.', params: obj({ id: str(), proposalId: str() }), ok: ref('SupervisorProposal') }),
  'PATCH /chats/:id': d('Chats', 'Change the permission mode or the model', { description: 'A live process switches at once; a chat whose process has exited gets the new settings when the next execution starts.', body: ref('ChatSettingsUpdate'), ok: ref('ChatSummary') }),
  'DELETE /chats/:id': d('Chats', 'Delete a chat', { description: 'Its transcript, its sidecar files and Agentry\'s record of it. Refused with 409 while something is running on it.', ok: OK }),
  'GET /chats/:id/logs': d('Chats', "A background session's recent terminal output", { description: 'From `claude logs`: the process output, which the transcripts do not contain.', ok: obj({ logs: str('Raw terminal output') }) }),
  'GET /chats/:id/permissions': d('Chats', 'Prompts waiting for a person', { description: 'Tool calls to approve, questions (`AskUserQuestion`) and plans (`ExitPlanMode`). Populated only when the chat was started with `permissionPrompts: "host"`. A notice on the chat\'s event stream announces each one.', ok: list('PermissionRequest') }),
  'POST /chats/:id/permissions/:requestId': d('Chats', 'Answer a prompt', { description: 'Allow, optionally with edited arguments and with the request\'s `suggestions` to remember them, or deny with a message the model can read and adapt to. A question is answered by allowing it with `updatedInput.answers` mapping each question to the chosen label(s). A request nobody answers is denied after ten minutes.', body: ref('PermissionDecision'), ok: ref('PermissionRequest') }),
  'GET /chats/:id/subagents': d('Chats', 'Subagents of a chat', { description: 'A branch of the chat: its messages live inside the chat\'s transcript. Read from what the CLI writes beside the transcript, so it covers chats started from a terminal as well as Agentry\'s. An agent is running until it stops, and again whenever it writes after stopping — the CLI can resume one.', ok: list('ChatSubagentEntry') }),
  'GET /chats/:id/subagents/:agentId': d('Chats', 'One subagent: prompt, outcome and full transcript', { description: 'Carries the prompt, type, status, duration, token usage, the final result, the conversation normalised like the chat\'s, and the background tasks the subagent launched. `after` skips the first N entries, so a live view can append: pass back the `total` of the previous response. `agentId` is the `id` of the subagent in the chat.', querystring: obj({ after: str('Entries already held: only those from this index on are returned') }), ok: ref('AgentTranscript') }),
  'GET /chats/:id/tasks': d('Chats', 'Commands a chat sent to the background', { description: 'The command, who sent it to the background, and how it ended. One still marked running when nothing is left to run it is reported as `stopped`. Those a subagent launched are listed too, with its id as `ownerId`.', ok: list('ChatBackgroundTaskEntry') }),
  'GET /chats/:id/tasks/:taskId/output': d('Chats', 'What a background command printed', { description: 'Read from the CLI\'s temp dir, which a reboot clears. Without `offset`, the last 64 KiB of the file. With it, up to 64 KiB of what was written after that byte, so a running task can be followed by passing back the `offset` of the previous response; `offset` less than `bytes` means more is waiting. An `offset` past the end of the file (it was replaced) restarts from the tail with `reset: true`.', querystring: obj({ offset: str('Byte position to resume from: the `offset` of the previous response') }), ok: ref('BackgroundTaskOutput') }),
  'GET /chats/:id/workflows': d('Chats', 'Workflow runs of a chat', { description: 'Runs of the Workflow tool: a script that orchestrates subagents inside the chat, with its phases and the progress of every agent it launched.', ok: list('ChatWorkflowEntry') }),
  'GET /chats/:id/workflows/:workflowId/agents/:agentId': d('Chats', 'One workflow agent: prompt, outcome and full transcript', { description: 'The same as a subagent\'s, for an agent a workflow launched: `workflowId` is the workflow\'s and `agentId` comes from its `agents`. Status and timing come from the workflow\'s record or journal.', querystring: obj({ after: str('Entries already held: only those from this index on are returned') }), ok: ref('AgentTranscript') }),
  'GET /environments': d('Chats', 'What Claude actually loaded, per directory', { description: 'Tools, MCP server status, agents, skills, plugins, slash commands and memory paths, captured from the `init` event of the latest chat started in each directory.', querystring: obj({ cwd: str('Absolute directory to filter by') }), ok: list('EffectiveEnvironment') }),
  'GET /tasks': d('Chats', 'Background commands across every chat', { description: 'Commands sent to the background, monitors and remote agents, each with the chat that sent it: the inbox sees a hung command wherever it is. A chat with a process reports from its stream; the others (terminal chats live or ended in the last day, ended chats of Agentry) are read from their files, so the list survives a restart. The CLI reports long foreground commands as tasks too; those are left out, and so are subagents (`/subagents`) and workflows (`/workflows`).', ok: list('ChatBackgroundTaskEntry') }),
  'GET /subagents': d('Chats', 'Subagents across every chat', { description: 'Agents spawned with the Agent tool, in the foreground or the background, each with the chat it belongs to. Agents a workflow launched are listed with their workflow.', ok: list('ChatSubagentEntry') }),
  'GET /workflows': d('Chats', 'Workflow runs across every chat', { description: 'Runs of the Workflow tool, each with the chat it runs in, with its phases and the progress of every agent it launched.', ok: list('ChatWorkflowEntry') }),
  'GET /workflows/saved': d('Chats', 'Saved workflows', { description: 'Scripts in the project\'s `.claude/workflows/` (for `cwd`) and the user\'s, which the Workflow tool runs by name. A project workflow shadows a user one of the same name.', querystring: obj({ cwd: str('Project directory') }), ok: list('WorkflowDefinition') }),
  'POST /workflows/saved/run': d('Chats', 'Run a saved workflow', { description: 'Starts a chat that asks Claude to run the workflow with the Workflow tool: the CLI has no command of its own for it. Prompts go to the panel.', body: ref('RunWorkflowRequest'), ok: ref('ChatSummary'), created: true }),

  // ---- Orchestration
  'GET /orchestrations': d('Orchestration', 'List orchestrations', { ok: list('Orchestration') }),
  'POST /orchestrations': d('Orchestration', 'Launch an orchestration', { description: 'Independent tasks run in parallel up to `concurrency`; results of dependencies are passed to dependent tasks; `synthesize` adds a final report worker. Task ids must be unique and the graph acyclic. `limits` (on the graph, as the default, and on each task) cap what a worker may spend: `maxCostUsd` is passed to the CLI as `--max-budget-usd`, and `maxMinutes` is enforced by Agentry, which tells the worker to wrap up at 80% and stops the task at the limit, failing it with the reason.', body: ref('OrchestrationSpec'), ok: ref('Orchestration'), created: true }),
  'POST /orchestrations/plan': d('Orchestration', 'Draft a task graph from an objective', { description: 'Runs a planner agent with structured output; can take a couple of minutes. The draft is not launched.', body: ref('PlanRequest'), ok: ref('OrchestrationSpec') }),
  'POST /orchestrations/plan/start': d('Orchestration', 'Start the planner without waiting', { description: 'Returns the planner chat immediately; stream it at `/chats/:id/stream` and fetch the draft from `/orchestrations/plans/:runId` (the id of the planner chat) when it finishes. Preferred over `POST /orchestrations/plan`, which holds the request open for the whole run.', body: ref('PlanRequest'), ok: ref('ChatSummary'), created: true }),
  'GET /orchestrations/plans': d('Orchestration', 'Plans generated but not yet launched', { description: 'Recorded when a planner run finishes, so a draft survives a lost response or a reload.', querystring: obj({ limit: str('Max drafts to return (default 20, max 100)') }), ok: list('PlanDraftSummary') }),
  'GET /orchestrations/plans/:runId': d('Orchestration', 'The draft a planner run produced', { ok: ref('OrchestrationSpec') }),
  'GET /orchestrations/:id': d('Orchestration', 'State of every task, results and cost', { description: 'A task that is running carries its `health`, worked out when it is read: the same signals as a chat\'s, with the call to cancel and a suggested hint on each. The list carries it too.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/resume': d('Orchestration', 'Resume a stopped orchestration', { description: 'Runs again every task that did not complete and keeps the results of those that did; a task that already has a chat continues it, in a new execution. The body can correct the settings that stopped it — worktrees, where permission prompts go, allowed tools, permission mode — so a graph started with the wrong ones is picked up instead of rebuilt.', body: ref('ResumeOrchestrationRequest'), ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/retry': d('Orchestration', 'Run a failed task again in its own chat', { description: 'Only a task that failed for good (its attempts ran out, or it failed in a way that is never retried automatically). A new execution of the same chat, in the worktree it left, told what went wrong; the tasks blocked behind it go back to waiting for their turn. One more execution, however many attempts the graph allows: if it fails again the task is left for a decision again.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/retry-clean': d('Orchestration', 'Start a failed task over', { description: 'A new chat, in a worktree rebuilt from the base commit: the failed chat stays listed as what was tried, and its worktree and branch are removed, uncommitted work included.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/rerun': d('Orchestration', 'Run a task of a finished graph again', { description: 'For a graph that completed, failed or was stopped: the task and every task that depends on it start over, each in a new chat and a worktree rebuilt from what it now depends on, and the graph integrates and synthesises again. The integration branch is rebuilt from the base. Tasks that do not depend on it keep their work. Refused while the graph runs or waits for a decision (use retry or skip there), for a workflow, while any affected task has a process, and once the integration branch was pushed for a pull request.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/relaunch': d('Orchestration', 'Relaunch a graph with corrections as a new orchestration', { description: 'Starts from what the graph ran with. `spec` overrides its settings (name, objective, model, concurrency, worktrees…), and `tasks` replaces the whole task list: merging two graphs by task id is not attempted. The new orchestration records the original in `relaunchedFrom`; the original is left as it was. Refused while the original runs.', body: ref('RelaunchOrchestrationRequest'), ok: ref('Orchestration'), created: true }),
  'GET /orchestrations/templates': d('Orchestration', 'List orchestration templates', { description: 'Saved graphs, by name. Stored as a JSON file in the data directory.', ok: list('OrchestrationTemplate') }),
  'POST /orchestrations/templates': d('Orchestration', 'Save a graph as a template', { description: 'Give the graph as `spec` (a draft plan, say) or as `fromOrchestration`, the id of an orchestration to take it from. The task graph is validated as for a launch; names are unique.', body: ref('SaveOrchestrationTemplateRequest'), ok: ref('OrchestrationTemplate'), created: true }),
  'GET /orchestrations/templates/:templateId': d('Orchestration', 'One orchestration template', { ok: ref('OrchestrationTemplate') }),
  'PATCH /orchestrations/templates/:templateId': d('Orchestration', 'Edit an orchestration template', { description: 'Rename it, change its description or replace its spec.', body: ref('UpdateOrchestrationTemplateRequest'), ok: ref('OrchestrationTemplate') }),
  'DELETE /orchestrations/templates/:templateId': d('Orchestration', 'Delete an orchestration template', { description: 'Orchestrations launched from it are not affected.', ok: OK }),
  'POST /orchestrations/templates/:templateId/launch': d('Orchestration', 'Launch an orchestration template', { description: "Launches the template's graph with a new `objective`, `cwd`, `name` or `model`; what is given applies to this run only, and the template is not changed. The orchestration records the template in `templateId`.", body: ref('LaunchOrchestrationTemplateRequest'), ok: ref('Orchestration'), created: true }),
  'POST /orchestrations/:id/tasks/:taskId/skip': d('Orchestration', 'Give a branch up', { description: 'Skips a failed or blocked task and every task that depends on it, so the graph can finish without them. Nothing is deleted. A graph waiting on nothing else then integrates and synthesises.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/hint': d('Orchestration', 'Send a hint to a running worker', { description: 'A nudge for a worker whose task is still running, delivered as a message to its chat. Refused for a task that finished: its result already fed the tasks that depend on it, and its way forward is a fork of its chat.', body: ref('TaskHintRequest'), ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/supervisor/:proposalId/send': d('Orchestration', "Send the supervisor's proposal to a worker", { description: "The same as the chat route, from the board: the hint goes through the task hint route, so a task that is no longer running refuses it. What the supervisor cost is already on the graph's `costUsd`.", params: obj({ id: str(), taskId: str(), proposalId: str() }), ok: ref('SupervisorProposal') }),
  'POST /orchestrations/:id/tasks/:taskId/supervisor/:proposalId/dismiss': d('Orchestration', "Dismiss the supervisor's proposal for a worker", { description: 'Marks it `dismissed`; nothing reaches the worker.', params: obj({ id: str(), taskId: str(), proposalId: str() }), ok: ref('SupervisorProposal') }),
  'GET /orchestrations/:id/tasks/:taskId/changes': d('Orchestration', 'What a task changed on disk', {
    description: "The task's branch, the commit it started from (its dependencies' work is not counted as its own), the commits and the files it changed since, and what it has not committed yet. Refused for a graph without worktrees. A task that has not started has an empty summary. Announced by a `changes.updated` event while the worker runs.",
    ok: ref('ChangeSummary'),
  }),
  'GET /orchestrations/:id/tasks/:taskId/changes/diff': d('Orchestration', 'The diff of one file of a task', {
    description: 'Everything the task did to the file since it started, committed or not. A file created and not yet added shows as all new.',
    querystring: obj({ path: str('File to diff, relative to the checkout (required)') }, ['path']),
    ok: ref('FileDiff'),
  }),
  'GET /orchestrations/:id/tasks/:taskId/checklist': d('Orchestration', "A task's own checklist", {
    description: "The plan the worker kept with its `TaskCreate`/`TaskUpdate` or `TodoWrite` calls, read from its chat's transcript, as of its last update. Empty for a worker that never planned or one that has not started.",
    ok: ref('Checklist'),
  }),
  'GET /orchestrations/:id/integration/changes': d('Orchestration', 'What the integration branch changed', {
    description: "The same summary for the branch that merges every task's work, against the graph's base commit. Empty until the graph starts integrating.",
    ok: ref('ChangeSummary'),
  }),
  'GET /orchestrations/:id/integration/changes/diff': d('Orchestration', 'The diff of one file of the integration branch', {
    querystring: obj({ path: str('File to diff, relative to the checkout (required)') }, ['path']),
    ok: ref('FileDiff'),
  }),
  'DELETE /orchestrations/:id': d('Orchestration', 'Delete an orchestration', { description: 'Refused while it runs. Removes its worktrees and keeps their branches; refused if one holds uncommitted work, so a deletion never takes it.', ok: OK }),
  'POST /orchestrations/:id/integrate': d('Orchestration', 'Integrate the task branches again', { description: "Merges every completed task's branch into the graph's integration branch (`agentry/<name>-<id>`), handing conflicts to an integrator agent. Runs by itself when a worktree graph finishes; this retries it after resolving by hand, or integrates a graph that finished before orchestrations did so. Returns at once; follow `integration.status`.", ok: ref('Orchestration') }),
  'GET /orchestrations/:id/workflow': d('Orchestration', 'The graph as a workflow script', { description: 'The script a graph with `engine: "workflow"` runs: generated from its tasks, dependencies, concurrency and synthesis. For a graph that never ran as a workflow it is generated on the spot.', ok: obj({ path: str('Where the wrapper keeps it'), script: str() }) }),
  'POST /orchestrations/:id/workflow/save': d('Orchestration', 'Save the graph as a project workflow', { description: "Copies the script into the project's `.claude/workflows/`, where the Workflow tool (and `GET /workflows/saved`) can run it by name. Refuses to replace an existing one unless `overwrite`.", body: ref('SaveOrchestrationWorkflowRequest'), ok: ref('WorkflowDefinition'), created: true }),
  'POST /orchestrations/:id/verify': d('Orchestration', 'Run the graph\'s checks on the integration branch', { description: 'Runs `verification.commands` in order on the merged branch, each under its time limit, and records the outcome on `verification`: `passed`, `fixed` (with the fixer\'s commits) or `failed` (with a report). With a fixer, a failing command goes to an agent whose rules come from Agentry, up to `maxAttempts` times, and every command runs again from the first after a fix. It runs by itself when a worktree graph finishes; this runs it by hand, or again after the branch changed. Give `verification` to check a graph launched without any. Returns at once; follow `verification.status`. Before the commands comes an install step, as its own row with `install: true`: `verification.install` when it is a command, none when it is `null`, and otherwise the one the lockfile of the worktree asks for (`pnpm-lock.yaml`: `pnpm install --frozen-lockfile`, `package-lock.json`: `npm ci`, `yarn.lock`: `yarn install --frozen-lockfile`). `maxCostUsd` caps what the fixer spends over its attempts, passed to the CLI as `--max-budget-usd` with what is left; once spent the outcome is `failed`, and `verification.costUsd` says what it cost. With `failGraph`, failed checks leave the orchestration `failed` with `error` set, and passing them again brings it back to `completed`. Refused while the graph runs or waits, without a merged integration branch, and while the checks already run. Stopping the orchestration stops them.', body: ref('VerifyOrchestrationRequest'), ok: ref('Orchestration') }),
  'POST /orchestrations/:id/pull-request': d('Orchestration', 'Push the integration branch and open a pull request', { description: 'Pushes the integrated branch to `origin` and opens a pull request with `gh`, using the objective and final report as its body. When `gh` is missing or fails, the branch is still pushed and `detail` says why no pull request was opened. Refused while the checks run, and when they failed on a graph launched with `verification.failGraph`.', ok: obj({ branch: str(), url: str('Pull request URL, or null when none was opened'), detail: str() }) }),
  'POST /orchestrations/:id/worktrees/prune': d('Orchestration', "Remove the graph's worktrees", { description: 'Branches are always kept, so committed work survives. A worktree with uncommitted changes is left alone and reported unless `force` is set.', body: obj({ force: str('Remove even with uncommitted changes') }), ok: obj({ results: str('One entry per task: removed, and why not when it was kept') }) }),
  'POST /orchestrations/:id/stop': d('Orchestration', 'Stop all workers', { ok: ref('Orchestration') }),

  // ---- Configuration
  'GET /config/settings': d('Configuration', 'Read settings.json', { querystring: scopeQuery({ variant: VARIANT }), ok: ref('SettingsDoc') }),
  'PUT /config/settings': d('Configuration', 'Replace settings.json', { querystring: scopeQuery({ variant: VARIANT }), body: obj({ settings: { type: 'object', additionalProperties: true } }, ['settings']), ok: ref('SettingsDoc') }),
  'GET /config/instructions': d('Configuration', 'Read CLAUDE.md', { querystring: scopeQuery({ variant: VARIANT }), ok: ref('InstructionsDoc') }),
  'PUT /config/instructions': d('Configuration', 'Replace CLAUDE.md', { querystring: scopeQuery({ variant: VARIANT }), body: obj({ content: str() }, ['content']), ok: ref('InstructionsDoc') }),
  'GET /config/mcp': d('Configuration', 'MCP servers, tagged by scope', { description: 'User scope returns user servers. Project scope returns `local`, `project` (.mcp.json) and the inherited `user` servers.', querystring: scopeQuery(), ok: list('McpServerEntry') }),
  'GET /config/mcp/health': d('Configuration', 'Real MCP connection checks', { description: 'Runs `claude mcp list`; takes several seconds. Call on demand.', querystring: scopeQuery(), ok: list('McpServerHealth') }),
  'PUT /config/mcp/:name': d('Configuration', 'Create or replace an MCP server', { description: 'Written through `claude mcp add-json`. `config` is e.g. `{"type":"http","url":"…"}` or `{"command":"npx","args":["-y","pkg"],"env":{}}`.', querystring: scopeQuery(), body: obj({ config: { type: 'object', additionalProperties: true }, scope: ref('McpScope') }, ['config']), ok: ref('McpServerEntry') }),
  'DELETE /config/mcp/:name': d('Configuration', 'Remove an MCP server', { querystring: scopeQuery({ scope: ref('McpScope') }), ok: OK }),
  'GET /config/tool-presets': d('Configuration', 'Tool presets', { description: 'Named sets of `--allowedTools` / `--disallowedTools`, picked with `toolPreset` when a chat is created, resumed or forked. A fresh install lists the shipped ones (`builtIn`); they are edited like any other. `defaultPresetId` is the preset a new chat takes when it names neither `toolPreset` nor `allowedTools`.', ok: ref('ToolPresetsOverview') }),
  'PUT /config/tool-presets/default': d('Configuration', 'Set the default tool preset', { description: 'The preset a new chat takes when its request names neither `toolPreset` nor `allowedTools`; `null` leaves such a chat with the CLI\'s own tools. A request with `toolPreset: null` opts out. Resumes and forks keep the tools their chat already has. Deleting the preset clears the default. `default` is therefore not a valid preset id.', body: ref('ToolPresetsConfig'), ok: ref('ToolPresetsConfig') }),
  'POST /config/tool-presets/restore': d('Configuration', 'Restore the shipped tool presets', { description: 'Rewrites `read-only`, `no-network` and `everything` as they ship, whether they were edited or deleted. Every other preset, and the default, are left alone.', ok: ref('ToolPresetsOverview') }),
  'PUT /config/tool-presets/:id': d('Configuration', 'Create or replace a tool preset', { params: obj({ id: str('Lowercase letters, digits and `-`') }), body: obj({ name: str(), description: str(), allowedTools: { type: 'array', items: str() }, disallowedTools: { type: 'array', items: str() } }, ['name']), ok: ref('ToolPreset') }),
  'DELETE /config/tool-presets/:id': d('Configuration', 'Delete a tool preset', { description: 'A chat already running with it keeps the tools it was given.', params: obj({ id: str() }), ok: OK }),
  'GET /settings/editor': d('Configuration', 'Editor links', { description: 'How a file path and line become a link that opens the person\'s editor, and the side-by-side diff command to copy. `stored` is false until the first `PUT`; `settings` is then the default (`vscode://file/{path}:{line}`).', ok: ref('EditorSettingsDoc') }),
  'PUT /settings/editor': d('Configuration', 'Replace the editor links', { description: 'The whole document. A template must start with a URL scheme and contain `{path}`; `javascript:`, `data:`, `vbscript:`, `file:` and `blob:` are refused. Nothing here reaches the CLI.', body: ref('UpdateEditorSettingsRequest'), ok: ref('EditorSettingsDoc') }),
  'GET /config/resources/:kind': d('Configuration', 'List resources', { description: 'Saved workflows of the scope only: `GET /workflows/saved` also merges in the user\'s.', params: obj({ kind: KIND }), querystring: scopeQuery(), ok: list('ConfigResource') }),
  'GET /config/resources/:kind/:name': d('Configuration', 'Read a resource', { params: obj({ kind: KIND, name: str() }), querystring: scopeQuery(), ok: ref('ConfigResource') }),
  'PUT /config/resources/:kind/:name': d('Configuration', 'Create or replace a resource', { description: 'Skills are stored as `skills/<name>/SKILL.md`, workflows as the script `workflows/<name>.js` (an existing one keeps its own file, and is named by its `meta.name`), the other kinds as `<kind>/<name>.md`. `format` says which of the two the content is.', params: obj({ kind: KIND, name: str() }), querystring: scopeQuery(), body: obj({ content: str() }, ['content']), ok: ref('ConfigResource') }),
  'DELETE /config/resources/:kind/:name': d('Configuration', 'Delete a resource', { params: obj({ kind: KIND, name: str() }), querystring: scopeQuery(), ok: OK }),

  // ---- Config files
  'GET /config/files/roots': d('Config files', 'Available roots', { ok: list('ConfigFileRoot') }),
  'GET /config/files/tree': d('Config files', 'Nested file tree of a root', { querystring: obj({ root: ROOT }), ok: list('ConfigFileNode') }),
  'GET /config/files/content': d('Config files', 'Read a text file', { description: 'Up to 1 MB. Binary, hidden and out-of-root paths return 400.', querystring: obj({ root: ROOT, path: str('Path relative to the root') }, ['path']), ok: ref('ConfigFileContent') }),
  'PUT /config/files/content': d('Config files', 'Create or overwrite a file', { description: 'Parent directories are created. `executable` sets the mode (hook scripts).', body: ref('WriteConfigFileRequest'), ok: ref('ConfigFileContent') }),
  'DELETE /config/files/content': d('Config files', 'Delete a file or directory', { querystring: obj({ root: ROOT, path: str('Path relative to the root') }, ['path']), ok: OK }),

  // ---- Memory
  'GET /memory': d('Memory', 'Imported projects with their memory file counts', { ok: list('MemoryProjectSummary') }),
  'GET /memory/:project': d('Memory', 'Memory files of a project', { description: '`MEMORY.md` (the index loaded into every session) comes first.', ok: list('MemoryFile') }),
  'PUT /memory/:project/:name': d('Memory', 'Create or overwrite a memory file', { description: '`name` must end in `.md`.', body: obj({ content: str() }, ['content']), ok: ref('MemoryFile') }),
  'DELETE /memory/:project/:name': d('Memory', 'Delete a memory file', { ok: OK }),

  // ---- Connectors
  'GET /connectors': d('Connectors', 'claude.ai connectors and their status', { description: 'Read from `claude mcp list` (it connects to every server, so it takes seconds and is cached for a minute). Only servers named `claude.ai …` count as connectors. Each has prepared prompts a client can open a new chat with; the answer also says what a person has to do to authorise one and which claude.ai features (web artifacts, claude.ai memory) have no CLI surface.', querystring: obj({ refresh: str('`true` skips the one-minute cache', { enum: ['true', 'false'] }) }), ok: ref('ConnectorsOverview') }),

  // ---- Plugins
  'GET /plugins': d('Plugins', 'Installed plugins and marketplaces', { ok: ref('PluginsOverview') }),
  'GET /plugins/available': d('Plugins', 'Search the marketplaces', { querystring: obj({ q: str('Free-text filter') }), description: 'At most 100 results.', ok: list('AvailablePlugin') }),
  'GET /plugins/details': d('Plugins', "A plugin's component inventory", { querystring: obj({ plugin: str('`name@marketplace`') }, ['plugin']), ok: ref('CliTextResult') }),
  'POST /plugins/install': d('Plugins', 'Install a plugin', { body: ref('PluginActionRequest'), ok: ref('CliTextResult') }),
  'POST /plugins/uninstall': d('Plugins', 'Uninstall a plugin', { body: ref('PluginActionRequest'), ok: ref('CliTextResult') }),
  'POST /plugins/enable': d('Plugins', 'Enable a plugin', { body: ref('PluginActionRequest'), ok: ref('CliTextResult') }),
  'POST /plugins/disable': d('Plugins', 'Disable a plugin', { body: ref('PluginActionRequest'), ok: ref('CliTextResult') }),
  'POST /plugins/marketplaces': d('Plugins', 'Add a marketplace', { body: obj({ source: str('GitHub `owner/repo`, URL or path') }, ['source']), ok: ref('CliTextResult') }),
  'POST /plugins/marketplaces/update': d('Plugins', 'Update one or all marketplaces', { body: obj({ name: str('Omit to update all') }), ok: ref('CliTextResult') }),
  'DELETE /plugins/marketplaces/:name': d('Plugins', 'Remove a marketplace', { ok: ref('CliTextResult') }),

  // ---- Push
  'GET /push/key': d('Push', 'The VAPID public key to subscribe with', { description: 'The keypair is made on first use and kept as `push.json` in the data directory (mode 600). The private half never leaves the server. `configured: false` means it could not be made and nothing will be sent.', ok: ref('PushKeyInfo') }),
  'GET /push/subscriptions': d('Push', 'Installs registered to be pushed to', { description: 'Endpoints are truncated: a full push endpoint URL is a capability to notify that install. Each row carries the `id` its registration returned, which is how a browser recognises itself in the list.', ok: list('PushSubscriptionSummary') }),
  'POST /push/subscriptions': d('Push', 'Register or refresh a subscription', { description: "The browser's `PushSubscription` JSON plus the notification kinds this install wants (every kind when omitted) and a label for the list. An endpoint that is already registered is refreshed, keeping its `createdAt`.", body: ref('RegisterPushSubscriptionRequest'), ok: ref('PushSubscriptionSummary'), created: true }),
  'DELETE /push/subscriptions': d('Push', 'Unregister a subscription', { description: 'By `endpoint` (what a browser turning the switch off knows) or by `id` (what the Settings list shows). `removed: false` when no such install was registered.', body: ref('RemovePushSubscriptionRequest'), ok: obj({ removed: { type: 'boolean' } }, ['removed']) }),
  'POST /push/test': d('Push', 'Send one test notification', { description: 'Proves push works without waiting for a chat to stop. Aimed at one install by `endpoint` or `id`, or at every registered one when the body names none. An endpoint the push service reports as gone (404/410) is deleted and counted in `removed`.', body: ref('SendTestPushRequest'), ok: ref('PushSendResult') }),

  // ---- Security
  'GET /security/auth': d('Security', 'How the API is guarded', { description: 'The token is never returned: only whether one is set.', ok: ref('AuthConfig') }),
  'PUT /security/auth': d('Security', 'Change the auth mode or read-only', { description: 'Turning on `token` needs a token already set, and `oidc` an issuer and an audience, so a mode cannot lock everyone out. This route stays reachable in read-only mode: it is the switch.', body: ref('UpdateAuthConfigRequest'), ok: ref('AuthConfig') }),
  'POST /security/token': d('Security', 'Set or rotate the bearer token', { description: 'Returns the token once and keeps only its SHA-256. Omit `token` to have one generated. Send it as `Authorization: Bearer …`; `GET /events`, `GET /chats/{id}/stream` and `GET /uploads/{id}/content` also accept `?token=`, because a browser cannot set a header on those.', body: ref('SetAuthTokenRequest'), ok: ref('AuthTokenResult') }),
  'DELETE /security/token': d('Security', 'Remove the bearer token', { description: 'Refused while the mode is `token`.', ok: ref('AuthConfig') }),
  'GET /audit': d('Security', 'Mutating requests, newest first', { description: 'When, who (token id, OIDC subject, `local`, or `env` for a token reset from the environment), method, path, status and a one-line summary built from the route. Bodies are never recorded: they carry prompts and secrets.', querystring: obj({ limit: str('1-500, default 50'), from: str('Offset within the filtered set'), path: str('Matches anywhere in the path; `%`, `_` and `\\` are taken literally'), method: str('Exact, case-insensitive: `POST`'), status: str('A code (`404`) or a class (`4xx`)') }), ok: ref('AuditPage') }),

  // ---- Uploads
  'POST /uploads': d('Uploads', 'Upload a file to attach', { description: 'The request body is the file itself, sent as `application/octet-stream`; `name` is its file name. The type is read from the bytes. Limits: images (PNG, JPEG, GIF, WebP) 5 MB, PDFs 32 MB, anything else 50 MB. Files are kept in the data dir, outside every project, and every run can read them.', querystring: obj({ name: str('File name') }), ok: ref('Attachment'), created: true }),
  'GET /uploads/:id': d('Uploads', "An upload's metadata", { ok: ref('Attachment') }),
  'GET /uploads/:id/content': d('Uploads', 'The uploaded file', { description: 'Images and PDFs are served inline; any other type as a download, never rendered.' }),

  // ---- Schedules
  'GET /schedules': d('Schedules', 'List schedules', { description: 'Oldest first, each with when it last fired and when it fires next (null while disabled).', ok: list('Schedule') }),
  'GET /schedules/preview': d('Schedules', 'Say what a cron expression will do', { description: 'Nothing is saved. An invalid expression answers `valid: false` with the field that is wrong, so a form can show it while it is typed.', querystring: obj({ cron: str('Five fields, or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`'), timezone: str('IANA zone; the server\'s when omitted'), count: { type: 'integer', description: 'How many upcoming fires to list (default 5, at most 20)' } }, ['cron']), ok: ref('SchedulePreview') }),
  'POST /schedules': d('Schedules', 'Create a schedule', { description: 'The target is a chat (a `NewChatRequest`) or an orchestration (an `OrchestrationSpec`). It starts enabled unless `enabled` is false. `overlap` says what a slot does while the last run is still going (its chat working or waiting on a person, its orchestration running): `parallel` (the default) starts it anyway, `skip` records it as `overlapped` and starts nothing, `queue` starts it when that run ends, one pending at most. The clock starts now: slots before creation are not missed windows.', body: ref('CreateScheduleRequest'), ok: ref('Schedule'), created: true }),
  'GET /schedules/:id': d('Schedules', 'One schedule', { ok: ref('Schedule') }),
  'PATCH /schedules/:id': d('Schedules', 'Edit a schedule', { description: 'Changing the expression or the zone, or switching it on, starts its clock afresh: the time it was off is not counted as missed.', body: ref('UpdateScheduleRequest'), ok: ref('Schedule') }),
  'DELETE /schedules/:id': d('Schedules', 'Delete a schedule and its history', { description: 'Chats and orchestrations it already started are not touched.', ok: OK }),
  'POST /schedules/:id/enable': d('Schedules', 'Switch a schedule on', { ok: ref('Schedule') }),
  'POST /schedules/:id/disable': d('Schedules', 'Switch a schedule off', { ok: ref('Schedule') }),
  'POST /schedules/:id/run': d('Schedules', 'Run a schedule now', { description: 'Starts its target immediately, whatever the timetable says and even while it is disabled. The run is recorded without a slot and does not affect when it fires next; the overlap policy does not apply to it. A target that fails to start is a run with status `failed` and its error, not an HTTP error.', ok: ref('ScheduleRun'), created: true }),
  'GET /schedules/:id/runs': d('Schedules', 'History of a schedule', { description: 'Newest first. `started` carries the chat or orchestration it produced; `failed` the error; `skipped` says that slots passed while Agentry was not running: those are never run late. `overlapped` is a slot that came while the last run was still going and was not started (policy `skip`, or a queued slot replaced by a newer one or dropped when the schedule was switched off); `queued` waits for the last run to end, and becomes `started` with the same `slot` when it does.', querystring: obj({ limit: { type: 'integer', description: 'At most 500, default 50' } }), ok: list('ScheduleRun') }),
};

/** Builds the Fastify route schema for a documented route; path params are derived from the URL. */
export function routeSchema(method: string, path: string): Json | null {
  const doc = ROUTE_DOCS[`${method} ${path}`];
  if (!doc) return null;
  const pathParams = [...path.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
  const params = doc.params ?? (pathParams.length ? obj(Object.fromEntries(pathParams.map((p) => [p, str()])), pathParams) : undefined);
  const error = { description: 'Invalid request or not found', content: { 'application/json': { schema: ref('ApiError') } } };
  return {
    tags: doc.tags,
    summary: doc.summary,
    ...(doc.description ? { description: doc.description } : {}),
    ...(params ? { params: { ...params, required: pathParams } } : {}),
    ...(doc.querystring ? { querystring: doc.querystring } : {}),
    ...(doc.body ? { body: doc.body } : {}),
    ...(doc.produces ? { produces: [doc.produces] } : {}),
    response: {
      [doc.created ? 201 : 200]: doc.produces
        ? { description: 'Event stream', content: { [doc.produces]: { schema: doc.ok } } }
        : { description: 'Success', content: { 'application/json': { schema: doc.ok ?? {} } } },
      400: error,
      ...(pathParams.length || doc.querystring ? { 404: error } : {}),
    },
  };
}
