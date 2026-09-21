import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  Attachment,
  AccountConfig,
  AccountsOverview,
  AgentTranscript,
  AddAccountTokenRequest,
  ApiError,
  AuditPage,
  AuthConfig,
  AuthMode,
  AuthStatus,
  AuthTokenResult,
  SetAuthTokenRequest,
  UpdateAuthConfigRequest,
  AuthVerification,
  AutoSwitchEvent,
  AutoSwitchSettings,
  AvailablePlugin,
  BackgroundTaskOutput,
  CancelCommandRequest,
  CancelCommandResult,
  ChangeSummary,
  ChatChanges,
  Checklist,
  ChatBackgroundTask,
  ChatBackgroundTaskEntry,
  ChatDetail,
  ChatMessageRequest,
  ChatOrigin,
  ChatSettingsUpdate,
  ChatState,
  CliVersionInfo,
  ChatSubagentEntry,
  ChatSummary,
  ChatWorkflowEntry,
  CliTextResult,
  ConfigFileContent,
  ConfigFileNode,
  ConfigFileRoot,
  ConfigFileVariant,
  ConnectorsOverview,
  LaunchOrchestrationTemplateRequest,
  CreateProjectRequest,
  FileDiff,
  CreateScheduleRequest,
  ExportFormat,
  ForkChatRequest,
  HintRequest,
  ImportProjectRequest,
  NewChatRequest,
  EffectiveEnvironment,
  InstructionsDoc,
  ConfigResource,
  MemoryFile,
  MemoryProjectSummary,
  McpScope,
  McpServerEntry,
  McpServerHealth,
  ToolPreset,
  Orchestration,
  OrchestrationSpec,
  OrchestrationTemplate,
  Overview,
  PermissionDecision,
  PermissionRequest,
  PlanDraftSummary,
  PlanRequest,
  RelaunchOrchestrationRequest,
  ResumeOrchestrationRequest,
  RotationPolicy,
  RotationPolicyRequest,
  SaveOrchestrationTemplateRequest,
  UpdateAccountConfigRequest,
  UpdateOrchestrationTemplateRequest,
  UsageHistoryPoint,
  UsageWindowKind,
  PluginActionRequest,
  PluginsOverview,
  Project,
  ProjectCandidate,
  ResourceKind,
  ResumeChatRequest,
  Schedule,
  SchedulePreview,
  ScheduleRun,
  UpdateScheduleRequest,
  UsageBreakdown,
  UsageBucket,
  UsageSeries,
  SetCredentialsRequest,
  SwitchAccountRequest,
  SwitchResult,
  SettingsDoc,
  RunWorkflowRequest,
  WorkflowDefinition,
  SystemInfo,
  WriteConfigFileRequest,
  SaveOrchestrationWorkflowRequest,
  TaskHintRequest,
  TranscriptSearchResult,
  UsageReport,
} from '@agentry/shared';
import i18n from './i18n';
import { authHeaders, setChallenge, withToken } from './lib/auth';
import { useFallbackInterval } from './lib/feed';

export const BASE = '/api';

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
      headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...authHeaders() },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiRequestError(i18n.t('common:requestTimeout'), 408);
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
    const err = json as (Partial<ApiError> & { mode?: AuthMode }) | null;
    // The guard refused the credential: every page is about to fail the same way, so the app
    // shows one sign-in screen instead of an error on each of them
    if (res.status === 401) setChallenge(err?.mode ?? 'token');
    throw new ApiRequestError(err?.error ?? `HTTP ${res.status} ${res.statusText}`, res.status, err?.detail);
  }
  return json as T;
}

export const enc = encodeURIComponent;

/** The file is the request body, as is: no multipart, no base64 on the way up. */
async function uploadFile(file: File): Promise<Attachment> {
  const res = await fetch(`${BASE}/uploads?name=${encodeURIComponent(file.name || 'pasted')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...authHeaders() },
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
  cliVersion: () => request<CliVersionInfo>('/system/cli-version'),
  checkCliVersion: () => request<CliVersionInfo>('/system/cli-version/check', { method: 'POST' }),
  verifyAuth: () => request<AuthVerification>('/auth/verify', { method: 'POST' }),
  projects: () => request<Project[]>('/projects'),
  projectCandidates: () => request<ProjectCandidate[]>('/projects/candidates'),
  importProject: (req: ImportProjectRequest) => request<Project>('/projects/import', { method: 'POST', body: req }),
  createProject: (req: CreateProjectRequest) => request<Project>('/projects', { method: 'POST', body: req }),
  renameProject: (id: string, name: string) => request<Project>(`/projects/${enc(id)}`, { method: 'PATCH', body: { name } }),
  removeProject: (id: string) => request<{ ok: true }>(`/projects/${enc(id)}`, { method: 'DELETE' }),
  purgeProject: (id: string) => request<{ detail: string }>(`/projects/${enc(id)}/state`, { method: 'DELETE' }),
  chats: (filter: ChatFilter = {}) =>
    request<ChatSummary[]>(
      `/chats${qs({
        // `null` is the chats under no project, which the route asks for with `loose`
        project: filter.project ?? undefined,
        loose: filter.project === null ? '1' : undefined,
        origin: filter.origin?.join(','),
        state: filter.state,
        limit: num(filter.limit),
      })}`,
    ),
  chat: (id: string, sidechains: boolean, page: { limit?: number; before?: number } = {}) =>
    request<ChatDetail>(
      `/chats/${enc(id)}${qs({ sidechains: sidechains ? '1' : undefined, limit: num(page.limit), before: num(page.before) })}`,
    ),
  searchChat: (id: string, sidechains: boolean, q: string) =>
    request<TranscriptSearchResult>(`/chats/${enc(id)}/search${qs({ q, sidechains: sidechains ? '1' : undefined })}`),
  createChat: (req: NewChatRequest) => request<ChatSummary>('/chats', { method: 'POST', body: req }),
  resumeChat: (id: string, req: ResumeChatRequest) => request<ChatSummary>(`/chats/${enc(id)}/resume`, { method: 'POST', body: req }),
  forkChat: (id: string, req: ForkChatRequest) => request<ChatSummary>(`/chats/${enc(id)}/fork`, { method: 'POST', body: req }),
  sendMessage: (id: string, req: ChatMessageRequest) => request<ChatSummary>(`/chats/${enc(id)}/messages`, { method: 'POST', body: req }),
  stopChat: (id: string) => request<ChatSummary>(`/chats/${enc(id)}/stop`, { method: 'POST' }),
  interruptChat: (id: string) => request<ChatSummary>(`/chats/${enc(id)}/interrupt`, { method: 'POST' }),
  updateChat: (id: string, update: ChatSettingsUpdate) => request<ChatSummary>(`/chats/${enc(id)}`, { method: 'PATCH', body: update }),
  deleteChat: (id: string) => request<{ ok: true }>(`/chats/${enc(id)}`, { method: 'DELETE' }),
  uploadFile: (file: File) => uploadFile(file),
  chatPermissions: (id: string) => request<PermissionRequest[]>(`/chats/${enc(id)}/permissions`),
  chatTasks: (id: string) => request<ChatBackgroundTask[]>(`/chats/${enc(id)}/tasks`),
  answerPermission: (id: string, requestId: string, decision: PermissionDecision) =>
    request<PermissionRequest>(`/chats/${enc(id)}/permissions/${enc(requestId)}`, { method: 'POST', body: decision }),
  usage: (range: { from?: string; to?: string } = {}) => request<UsageReport>(`/usage${qs(range)}`),
  usageSeries: (range: UsageRange, bucket: UsageBucket) => request<UsageSeries>(`/usage/series${qs({ from: range.from, to: range.to, bucket })}`),
  usageBreakdown: (range: UsageRange) => request<UsageBreakdown>(`/usage/breakdown${qs({ from: range.from, to: range.to })}`),
  /**
   * A link, not a fetch: the route answers with `Content-Disposition: attachment`, so the browser
   * saves it. A link carries no `Authorization` header, so a guarded wrapper takes the credential
   * from the query string here, as it does for the streams and an attachment.
   */
  chatExportUrl: (id: string, format: ExportFormat) => withToken(`${BASE}/chats/${enc(id)}/export?format=${format}`),
  projectExportUrl: (id: string, format: ExportFormat) => withToken(`${BASE}/projects/${enc(id)}/export?format=${format}`),
  schedules: () => request<Schedule[]>('/schedules'),
  schedulePreview: (cron: string, timezone: string | undefined, count = 5) =>
    request<SchedulePreview>(`/schedules/preview${qs({ cron, timezone, count: String(count) })}`),
  createSchedule: (req: CreateScheduleRequest) => request<Schedule>('/schedules', { method: 'POST', body: req }),
  updateSchedule: (id: string, req: UpdateScheduleRequest) => request<Schedule>(`/schedules/${enc(id)}`, { method: 'PATCH', body: req }),
  deleteSchedule: (id: string) => request<{ ok: true }>(`/schedules/${enc(id)}`, { method: 'DELETE' }),
  setScheduleEnabled: (id: string, enabled: boolean) => request<Schedule>(`/schedules/${enc(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  runScheduleNow: (id: string) => request<ScheduleRun>(`/schedules/${enc(id)}/run`, { method: 'POST' }),
  scheduleRuns: (id: string, limit = 50) => request<ScheduleRun[]>(`/schedules/${enc(id)}/runs${qs({ limit: String(limit) })}`),
  environments: (cwd: string) => request<EffectiveEnvironment[]>(`/environments${qs({ cwd })}`),
  memoryProjects: () => request<MemoryProjectSummary[]>('/memory'),
  memoryFiles: (projectId: string) => request<MemoryFile[]>(`/memory/${enc(projectId)}`),
  putMemoryFile: (projectId: string, name: string, content: string) =>
    request<MemoryFile>(`/memory/${enc(projectId)}/${enc(name)}`, { method: 'PUT', body: { content } }),
  deleteMemoryFile: (projectId: string, name: string) =>
    request<{ ok: true }>(`/memory/${enc(projectId)}/${enc(name)}`, { method: 'DELETE' }),
  tasks: () => request<ChatBackgroundTaskEntry[]>('/tasks'),
  taskOutput: (chatId: string, taskId: string, offset?: number) =>
    request<BackgroundTaskOutput>(`/chats/${enc(chatId)}/tasks/${enc(taskId)}/output${qs({ offset: num(offset) })}`),
  subagent: (chatId: string, agentId: string, after?: number) =>
    request<AgentTranscript>(`/chats/${enc(chatId)}/subagents/${enc(agentId)}${qs({ after: num(after) })}`),
  workflowAgent: (chatId: string, workflowId: string, agentId: string, after?: number) =>
    request<AgentTranscript>(`/chats/${enc(chatId)}/workflows/${enc(workflowId)}/agents/${enc(agentId)}${qs({ after: num(after) })}`),
  subagents: () => request<ChatSubagentEntry[]>('/subagents'),
  workflows: () => request<ChatWorkflowEntry[]>('/workflows'),
  savedWorkflows: (cwd?: string) => request<WorkflowDefinition[]>(`/workflows/saved${qs({ cwd })}`),
  /** Starts a chat that runs a saved workflow */
  runWorkflow: (req: RunWorkflowRequest) => request<ChatSummary>('/workflows/saved/run', { method: 'POST', body: req }),
  orchestrations: () => request<Orchestration[]>('/orchestrations'),
  orchestration: (id: string) => request<Orchestration>(`/orchestrations/${enc(id)}`),
  createOrchestration: (spec: OrchestrationSpec) =>
    request<Orchestration>('/orchestrations', { method: 'POST', body: spec }),
  planOrchestration: (req: PlanRequest) =>
    request<OrchestrationSpec>('/orchestrations/plan', { method: 'POST', body: req, timeoutMs: 10 * 60_000 }),
  startPlan: (req: PlanRequest) => request<ChatSummary>('/orchestrations/plan/start', { method: 'POST', body: req }),
  planDrafts: () => request<PlanDraftSummary[]>('/orchestrations/plans'),
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
  rerunOrchestrationTask: (id: string, taskId: string) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/rerun`, { method: 'POST' }),
  relaunchOrchestration: (id: string, req: RelaunchOrchestrationRequest) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/relaunch`, { method: 'POST', body: req }),
  orchestrationTemplates: () => request<OrchestrationTemplate[]>('/orchestrations/templates'),
  saveOrchestrationTemplate: (req: SaveOrchestrationTemplateRequest) =>
    request<OrchestrationTemplate>('/orchestrations/templates', { method: 'POST', body: req }),
  updateOrchestrationTemplate: (templateId: string, req: UpdateOrchestrationTemplateRequest) =>
    request<OrchestrationTemplate>(`/orchestrations/templates/${enc(templateId)}`, { method: 'PATCH', body: req }),
  deleteOrchestrationTemplate: (templateId: string) =>
    request<{ ok: true }>(`/orchestrations/templates/${enc(templateId)}`, { method: 'DELETE' }),
  launchOrchestrationTemplate: (templateId: string, req: LaunchOrchestrationTemplateRequest) =>
    request<Orchestration>(`/orchestrations/templates/${enc(templateId)}/launch`, { method: 'POST', body: req }),
  hintOrchestrationTask: (id: string, taskId: string, req: TaskHintRequest) =>
    request<Orchestration>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/hint`, { method: 'POST', body: req }),
  // What a worker changed on disk, and the plan it kept for itself (see docs: agent observability)
  taskChanges: (id: string, taskId: string) => request<ChangeSummary>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/changes`),
  taskDiff: (id: string, taskId: string, path: string) =>
    request<FileDiff>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/changes/diff${qs({ path })}`),
  taskChecklist: (id: string, taskId: string) => request<Checklist>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/checklist`),
  integrationChanges: (id: string) => request<ChangeSummary>(`/orchestrations/${enc(id)}/integration/changes`),
  integrationDiff: (id: string, path: string) => request<FileDiff>(`/orchestrations/${enc(id)}/integration/changes/diff${qs({ path })}`),
  chatChanges: (id: string) => request<ChatChanges>(`/chats/${enc(id)}/changes`),
  chatDiff: (id: string, path: string) => request<FileDiff>(`/chats/${enc(id)}/changes/diff${qs({ path })}`),
  chatChecklist: (id: string) => request<Checklist>(`/chats/${enc(id)}/checklist`),
  hintChat: (id: string, req: HintRequest) => request<ChatSummary>(`/chats/${enc(id)}/hint`, { method: 'POST', body: req }),
  cancelCommand: (id: string, toolUseId: string, req: CancelCommandRequest = {}) =>
    request<CancelCommandResult>(`/chats/${enc(id)}/commands/${enc(toolUseId)}/cancel`, { method: 'POST', body: req }),
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
  toolPresets: () => request<ToolPreset[]>('/config/tool-presets'),
  putToolPreset: (id: string, preset: Pick<ToolPreset, 'name' | 'description' | 'allowedTools' | 'disallowedTools'>) =>
    request<ToolPreset>(`/config/tool-presets/${enc(id)}`, { method: 'PUT', body: preset }),
  deleteToolPreset: (id: string) => request<{ ok: true }>(`/config/tool-presets/${enc(id)}`, { method: 'DELETE' }),
  resources: (scope: Scope, kind: ResourceKind) =>
    request<ConfigResource[]>(`/config/resources/${kind}${scoped(scope)}`),
  resource: (scope: Scope, kind: ResourceKind, name: string) =>
    request<ConfigResource>(`/config/resources/${kind}/${enc(name)}${scoped(scope)}`),
  putResource: (scope: Scope, kind: ResourceKind, name: string, content: string) =>
    request<ConfigResource>(`/config/resources/${kind}/${enc(name)}${scoped(scope)}`, {
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
  securityAuth: () => request<AuthConfig>('/security/auth'),
  updateSecurityAuth: (body: UpdateAuthConfigRequest) => request<AuthConfig>('/security/auth', { method: 'PUT', body }),
  /** The only answer that ever carries the token; it cannot be read back afterwards. */
  setSecurityToken: (body: SetAuthTokenRequest = {}) => request<AuthTokenResult>('/security/token', { method: 'POST', body }),
  clearSecurityToken: () => request<AuthConfig>('/security/token', { method: 'DELETE' }),
  audit: (page: { limit?: number; from?: number; path?: string } = {}) =>
    request<AuditPage>(`/audit${qs({ limit: num(page.limit), from: num(page.from), path: page.path })}`),
  setAccountConfig: (number: number, body: UpdateAccountConfigRequest) =>
    request<AccountConfig>(`/accounts/${number}/config`, { method: 'PUT', body }),
  accountPolicies: () => request<RotationPolicy[]>('/accounts/policies'),
  createAccountPolicy: (body: RotationPolicyRequest) => request<RotationPolicy>('/accounts/policies', { method: 'POST', body }),
  updateAccountPolicy: (id: string, body: RotationPolicyRequest) =>
    request<RotationPolicy>(`/accounts/policies/${enc(id)}`, { method: 'PUT', body }),
  deleteAccountPolicy: (id: string) => request<{ ok: true }>(`/accounts/policies/${enc(id)}`, { method: 'DELETE' }),
  accountUsageHistory: (query: { account?: number; window?: UsageWindowKind; since?: string; limit?: number } = {}) =>
    request<UsageHistoryPoint[]>(
      `/accounts/usage${qs({ account: num(query.account), window: query.window, since: query.since, limit: num(query.limit) })}`,
    ),
  /** `refresh` asks the CLI again instead of reading the 60 seconds it keeps the answer for */
  connectors: (refresh = false) => request<ConnectorsOverview>(`/connectors${qs({ refresh: refresh ? 'true' : '' })}`, { timeoutMs: 100_000 }),
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
  cliVersion: ['cli-version'] as const,
  projects: ['projects'] as const,
  projectCandidates: ['projects', 'candidates'] as const,
  // Prefixes the event feed invalidates: every list and every open chat sits under them
  chats: ['chats'] as const,
  chatList: (filter: ChatFilter) => ['chats', filter.project === undefined ? 'all' : (filter.project ?? 'loose'), filter.origin?.join(',') ?? '', filter.state ?? '', filter.limit ?? 0] as const,
  /** Prefix of a chat's page and of everything read for it */
  chatScope: (id: string) => ['chat', id] as const,
  chat: (id: string, sidechains: boolean) => ['chat', id, sidechains] as const,
  usage: (range: { from?: string; to?: string }) => ['usage', range.from ?? '', range.to ?? ''] as const,
  usageSeries: (range: UsageRange, bucket: UsageBucket) => ['usage', 'series', range.from ?? '', range.to ?? '', bucket] as const,
  usageBreakdown: (range: UsageRange) => ['usage', 'breakdown', range.from ?? '', range.to ?? ''] as const,
  schedules: ['schedules'] as const,
  schedulePreview: (cron: string, timezone: string | undefined) => ['schedules', 'preview', cron, timezone ?? ''] as const,
  scheduleRuns: (id: string) => ['schedules', 'runs', id] as const,
  tasks: ['tasks'] as const,
  subagents: ['subagents'] as const,
  workflows: ['workflows'] as const,
  // Prefixes the event feed invalidates (lib/events.ts): a panel's queries all sit under them
  agentDetail: ['agent-detail'] as const,
  agent: (chatId: string, workflowId: string, agentId: string) => ['agent-detail', chatId, workflowId, agentId] as const,
  taskOutput: ['task-output'] as const,
  output: (chatId: string, taskId: string) => ['task-output', chatId, taskId] as const,
  chatTasks: (chatId: string) => ['tasks', 'chat', chatId] as const,
  savedWorkflowsAll: ['workflows', 'saved'] as const,
  savedWorkflows: (cwd: string) => ['workflows', 'saved', cwd] as const,
  orchestrations: ['orchestrations'] as const,
  planDrafts: ['orchestrations', 'plans'] as const,
  chatPermissions: (id: string) => ['chat', id, 'permissions'] as const,
  orchestration: (id: string) => ['orchestration', id] as const,
  settings: (scope: Scope, variant: ConfigFileVariant) =>
    ['config', 'settings', scope.projectId ?? 'user', variant] as const,
  instructions: (scope: Scope, variant: ConfigFileVariant) =>
    ['config', 'instructions', scope.projectId ?? 'user', variant] as const,
  mcp: (scope: Scope) => ['config', 'mcp', scope.projectId ?? 'user'] as const,
  toolPresets: ['config', 'tool-presets'] as const,
  resources: (scope: Scope, kind: ResourceKind) => ['config', 'resources', scope.projectId ?? 'user', kind] as const,
  fileRoots: ['config', 'files', 'roots'] as const,
  fileTree: (root: string) => ['config', 'files', 'tree', root] as const,
  fileContent: (root: string, path: string) => ['config', 'files', 'content', root, path] as const,
  environments: (cwd: string) => ['environments', cwd] as const,
  memoryProjects: ['memory'] as const,
  memoryFiles: (projectId: string) => ['memory', projectId] as const,
  accounts: ['accounts'] as const,
  accountEvents: ['accounts', 'events'] as const,
  accountUsage: (account: number | 'all', window: UsageWindowKind, since: string) => ['accounts', 'usage', account, window, since] as const,
  orchestrationTemplates: ['orchestrations', 'templates'] as const,
  connectors: ['connectors'] as const,
  plugins: ['plugins'] as const,
  securityAuth: ['security', 'auth'] as const,
  audit: (page: { from?: number; path?: string }) => ['security', 'audit', page.from ?? 0, page.path ?? ''] as const,
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

/** Directories the person could import: what a first start offers instead of an empty screen. */
export const useProjectCandidates = (enabled = true) =>
  useQuery({ queryKey: keys.projectCandidates, queryFn: api.projectCandidates, enabled });

/** Which chats a list asks for. `project`: undefined is every chat, a string one project, null the ones under none. */
export interface ChatFilter {
  project?: string | null;
  /** Defaults to the chats a person started or adopted; workers and housekeeping stay out unless asked for */
  origin?: ChatOrigin[];
  state?: ChatState;
  limit?: number;
  /** The query waits, e.g. until the project it depends on is known */
  enabled?: boolean;
}

export const useChats = (filter: ChatFilter = {}) => {
  const { enabled = true, ...rest } = filter;
  return useQuery({ queryKey: keys.chatList(rest), queryFn: () => api.chats(rest), refetchInterval: useFallbackInterval(), enabled });
};

/** What the chats spent over a range of days (`YYYY-MM-DD`, inclusive), or ever. */
export const useUsage = (range: { from?: string; to?: string } = {}) =>
  useQuery({ queryKey: keys.usage(range), queryFn: () => api.usage(range), refetchInterval: useFallbackInterval() });

export interface UsageRange {
  from?: string;
  to?: string;
}

// The previous range stays on screen while the next one loads, so picking a range does not blank the page
export const useUsageSeries = (range: UsageRange, bucket: UsageBucket) =>
  useQuery({ queryKey: keys.usageSeries(range, bucket), queryFn: () => api.usageSeries(range, bucket), refetchInterval: useFallbackInterval(), placeholderData: keepPreviousData });

export const useUsageBreakdown = (range: UsageRange) =>
  useQuery({ queryKey: keys.usageBreakdown(range), queryFn: () => api.usageBreakdown(range), refetchInterval: useFallbackInterval(), placeholderData: keepPreviousData });

// `schedule.changed` and `schedule.fired` keep both fresh (lib/events.ts), `nextRunAt` included
export const useSchedules = () => useQuery({ queryKey: keys.schedules, queryFn: api.schedules, refetchInterval: useFallbackInterval() });

export const useScheduleRuns = (id: string, enabled: boolean) => {
  const fallback = useFallbackInterval();
  return useQuery({ queryKey: keys.scheduleRuns(id), queryFn: () => api.scheduleRuns(id), enabled, refetchInterval: enabled ? fallback : false });
};

/** Usage refreshes on claude-swap's own cadence; polling faster would only re-read its cache. */
export const useAccounts = () =>
  useQuery({ queryKey: keys.accounts, queryFn: () => api.accounts(), refetchInterval: 10_000 });

/** The rotation history kept beyond the window `GET /accounts` carries; only fetched when asked for. */
export const useAccountEvents = (enabled: boolean) =>
  useQuery({ queryKey: keys.accountEvents, queryFn: () => api.accountEvents(), refetchInterval: 10_000, enabled });




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
