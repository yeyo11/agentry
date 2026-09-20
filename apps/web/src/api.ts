import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Attachment,
  AccountsOverview,
  ActiveCliSession,
  AgentTranscript,
  AddAccountTokenRequest,
  ApiError,
  AuthStatus,
  AuthVerification,
  AutoSwitchEvent,
  AutoSwitchSettings,
  AvailablePlugin,
  BackgroundTask,
  BackgroundTaskOutput,
  ChatDetail,
  CliTextResult,
  ConfigFileContent,
  ConfigFileNode,
  ConfigFileRoot,
  ConfigFileVariant,
  CreateProjectRequest,
  EffectiveEnvironment,
  InstructionsDoc,
  MarkdownResource,
  MemoryFile,
  MemoryProjectSummary,
  McpScope,
  McpServerEntry,
  McpServerHealth,
  Orchestration,
  OrchestrationSpec,
  Overview,
  PermissionDecision,
  PermissionRequest,
  PlanDraftSummary,
  PlanRequest,
  ResumeOrchestrationRequest,
  PluginActionRequest,
  PluginsOverview,
  ProjectSummary,
  ResourceKind,
  RunDetail,
  RunEvent,
  RunOptions,
  RunSettingsUpdate,
  RunSummary,
  SessionDetail,
  SessionSummary,
  SetCredentialsRequest,
  SwitchAccountRequest,
  SwitchResult,
  SettingsDoc,
  SubagentInfo,
  RunWorkflowRequest,
  WorkflowDefinition,
  WorkflowRun,
  SystemInfo,
  WriteConfigFileRequest,
  SaveOrchestrationWorkflowRequest,
  TaskHintRequest,
  TranscriptSearchResult,
} from '@agentry/shared';
import { TRANSCRIPT_PAGE_MAX } from '@agentry/shared';
import { useFallbackInterval } from './lib/feed';

const BASE = '/api';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Long enough for the slowest honest call (a plugin install shelling out to the CLI), short enough
 * that a response which will never arrive surfaces as an error instead of a spinner that turns for
 * ever. Nothing here should hold a request open for minutes — long work returns a run to stream.
 */
const REQUEST_TIMEOUT_MS = 120_000;

async function request<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiRequestError('The server did not answer in time. It may still be working — reload to see the current state.', 408);
    }
    throw err;
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (e.g. proxy error page)
  }
  if (!res.ok) {
    const err = json as Partial<ApiError> | null;
    throw new ApiRequestError(err?.error ?? `HTTP ${res.status} ${res.statusText}`, res.status, err?.detail);
  }
  return json as T;
}

const enc = encodeURIComponent;

/** The file is the request body, as is: no multipart, no base64 on the way up. */
async function uploadFile(file: File): Promise<Attachment> {
  const res = await fetch(`${BASE}/uploads?name=${encodeURIComponent(file.name || 'pasted')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const json = (await res.json().catch(() => null)) as (Attachment & Partial<ApiError>) | null;
  if (!res.ok) throw new ApiRequestError(json?.error ?? `HTTP ${res.status} ${res.statusText}`, res.status, json?.detail);
  return json as Attachment;
}

/** Config scope: no projectId means the user scope. */
export interface Scope {
  projectId?: string;
}

const num = (value: number | undefined) => (value === undefined ? undefined : String(value));

function qs(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '');
  return pairs.length ? `?${pairs.map(([k, v]) => `${k}=${enc(v)}`).join('&')}` : '';
}

const scoped = (scope: Scope, variant?: ConfigFileVariant) =>
  qs({ project: scope.projectId, variant: scope.projectId ? variant : undefined });

export const api = {
  overview: () => request<Overview>('/overview'),
  system: () => request<SystemInfo>('/system'),
  auth: () => request<AuthStatus>('/auth'),
  setCredentials: (credentials: SetCredentialsRequest) =>
    request<AuthStatus>('/auth/credentials', { method: 'PUT', body: credentials }),
  clearCredentials: () => request<AuthStatus>('/auth/credentials', { method: 'DELETE' }),
  verifyAuth: () => request<AuthVerification>('/auth/verify', { method: 'POST' }),
  projects: () => request<ProjectSummary[]>('/projects'),
  createProject: (req: CreateProjectRequest) => request<ProjectSummary>('/projects', { method: 'POST', body: req }),
  projectSessions: (id: string) => request<SessionSummary[]>(`/projects/${enc(id)}/sessions`),
  sessions: (limit = 500) => request<SessionSummary[]>(`/sessions?limit=${limit}`),
  session: (id: string, sidechains: boolean, page: { limit?: number; before?: number } = {}) =>
    request<SessionDetail>(
      `/sessions/${enc(id)}${qs({ sidechains: sidechains ? '1' : undefined, limit: num(page.limit), before: num(page.before) })}`,
    ),
  runDetail: (id: string, page: { limit?: number; before?: number } = {}) =>
    request<RunDetail>(`/runs/${enc(id)}${qs({ limit: num(page.limit), before: num(page.before) })}`),
  searchSession: (id: string, sidechains: boolean, q: string) =>
    request<TranscriptSearchResult>(`/sessions/${enc(id)}/search${qs({ q, sidechains: sidechains ? '1' : undefined })}`),
  searchRun: (id: string, q: string) => request<TranscriptSearchResult>(`/runs/${enc(id)}/search${qs({ q })}`),
  deleteSession: (id: string) => request<{ ok: true }>(`/sessions/${enc(id)}`, { method: 'DELETE' }),
  active: () => request<ActiveCliSession[]>('/active'),
  environments: (cwd: string) => request<EffectiveEnvironment[]>(`/environments${qs({ cwd })}`),
  memoryProjects: () => request<MemoryProjectSummary[]>('/memory'),
  memoryFiles: (projectId: string) => request<MemoryFile[]>(`/memory/${enc(projectId)}`),
  putMemoryFile: (projectId: string, name: string, content: string) =>
    request<MemoryFile>(`/memory/${enc(projectId)}/${enc(name)}`, { method: 'PUT', body: { content } }),
  deleteMemoryFile: (projectId: string, name: string) =>
    request<{ ok: true }>(`/memory/${enc(projectId)}/${enc(name)}`, { method: 'DELETE' }),
  runs: () => request<RunSummary[]>('/runs'),
  run: (id: string) => request<RunDetail>(`/runs/${enc(id)}`),
  startRun: (opts: RunOptions) => request<RunSummary>('/runs', { method: 'POST', body: opts }),
  sendMessage: (id: string, text: string, attachments: string[] = []) =>
    request<RunSummary>(`/runs/${enc(id)}/messages`, { method: 'POST', body: attachments.length ? { text, attachments } : { text } }),
  uploadFile: (file: File) => uploadFile(file),
  stopRun: (id: string) => request<RunSummary>(`/runs/${enc(id)}/stop`, { method: 'POST' }),
  interruptRun: (id: string) => request<RunSummary>(`/runs/${enc(id)}/interrupt`, { method: 'POST' }),
  updateRun: (id: string, update: RunSettingsUpdate) => request<RunSummary>(`/runs/${enc(id)}`, { method: 'PATCH', body: update }),
  deleteRun: (id: string) => request<{ ok: true }>(`/runs/${enc(id)}`, { method: 'DELETE' }),
  tasks: () => request<BackgroundTask[]>('/tasks'),
  taskOutput: (sessionId: string, taskId: string, offset?: number) =>
    request<BackgroundTaskOutput>(
      `/sessions/${enc(sessionId)}/tasks/${enc(taskId)}/output${qs({ offset: offset === undefined ? undefined : String(offset) })}`,
    ),
  subagent: (sessionId: string, agentId: string, after?: number) =>
    request<AgentTranscript>(`/sessions/${enc(sessionId)}/subagents/${enc(agentId)}${qs({ after: after === undefined ? undefined : String(after) })}`),
  workflowAgent: (sessionId: string, runId: string, agentId: string, after?: number) =>
    request<AgentTranscript>(
      `/sessions/${enc(sessionId)}/workflows/${enc(runId)}/agents/${enc(agentId)}${qs({ after: after === undefined ? undefined : String(after) })}`,
    ),
  subagents: () => request<SubagentInfo[]>('/subagents'),
  workflows: () => request<WorkflowRun[]>('/workflows'),
  savedWorkflows: (cwd?: string) => request<WorkflowDefinition[]>(`/workflows/saved${qs({ cwd })}`),
  runWorkflow: (req: RunWorkflowRequest) => request<RunSummary>('/workflows/saved/run', { method: 'POST', body: req }),
  orchestrations: () => request<Orchestration[]>('/orchestrations'),
  orchestration: (id: string) => request<Orchestration>(`/orchestrations/${enc(id)}`),
  createOrchestration: (spec: OrchestrationSpec) =>
    request<Orchestration>('/orchestrations', { method: 'POST', body: spec }),
  planOrchestration: (req: PlanRequest) =>
    request<OrchestrationSpec>('/orchestrations/plan', { method: 'POST', body: req, timeoutMs: 10 * 60_000 }),
  startPlan: (req: PlanRequest) => request<RunSummary>('/orchestrations/plan/start', { method: 'POST', body: req }),
  planDrafts: () => request<PlanDraftSummary[]>('/orchestrations/plans'),
  runPermissions: (runId: string) => request<PermissionRequest[]>(`/runs/${enc(runId)}/permissions`),
  answerPermission: (runId: string, requestId: string, decision: PermissionDecision) =>
    request<PermissionRequest>(`/runs/${enc(runId)}/permissions/${enc(requestId)}`, { method: 'POST', body: decision }),
  planDraft: (runId: string) => request<OrchestrationSpec>(`/orchestrations/plans/${enc(runId)}`),
  stopOrchestration: (id: string) => request<Orchestration>(`/orchestrations/${enc(id)}/stop`, { method: 'POST' }),
  resumeOrchestration: (id: string, changes: ResumeOrchestrationRequest = {}) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/resume`, { method: 'POST', body: changes }),
  retryOrchestrationTask: (id: string, taskId: string) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/retry`, { method: 'POST' }),
  retryOrchestrationTaskClean: (id: string, taskId: string) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/retry-clean`, { method: 'POST' }),
  skipOrchestrationTask: (id: string, taskId: string) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/skip`, { method: 'POST' }),
  hintOrchestrationTask: (id: string, taskId: string, req: TaskHintRequest) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/hint`, { method: 'POST', body: req }),
  /** The executions of a chat, without the transcript: how each attempt of a task ended. */
  chatExecutions: (id: string) => request<ChatDetail>(`/chats/${enc(id)}?limit=1`).then((detail) => detail.chat.executions),
  deleteOrchestration: (id: string) => request<{ ok: true }>(`/orchestrations/${enc(id)}`, { method: 'DELETE' }),
  integrateOrchestration: (id: string) => request<Orchestration>(`/orchestrations/${enc(id)}/integrate`, { method: 'POST' }),
  orchestrationWorkflow: (id: string) => request<{ path: string; script: string }>(`/orchestrations/${enc(id)}/workflow`),
  saveOrchestrationWorkflow: (id: string, req: SaveOrchestrationWorkflowRequest) =>
    request<WorkflowDefinition>(`/orchestrations/${enc(id)}/workflow/save`, { method: 'POST', body: req }),
  orchestrationPullRequest: (id: string) =>
    request<{ branch: string; url: string | null; detail: string }>(`/orchestrations/${enc(id)}/pull-request`, {
      method: 'POST',
      timeoutMs: 5 * 60_000,
    }),
  pruneOrchestrationWorktrees: (id: string, force = false) =>
    request<{ results: Array<{ task: string; removed: boolean; detail: string }> }>(`/orchestrations/${enc(id)}/worktrees/prune`, {
      method: 'POST',
      body: { force },
    }),
  getSettings: (scope: Scope, variant: ConfigFileVariant = 'shared') =>
    request<SettingsDoc>(`/config/settings${scoped(scope, variant)}`),
  putSettings: (scope: Scope, variant: ConfigFileVariant, settings: Record<string, unknown>) =>
    request<SettingsDoc>(`/config/settings${scoped(scope, variant)}`, { method: 'PUT', body: { settings } }),
  getInstructions: (scope: Scope, variant: ConfigFileVariant = 'shared') =>
    request<InstructionsDoc>(`/config/instructions${scoped(scope, variant)}`),
  putInstructions: (scope: Scope, variant: ConfigFileVariant, content: string) =>
    request<InstructionsDoc>(`/config/instructions${scoped(scope, variant)}`, { method: 'PUT', body: { content } }),
  mcpServers: (scope: Scope) => request<McpServerEntry[]>(`/config/mcp${scoped(scope)}`),
  mcpHealth: (scope: Scope) => request<McpServerHealth[]>(`/config/mcp/health${scoped(scope)}`),
  putMcpServer: (scope: Scope, name: string, config: Record<string, unknown>, mcpScope: McpScope) =>
    request<McpServerEntry>(`/config/mcp/${enc(name)}${scoped(scope)}`, {
      method: 'PUT',
      body: { config, scope: mcpScope },
    }),
  deleteMcpServer: (scope: Scope, name: string, mcpScope: McpScope) =>
    request<{ ok: true }>(`/config/mcp/${enc(name)}${qs({ project: scope.projectId, scope: mcpScope })}`, {
      method: 'DELETE',
    }),
  resources: (scope: Scope, kind: ResourceKind) =>
    request<MarkdownResource[]>(`/config/resources/${kind}${scoped(scope)}`),
  resource: (scope: Scope, kind: ResourceKind, name: string) =>
    request<MarkdownResource>(`/config/resources/${kind}/${enc(name)}${scoped(scope)}`),
  putResource: (scope: Scope, kind: ResourceKind, name: string, content: string) =>
    request<MarkdownResource>(`/config/resources/${kind}/${enc(name)}${scoped(scope)}`, {
      method: 'PUT',
      body: { content },
    }),
  deleteResource: (scope: Scope, kind: ResourceKind, name: string) =>
    request<{ ok: true }>(`/config/resources/${kind}/${enc(name)}${scoped(scope)}`, { method: 'DELETE' }),
  fileRoots: () => request<ConfigFileRoot[]>('/config/files/roots'),
  fileTree: (root: string) => request<ConfigFileNode[]>(`/config/files/tree${qs({ root })}`),
  fileContent: (root: string, path: string) =>
    request<ConfigFileContent>(`/config/files/content${qs({ root, path })}`),
  putFile: (req: WriteConfigFileRequest) =>
    request<ConfigFileContent>('/config/files/content', { method: 'PUT', body: req }),
  deleteFile: (root: string, path: string) =>
    request<{ ok: true }>(`/config/files/content${qs({ root, path })}`, { method: 'DELETE' }),
  accounts: (refresh = false) => request<AccountsOverview>(`/accounts${qs({ refresh: refresh ? '1' : '' })}`),
  switchAccount: (body: SwitchAccountRequest) => request<SwitchResult>('/accounts/switch', { method: 'POST', body }),
  addAccount: (body: AddAccountTokenRequest) => request<AccountsOverview>('/accounts/token', { method: 'POST', body }),
  removeAccount: (number: number) => request<{ ok: true }>(`/accounts/${number}`, { method: 'DELETE' }),
  accountEvents: (limit = 500) => request<AutoSwitchEvent[]>(`/accounts/events${qs({ limit: String(limit) })}`),
  setAccountEnabled: (number: number, enabled: boolean) =>
    request<{ ok: true }>(`/accounts/${number}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  setAccountAlias: (number: number, alias: string | null) =>
    request<{ ok: true }>(`/accounts/${number}/alias`, { method: 'PUT', body: { alias } }),
  setAutoSwitch: (body: Partial<AutoSwitchSettings>) =>
    request<AutoSwitchSettings>('/accounts/autoswitch', { method: 'PUT', body }),
  plugins: () => request<PluginsOverview>('/plugins'),
  availablePlugins: (q: string) => request<AvailablePlugin[]>(`/plugins/available${qs({ q })}`),
  pluginAction: (action: 'install' | 'uninstall' | 'enable' | 'disable', req: PluginActionRequest) =>
    request<CliTextResult>(`/plugins/${action}`, { method: 'POST', body: req }),
  pluginDetails: (plugin: string) => request<CliTextResult>(`/plugins/details${qs({ plugin })}`),
  addMarketplace: (source: string) =>
    request<CliTextResult>('/plugins/marketplaces', { method: 'POST', body: { source } }),
  removeMarketplace: (name: string) =>
    request<CliTextResult>(`/plugins/marketplaces/${enc(name)}`, { method: 'DELETE' }),
  updateMarketplaces: (name?: string) =>
    request<CliTextResult>('/plugins/marketplaces/update', { method: 'POST', body: name ? { name } : {} }),
};

// ---------- Query hooks ----------

export const keys = {
  overview: ['overview'] as const,
  auth: ['auth'] as const,
  projects: ['projects'] as const,
  sessions: (projectId?: string) => ['sessions', projectId ?? 'all'] as const,
  session: (id: string, sidechains: boolean) => ['session', id, sidechains] as const,
  active: ['active'] as const,
  runs: ['runs'] as const,
  tasks: ['tasks'] as const,
  subagents: ['subagents'] as const,
  workflows: ['workflows'] as const,
  // Prefixes the event feed invalidates (lib/events.ts): a panel's queries all sit under them
  agentDetail: ['agent-detail'] as const,
  taskOutput: ['task-output'] as const,
  savedWorkflows: (cwd: string) => ['workflows', 'saved', cwd] as const,
  orchestrations: ['orchestrations'] as const,
  planDrafts: ['orchestrations', 'plans'] as const,
  runPermissions: (id: string) => ['runs', id, 'permissions'] as const,
  orchestration: (id: string) => ['orchestration', id] as const,
  settings: (scope: Scope, variant: ConfigFileVariant) =>
    ['config', 'settings', scope.projectId ?? 'user', variant] as const,
  instructions: (scope: Scope, variant: ConfigFileVariant) =>
    ['config', 'instructions', scope.projectId ?? 'user', variant] as const,
  mcp: (scope: Scope) => ['config', 'mcp', scope.projectId ?? 'user'] as const,
  resources: (scope: Scope, kind: ResourceKind) => ['config', 'resources', scope.projectId ?? 'user', kind] as const,
  fileRoots: ['config', 'files', 'roots'] as const,
  fileTree: (root: string) => ['config', 'files', 'tree', root] as const,
  fileContent: (root: string, path: string) => ['config', 'files', 'content', root, path] as const,
  environments: (cwd: string) => ['environments', cwd] as const,
  memoryProjects: ['memory'] as const,
  memoryFiles: (projectId: string) => ['memory', projectId] as const,
  accounts: ['accounts'] as const,
  accountEvents: ['accounts', 'events'] as const,
  plugins: ['plugins'] as const,
  availablePlugins: (q: string) => ['plugins', 'available', q] as const,
  pluginDetails: (plugin: string) => ['plugins', 'details', plugin] as const,
};

// The queries below are kept fresh by the event feed (lib/events.ts); their intervals are only a
// slow fallback that runs while it is disconnected.
export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: api.overview, refetchInterval: useFallbackInterval() });

/** `poll: false` for pages that read the list once, e.g. to fill a picker. */
export const useProjects = (poll = true) => {
  const fallback = useFallbackInterval();
  return useQuery({ queryKey: keys.projects, queryFn: api.projects, refetchInterval: poll ? fallback : false });
};

export const useSessions = (projectId?: string) =>
  useQuery({
    queryKey: keys.sessions(projectId),
    queryFn: () => (projectId ? api.projectSessions(projectId) : api.sessions()),
    refetchInterval: useFallbackInterval(),
  });

export const useSession = (id: string, sidechains: boolean, live: boolean) => {
  const fallback = useFallbackInterval();
  return useQuery({
    queryKey: keys.session(id, sidechains),
    queryFn: () => api.session(id, sidechains),
    refetchInterval: live ? fallback : false,
  });
};

export interface Paged<T> {
  items: T[];
  /** Index of the first item held, within the whole transcript */
  from: number;
  total: number;
  /** Something is still above what is held */
  more: boolean;
  loadingMore: boolean;
  loadEarlier: () => void;
  /** Reads back until `index` is held, however many pages that takes */
  reach: (index: number) => Promise<void>;
}

/** How many entries to read at once to get back to `index` from `from`. */
const stretch = (from: number, index: number) => Math.min(TRANSCRIPT_PAGE_MAX, Math.max(1, from - index));

/**
 * Holds a contiguous run of a transcript, `[from, total)`, from the newest page back. The query
 * fetches the newest page and keeps it current; pages read further back are kept here and spliced
 * on, so following a live conversation never re-reads what is already held.
 */
function usePages<T>(
  page: { items: T[]; from: number; total: number } | undefined,
  fetchBefore: (before: number, limit?: number) => Promise<{ items: T[]; from: number; total: number }>,
  reset: unknown,
): Paged<T> {
  const [earlier, setEarlier] = useState<{ items: T[]; from: number }>({ items: [], from: -1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const busy = useRef(false);
  // A page that lands after the reader switched transcripts belongs to the previous one
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setEarlier({ items: [], from: -1 });
    setLoadingMore(false);
    busy.current = false;
  }, [reset]);

  const tail = page?.items ?? [];
  const tailFrom = page?.from ?? 0;
  // The newest page slid past what is held (the conversation grew faster than it was read): the
  // pages no longer meet, and the honest thing is to show the newest run rather than a false one.
  const joined = earlier.from >= 0 && earlier.from + earlier.items.length >= tailFrom;
  const items = joined ? [...earlier.items.slice(0, tailFrom - earlier.from), ...tail] : tail;
  const from = joined ? earlier.from : tailFrom;
  const total = page?.total ?? 0;
  const fromNow = useRef(from);
  useEffect(() => {
    fromNow.current = from;
  }, [from]);

  /** Reads the page before `before` and splices it on; resolves to where what is held now starts. */
  const readBefore = useCallback(
    async (before: number, limit?: number): Promise<number> => {
      const started = generation.current;
      const older = await fetchBefore(before, limit);
      if (started !== generation.current || older.items.length === 0) return before;
      setEarlier((held) =>
        held.from >= 0 && held.from <= older.from
          ? held
          : { items: [...older.items, ...(held.from >= 0 ? held.items : [])], from: older.from },
      );
      return older.from;
    },
    [fetchBefore],
  );

  const loadEarlier = useCallback(() => {
    if (busy.current || from <= 0) return;
    busy.current = true;
    setLoadingMore(true);
    void readBefore(from)
      .catch(() => {
        // the page stays as it is; the reader can ask again
      })
      .finally(() => {
        busy.current = false;
        setLoadingMore(false);
      });
  }, [readBefore, from]);

  const reach = useCallback(
    async (index: number) => {
      // A page the reader asked for is already on its way: wait for it rather than read it twice
      while (busy.current) await new Promise((resolve) => setTimeout(resolve, 50));
      busy.current = true;
      setLoadingMore(true);
      try {
        let at = fromNow.current;
        while (at > index) {
          const next = await readBefore(at, stretch(at, index));
          if (next >= at) break;
          at = next;
        }
      } finally {
        busy.current = false;
        setLoadingMore(false);
      }
    },
    [readBefore],
  );

  return { items, from, total, more: from > 0, loadingMore, loadEarlier, reach };
}

/** A session's transcript, newest page first, reading backwards on demand. */
export const useSessionTranscript = (id: string, sidechains: boolean, live: boolean) => {
  const query = useSession(id, sidechains, live);
  const fetchBefore = useCallback(
    (before: number, limit?: number) =>
      api.session(id, sidechains, { before, limit }).then((d) => ({ items: d.entries, from: d.from, total: d.total })),
    [id, sidechains],
  );
  const page = query.data ? { items: query.data.entries, from: query.data.from, total: query.data.total } : undefined;
  return { query, ...usePages(page, fetchBefore, `${id}:${sidechains}`) };
};

export const useActive = () => useQuery({ queryKey: keys.active, queryFn: api.active, refetchInterval: useFallbackInterval() });

export const useRuns = () => useQuery({ queryKey: keys.runs, queryFn: api.runs, refetchInterval: useFallbackInterval() });

/** Usage refreshes on claude-swap's own cadence; polling faster would only re-read its cache. */
export const useAccounts = () =>
  useQuery({ queryKey: keys.accounts, queryFn: () => api.accounts(), refetchInterval: 10_000 });

/** The rotation history kept beyond the window `GET /accounts` carries; only fetched when asked for. */
export const useAccountEvents = (enabled: boolean) =>
  useQuery({ queryKey: keys.accountEvents, queryFn: () => api.accountEvents(), refetchInterval: 10_000, enabled });

export const useTasks = () => useQuery({ queryKey: keys.tasks, queryFn: api.tasks, refetchInterval: useFallbackInterval() });

export const useSubagents = () =>
  useQuery({ queryKey: keys.subagents, queryFn: api.subagents, refetchInterval: useFallbackInterval() });

export const useWorkflows = () => useQuery({ queryKey: keys.workflows, queryFn: api.workflows, refetchInterval: useFallbackInterval() });

export const useOrchestrations = () =>
  useQuery({ queryKey: keys.orchestrations, queryFn: api.orchestrations, refetchInterval: useFallbackInterval() });

export const useOrchestration = (id: string) => {
  const fallback = useFallbackInterval();
  return useQuery({
    queryKey: keys.orchestration(id),
    queryFn: () => api.orchestration(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      // Integrating again happens after the graph finished, and is worth following too
      const integrating = data?.integration && ['merging', 'resolving'].includes(data.integration.status);
      return data && data.status !== 'running' && !integrating ? false : fallback;
    },
  });
};

// ---------- Execution detail ----------

/**
 * What the events cannot say: a subagent writes to its own transcript and a task to its own output
 * file, and neither announces each line. So while one is running, its panel asks again this often,
 * which is cheap because both reads are incremental.
 */
const RUNNING_POLL_MS = 2500;

/** More than any reasonable panel scrolls through; older output is dropped from the front. */
const MAX_OUTPUT_CHARS = 1_000_000;

/** Reads a chunk at a time until the end; a burst larger than one chunk is never left half read. */
const MAX_OUTPUT_CHUNKS = 16;

/** Which agent a panel shows: a subagent, or with `workflowRunId` an agent of that workflow. */
export interface AgentRef {
  sessionId: string;
  agentId: string;
  workflowRunId?: string;
}

/**
 * One agent's detail and transcript. Every fetch asks only for the entries after the ones already
 * cached and appends them, so following a long transcript costs its growth, not its size.
 */
export function useAgentDetail(ref: AgentRef, running: boolean) {
  const client = useQueryClient();
  const fallback = useFallbackInterval();
  const key = [...keys.agentDetail, ref.sessionId, ref.workflowRunId ?? '', ref.agentId];
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<AgentTranscript> => {
      const before = client.getQueryData<AgentTranscript>(key);
      const next = ref.workflowRunId
        ? await api.workflowAgent(ref.sessionId, ref.workflowRunId, ref.agentId, before?.total)
        : await api.subagent(ref.sessionId, ref.agentId, before?.total);
      // `from` is 0 when the server had to start over (the file was rewritten): then it is all there is
      if (!before || next.from === 0) return next;
      return { ...next, entries: [...before.entries.slice(0, next.from), ...next.entries], from: 0 };
    },
    // Entries are appended by identity, so comparing thousands of them deeply on each poll is waste
    structuralSharing: false,
    refetchInterval: (query) => ((query.state.data ? query.state.data.status === 'running' : running) ? RUNNING_POLL_MS : fallback),
  });
}

/** A background task's output as followed so far. */
export interface FollowedOutput {
  text: string;
  /** Size of the file when last read */
  bytes: number;
  /** Where the next read resumes */
  offset: number;
  /** The start of the output is not in `text`: the file was longer than what is kept */
  cutHead: boolean;
}

/** A task's output, following the file as it grows: each fetch resumes from where the last one ended. */
export function useTaskOutput(sessionId: string, taskId: string, running: boolean) {
  const client = useQueryClient();
  const fallback = useFallbackInterval();
  const key = [...keys.taskOutput, sessionId, taskId];
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<FollowedOutput> => {
      const before = client.getQueryData<FollowedOutput>(key);
      let text = before?.text ?? '';
      let cutHead = before?.cutHead ?? false;
      let offset = before?.offset;
      let bytes = before?.bytes ?? 0;
      for (let i = 0; i < MAX_OUTPUT_CHUNKS; i++) {
        const chunk = await api.taskOutput(sessionId, taskId, offset);
        if (offset === undefined || chunk.reset) {
          text = chunk.output;
          cutHead = chunk.truncated;
        } else {
          text += chunk.output;
        }
        offset = chunk.offset;
        bytes = chunk.bytes;
        // Nothing came back while bytes remain: the rest is the start of a character still being written
        if (offset >= bytes || !chunk.output) break;
      }
      if (text.length > MAX_OUTPUT_CHARS) {
        text = text.slice(-MAX_OUTPUT_CHARS);
        cutHead = true;
      }
      return { text, bytes, offset: offset ?? 0, cutHead };
    },
    structuralSharing: false,
    refetchInterval: running ? RUNNING_POLL_MS : fallback,
  });
}

// ---------- SSE run stream ----------

/**
 * Subscribes to a run's SSE stream. Events are deduplicated by `seq` and the
 * connection is re-established from the last seen seq when it drops.
 */
/** Text generated so far for the block Claude is streaming right now (ephemeral, never stored). */
export interface StreamingPartial {
  block: 'text' | 'thinking';
  text: string;
}

/** A stored event that means the streamed block is now final (or the turn is over). */
function endsPartial(event: RunEvent): boolean {
  if (event.kind === 'message') return event.entry?.role === 'assistant';
  if (event.kind === 'result') return true;
  return event.kind === 'status' && event.status !== 'busy';
}

/**
 * A run's events: the newest page over REST, then the live stream from where that page ends, so
 * opening a run that has been going for hours does not replay every event it ever emitted.
 * `loadEarlier` reads the page before the one held.
 */
export function useRunStream(
  id: string | undefined,
  enabled = true,
): {
  events: RunEvent[];
  connected: boolean;
  partial: StreamingPartial | null;
  /** Events held back before the first one on screen */
  from: number;
  more: boolean;
  loadingMore: boolean;
  loadEarlier: () => void;
  /** Reads back until the event at `index` is held */
  reach: (index: number) => Promise<void>;
} {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [from, setFrom] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [partial, setPartial] = useState<StreamingPartial | null>(null);
  const buffer = useRef<RunEvent[]>([]);
  const olderBusy = useRef(false);
  // Latest partial of the current frame; applied together with the stored events in flush()
  const pendingPartial = useRef<StreamingPartial | null | undefined>(undefined);

  const fromNow = useRef(from);
  useEffect(() => {
    fromNow.current = from;
  }, [from]);
  // The run a page was read for, so one landing after the reader moved on is dropped
  const current = useRef(id);
  useEffect(() => {
    current.current = id;
  }, [id]);

  const readBefore = useCallback(
    async (before: number, limit?: number): Promise<number> => {
      if (!id) return before;
      const older = await api.runDetail(id, { before, limit });
      if (current.current !== id || older.events.length === 0) return before;
      setEvents((held) => [...older.events, ...held]);
      setFrom(older.from);
      return older.from;
    },
    [id],
  );

  const loadEarlier = useCallback(() => {
    if (!id || olderBusy.current || from <= 0) return;
    olderBusy.current = true;
    setLoadingMore(true);
    void readBefore(from)
      .catch(() => {
        // the page stays as it is; the reader can ask again
      })
      .finally(() => {
        olderBusy.current = false;
        setLoadingMore(false);
      });
  }, [id, from, readBefore]);

  const reach = useCallback(
    async (index: number) => {
      while (olderBusy.current) await new Promise((resolve) => setTimeout(resolve, 50));
      olderBusy.current = true;
      setLoadingMore(true);
      try {
        let at = fromNow.current;
        while (at > index) {
          const next = await readBefore(at, stretch(at, index));
          if (next >= at) break;
          at = next;
        }
      } finally {
        olderBusy.current = false;
        setLoadingMore(false);
      }
    },
    [readBefore],
  );

  useEffect(() => {
    setEvents([]);
    setFrom(0);
    setConnected(false);
    setPartial(null);
    buffer.current = [];
    pendingPartial.current = undefined;
    olderBusy.current = false;
    if (!id || !enabled) return;

    let lastSeq = 0;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let closed = false;

    // Batch bursts (e.g. replay of a long history) into a single state update.
    const flush = () => {
      frame = 0;
      const nextPartial = pendingPartial.current;
      pendingPartial.current = undefined;
      if (nextPartial !== undefined) setPartial(nextPartial);
      const pending = buffer.current;
      if (pending.length === 0) return;
      buffer.current = [];
      setEvents((prev) => [...prev, ...pending]);
    };

    const connect = () => {
      source = new EventSource(`${BASE}/runs/${enc(id)}/stream?since=${lastSeq}`);
      source.onopen = () => setConnected(true);
      source.onmessage = (msg) => {
        try {
          const event = JSON.parse(String(msg.data)) as RunEvent;
          // Partials reuse the seq of the last stored event, so they must be handled before the dedupe
          if (event.kind === 'partial') {
            pendingPartial.current = { block: event.block ?? 'text', text: event.text ?? '' };
            if (!frame) frame = requestAnimationFrame(flush);
            return;
          }
          if (typeof event.seq !== 'number' || event.seq <= lastSeq) return;
          lastSeq = event.seq;
          if (endsPartial(event)) pendingPartial.current = null;
          buffer.current.push(event);
          if (!frame) frame = requestAnimationFrame(flush);
        } catch {
          // ignore keep-alives / malformed frames
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    // The newest page first, then the stream from where it ends. If the page cannot be had, the
    // stream still replays everything, which is slower but never leaves the run blank.
    void api
      .runDetail(id, {})
      .then((page) => {
        if (closed) return;
        setEvents(page.events);
        setFrom(page.from);
        lastSeq = page.events.at(-1)?.seq ?? 0;
      })
      .catch(() => {})
      .finally(() => {
        if (!closed) connect();
      });

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (frame) cancelAnimationFrame(frame);
      source?.close();
    };
  }, [id, enabled]);

  return { events, connected, partial, from, more: from > 0, loadingMore, loadEarlier, reach };
}
