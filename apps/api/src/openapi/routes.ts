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
const KIND = str('Resource kind', { enum: ['agents', 'skills', 'commands', 'output-styles', 'rules'] });
const ROOT = str("`user` or a project id (see `GET /config/files/roots`)");

export const TAGS = [
  { name: 'System', description: 'CLI detection, health and the dashboard overview.' },
  { name: 'Account', description: 'Credential used by every `claude` process. The secret is never returned.' },
  { name: 'Accounts', description: 'Several Claude accounts through claude-swap (`cswap`), with usage per window and rotation when one runs out.' },
  { name: 'Projects & sessions', description: 'Read from the transcripts Claude Code writes under `<configDir>/projects`.' },
  { name: 'Runs', description: 'Live conversations, each backed by a `claude -p` process speaking stream-json.' },
  { name: 'Orchestration', description: 'A DAG of tasks, each executed by its own Claude worker.' },
  { name: 'Configuration', description: 'Settings, instructions, MCP servers and markdown resources, per user or per project (`?project=`).' },
  { name: 'Config files', description: "Generic editor confined to a scope's Claude dir; secrets and runtime state are refused." },
  { name: 'Memory', description: "Claude Code's per-project file memory." },
  { name: 'Plugins', description: 'Delegated to `claude plugin`; actions return the CLI output.' },
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
  'GET /active': d('System', 'Live CLI sessions on the machine', { description: 'Interactive and background sessions reported by `claude agents --json`.', ok: list('ActiveCliSession') }),

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

  // ---- Projects & sessions
  'GET /projects': d('Projects & sessions', 'Workspace directories and directories with history', { ok: list('ProjectSummary') }),
  'POST /projects': d('Projects & sessions', 'Create a project in the workspace', { description: 'Creates an empty directory, or clones `gitUrl` into it.', body: ref('CreateProjectRequest'), ok: ref('ProjectSummary'), created: true }),
  'GET /projects/:id/sessions': d('Projects & sessions', 'Sessions of one project', { ok: list('SessionSummary') }),
  'GET /sessions': d('Projects & sessions', 'All sessions, newest first', { description: 'Sessions are flagged `live` when a wrapper run or a CLI process currently owns them.', querystring: obj({ limit: str('Max sessions to return') }), ok: list('SessionSummary') }),
  'GET /sessions/:id': d('Projects & sessions', 'Full transcript', { querystring: obj({ sidechains: str('`1` includes subagent messages') }), ok: ref('SessionDetail') }),
  'DELETE /sessions/:id': d('Projects & sessions', 'Delete a transcript', { description: 'Refused with 400 while the session is live.', ok: OK }),

  // ---- Runs
  'GET /runs': d('Runs', 'All runs, newest first', { description: 'Includes runs restored from previous wrapper processes.', ok: list('RunSummary') }),
  'POST /runs': d('Runs', 'Start a run', { description: 'Spawns `claude -p` with stream-json I/O. With `keepAlive` (default) the process stays up for follow-up turns.', body: ref('RunOptions'), ok: ref('RunSummary'), created: true }),
  'GET /runs/:id': d('Runs', 'Run summary and buffered events', { ok: ref('RunDetail') }),
  'GET /runs/:id/stream': d('Runs', 'Live event stream (Server-Sent Events)', {
    description:
      'Replays buffered events with `seq > since` (or `Last-Event-ID`), then streams live ones. Each message is `data: <RunEvent JSON>`. Ephemeral `partial` events carry the text generated so far (token streaming); they have no SSE id and are never replayed.',
    querystring: obj({ since: str('Last seq already received') }),
    ok: ref('RunEvent'),
    produces: 'text/event-stream',
  }),
  'POST /runs/:id/messages': d('Runs', 'Send another turn', { description: 'If the process has exited, the session is resumed transparently with `--resume`.', body: obj({ text: str() }, ['text']), ok: ref('RunSummary') }),
  'POST /runs/:id/stop': d('Runs', 'Stop the process', { description: 'The conversation is kept and can be continued later.', ok: ref('RunSummary') }),
  'DELETE /runs/:id': d('Runs', 'Forget an ended run', { ok: OK }),
  'GET /environments': d('Runs', 'What Claude actually loaded, per directory', { description: 'Tools, MCP server status, agents, skills, plugins, slash commands and memory paths, captured from the `init` event of the latest run in each directory.', querystring: obj({ cwd: str('Absolute directory to filter by') }), ok: list('EffectiveEnvironment') }),
  'GET /tasks': d('Runs', 'Background tasks across runs', { ok: list('BackgroundTask') }),
  'GET /subagents': d('Runs', 'Subagents across runs', { ok: list('SubagentInfo') }),

  // ---- Orchestration
  'GET /orchestrations': d('Orchestration', 'List orchestrations', { ok: list('Orchestration') }),
  'POST /orchestrations': d('Orchestration', 'Launch an orchestration', { description: 'Independent tasks run in parallel up to `concurrency`; results of dependencies are passed to dependent tasks; `synthesize` adds a final report worker. Task ids must be unique and the graph acyclic.', body: ref('OrchestrationSpec'), ok: ref('Orchestration'), created: true }),
  'POST /orchestrations/plan': d('Orchestration', 'Draft a task graph from an objective', { description: 'Runs a planner agent with structured output; can take a couple of minutes. The draft is not launched.', body: ref('PlanRequest'), ok: ref('OrchestrationSpec') }),
  'POST /orchestrations/plan/start': d('Orchestration', 'Start the planner without waiting', { description: 'Returns the planner run immediately; stream it at `/runs/:id/stream` and fetch the draft from `/orchestrations/plans/:runId` when it finishes. Preferred over `POST /orchestrations/plan`, which holds the request open for the whole run.', body: ref('PlanRequest'), ok: ref('RunSummary'), created: true }),
  'GET /orchestrations/plans': d('Orchestration', 'Plans generated but not yet launched', { description: 'Recorded when a planner run finishes, so a draft survives a lost response or a reload.', querystring: obj({ limit: str('Max drafts to return (default 20, max 100)') }), ok: list('PlanDraftSummary') }),
  'GET /orchestrations/plans/:runId': d('Orchestration', 'The draft a planner run produced', { ok: ref('OrchestrationSpec') }),
  'GET /orchestrations/:id': d('Orchestration', 'State of every task, results and cost', { ok: ref('Orchestration') }),
  'POST /orchestrations/:id/resume': d('Orchestration', 'Resume a stopped orchestration', { description: 'Re-runs every task that did not complete — stopped, failed, or skipped behind a blocked dependency — and keeps the results of the ones that did. Workers do not survive a wrapper restart, so this is how a graph interrupted by one is picked back up.', ok: ref('Orchestration') }),
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
  'GET /config/resources/:kind': d('Configuration', 'List markdown resources', { params: obj({ kind: KIND }), querystring: scopeQuery(), ok: list('MarkdownResource') }),
  'GET /config/resources/:kind/:name': d('Configuration', 'Read a resource', { params: obj({ kind: KIND, name: str() }), querystring: scopeQuery(), ok: ref('MarkdownResource') }),
  'PUT /config/resources/:kind/:name': d('Configuration', 'Create or replace a resource', { description: 'Skills are stored as `skills/<name>/SKILL.md`; the other kinds as `<kind>/<name>.md`.', params: obj({ kind: KIND, name: str() }), querystring: scopeQuery(), body: obj({ content: str() }, ['content']), ok: ref('MarkdownResource') }),
  'DELETE /config/resources/:kind/:name': d('Configuration', 'Delete a resource', { params: obj({ kind: KIND, name: str() }), querystring: scopeQuery(), ok: OK }),

  // ---- Config files
  'GET /config/files/roots': d('Config files', 'Available roots', { ok: list('ConfigFileRoot') }),
  'GET /config/files/tree': d('Config files', 'Nested file tree of a root', { querystring: obj({ root: ROOT }), ok: list('ConfigFileNode') }),
  'GET /config/files/content': d('Config files', 'Read a text file', { description: 'Up to 1 MB. Binary, hidden and out-of-root paths return 400.', querystring: obj({ root: ROOT, path: str('Path relative to the root') }, ['path']), ok: ref('ConfigFileContent') }),
  'PUT /config/files/content': d('Config files', 'Create or overwrite a file', { description: 'Parent directories are created. `executable` sets the mode (hook scripts).', body: ref('WriteConfigFileRequest'), ok: ref('ConfigFileContent') }),
  'DELETE /config/files/content': d('Config files', 'Delete a file or directory', { querystring: obj({ root: ROOT, path: str('Path relative to the root') }, ['path']), ok: OK }),

  // ---- Memory
  'GET /memory': d('Memory', 'Projects with their memory file counts', { ok: list('MemoryProjectSummary') }),
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
