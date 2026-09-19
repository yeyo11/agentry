import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type {
  AccountsOverview,
  ActiveCliSession,
  AddAccountTokenRequest,
  ApiError,
  AuthStatus,
  AuthVerification,
  AutoSwitchEvent,
  AutoSwitchSettings,
  AvailablePlugin,
  BackgroundTask,
  BackgroundTaskOutput,
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
  RunSummary,
  SessionDetail,
  SessionSummary,
  SetCredentialsRequest,
  SwitchAccountRequest,
  SwitchResult,
  SettingsDoc,
  SubagentInfo,
  SystemInfo,
  WriteConfigFileRequest,
} from '@agentry/shared';

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

/** Config scope: no projectId means the user scope. */
export interface Scope {
  projectId?: string;
}

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
  session: (id: string, sidechains: boolean) =>
    request<SessionDetail>(`/sessions/${enc(id)}${sidechains ? '?sidechains=1' : ''}`),
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
  sendMessage: (id: string, text: string) =>
    request<RunSummary>(`/runs/${enc(id)}/messages`, { method: 'POST', body: { text } }),
  stopRun: (id: string) => request<RunSummary>(`/runs/${enc(id)}/stop`, { method: 'POST' }),
  deleteRun: (id: string) => request<{ ok: true }>(`/runs/${enc(id)}`, { method: 'DELETE' }),
  tasks: () => request<BackgroundTask[]>('/tasks'),
  taskOutput: (sessionId: string, taskId: string) =>
    request<BackgroundTaskOutput>(`/sessions/${enc(sessionId)}/tasks/${enc(taskId)}/output`),
  subagents: () => request<SubagentInfo[]>('/subagents'),
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
  deleteOrchestration: (id: string) => request<{ ok: true }>(`/orchestrations/${enc(id)}`, { method: 'DELETE' }),
  integrateOrchestration: (id: string) => request<Orchestration>(`/orchestrations/${enc(id)}/integrate`, { method: 'POST' }),
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

export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: api.overview, refetchInterval: 3000 });

export const useProjects = (interval: number | false = 10_000) =>
  useQuery({ queryKey: keys.projects, queryFn: api.projects, refetchInterval: interval });

export const useSessions = (projectId?: string) =>
  useQuery({
    queryKey: keys.sessions(projectId),
    queryFn: () => (projectId ? api.projectSessions(projectId) : api.sessions()),
    refetchInterval: 5000,
  });

export const useSession = (id: string, sidechains: boolean, live: boolean) =>
  useQuery({
    queryKey: keys.session(id, sidechains),
    queryFn: () => api.session(id, sidechains),
    refetchInterval: live ? 3000 : false,
  });

export const useActive = () => useQuery({ queryKey: keys.active, queryFn: api.active, refetchInterval: 2000 });

export const useRuns = (interval = 2000) =>
  useQuery({ queryKey: keys.runs, queryFn: api.runs, refetchInterval: interval });

/** Usage refreshes on claude-swap's own cadence; polling faster would only re-read its cache. */
export const useAccounts = () =>
  useQuery({ queryKey: keys.accounts, queryFn: () => api.accounts(), refetchInterval: 10_000 });

/** The rotation history kept beyond the window `GET /accounts` carries; only fetched when asked for. */
export const useAccountEvents = (enabled: boolean) =>
  useQuery({ queryKey: keys.accountEvents, queryFn: () => api.accountEvents(), refetchInterval: 10_000, enabled });

export const useTasks = () => useQuery({ queryKey: keys.tasks, queryFn: api.tasks, refetchInterval: 2000 });

export const useSubagents = () =>
  useQuery({ queryKey: keys.subagents, queryFn: api.subagents, refetchInterval: 2000 });

export const useOrchestrations = () =>
  useQuery({ queryKey: keys.orchestrations, queryFn: api.orchestrations, refetchInterval: 3000 });

export const useOrchestration = (id: string) =>
  useQuery({
    queryKey: keys.orchestration(id),
    queryFn: () => api.orchestration(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      // Integrating again happens after the graph finished, and is worth following too
      const integrating = data?.integration && ['merging', 'resolving'].includes(data.integration.status);
      return data && data.status !== 'running' && !integrating ? false : 2000;
    },
  });

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

export function useRunStream(
  id: string | undefined,
  enabled = true,
): { events: RunEvent[]; connected: boolean; partial: StreamingPartial | null } {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [partial, setPartial] = useState<StreamingPartial | null>(null);
  const buffer = useRef<RunEvent[]>([]);
  // Latest partial of the current frame; applied together with the stored events in flush()
  const pendingPartial = useRef<StreamingPartial | null | undefined>(undefined);

  useEffect(() => {
    setEvents([]);
    setConnected(false);
    setPartial(null);
    buffer.current = [];
    pendingPartial.current = undefined;
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
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (frame) cancelAnimationFrame(frame);
      source?.close();
    };
  }, [id, enabled]);

  return { events, connected, partial };
}
