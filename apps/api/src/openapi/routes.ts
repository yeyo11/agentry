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
  { name: 'Configuration', description: 'Settings, instructions, MCP servers and markdown resources, per user or per project (`?project=`).' },
  { name: 'Config files', description: "Generic editor confined to a scope's Claude dir; secrets and runtime state are refused." },
  { name: 'Memory', description: "Claude Code's per-project file memory." },
  { name: 'Plugins', description: 'Delegated to `claude plugin`; actions return the CLI output.' },
  { name: 'Uploads', description: 'Files to attach to a message. Images and PDFs reach Claude as content blocks, any other file by its path.' },
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
  'GET /accounts/events': d('Accounts', 'Rotation history', { description: 'Every poll, switch and failure claude-swap reported, persisted across restarts. `GET /accounts` carries only the last 200.', querystring: obj({ limit: str('Max events to return (default 200, max 5000)'), since: str('ISO-8601 timestamp; only newer events are returned') }), ok: list('AutoSwitchEvent') }),
  'GET /accounts/autoswitch': d('Accounts', 'Auto-rotation settings', { ok: ref('AutoSwitchSettings') }),
  'PUT /accounts/autoswitch': d('Accounts', 'Change the auto-rotation settings', { description: 'Enabling it supervises a `cswap auto --json` process that rotates before the active account reaches `threshold`. `rotateOnLimit` also rotates and resumes a run that died against its limit.', body: ref('AutoSwitchSettings'), ok: ref('AutoSwitchSettings') }),

  // ---- Projects
  'GET /projects': d('Projects', 'Imported projects', { description: 'Only directories that were imported. Each carries its worktrees and the number of chats under it or them.', ok: list('Project') }),
  'GET /projects/candidates': d('Projects', 'Directories worth importing', { description: 'Directories chats have run in that are not projects yet, the busiest first, with scratch and missing directories left out. What a first start offers instead of an empty screen.', ok: list('ProjectCandidate') }),
  'POST /projects/import': d('Projects', 'Import a directory as a project', { description: 'Every chat under the directory belongs to it from then on, retroactively. A git worktree is refused: it belongs to its repository.', body: ref('ImportProjectRequest'), ok: ref('Project'), created: true }),
  'POST /projects': d('Projects', 'Create a project in the workspace', { description: 'Creates an empty directory, or clones `gitUrl` into it, and imports it.', body: ref('CreateProjectRequest'), ok: ref('Project'), created: true }),
  'PATCH /projects/:id': d('Projects', 'Rename a project', { params: obj({ id: str('Project id') }), body: ref('UpdateProjectRequest'), ok: ref('Project') }),
  'DELETE /projects/:id': d('Projects', 'Remove a project from Agentry', { description: 'Harmless: nothing on disk changes, and importing the directory again adopts its chats again. Distinct from `DELETE /projects/:id/state`.', params: obj({ id: str('Project id') }), ok: OK }),
  'DELETE /projects/:id/state': d('Projects', 'Purge everything Claude Code keeps about a project', { description: 'Transcripts, tasks, file history and the config entry, through `claude project purge`. Irreversible; the project stays imported.', params: obj({ id: str('Project id') }), ok: obj({ detail: str('What the CLI reported') }) }),

  // ---- Events
  'GET /events': d('Events', 'Live feed of everything that changes (Server-Sent Events)', {
    description:
      'One stream for the whole app. Every message has an SSE `id`, an `event:` line naming its `type` and `data: <AgentryEvent JSON>`: run created/updated/ended/removed, prompts waiting for a person (`run.waiting`, `permission.*`), rate limits and account rotation, background tasks, subagents and workflows starting and ending, orchestration, task and merge-conflict changes, and `sessions.changed` when the CLI writes under its projects directory. Events describe what changed and carry the ids to refetch it; `run.updated` and `workflow.progress` are coalesced to about one per 250 ms. The stream opens with `stream.hello` (no id) carrying the server `bootId`. Reconnect with `Last-Event-ID` (or `since`) to receive what was missed from a bounded in-memory buffer; when that id has fallen out of it, or belongs to a previous server process, `stream.resync` is sent instead and the client must refetch everything it shows. A `: ping` comment is sent every 15 s.',
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
  'POST /chats': d('Chats', 'Start a chat', { description: 'Spawns `claude -p` with stream-json I/O under a session id Agentry chooses. With `keepAlive` (default) the process stays up for follow-up turns.', body: ref('NewChatRequest'), ok: ref('ChatSummary'), created: true }),
  'GET /chats/:id': d('Chats', 'A chat and a window of its transcript', {
    description:
      'The chat with its branches (subagents, background tasks, workflows) and environment, and the newest `limit` transcript entries by default — a long conversation runs to tens of megabytes, which nobody reads at once. `from` is the index the window starts at and `total` what the transcript holds, so passing the `from` of a page back as `before` reads the one before it. A chat with no transcript (housekeeping, or one that has not written its first line) is read from what its process streamed.',
    querystring: obj({ sidechains: str('`1` includes subagent messages'), limit: str('Entries per page (default 200, max 1000)'), before: str('Index to read backwards from: the `from` of the previous response') }),
    ok: ref('ChatDetail'),
  }),
  'GET /chats/:id/search': d('Chats', 'Search the whole transcript', { description: 'Case-insensitive plain-text match over what the transcript view shows of each entry: text, thinking, tool names and inputs, tool results. Any run of whitespace in `q` matches any run in the text. One hit per matching entry, `index` in the same space as a page\'s `from` and `total`, so a hit on a page not loaded yet is reached by reading back to it. At most 500 hits, the newest; `truncated` says older ones were left out.', querystring: obj({ q: str('Text to find (required, up to 200 characters)'), sidechains: str('`1` includes subagent messages, as the page read with it does') }, ['q']), ok: ref('TranscriptSearchResult') }),
  'GET /chats/:id/stream': d('Chats', 'Live event stream (Server-Sent Events)', {
    description:
      'Replays buffered events with `seq > since` (or `Last-Event-ID`), then streams live ones. Each message is `data: <RunEvent JSON>`. Ephemeral `partial` events carry the text generated so far (token streaming); they have no SSE id and are never replayed. Only a chat Agentry has driven has a stream; to follow one, take the last event\'s `seq` from the page you hold and pass it as `since`.',
    querystring: obj({ since: str('Last seq already received') }),
    ok: ref('RunEvent'),
    produces: 'text/event-stream',
  }),
  'POST /chats/:id/resume': d('Chats', 'Continue a chat in place', { description: 'Adds an execution to the same chat, which keeps its id: it never creates one. Whether something else holds the session is checked on the server at this moment, from the CLI\'s own list and the process table, whatever the client last saw. A chat from a terminal that nothing holds is adopted and stays `external`; one a terminal holds, or that belongs to an orchestration, is refused with 409 and the reason, and `fork` is the way forward.', body: ref('ResumeChatRequest'), ok: ref('ChatSummary') }),
  'POST /chats/:id/fork': d('Chats', 'Continue a chat in a copy', { description: 'Creates a new chat with the same history that records where it came from (`derivedFrom`), and leaves the original untouched. Available on any chat, held or not.', body: ref('ForkChatRequest'), ok: ref('ChatSummary'), created: true }),
  'POST /chats/:id/messages': d('Chats', 'Send another turn', { description: 'To a chat with a live execution. `attachments` are upload ids from `POST /uploads`; with attachments the text may be empty. A chat without one is refused with 409: resume it.', body: ref('ChatMessageRequest'), ok: ref('ChatSummary') }),
  'POST /chats/:id/stop': d('Chats', 'Stop what is working on the chat', { description: 'The execution Agentry runs, or for a background session the CLI itself holds, `claude stop`, so no pid is signalled directly. The conversation is kept and can be resumed.', ok: ref('ChatSummary') }),
  'POST /chats/:id/interrupt': d('Chats', 'Interrupt the current turn', { description: 'Ends the turn in progress and keeps the process, which waits for the next message. Any prompt the chat was holding is withdrawn.', ok: ref('ChatSummary') }),
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
  'POST /orchestrations': d('Orchestration', 'Launch an orchestration', { description: 'Independent tasks run in parallel up to `concurrency`; results of dependencies are passed to dependent tasks; `synthesize` adds a final report worker. Task ids must be unique and the graph acyclic.', body: ref('OrchestrationSpec'), ok: ref('Orchestration'), created: true }),
  'POST /orchestrations/plan': d('Orchestration', 'Draft a task graph from an objective', { description: 'Runs a planner agent with structured output; can take a couple of minutes. The draft is not launched.', body: ref('PlanRequest'), ok: ref('OrchestrationSpec') }),
  'POST /orchestrations/plan/start': d('Orchestration', 'Start the planner without waiting', { description: 'Returns the planner chat immediately; stream it at `/chats/:id/stream` and fetch the draft from `/orchestrations/plans/:runId` (the id of the planner chat) when it finishes. Preferred over `POST /orchestrations/plan`, which holds the request open for the whole run.', body: ref('PlanRequest'), ok: ref('ChatSummary'), created: true }),
  'GET /orchestrations/plans': d('Orchestration', 'Plans generated but not yet launched', { description: 'Recorded when a planner run finishes, so a draft survives a lost response or a reload.', querystring: obj({ limit: str('Max drafts to return (default 20, max 100)') }), ok: list('PlanDraftSummary') }),
  'GET /orchestrations/plans/:runId': d('Orchestration', 'The draft a planner run produced', { ok: ref('OrchestrationSpec') }),
  'GET /orchestrations/:id': d('Orchestration', 'State of every task, results and cost', { ok: ref('Orchestration') }),
  'POST /orchestrations/:id/resume': d('Orchestration', 'Resume a stopped orchestration', { description: 'Runs again every task that did not complete and keeps the results of those that did; a task that already has a chat continues it, in a new execution. The body can correct the settings that stopped it — worktrees, where permission prompts go, allowed tools, permission mode — so a graph started with the wrong ones is picked up instead of rebuilt.', body: ref('ResumeOrchestrationRequest'), ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/retry': d('Orchestration', 'Run a failed task again in its own chat', { description: 'Only a task that failed for good (its attempts ran out, or it failed in a way that is never retried automatically). A new execution of the same chat, in the worktree it left, told what went wrong; the tasks blocked behind it go back to waiting for their turn. One more execution, however many attempts the graph allows: if it fails again the task is left for a decision again.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/retry-clean': d('Orchestration', 'Start a failed task over', { description: 'A new chat, in a worktree rebuilt from the base commit: the failed chat stays listed as what was tried, and its worktree and branch are removed, uncommitted work included.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/skip': d('Orchestration', 'Give a branch up', { description: 'Skips a failed or blocked task and every task that depends on it, so the graph can finish without them. Nothing is deleted. A graph waiting on nothing else then integrates and synthesises.', ok: ref('Orchestration') }),
  'POST /orchestrations/:id/tasks/:taskId/hint': d('Orchestration', 'Send a hint to a running worker', { description: 'A nudge for a worker whose task is still running, delivered as a message to its chat. Refused for a task that finished: its result already fed the tasks that depend on it, and its way forward is a fork of its chat.', body: ref('TaskHintRequest'), ok: ref('Orchestration') }),
  'DELETE /orchestrations/:id': d('Orchestration', 'Delete an orchestration', { description: 'Refused while it runs. Removes its worktrees and keeps their branches; refused if one holds uncommitted work, so a deletion never takes it.', ok: OK }),
  'POST /orchestrations/:id/integrate': d('Orchestration', 'Integrate the task branches again', { description: "Merges every completed task's branch into the graph's integration branch (`agentry/<name>-<id>`), handing conflicts to an integrator agent. Runs by itself when a worktree graph finishes; this retries it after resolving by hand, or integrates a graph that finished before orchestrations did so. Returns at once; follow `integration.status`.", ok: ref('Orchestration') }),
  'GET /orchestrations/:id/workflow': d('Orchestration', 'The graph as a workflow script', { description: 'The script a graph with `engine: "workflow"` runs: generated from its tasks, dependencies, concurrency and synthesis. For a graph that never ran as a workflow it is generated on the spot.', ok: obj({ path: str('Where the wrapper keeps it'), script: str() }) }),
  'POST /orchestrations/:id/workflow/save': d('Orchestration', 'Save the graph as a project workflow', { description: "Copies the script into the project's `.claude/workflows/`, where the Workflow tool (and `GET /workflows/saved`) can run it by name. Refuses to replace an existing one unless `overwrite`.", body: ref('SaveOrchestrationWorkflowRequest'), ok: ref('WorkflowDefinition'), created: true }),
  'POST /orchestrations/:id/pull-request': d('Orchestration', 'Push the integration branch and open a pull request', { description: 'Pushes the integrated branch to `origin` and opens a pull request with `gh`, using the objective and final report as its body. When `gh` is missing or fails, the branch is still pushed and `detail` says why no pull request was opened.', ok: obj({ branch: str(), url: str('Pull request URL, or null when none was opened'), detail: str() }) }),
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

  // ---- Uploads
  'POST /uploads': d('Uploads', 'Upload a file to attach', { description: 'The request body is the file itself, sent as `application/octet-stream`; `name` is its file name. The type is read from the bytes. Limits: images (PNG, JPEG, GIF, WebP) 5 MB, PDFs 32 MB, anything else 50 MB. Files are kept in the data dir, outside every project, and every run can read them.', querystring: obj({ name: str('File name') }), ok: ref('Attachment'), created: true }),
  'GET /uploads/:id': d('Uploads', "An upload's metadata", { ok: ref('Attachment') }),
  'GET /uploads/:id/content': d('Uploads', 'The uploaded file', { description: 'Images and PDFs are served inline; any other type as a download, never rendered.' }),
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
