import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Attachment,
  AccountConfig,
  AccountsOverview,
  AgentTranscript,
  AgentryReleaseInfo,
  AddAccountTokenRequest,
  DecisionClearResult,
  DecisionConsentRequest,
  DecisionCredentialsResult,
  DecisionFeedback,
  DecisionFilter,
  DecisionPage,
  DecisionPageQuery,
  DecisionNotificationOpenedResult,
  DecisionPaletteRequest,
  DecisionPaletteResult,
  DecisionPointId,
  DecisionPointInfo,
  DecisionPreview,
  DecisionRecord,
  DecisionStats,
  DecisionSettings,
  DecisionSettingsUpdate,
  DecisionTestResult,
  CodeHostStatus,
  CodeHostsSettings,
  DecisionProviderId,
  ApiError,
  AuditFilter,
  AuditPage,
  AppSettings,
  AuthConfig,
  AuthMode,
  AuthStatus,
  AuthTokenResult,
  SetAuthTokenRequest,
  UpdateAuthConfigRequest,
  UpdateAppSettingsRequest,
  TunnelStatus,
  UpdateTunnelSettingsRequest,
  AuthVerification,
  AutoSwitchEvent,
  AutoSwitchSettings,
  AvailablePlugin,
  BackgroundTaskOutput,
  CancelCommandRequest,
  CancelCommandResult,
  ChangeSummary,
  CswapInfo,
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
  DiffContext,
  EditStep,
  CreateScheduleRequest,
  ExportFormat,
  ForkChatRequest,
  HintRequest,
  ImportProjectRequest,
  ModelOption,
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
  ToolPresetsConfig,
  ToolPresetsOverview,
  Orchestration,
  OrchestrationSummary,
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
  ProjectCodeHost,
  ProviderStatus,
  ProvidersSettings,
  PushKeyInfo,
  PushSendResult,
  PushSubscriptionSummary,
  RegisterPushSubscriptionRequest,
  RemovePushSubscriptionRequest,
  SendTestPushRequest,
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
  SupervisorConfig,
  SupervisorProposal,
  UpdateSupervisorConfigRequest,
  RunWorkflowRequest,
  WorkflowDefinition,
  SystemInfo,
  WriteConfigFileRequest,
  SaveOrchestrationWorkflowRequest,
  TaskHintRequest,
  TranscriptSearchResult,
  UsageReport,
  Board,
  BoardQuery,
  CreateMilestoneRequest,
  CreateWorkItemCommentRequest,
  CreateWorkItemFromMessageRequest,
  CreateWorkItemLinkRequest,
  CreateWorkItemRelationRequest,
  CreateWorkItemRequest,
  Milestone,
  MoveWorkItemRequest,
  MoveWorkItemResult,
  WorkItemPullRequestResult,
  ChangeRequest,
  AddressReviewRequest,
  ApprovalState,
  ChangeRequestChecks,
  ChangeRequestReviewPosts,
  ChangeRequestReviewers,
  ChangeRequestThreads,
  CheckLog,
  CheckState,
  ChecksRerunRequest,
  ReviewDraft,
  ReviewDraftInput,
  ReviewPost,
  ReviewSubmitRequest,
  ReviewThread,
  ReviewersRequest,
  OrchestrationPullRequest,
  WorkItemPullRequest,
  OrchestrateWorkItemsRequest,
  ProjectSettings,
  ProjectTemplate,
  UpdateMilestoneRequest,
  UpdateProjectRequest,
  TriageWorkItemRequest,
  TriageWorkItemResult,
  UpdateWorkItemRequest,
  WorkItem,
  WorkItemChanges,
  WorkItemComment,
  WorkItemDetail,
  WorkItemFilter,
  WorkItemHistoryEntry,
  WorkItemLink,
  WorkItemOrchestrationDraft,
  WorkItemPage,
  WorkItemPageQuery,
  WorkOnWorkItemRequest,
  WorkOnWorkItemResult,
  ApproveMemoryProposalRequest,
  CreateJournalEntryRequest,
  DocumentFile,
  JournalEntry,
  JournalPage,
  MemoryProposal,
  MemoryProposalStatus,
  ProjectDocuments,
  FlowRun,
  FlowRunPage,
  FlowRunQuery,
  ProjectFlow,
  FlowStartWaitingResult,
  FlowWaiting,
  PutTeamMemberRequest,
  RejectMemoryProposalRequest,
  Team,
  TeamFromTemplateRequest,
  TeamMember,
  TieDocumentRequest,
  WriteDocumentRequest,
  AcceptAssistantProposalRequest,
  AssistantProposal,
  AssistantRun,
  AssistantRunDetail,
  AssistantRunKind,
  StartAssistantRunRequest,
} from '@agentry/shared';
import i18n from './i18n';
import { authHeaders, setChallenge, withToken } from './lib/auth';
import { chatKeys, type ChatClient } from '@agentry/chat-ui/lib/context';
import { accountsRefetchInterval, normalizeCswap } from './lib/cswap';
import { useFallbackInterval } from './lib/feed';
import { filterKey, normalizeKey, openCount } from './lib/work-items';

export const BASE = '/api';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly detail?: string;
  /** The refusal's code, when the route names one (`{ error, code }`), so the page can word it */
  readonly code?: string;
  /** The review post a refusal belongs to: a partly posted review is published or discarded by it */
  readonly postId?: string;

  constructor(message: string, status: number, detail?: string, code?: string, postId?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.postId = postId;
  }
}

/**
 * Long enough for the slowest honest call (a plugin install shelling out to the CLI), short enough
 * that a response which will never arrive surfaces as an error instead of a spinner that turns for
 * ever. Nothing here should hold a request open for minutes — long work returns a run to stream.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * What react-query hands a query function. A reader takes it as its last argument, so a refetch the
 * cache no longer wants (a filter changed, the page was left) cancels its request instead of letting
 * the response download for nobody. `queryFn: api.overview` passes it as it is.
 */
export interface ReadOptions {
  signal?: AbortSignal;
}

/**
 * Aborts when either does, with that one's reason, so a timeout still reads as one. `AbortSignal.any`
 * is recent (Safari 17.4, Firefox 124): without it every read would throw before being sent.
 */
function either(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}

/** What `POST /change-requests/:id/checks/fix` answers (core's `ChangeRequestFix`, which shared does not export). */
export interface ChangeRequestFixResult {
  started: boolean;
  prompt: string;
  worktree: string | null;
  pullRequest: WorkItemPullRequest | OrchestrationPullRequest | null;
}

async function request<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const timeout = AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      // The language the person reads Agentry in, for what the server writes in it (a chat's title)
      headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), 'accept-language': i18n.resolvedLanguage ?? i18n.language, ...authHeaders() },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: init.signal ? either(init.signal, timeout) : timeout,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiRequestError(i18n.t('common:requestTimeout'), 408);
    }
    // fetch rejects with a bare TypeError ("Failed to fetch", "NetworkError…") when no answer came
    // back at all: the browser's wording, in the browser's language, and nothing a person can act on
    if (err instanceof TypeError) throw new ApiRequestError(i18n.t('common:networkError'), 0, err.message);
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
    // No JSON error means Agentry did not write this answer (a proxy's or a tunnel's page): say so in
    // the person's language and keep the status line as the detail
    if (!err?.error) throw new ApiRequestError(i18n.t('common:httpError', { status: res.status }), res.status, `HTTP ${res.status} ${res.statusText}`.trim());
    const code = (err as { code?: unknown }).code;
    const postId = (err as { postId?: unknown }).postId;
    throw new ApiRequestError(err.error, res.status, err.detail, typeof code === 'string' ? code : undefined, typeof postId === 'string' ? postId : undefined);
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

/** A page of a project's journal, newest first: `before` is the `nextBefore` of the previous page. */
export interface JournalQuery {
  limit?: number;
  before?: string;
}

const num = (value: number | undefined) => (value === undefined ? undefined : String(value));

function qs(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '');
  return pairs.length ? `?${pairs.map(([k, v]) => `${k}=${enc(v)}`).join('&')}` : '';
}

/** A work item filter as the routes read it: every list comma separated. */
const workItemQuery = (filter: Omit<WorkItemFilter, 'projectId'>) =>
  qs({
    status: filter.status?.join(','),
    type: filter.type?.join(','),
    priority: filter.priority?.join(','),
    labels: filter.labels?.join(','),
    assignee: filter.assignee?.join(','),
    epicId: filter.epicId,
    milestoneId: filter.milestoneId,
    q: filter.q?.trim() || undefined,
  });

/** A project's collection, or every project's (the All projects view) for `null`. */
const workItemsOf = (projectId: string | null) => (projectId ? `/projects/${enc(projectId)}/work-items` : '/work-items');

/**
 * The item behind a key, whole, as its page shows it (`GET /work-items/by-key/:key`). Null when no
 * project has it, and for what is not a key at all, which is never asked.
 */
async function workItemByKey(key: string, o: ReadOptions = {}): Promise<WorkItemDetail | null> {
  const wanted = normalizeKey(key);
  if (!wanted) return null;
  try {
    return await request<WorkItemDetail>(`/work-items/by-key/${enc(wanted)}`, o);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

/** A page of a list: the filter, then where to start and how many. */
const workItemPageQuery = (query: WorkItemPageQuery) => {
  const { limit, cursor, ...filter } = query;
  const base = workItemQuery(filter);
  const extra = qs({ limit: num(limit), cursor }).slice(1);
  return extra ? `${base}${base ? '&' : '?'}${extra}` : base;
};

/** A page of a project's flow runs, every list comma separated. */
const flowRunQuery = (query: FlowRunQuery) =>
  qs({
    agent: query.agent?.join(','),
    role: query.role?.join(','),
    status: query.status?.join(','),
    itemId: query.itemId,
    before: query.before,
    limit: num(query.limit),
    cursor: query.cursor,
  });

/** Which part of a branch's work a change summary or diff is about; neither means all of it. */
export interface ChangeScope {
  commit?: string;
  uncommitted?: boolean;
}

export interface DiffOptions extends ChangeScope {
  context?: DiffContext;
}

const scopeQs = (scope: ChangeScope, extra: Record<string, string | undefined> = {}) =>
  qs({ ...extra, commit: scope.commit, uncommitted: scope.uncommitted ? '1' : undefined });
const diffQs = (path: string, opts: DiffOptions) =>
  scopeQs(opts, { path, context: opts.context === undefined ? undefined : String(opts.context) });

const scoped = (scope: Scope, variant?: ConfigFileVariant) =>
  qs({ project: scope.projectId, variant: scope.projectId ? variant : undefined });

export const api = {
  overview: (o: ReadOptions = {}) => request<Overview>('/overview', o),
  system: (o: ReadOptions = {}) => request<SystemInfo>('/system', o),
  auth: (o: ReadOptions = {}) => request<AuthStatus>('/auth', o),
  setCredentials: (credentials: SetCredentialsRequest) =>
    request<AuthStatus>('/auth/credentials', { method: 'PUT', body: credentials }),
  clearCredentials: () => request<AuthStatus>('/auth/credentials', { method: 'DELETE' }),
  cliVersion: (o: ReadOptions = {}) => request<CliVersionInfo>('/system/cli-version', o),
  checkCliVersion: () => request<CliVersionInfo>('/system/cli-version/check', { method: 'POST' }),
  release: (o: ReadOptions = {}) => request<AgentryReleaseInfo>('/system/release', o),
  checkRelease: () => request<AgentryReleaseInfo>('/system/release/check', { method: 'POST' }),
  verifyAuth: () => request<AuthVerification>('/auth/verify', { method: 'POST' }),
  projects: (o: ReadOptions = {}) => request<Project[]>('/projects', o),
  projectCandidates: (o: ReadOptions = {}) => request<ProjectCandidate[]>('/projects/candidates', o),
  importProject: (req: ImportProjectRequest) => request<Project>('/projects/import', { method: 'POST', body: req }),
  createProject: (req: CreateProjectRequest) => request<Project>('/projects', { method: 'POST', body: req }),
  renameProject: (id: string, name: string) => request<Project>(`/projects/${enc(id)}`, { method: 'PATCH', body: { name } }),
  /** Name, key prefix and modules; only the fields present change */
  updateProject: (id: string, req: UpdateProjectRequest) => request<Project>(`/projects/${enc(id)}`, { method: 'PATCH', body: req }),
  projectTemplates: (o: ReadOptions = {}) => request<ProjectTemplate[]>('/projects/templates', o),
  projectSettings: (id: string, o?: ReadOptions) => request<ProjectSettings>(`/projects/${enc(id)}/settings`, o),
  /** The whole document: read it, change it, write it back */
  putProjectSettings: (id: string, settings: ProjectSettings) =>
    request<ProjectSettings>(`/projects/${enc(id)}/settings`, { method: 'PUT', body: settings }),
  removeProject: (id: string) => request<{ ok: true }>(`/projects/${enc(id)}`, { method: 'DELETE' }),
  purgeProject: (id: string) => request<{ detail: string }>(`/projects/${enc(id)}/state`, { method: 'DELETE' }),
  chats: (filter: ChatFilter = {}, o?: ReadOptions) =>
    request<ChatSummary[]>(
      `/chats${qs({
        // `null` is the chats under no project, which the route asks for with `loose`
        project: filter.project ?? undefined,
        loose: filter.project === null ? '1' : undefined,
        origin: filter.origin?.join(','),
        workers: filter.workers === false ? '0' : undefined,
        state: filter.state,
        limit: num(filter.limit),
      })}`,
      o,
    ),
  chat: (id: string, sidechains: boolean, page: { limit?: number; before?: number } = {}, o?: ReadOptions) =>
    request<ChatDetail>(
      `/chats/${enc(id)}${qs({ sidechains: sidechains ? '1' : undefined, limit: num(page.limit), before: num(page.before) })}`,
      o,
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
  usage: (range: { from?: string; to?: string } = {}, o?: ReadOptions) => request<UsageReport>(`/usage${qs(range)}`, o),
  usageSeries: (range: UsageRange, bucket: UsageBucket, o?: ReadOptions) =>
    request<UsageSeries>(`/usage/series${qs({ from: range.from, to: range.to, bucket })}`, o),
  usageBreakdown: (range: UsageRange, o?: ReadOptions) => request<UsageBreakdown>(`/usage/breakdown${qs({ from: range.from, to: range.to })}`, o),
  /**
   * A link, not a fetch: the route answers with `Content-Disposition: attachment`, so the browser
   * saves it. A link carries no `Authorization` header, so a guarded wrapper takes the credential
   * from the query string here, as it does for the streams and an attachment.
   */
  chatExportUrl: (id: string, format: ExportFormat) => withToken(`${BASE}/chats/${enc(id)}/export?format=${format}`),
  projectExportUrl: (id: string, format: ExportFormat) => withToken(`${BASE}/projects/${enc(id)}/export?format=${format}`),
  schedules: (o: ReadOptions = {}) => request<Schedule[]>('/schedules', o),
  schedulePreview: (cron: string, timezone: string | undefined, count = 5) =>
    request<SchedulePreview>(`/schedules/preview${qs({ cron, timezone, count: String(count) })}`),
  createSchedule: (req: CreateScheduleRequest) => request<Schedule>('/schedules', { method: 'POST', body: req }),
  updateSchedule: (id: string, req: UpdateScheduleRequest) => request<Schedule>(`/schedules/${enc(id)}`, { method: 'PATCH', body: req }),
  deleteSchedule: (id: string) => request<{ ok: true }>(`/schedules/${enc(id)}`, { method: 'DELETE' }),
  setScheduleEnabled: (id: string, enabled: boolean) => request<Schedule>(`/schedules/${enc(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  runScheduleNow: (id: string) => request<ScheduleRun>(`/schedules/${enc(id)}/run`, { method: 'POST' }),
  scheduleRuns: (id: string, limit = 50, o?: ReadOptions) => request<ScheduleRun[]>(`/schedules/${enc(id)}/runs${qs({ limit: String(limit) })}`, o),
  environments: (cwd: string) => request<EffectiveEnvironment[]>(`/environments${qs({ cwd })}`),
  memoryProjects: (o: ReadOptions = {}) => request<MemoryProjectSummary[]>('/memory', o),
  memoryFiles: (projectId: string) => request<MemoryFile[]>(`/memory/${enc(projectId)}`),
  putMemoryFile: (projectId: string, name: string, content: string) =>
    request<MemoryFile>(`/memory/${enc(projectId)}/${enc(name)}`, { method: 'PUT', body: { content } }),
  deleteMemoryFile: (projectId: string, name: string) =>
    request<{ ok: true }>(`/memory/${enc(projectId)}/${enc(name)}`, { method: 'DELETE' }),
  tasks: (o: ReadOptions = {}) => request<ChatBackgroundTaskEntry[]>('/tasks', o),
  taskOutput: (chatId: string, taskId: string, offset?: number) =>
    request<BackgroundTaskOutput>(`/chats/${enc(chatId)}/tasks/${enc(taskId)}/output${qs({ offset: num(offset) })}`),
  subagent: (chatId: string, agentId: string, after?: number) =>
    request<AgentTranscript>(`/chats/${enc(chatId)}/subagents/${enc(agentId)}${qs({ after: num(after) })}`),
  workflowAgent: (chatId: string, workflowId: string, agentId: string, after?: number) =>
    request<AgentTranscript>(`/chats/${enc(chatId)}/workflows/${enc(workflowId)}/agents/${enc(agentId)}${qs({ after: num(after) })}`),
  subagents: (o: ReadOptions = {}) => request<ChatSubagentEntry[]>('/subagents', o),
  workflows: (o: ReadOptions = {}) => request<ChatWorkflowEntry[]>('/workflows', o),
  savedWorkflows: (cwd?: string) => request<WorkflowDefinition[]>(`/workflows/saved${qs({ cwd })}`),
  /** Starts a chat that runs a saved workflow */
  runWorkflow: (req: RunWorkflowRequest) => request<ChatSummary>('/workflows/saved/run', { method: 'POST', body: req }),
  orchestrations: (o: ReadOptions = {}) => request<OrchestrationSummary[]>('/orchestrations', o),
  orchestration: (id: string, o?: ReadOptions) => request<Orchestration>(`/orchestrations/${enc(id)}`, o),
  createOrchestration: (spec: OrchestrationSpec) =>
    request<Orchestration>('/orchestrations', { method: 'POST', body: spec }),
  planOrchestration: (req: PlanRequest) =>
    request<OrchestrationSpec>('/orchestrations/plan', { method: 'POST', body: req, timeoutMs: 10 * 60_000 }),
  startPlan: (req: PlanRequest) => request<ChatSummary>('/orchestrations/plan/start', { method: 'POST', body: req }),
  planDrafts: (o: ReadOptions = {}) => request<PlanDraftSummary[]>('/orchestrations/plans', o),
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
  orchestrationTemplates: (o: ReadOptions = {}) => request<OrchestrationTemplate[]>('/orchestrations/templates', o),
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
  taskChanges: (id: string, taskId: string, scope: ChangeScope = {}) =>
    request<ChangeSummary>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/changes${scopeQs(scope)}`),
  taskDiff: (id: string, taskId: string, path: string, opts: DiffOptions = {}) =>
    request<FileDiff>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/changes/diff${diffQs(path, opts)}`),
  taskSteps: (id: string, taskId: string) => request<EditStep[]>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/changes/steps`),
  taskChecklist: (id: string, taskId: string) => request<Checklist>(`/orchestrations/${enc(id)}/tasks/${enc(taskId)}/checklist`),
  integrationChanges: (id: string, scope: ChangeScope = {}) => request<ChangeSummary>(`/orchestrations/${enc(id)}/integration/changes${scopeQs(scope)}`),
  integrationDiff: (id: string, path: string, opts: DiffOptions = {}) =>
    request<FileDiff>(`/orchestrations/${enc(id)}/integration/changes/diff${diffQs(path, opts)}`),
  chatChanges: (id: string, scope: ChangeScope = {}) => request<ChatChanges>(`/chats/${enc(id)}/changes${scopeQs(scope)}`),
  chatDiff: (id: string, path: string, opts: DiffOptions = {}) => request<FileDiff>(`/chats/${enc(id)}/changes/diff${diffQs(path, opts)}`),
  chatSteps: (id: string) => request<EditStep[]>(`/chats/${enc(id)}/changes/steps`),
  chatChecklist: (id: string) => request<Checklist>(`/chats/${enc(id)}/checklist`),
  hintChat: (id: string, req: HintRequest) => request<ChatSummary>(`/chats/${enc(id)}/hint`, { method: 'POST', body: req }),
  // A task's proposal goes through its task's routes, so the hint reaches it the way a task's hint does
  settleSupervisorProposal: (proposal: SupervisorProposal, action: 'send' | 'dismiss') =>
    request<SupervisorProposal>(
      proposal.orchestrationId && proposal.taskId
        ? `/orchestrations/${enc(proposal.orchestrationId)}/tasks/${enc(proposal.taskId)}/supervisor/${enc(proposal.id)}/${action}`
        : `/chats/${enc(proposal.chatId)}/supervisor/${enc(proposal.id)}/${action}`,
      { method: 'POST' },
    ),
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
  toolPresets: (o: ReadOptions = {}) => request<ToolPresetsOverview>('/config/tool-presets', o),
  setDefaultToolPreset: (defaultPresetId: string | null) =>
    request<ToolPresetsConfig>('/config/tool-presets/default', { method: 'PUT', body: { defaultPresetId } }),
  restoreToolPresets: () => request<ToolPresetsOverview>('/config/tool-presets/restore', { method: 'POST' }),
  putToolPreset: (id: string, preset: Pick<ToolPreset, 'name' | 'description' | 'allowedTools' | 'disallowedTools'>) =>
    request<ToolPreset>(`/config/tool-presets/${enc(id)}`, { method: 'PUT', body: preset }),
  deleteToolPreset: (id: string) => request<{ ok: true }>(`/config/tool-presets/${enc(id)}`, { method: 'DELETE' }),
  supervisorConfig: (o: ReadOptions = {}) => request<SupervisorConfig>('/settings/supervisor', o),
  putSupervisorConfig: (config: UpdateSupervisorConfigRequest) => request<SupervisorConfig>('/settings/supervisor', { method: 'PUT', body: config }),
  decisionSettings: (o: ReadOptions = {}) => request<DecisionSettings>('/decisions/settings', o),
  putDecisionSettings: (settings: DecisionSettingsUpdate) => request<DecisionSettings>('/decisions/settings', { method: 'PUT', body: settings }),
  decisionPoints: (o: ReadOptions = {}) => request<DecisionPointInfo[]>('/decisions/points', o),
  putDecisionKey: (key: string) => request<DecisionCredentialsResult>('/decisions/credentials', { method: 'PUT', body: { key } }),
  deleteDecisionKey: () => request<DecisionCredentialsResult>('/decisions/credentials', { method: 'DELETE' }),
  testDecisionProvider: (provider: DecisionProviderId) => request<DecisionTestResult>('/decisions/test', { method: 'POST', body: { provider } }),
  decisions: (query: DecisionPageQuery = {}, o: ReadOptions = {}) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(name, String(value));
    const qs = params.toString();
    return request<DecisionPage>(`/decisions${qs ? `?${qs}` : ''}`, o);
  },
  decisionPreview: (point: DecisionPointId, o: ReadOptions = {}) => request<DecisionPreview>(`/decisions/points/${enc(point)}/preview`, o),
  putDecisionConsent: (point: DecisionPointId, consent: DecisionConsentRequest) =>
    request<DecisionSettings>(`/decisions/points/${enc(point)}/consent`, { method: 'PUT', body: consent }),
  decisionStats: (days: number, o: ReadOptions = {}) => request<DecisionStats>(`/decisions/stats?days=${days}`, o),
  decisionStatsSince: (since: string, o: ReadOptions = {}) => request<DecisionStats>(`/decisions/stats?since=${encodeURIComponent(since)}`, o),
  decision: (id: string, o: ReadOptions = {}) => request<DecisionRecord>(`/decisions/${enc(id)}`, o),
  decisionPalette: (query: string, commands: DecisionPaletteRequest['commands'], o: ReadOptions = {}) =>
    request<DecisionPaletteResult>('/decisions/palette', { method: 'POST', body: { query, commands }, ...o }),
  decisionFeedback: (id: string, feedback: DecisionFeedback) => request<DecisionRecord>(`/decisions/${enc(id)}/feedback`, { method: 'POST', body: { feedback } }),
  decisionPaletteAction: (id: string, commandId: string | null) =>
    request<DecisionRecord>(`/decisions/${enc(id)}/palette-action`, { method: 'POST', body: { commandId } }),
  decisionNotificationOpened: (key: string) => request<DecisionNotificationOpenedResult>('/decisions/notification-opened', { method: 'POST', body: { key } }),
  deleteDecision: (id: string) => request<{ ok: true }>(`/decisions/${enc(id)}`, { method: 'DELETE' }),
  clearDecisions: (filter: DecisionFilter = {}) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(name, String(value));
    const qs = params.toString();
    return request<DecisionClearResult>(`/decisions${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  },
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
  fileRoots: (o: ReadOptions = {}) => request<ConfigFileRoot[]>('/config/files/roots', o),
  fileTree: (root: string) => request<ConfigFileNode[]>(`/config/files/tree${qs({ root })}`),
  fileContent: (root: string, path: string) =>
    request<ConfigFileContent>(`/config/files/content${qs({ root, path })}`),
  putFile: (req: WriteConfigFileRequest) =>
    request<ConfigFileContent>('/config/files/content', { method: 'PUT', body: req }),
  deleteFile: (root: string, path: string) =>
    request<{ ok: true }>(`/config/files/content${qs({ root, path })}`, { method: 'DELETE' }),
  accounts: (refresh = false, o?: ReadOptions) =>
    request<AccountsOverview>(`/accounts${qs({ refresh: refresh ? '1' : '' })}`, o).then((overview) => ({ ...overview, cswap: normalizeCswap(overview.cswap) })),
  switchAccount: (body: SwitchAccountRequest) => request<SwitchResult>('/accounts/switch', { method: 'POST', body }),
  addAccount: (body: AddAccountTokenRequest) => request<AccountsOverview>('/accounts/token', { method: 'POST', body }),
  removeAccount: (number: number) => request<{ ok: true }>(`/accounts/${number}`, { method: 'DELETE' }),
  /** Starts Agentry's own install of claude-swap; it goes on in the background and `accounts()` follows it */
  installCswap: () => request<CswapInfo>('/accounts/cswap/install', { method: 'POST' }).then(normalizeCswap),
  /** Removes the copy of claude-swap Agentry installed; the accounts are kept */
  removeCswap: () => request<CswapInfo>('/accounts/cswap', { method: 'DELETE' }).then(normalizeCswap),
  accountEvents: (limit = 500, o?: ReadOptions) => request<AutoSwitchEvent[]>(`/accounts/events${qs({ limit: String(limit) })}`, o),
  setAccountEnabled: (number: number, enabled: boolean) =>
    request<{ ok: true }>(`/accounts/${number}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  setAccountAlias: (number: number, alias: string | null) =>
    request<{ ok: true }>(`/accounts/${number}/alias`, { method: 'PUT', body: { alias } }),
  setAutoSwitch: (body: Partial<AutoSwitchSettings>) =>
    request<AutoSwitchSettings>('/accounts/autoswitch', { method: 'PUT', body }),
  securityAuth: (o: ReadOptions = {}) => request<AuthConfig>('/security/auth', o),
  updateSecurityAuth: (body: UpdateAuthConfigRequest) => request<AuthConfig>('/security/auth', { method: 'PUT', body }),
  /** The only answer that ever carries the token; it cannot be read back afterwards. */
  setSecurityToken: (body: SetAuthTokenRequest = {}) => request<AuthTokenResult>('/security/token', { method: 'POST', body }),
  clearSecurityToken: () => request<AuthConfig>('/security/token', { method: 'DELETE' }),
  /** The settings that change at runtime; a key the environment set is refused, so send only what changed */
  appSettings: (o: ReadOptions = {}) => request<AppSettings>('/settings/app', o),
  updateAppSettings: (body: UpdateAppSettingsRequest) => request<AppSettings>('/settings/app', { method: 'PUT', body }),
  tunnel: (o: ReadOptions = {}) => request<TunnelStatus>('/tunnel', o),
  updateTunnelSettings: (body: UpdateTunnelSettingsRequest) => request<TunnelStatus>('/tunnel/settings', { method: 'PUT', body }),
  startTunnel: () => request<TunnelStatus>('/tunnel/start', { method: 'POST' }),
  stopTunnel: () => request<TunnelStatus>('/tunnel/stop', { method: 'POST' }),
  audit: (page: AuditFilter & { limit?: number; from?: number } = {}) =>
    request<AuditPage>(`/audit${qs({ limit: num(page.limit), from: num(page.from), path: page.path, method: page.method, status: page.status })}`),
  setAccountConfig: (number: number, body: UpdateAccountConfigRequest) =>
    request<AccountConfig>(`/accounts/${number}/config`, { method: 'PUT', body }),
  accountPolicies: (o: ReadOptions = {}) => request<RotationPolicy[]>('/accounts/policies', o),
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
  plugins: (o: ReadOptions = {}) => request<PluginsOverview>('/plugins', o),
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
  // ---- work items (docs/work-items.md). `projectId` null is every project: the All projects view
  workItems: (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, o?: ReadOptions) =>
    request<WorkItem[]>(`${workItemsOf(projectId)}${workItemQuery(filter)}`, o),
  /** Descriptions left out (`hasDescription`); the Done column holds its newest `doneLimit` items, and `more` counts the rest */
  workItemBoard: (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, o: ReadOptions & BoardQuery = {}) => {
    const { doneLimit, ...read } = o;
    const done = doneLimit === undefined ? '' : `doneLimit=${doneLimit}`;
    const query = workItemQuery(filter);
    return request<Board>(`${workItemsOf(projectId)}/board${done ? `${query}${query ? '&' : '?'}${done}` : query}`, read);
  },
  /** A page of the list, descriptions left out; `nextCursor` is the next page's `cursor` */
  workItemPage: (projectId: string | null, query: WorkItemPageQuery = {}, o?: ReadOptions) =>
    request<WorkItemPage>(`${workItemsOf(projectId)}/page${workItemPageQuery(query)}`, o),
  workItemByKey,
  workItem: (itemId: string, o?: ReadOptions) => request<WorkItemDetail>(`/work-items/${enc(itemId)}`, o),
  /** Every flow run of the item, newest first, failed ones included */
  workItemRuns: (itemId: string, o?: ReadOptions) => request<FlowRun[]>(`/work-items/${enc(itemId)}/runs`, o),
  triageWorkItem: (projectId: string, draft: TriageWorkItemRequest, o: ReadOptions = {}) =>
    request<TriageWorkItemResult>(`/projects/${enc(projectId)}/work-items/triage`, { method: 'POST', body: draft, ...o }),
  createWorkItem: (projectId: string, req: CreateWorkItemRequest) =>
    request<WorkItem>(`/projects/${enc(projectId)}/work-items`, { method: 'POST', body: req }),
  updateWorkItem: (itemId: string, req: UpdateWorkItemRequest) => request<WorkItem>(`/work-items/${enc(itemId)}`, { method: 'PATCH', body: req }),
  deleteWorkItem: (itemId: string) => request<{ ok: true }>(`/work-items/${enc(itemId)}`, { method: 'DELETE' }),
  /** `afterId` names the neighbour it lands after: null puts it first in the column, absent last */
  moveWorkItem: (itemId: string, req: MoveWorkItemRequest) =>
    request<MoveWorkItemResult>(`/work-items/${enc(itemId)}/move`, { method: 'POST', body: req }),
  /** Approve: commit, update, push and open the item's pull request; 202 while it is prepared, 200 when one is open already */
  openPullRequest: (itemId: string) => request<WorkItemPullRequestResult>(`/work-items/${enc(itemId)}/pull-request`, { method: 'POST', body: {} }),
  /** Ask gh about the item's open pull request now, rather than at the watcher's next pass */
  refreshPullRequest: (itemId: string) => request<WorkItem>(`/work-items/${enc(itemId)}/pull-request/refresh`, { method: 'POST', body: {} }),
  /** The neutral change request of either table; `id` is the pull request row's, not the item's */
  changeRequest: (id: string, o?: ReadOptions) => request<ChangeRequest>(`/change-requests/${enc(id)}`, o),
  /** `refresh` skips the 30 s cache by head, for the person's own "check again" */
  changeRequestChecks: (id: string, refresh = false, o?: ReadOptions) =>
    request<ChangeRequestChecks>(`/change-requests/${enc(id)}/checks${refresh ? '?refresh=1' : ''}`, o),
  checkLog: (id: string, checkId: string, o?: ReadOptions) =>
    request<CheckLog>(`/change-requests/${enc(id)}/checks/${enc(checkId)}/log`, o),
  rerunChecks: (id: string, req: ChecksRerunRequest) =>
    request<ChangeRequestChecks>(`/change-requests/${enc(id)}/checks/rerun`, { method: 'POST', body: req }),
  cancelChecks: (id: string) => request<ChangeRequestChecks>(`/change-requests/${enc(id)}/checks/cancel`, { method: 'POST', body: {} }),
  /** Play a GitLab manual job */
  runCheck: (id: string, checkId: string) =>
    request<ChangeRequestChecks>(`/change-requests/${enc(id)}/checks/${enc(checkId)}/run`, { method: 'POST', body: {} }),
  /** Fix failing checks; `started` false means the project's flow is off and `prompt` is for a chat of the person's own */
  fixChecks: (id: string) => request<ChangeRequestFixResult>(`/change-requests/${enc(id)}/checks/fix`, { method: 'POST', body: {} }),
  pushFix: (id: string) =>
    request<WorkItemPullRequest | OrchestrationPullRequest | null>(`/change-requests/${enc(id)}/push-fix`, { method: 'POST', body: {} }),
  /** The review threads of the head commit; `refresh` skips the cache by head */
  changeRequestThreads: (id: string, refresh = false, o?: ReadOptions) =>
    request<ChangeRequestThreads>(`/change-requests/${enc(id)}/threads${refresh ? '?refresh=1' : ''}`, o),
  reviewDrafts: (id: string, o?: ReadOptions) => request<ReviewDraft[]>(`/change-requests/${enc(id)}/review-drafts`, o),
  addReviewDraft: (id: string, req: ReviewDraftInput) =>
    request<ReviewDraft>(`/change-requests/${enc(id)}/review-drafts`, { method: 'POST', body: req }),
  updateReviewDraft: (id: string, draftId: string, req: ReviewDraftInput) =>
    request<ReviewDraft>(`/change-requests/${enc(id)}/review-drafts/${enc(draftId)}`, { method: 'PUT', body: req }),
  deleteReviewDraft: (id: string, draftId: string) =>
    request<{ ok: true }>(`/change-requests/${enc(id)}/review-drafts/${enc(draftId)}`, { method: 'DELETE' }),
  /** Post the drafts as one review */
  submitReview: (id: string, req: ReviewSubmitRequest) =>
    request<ReviewPost>(`/change-requests/${enc(id)}/reviews`, { method: 'POST', body: req }),
  /** The attempts to post a review, newest first: a review that stopped half way is known after a reload */
  reviewPosts: (id: string, o?: ReadOptions) => request<ChangeRequestReviewPosts>(`/change-requests/${enc(id)}/review-posts`, o),
  /** GitLab, after a partly-posted review: publish the notes that were saved, or drop them */
  publishSavedReview: (id: string, postId: string) =>
    request<ReviewPost>(`/change-requests/${enc(id)}/reviews/${enc(postId)}/publish-saved`, { method: 'POST', body: {} }),
  discardSavedReview: (id: string, postId: string) =>
    request<ReviewPost>(`/change-requests/${enc(id)}/reviews/${enc(postId)}/discard-saved`, { method: 'POST', body: {} }),
  replyToThread: (id: string, threadId: string, body: string) =>
    request<ReviewThread>(`/change-requests/${enc(id)}/threads/${enc(threadId)}/reply`, { method: 'POST', body: { body } }),
  resolveThread: (id: string, threadId: string, resolved: boolean) =>
    request<ReviewThread>(`/change-requests/${enc(id)}/threads/${enc(threadId)}/${resolved ? 'resolve' : 'unresolve'}`, { method: 'POST', body: {} }),
  changeRequestApproval: (id: string, o?: ReadOptions) => request<ApprovalState>(`/change-requests/${enc(id)}/approval`, o),
  /** GitLab: `sha` is the head the person looked at */
  approveChangeRequest: (id: string, sha: string) =>
    request<ApprovalState>(`/change-requests/${enc(id)}/approval`, { method: 'POST', body: { sha } }),
  revokeApproval: (id: string) => request<ApprovalState>(`/change-requests/${enc(id)}/approval`, { method: 'DELETE' }),
  changeRequestReviewers: (id: string, o?: ReadOptions) => request<ChangeRequestReviewers>(`/change-requests/${enc(id)}/reviewers`, o),
  requestReviewers: (id: string, req: ReviewersRequest) =>
    request<ChangeRequestReviewers>(`/change-requests/${enc(id)}/reviewers`, { method: 'POST', body: req }),
  /** Hand threads to the item's agent; the answer is Fix failing checks'. No `threadIds` means every unresolved one */
  addressReview: (id: string, req: AddressReviewRequest) =>
    request<ChangeRequestFixResult>(`/change-requests/${enc(id)}/address`, { method: 'POST', body: req }),
  checkCriterion: (itemId: string, criterionId: string, checked: boolean) =>
    request<WorkItem>(`/work-items/${enc(itemId)}/criteria/${enc(criterionId)}`, { method: 'PATCH', body: { checked } }),
  workItemComments: (itemId: string, o?: ReadOptions) => request<WorkItemComment[]>(`/work-items/${enc(itemId)}/comments`, o),
  addWorkItemComment: (itemId: string, req: CreateWorkItemCommentRequest) =>
    request<WorkItemComment>(`/work-items/${enc(itemId)}/comments`, { method: 'POST', body: req }),
  addWorkItemRelation: (itemId: string, req: CreateWorkItemRelationRequest) =>
    request<WorkItem>(`/work-items/${enc(itemId)}/relations`, { method: 'POST', body: req }),
  removeWorkItemRelation: (itemId: string, otherId: string) =>
    request<WorkItem>(`/work-items/${enc(itemId)}/relations/${enc(otherId)}`, { method: 'DELETE' }),
  workItemLinks: (itemId: string, o?: ReadOptions) => request<WorkItemLink[]>(`/work-items/${enc(itemId)}/links`, o),
  addWorkItemLink: (itemId: string, req: CreateWorkItemLinkRequest) =>
    request<WorkItemLink>(`/work-items/${enc(itemId)}/links`, { method: 'POST', body: req }),
  removeWorkItemLink: (itemId: string, linkId: string) =>
    request<{ ok: true }>(`/work-items/${enc(itemId)}/links/${enc(linkId)}`, { method: 'DELETE' }),
  workItemHistory: (itemId: string, o?: ReadOptions) => request<WorkItemHistoryEntry[]>(`/work-items/${enc(itemId)}/history`, o),
  /** "Work on it": a chat in the item's own worktree, prompted with the item; the page opens `chat.id` */
  workOnWorkItem: (itemId: string, req: WorkOnWorkItemRequest = {}) =>
    request<WorkOnWorkItemResult>(`/work-items/${enc(itemId)}/work`, { method: 'POST', body: req }),
  workItemChanges: (itemId: string, scope: ChangeScope = {}, o?: ReadOptions) => request<WorkItemChanges>(`/work-items/${enc(itemId)}/changes${scopeQs(scope)}`, o),
  workItemDiff: (itemId: string, path: string, opts: DiffOptions = {}) => request<FileDiff>(`/work-items/${enc(itemId)}/changes/diff${diffQs(path, opts)}`),
  /** A draft for the orchestration editor to review, not a launched graph: `createOrchestration` launches it */
  orchestrateWorkItems: (projectId: string, req: OrchestrateWorkItemsRequest) =>
    request<WorkItemOrchestrationDraft>(`/projects/${enc(projectId)}/work-items/orchestrate`, { method: 'POST', body: req }),
  /** "Create a task from this message": in Backlog, linked to the chat */
  workItemFromMessage: (chatId: string, req: CreateWorkItemFromMessageRequest) =>
    request<WorkItem>(`/chats/${enc(chatId)}/work-items`, { method: 'POST', body: req }),
  /** The items a chat is linked to, whatever part it played */
  chatWorkItems: (chatId: string, o?: ReadOptions) => request<WorkItem[]>(`/chats/${enc(chatId)}/work-items`, o),
  milestones: (projectId: string, o?: ReadOptions) => request<Milestone[]>(`/projects/${enc(projectId)}/milestones`, o),
  milestone: (milestoneId: string, o?: ReadOptions) => request<Milestone>(`/milestones/${enc(milestoneId)}`, o),
  createMilestone: (projectId: string, req: CreateMilestoneRequest) =>
    request<Milestone>(`/projects/${enc(projectId)}/milestones`, { method: 'POST', body: req }),
  updateMilestone: (milestoneId: string, req: UpdateMilestoneRequest) =>
    request<Milestone>(`/milestones/${enc(milestoneId)}`, { method: 'PATCH', body: req }),
  deleteMilestone: (milestoneId: string) => request<{ ok: true }>(`/milestones/${enc(milestoneId)}`, { method: 'DELETE' }),
  // ---- team, flow, journal, memory proposals and documents (docs/plans/project-ecosystem.md, orchestration 3)
  team: (projectId: string, o?: ReadOptions) => request<Team>(`/projects/${enc(projectId)}/team`, o),
  teamFromTemplate: (projectId: string, req: TeamFromTemplateRequest = {}) =>
    request<Team>(`/projects/${enc(projectId)}/team/from-template`, { method: 'POST', body: req }),
  /** The member's metadata; its agent file is a resource: `putResource({ projectId }, 'agents', agent, …)` */
  putTeamMember: (projectId: string, agent: string, req: PutTeamMemberRequest) =>
    request<TeamMember>(`/projects/${enc(projectId)}/team/${enc(agent)}`, { method: 'PUT', body: req }),
  /** Takes the member off the team; its agent file stays */
  removeTeamMember: (projectId: string, agent: string) =>
    request<{ ok: true }>(`/projects/${enc(projectId)}/team/${enc(agent)}`, { method: 'DELETE' }),
  flow: (projectId: string, o?: ReadOptions) => request<ProjectFlow>(`/projects/${enc(projectId)}/flow`, o),
  /** Every flow run of the project, newest first, a page at a time: the team's activity */
  flowRuns: (projectId: string, query: FlowRunQuery = {}, o?: ReadOptions) =>
    request<FlowRunPage>(`/projects/${enc(projectId)}/flow/runs${flowRunQuery(query)}`, o),
  /**
   * Queues a failed run's step again, as the person (409 once the item left the run's column, or the
   * step ran again). The new run comes back; `flow.run` refreshes the lists that show either.
   */
  retryFlowRun: (runId: string) => request<FlowRun>(`/flow-runs/${enc(runId)}/retry`, { method: 'POST' }),
  /** The cards switching the flow on left waiting, per column; `total: 0` while the flow is off */
  flowWaiting: (projectId: string, o?: ReadOptions) => request<FlowWaiting>(`/projects/${enc(projectId)}/flow/waiting`, o),
  /** Queues one run per waiting card, as the person (409 once the flow is off); `flow.run` refreshes the lists */
  startWaitingFlowRuns: (projectId: string) => request<FlowStartWaitingResult>(`/projects/${enc(projectId)}/flow/start-waiting`, { method: 'POST' }),
  journal: (projectId: string, page: JournalQuery = {}, o?: ReadOptions) =>
    request<JournalPage>(`/projects/${enc(projectId)}/journal${qs({ limit: num(page.limit), before: page.before })}`, o),
  addJournalEntry: (projectId: string, req: CreateJournalEntryRequest) =>
    request<JournalEntry>(`/projects/${enc(projectId)}/journal`, { method: 'POST', body: req }),
  removeJournalEntry: (entryId: string) => request<{ ok: true }>(`/journal/${enc(entryId)}`, { method: 'DELETE' }),
  /** Every status when `status` is left out */
  memoryProposals: (projectId: string, status?: MemoryProposalStatus, o?: ReadOptions) =>
    request<MemoryProposal[]>(`/projects/${enc(projectId)}/memory/proposals${qs({ status })}`, o),
  approveMemoryProposal: (proposalId: string, req: ApproveMemoryProposalRequest = {}) =>
    request<MemoryProposal>(`/memory-proposals/${enc(proposalId)}/approve`, { method: 'POST', body: req }),
  rejectMemoryProposal: (proposalId: string, req: RejectMemoryProposalRequest = {}) =>
    request<MemoryProposal>(`/memory-proposals/${enc(proposalId)}/reject`, { method: 'POST', body: req }),
  documents: (projectId: string, o?: ReadOptions) => request<ProjectDocuments>(`/projects/${enc(projectId)}/documents`, o),
  /** `path` is relative to the project, as the tree gives it */
  documentFile: (projectId: string, path: string, o?: ReadOptions) =>
    request<DocumentFile>(`/projects/${enc(projectId)}/documents/file${qs({ path })}`, o),
  writeDocument: (projectId: string, path: string, req: WriteDocumentRequest) =>
    request<DocumentFile>(`/projects/${enc(projectId)}/documents/file${qs({ path })}`, { method: 'PUT', body: req }),
  deleteDocument: (projectId: string, path: string) =>
    request<{ ok: true }>(`/projects/${enc(projectId)}/documents/file${qs({ path })}`, { method: 'DELETE' }),
  tieDocument: (itemId: string, req: TieDocumentRequest) =>
    request<WorkItemLink>(`/work-items/${enc(itemId)}/documents`, { method: 'POST', body: req }),
  // ---- the project assistant (docs/plans/project-ecosystem.md, orchestration 4)
  /** Refused with 409 while a run of the same kind runs in the project */
  startAssistantRun: (projectId: string, req: StartAssistantRunRequest) =>
    request<AssistantRunDetail>(`/projects/${enc(projectId)}/assistant/runs`, { method: 'POST', body: req }),
  /** Latest first; every kind when `kind` is left out */
  assistantRuns: (projectId: string, kind?: AssistantRunKind, o?: ReadOptions) =>
    request<AssistantRun[]>(`/projects/${enc(projectId)}/assistant/runs${qs({ kind })}`, o),
  assistantRun: (runId: string, o?: ReadOptions) => request<AssistantRunDetail>(`/assistant/runs/${enc(runId)}`, o),
  stopAssistantRun: (runId: string) => request<AssistantRunDetail>(`/assistant/runs/${enc(runId)}/stop`, { method: 'POST' }),
  /** For a resource, this is the editor's save: pass what the person left in `resource` */
  acceptAssistantProposal: (proposalId: string, req: AcceptAssistantProposalRequest = {}) =>
    request<AssistantProposal>(`/assistant/proposals/${enc(proposalId)}/accept`, { method: 'POST', body: req }),
  discardAssistantProposal: (proposalId: string) =>
    request<AssistantProposal>(`/assistant/proposals/${enc(proposalId)}/discard`, { method: 'POST' }),
  restoreAssistantProposal: (proposalId: string) =>
    request<AssistantProposal>(`/assistant/proposals/${enc(proposalId)}/restore`, { method: 'POST' }),
  /** The VAPID public key to subscribe against; the server makes its keypair when this is first asked */
  pushKey: () => request<PushKeyInfo>('/push/key'),
  pushSubscriptions: () => request<PushSubscriptionSummary[]>('/push/subscriptions'),
  registerPush: (body: RegisterPushSubscriptionRequest) => request<PushSubscriptionSummary>('/push/subscriptions', { method: 'POST', body }),
  removePush: (body: RemovePushSubscriptionRequest) => request<{ removed: boolean }>('/push/subscriptions', { method: 'DELETE', body }),
  /** No body at all means every registered install; `{ id }` the one row a person aimed at */
  testPush: (body: SendTestPushRequest = {}) => request<PushSendResult>('/push/test', { method: 'POST', body }),
  providers: (o: ReadOptions = {}) => request<ProviderStatus[]>('/providers', o),
  provider: (id: string, o: ReadOptions = {}) => request<ProviderStatus>(`/providers/${enc(id)}`, o),
  /** What the provider's driver offers for the model picker */
  providerModels: (id: string, o: ReadOptions = {}) => request<ModelOption[]>(`/providers/${enc(id)}/models`, o),
  /** Skips the detector's cache; the answer is the fresh statuses */
  refreshProviders: () => request<ProviderStatus[]>('/providers/refresh', { method: 'POST' }),
  providerSettings: (o: ReadOptions = {}) => request<ProvidersSettings>('/providers/settings', o),
  putProviderSettings: (settings: ProvidersSettings) => request<ProvidersSettings>('/providers/settings', { method: 'PUT', body: settings }),
  hosts: (o: ReadOptions = {}) => request<CodeHostStatus[]>('/hosts', o),
  host: (id: string, o: ReadOptions = {}) => request<CodeHostStatus>(`/hosts/${enc(id)}`, o),
  /** Skips the detector's cache; the answer is the fresh statuses */
  refreshHosts: () => request<CodeHostStatus[]>('/hosts/refresh', { method: 'POST' }),
  hostSettings: (o: ReadOptions = {}) => request<CodeHostsSettings>('/hosts/settings', o),
  putHostSettings: (settings: CodeHostsSettings) => request<CodeHostsSettings>('/hosts/settings', { method: 'PUT', body: settings }),
  /** Whether the project's origin can open pull or merge requests, and the remote as parsed */
  projectCodeHost: (id: string, o: ReadOptions = {}) => request<ProjectCodeHost>(`/projects/${enc(id)}/code-host`, o),
};

// A drift between the chat package's client and the real one fails the build here, not at a call
void (api satisfies Omit<ChatClient, 'streamUrl' | 'contentUrl'>);

// ---------- Query hooks ----------

export const keys = {
  // The chat package's keys, with the prefixes the event feed invalidates: every list and every open chat sits under them
  ...chatKeys,
  overview: ['overview'] as const,
  auth: ['auth'] as const,
  cliVersion: ['cli-version'] as const,
  release: ['release'] as const,
  providers: ['providers'] as const,
  providerSettings: ['providers', 'settings'] as const,
  providerModels: (id: string) => ['providers', id, 'models'] as const,
  hosts: ['hosts'] as const,
  hostSettings: ['hosts', 'settings'] as const,
  projectCodeHost: (id: string) => ['project-code-host', id] as const,
  projects: ['projects'] as const,
  projectCandidates: ['projects', 'candidates'] as const,
  chatList: (filter: ChatFilter) =>
    ['chats', filter.project === undefined ? 'all' : (filter.project ?? 'loose'), filter.origin?.join(',') ?? '', filter.state ?? '', filter.limit ?? 0, filter.workers === false ? 'no-workers' : ''] as const,
  // A chat's changes sit under its scope: `changes.updated` never names a chat, but its own events
  // (and the panel's timer while it works) refresh everything there
  chatChanges: (id: string, scope: ChangeScope = {}) => ['chat', id, 'changes', scope.commit ?? '', scope.uncommitted ? 'uncommitted' : ''] as const,
  /**
   * The review screen caches the summary alone, while the chat's panel caches the whole response:
   * one key for both served the panel's object to the review, which read `files` from it and threw.
   */
  chatChangesReview: (id: string, scope: ChangeScope = {}) => ['chat', id, 'changes', scope.commit ?? '', scope.uncommitted ? 'uncommitted' : '', 'review'] as const,
  chatDiff: (id: string, path: string, opts: DiffOptions = {}) =>
    ['chat', id, 'changes', 'diff', path, String(opts.context ?? ''), opts.commit ?? '', opts.uncommitted ? 'uncommitted' : ''] as const,
  chatSteps: (id: string) => ['chat', id, 'changes', 'steps'] as const,
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
  savedWorkflowsAll: ['workflows', 'saved'] as const,
  savedWorkflows: (cwd: string) => ['workflows', 'saved', cwd] as const,
  orchestrations: ['orchestrations'] as const,
  planDrafts: ['orchestrations', 'plans'] as const,
  orchestration: (id: string) => ['orchestration', id] as const,
  /** Prefix of a change request's reads (itself, its checks, their logs): `change-request.checks` refreshes them all */
  changeRequest: (id: string) => ['change-request', id] as const,
  changeRequestChecks: (id: string) => ['change-request', id, 'checks'] as const,
  // The review's reads sit under the request too: `change-request.review` refreshes them all
  changeRequestThreads: (id: string) => ['change-request', id, 'threads'] as const,
  reviewDrafts: (id: string) => ['change-request', id, 'review-drafts'] as const,
  reviewPosts: (id: string) => ['change-request', id, 'review-posts'] as const,
  changeRequestReviewers: (id: string) => ['change-request', id, 'reviewers'] as const,
  changeRequestApproval: (id: string) => ['change-request', id, 'approval'] as const,
  /**
   * A check keeps its id when its state moves (a job that finishes, a failed run that passes on a
   * re-read), and its log moves with it: the state is part of the key so the tail is read again
   */
  checkLog: (id: string, checkId: string, state?: CheckState) =>
    ['change-request', id, 'checks', checkId, 'log', ...(state ? [state] : [])] as const,
  // A task's and the integration branch's changes sit under the graph, which `changes.updated` refreshes
  taskChanges: (id: string, taskId: string, scope: ChangeScope = {}) =>
    ['orchestration', id, 'changes', 'task', taskId, scope.commit ?? '', scope.uncommitted ? 'uncommitted' : ''] as const,
  taskDiff: (id: string, taskId: string, path: string, opts: DiffOptions = {}) =>
    ['orchestration', id, 'changes', 'task', taskId, 'diff', path, String(opts.context ?? ''), opts.commit ?? '', opts.uncommitted ? 'uncommitted' : ''] as const,
  taskSteps: (id: string, taskId: string) => ['orchestration', id, 'changes', 'task', taskId, 'steps'] as const,
  integrationChanges: (id: string, scope: ChangeScope = {}) =>
    ['orchestration', id, 'changes', 'integration', scope.commit ?? '', scope.uncommitted ? 'uncommitted' : ''] as const,
  integrationDiff: (id: string, path: string, opts: DiffOptions = {}) =>
    ['orchestration', id, 'changes', 'integration', 'diff', path, String(opts.context ?? ''), opts.commit ?? '', opts.uncommitted ? 'uncommitted' : ''] as const,
  settings: (scope: Scope, variant: ConfigFileVariant) =>
    ['config', 'settings', scope.projectId ?? 'user', variant] as const,
  instructions: (scope: Scope, variant: ConfigFileVariant) =>
    ['config', 'instructions', scope.projectId ?? 'user', variant] as const,
  mcp: (scope: Scope) => ['config', 'mcp', scope.projectId ?? 'user'] as const,
  toolPresets: ['config', 'tool-presets'] as const,
  supervisor: ['settings', 'supervisor'] as const,
  decisionSettings: ['decisions', 'settings'] as const,
  decisionPoints: ['decisions', 'points'] as const,
  decision: (id: string) => ['decisions', 'one', id] as const,
  decisionsRecent: (query: DecisionPageQuery) => ['decisions', 'recent', query] as const,
  decisionStats: (days: number) => ['decisions', 'stats', days] as const,
  decisionStatsSince: (since: string) => ['decisions', 'stats', 'since', since] as const,
  decisionPreview: (point: DecisionPointId) => ['decisions', 'preview', point] as const,
  decisionHistory: (filter: DecisionFilter) => ['decisions', 'history', filter] as const,
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
  audit: (page: AuditFilter & { from?: number }) =>
    ['security', 'audit', page.from ?? 0, page.path ?? '', page.method ?? '', page.status ?? ''] as const,
  // ---- the project ecosystem. Every work item read sits under `workItems` or `workItemDetails`, and
  // milestones under `milestonesAll`, so the event feed (lib/events.ts) reaches exactly the ones an
  // event touches by prefix.
  projectTemplates: ['project-templates'] as const,
  // Not under `projects`: the run events refresh that prefix all the time, and a settings form must
  // not be read back from under the person editing it
  projectSettings: (projectId: string) => ['project-settings', projectId] as const,
  workItems: ['work-items'] as const,
  /** Every board of a project whatever its filter, or of All projects for `null` */
  workItemBoards: (projectId: string | null) => ['work-items', 'board', projectId ?? 'all'] as const,
  /** The unpaged board keeps its key, which the sidebar's count shares; "and N more" adds the Done column's limit */
  workItemBoard: (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, doneLimit?: number) =>
    doneLimit === undefined
      ? (['work-items', 'board', projectId ?? 'all', filterKey(filter)] as const)
      : (['work-items', 'board', projectId ?? 'all', filterKey(filter), doneLimit] as const),
  /** Every list of a project whatever its filter, or of All projects for `null` */
  workItemLists: (projectId: string | null) => ['work-items', 'list', projectId ?? 'all'] as const,
  workItemList: (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}) =>
    ['work-items', 'list', projectId ?? 'all', filterKey(filter)] as const,
  /** Under the lists, so what refreshes a list refreshes its pages; every page loaded is read again */
  workItemPages: (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, limit?: number) =>
    ['work-items', 'list', projectId ?? 'all', filterKey(filter), 'pages', limit ?? 0] as const,
  /** Which item each key names: stale once an item is removed or a project's prefix changes */
  workItemKeys: ['work-items', 'key'] as const,
  workItemByKey: (key: string) => ['work-items', 'key', normalizeKey(key) ?? key] as const,
  chatWorkItemsAll: ['work-items', 'chat'] as const,
  chatWorkItems: (chatId: string) => ['work-items', 'chat', chatId] as const,
  /** Prefix of every item's page and of what is read for it */
  workItemDetails: ['work-item'] as const,
  workItem: (itemId: string) => ['work-item', itemId] as const,
  workItemComments: (itemId: string) => ['work-item', itemId, 'comments'] as const,
  workItemHistory: (itemId: string) => ['work-item', itemId, 'history'] as const,
  workItemLinks: (itemId: string) => ['work-item', itemId, 'links'] as const,
  /** Under the item, so `flow.run` and the item's own events refresh it with the page */
  workItemRuns: (itemId: string) => ['work-item', itemId, 'runs'] as const,
  workItemChanges: (itemId: string, scope: ChangeScope = {}) => ['work-item', itemId, 'changes', scope.commit ?? '', scope.uncommitted ? 'uncommitted' : ''] as const,
  /** The review screen's summary alone; `workItemChanges` holds the item page's whole response (see `chatChangesReview`) */
  workItemChangesReview: (itemId: string, scope: ChangeScope = {}) =>
    ['work-item', itemId, 'changes', scope.commit ?? '', scope.uncommitted ? 'uncommitted' : '', 'review'] as const,
  workItemDiff: (itemId: string, path: string, opts: DiffOptions = {}) =>
    ['work-item', itemId, 'changes', 'diff', path, String(opts.context ?? ''), opts.commit ?? '', opts.uncommitted ? 'uncommitted' : ''] as const,
  milestonesAll: ['milestones'] as const,
  /** Prefix of every milestone read alone */
  milestoneEach: ['milestones', 'one'] as const,
  milestones: (projectId: string) => ['milestones', projectId] as const,
  milestone: (milestoneId: string) => ['milestones', 'one', milestoneId] as const,
  // ---- team, flow, journal, memory proposals and documents. One prefix per project for each, so an
  // event of that project reaches every page and filter of it
  team: (projectId: string) => ['team', projectId] as const,
  flow: (projectId: string) => ['flow', projectId] as const,
  /**
   * Every page of a project's team activity. Not under `flow`: that prefix holds the live snapshot,
   * which `chat.activity` patches in place and would find pages there instead
   */
  flowRunsOf: (projectId: string) => ['flow-runs', projectId] as const,
  flowRuns: (projectId: string, query: Omit<FlowRunQuery, 'cursor'> = {}) =>
    [
      'flow-runs',
      projectId,
      [...(query.agent ?? [])].sort().join(','),
      [...(query.role ?? [])].sort().join(','),
      [...(query.status ?? [])].sort().join(','),
      query.itemId ?? '',
      query.before ?? '',
      query.limit ?? 0,
    ] as const,
  /** Every page of a project's journal */
  journal: (projectId: string) => ['journal', projectId] as const,
  journalPage: (projectId: string, page: JournalQuery = {}) => ['journal', projectId, page.limit ?? 0, page.before ?? ''] as const,
  /** Not under `memory`: that prefix is the CLI's memory files, which a proposal only reaches once approved */
  memoryProposalsOf: (projectId: string) => ['memory-proposals', projectId] as const,
  memoryProposals: (projectId: string, status?: MemoryProposalStatus) => ['memory-proposals', projectId, status ?? 'all'] as const,
  /** A project's tree and every file read of it */
  documentsOf: (projectId: string) => ['documents', projectId] as const,
  documentTree: (projectId: string) => ['documents', projectId, 'tree'] as const,
  documentFile: (projectId: string, path: string) => ['documents', projectId, 'file', path] as const,
  // ---- the project assistant. A project's lists under one prefix, so a run of any kind reaches the
  // filtered lists too; a run's detail under another, since its events name the run
  assistantRunsOf: (projectId: string) => ['assistant', 'runs', projectId] as const,
  assistantRuns: (projectId: string, kind?: AssistantRunKind) => ['assistant', 'runs', projectId, kind ?? 'all'] as const,
  /** Every run's detail */
  assistantRunEach: ['assistant', 'run'] as const,
  assistantRun: (runId: string) => ['assistant', 'run', runId] as const,
  pushSubscriptions: ['push', 'subscriptions'] as const,
  // Both are written whole from their events (lib/events.ts), never refetched for them
  appSettings: ['settings', 'app'] as const,
  tunnel: ['tunnel'] as const,
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
  /** `false` leaves the workers of orchestrations out while keeping their syntheses */
  workers?: boolean;
  state?: ChatState;
  limit?: number;
  /** The query waits, e.g. until the project it depends on is known */
  enabled?: boolean;
}

/** How the list is read everywhere, so a prefetch fills the very entry the page will ask for. */
export const chatListQuery = (filter: Omit<ChatFilter, 'enabled'>) => ({
  queryKey: keys.chatList(filter),
  queryFn: ({ signal }: { signal: AbortSignal }) => api.chats(filter, { signal }),
});

export const useChats = (filter: ChatFilter = {}) => {
  const { enabled = true, ...rest } = filter;
  // A filter that changes the request keeps the rows on screen until the new ones arrive, instead
  // of blanking the page to a skeleton
  return useQuery({ ...chatListQuery(rest), refetchInterval: useFallbackInterval(), enabled, placeholderData: keepPreviousData });
};

/** What the chats spent over a range of days (`YYYY-MM-DD`, inclusive), or ever. */
export const useUsage = (range: { from?: string; to?: string } = {}) =>
  useQuery({ queryKey: keys.usage(range), queryFn: ({ signal }) => api.usage(range, { signal }), refetchInterval: useFallbackInterval() });

export interface UsageRange {
  from?: string;
  to?: string;
}

// The previous range stays on screen while the next one loads, so picking a range does not blank the page
export const useUsageSeries = (range: UsageRange, bucket: UsageBucket) =>
  useQuery({ queryKey: keys.usageSeries(range, bucket), queryFn: ({ signal }) => api.usageSeries(range, bucket, { signal }), refetchInterval: useFallbackInterval(), placeholderData: keepPreviousData });

export const useUsageBreakdown = (range: UsageRange) =>
  useQuery({ queryKey: keys.usageBreakdown(range), queryFn: ({ signal }) => api.usageBreakdown(range, { signal }), refetchInterval: useFallbackInterval(), placeholderData: keepPreviousData });

// `schedule.changed` and `schedule.fired` keep both fresh (lib/events.ts), `nextRunAt` included
export const useSchedules = () => useQuery({ queryKey: keys.schedules, queryFn: api.schedules, refetchInterval: useFallbackInterval() });

export const useScheduleRuns = (id: string, enabled: boolean) => {
  const fallback = useFallbackInterval();
  return useQuery({ queryKey: keys.scheduleRuns(id), queryFn: ({ signal }) => api.scheduleRuns(id, undefined, { signal }), enabled, refetchInterval: enabled ? fallback : false });
};

/** Usage refreshes on claude-swap's own cadence; polling faster would only re-read its cache. */
export const useAccounts = (enabled = true) =>
  useQuery({
    queryKey: keys.accounts,
    queryFn: ({ signal }) => api.accounts(false, { signal }),
    // An install of claude-swap reports its progress only through this read
    refetchInterval: (query) => accountsRefetchInterval(query.state.data?.cswap),
    enabled,
  });

/** `claude mcp list` is slow, and the server keeps its answer for a minute: asking sooner gains nothing. */
export const useConnectors = (enabled = true) =>
  useQuery({ queryKey: keys.connectors, queryFn: () => api.connectors(), staleTime: 60_000, enabled });

/** The rotation history kept beyond the window `GET /accounts` carries; only fetched when asked for. */
export const useAccountEvents = (enabled: boolean) =>
  useQuery({ queryKey: keys.accountEvents, queryFn: ({ signal }) => api.accountEvents(undefined, { signal }), refetchInterval: 10_000, enabled });




export const useOrchestrations = () =>
  useQuery({ queryKey: keys.orchestrations, queryFn: api.orchestrations, refetchInterval: useFallbackInterval() });

export const useOrchestration = (id: string) => {
  const fallback = useFallbackInterval();
  return useQuery({
    queryKey: keys.orchestration(id),
    queryFn: ({ signal }) => api.orchestration(id, { signal }),
    refetchInterval: (query) => {
      const data = query.state.data;
      // Integrating again happens after the graph finished, and is worth following too
      const integrating = data?.integration && ['merging', 'resolving'].includes(data.integration.status);
      return data && data.status !== 'running' && !integrating ? false : fallback;
    },
  });
};

// ---------- the project ecosystem ----------
//
// Kept fresh by `workitem.*`, `milestone.changed` and `project.updated` (lib/events.ts), and by the
// run events for what makes a card live. A page that edits passes what it changed through the
// mutation's answer and lets the event refetch the rest.

/** The five built-in templates; they never change while the server runs. */
export const useProjectTemplates = () =>
  useQuery({ queryKey: keys.projectTemplates, queryFn: ({ signal }) => api.projectTemplates({ signal }), staleTime: Infinity });

export const useProjectSettings = (projectId: string | null) =>
  useQuery({
    queryKey: keys.projectSettings(projectId ?? ''),
    queryFn: ({ signal }) => api.projectSettings(projectId ?? '', { signal }),
    enabled: projectId !== null,
  });

/**
 * How a board is read everywhere, so the sidebar's count and the page share one cache entry. The
 * Done column holds its newest `BOARD_DONE_PAGE` items unless `doneLimit` asks for more ("and N more").
 */
export const workItemBoardQuery = (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, doneLimit?: number) => ({
  queryKey: keys.workItemBoard(projectId, filter, doneLimit),
  queryFn: ({ signal }: { signal: AbortSignal }) => api.workItemBoard(projectId, filter, { signal, ...(doneLimit === undefined ? {} : { doneLimit }) }),
});

/**
 * A project's board, or every project's for `null`. A new filter, or a larger Done column, keeps the
 * cards on screen until its answer arrives.
 */
export const useWorkItemBoard = (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, enabled = true, doneLimit?: number) =>
  useQuery({ ...workItemBoardQuery(projectId, filter, doneLimit), refetchInterval: useFallbackInterval(), enabled, placeholderData: keepPreviousData });

export const useWorkItemList = (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, enabled = true) =>
  useQuery({
    queryKey: keys.workItemList(projectId, filter),
    queryFn: ({ signal }) => api.workItems(projectId, filter, { signal }),
    refetchInterval: useFallbackInterval(),
    enabled,
    placeholderData: keepPreviousData,
  });

/**
 * The list a page at a time (`limit`, default `WORK_ITEMS_PAGE`): `fetchNextPage` loads the next one
 * while `hasNextPage`. An event refreshes every page loaded, so a long list stays whole.
 */
export const useWorkItemPages = (projectId: string | null, filter: Omit<WorkItemFilter, 'projectId'> = {}, enabled = true, limit?: number) =>
  useInfiniteQuery({
    queryKey: keys.workItemPages(projectId, filter, limit),
    queryFn: ({ signal, pageParam }) => api.workItemPage(projectId, { ...filter, ...(limit ? { limit } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: '',
    getNextPageParam: (last: WorkItemPage) => last.nextCursor ?? undefined,
    refetchInterval: useFallbackInterval(),
    enabled,
    placeholderData: keepPreviousData,
  });

/**
 * The item a key names (`/tasks/:key`), whole; `data` is null when no project has it. The answer is
 * also the item's page (`useWorkItem`), which starts from it instead of asking again.
 */
export const useWorkItemByKey = (key: string) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: keys.workItemByKey(key),
    queryFn: async ({ signal }) => {
      const item = await api.workItemByKey(key, { signal });
      if (item) client.setQueryData(keys.workItem(item.id), item);
      return item;
    },
  });
};

/** Every flow run of an item, newest first: each failed run stays failed on its link. */
export const useWorkItemRuns = (itemId: string | null, enabled = true) =>
  useQuery({
    queryKey: keys.workItemRuns(itemId ?? ''),
    queryFn: ({ signal }) => api.workItemRuns(itemId ?? '', { signal }),
    enabled: enabled && itemId !== null,
    refetchInterval: useFallbackInterval(),
  });

/** One item's page: its fields, children, links, comments and history. */
export const useWorkItem = (itemId: string | null) =>
  useQuery({
    queryKey: keys.workItem(itemId ?? ''),
    queryFn: ({ signal }) => api.workItem(itemId ?? '', { signal }),
    enabled: itemId !== null,
    refetchInterval: useFallbackInterval(),
  });

/** What the item's own branch changed; read while its Changes are shown. */
export const useWorkItemChanges = (itemId: string | null, enabled = true) =>
  useQuery({
    queryKey: keys.workItemChanges(itemId ?? ''),
    queryFn: ({ signal }) => api.workItemChanges(itemId ?? '', {}, { signal }),
    enabled: enabled && itemId !== null,
  });

export const useMilestones = (projectId: string | null) =>
  useQuery({
    queryKey: keys.milestones(projectId ?? ''),
    queryFn: ({ signal }) => api.milestones(projectId ?? '', { signal }),
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
  });

/** The work items a chat is linked to: the header of a chat that works on one names it. */
export const useChatWorkItems = (chatId: string | null) =>
  useQuery({
    queryKey: keys.chatWorkItems(chatId ?? ''),
    queryFn: ({ signal }) => api.chatWorkItems(chatId ?? '', { signal }),
    enabled: chatId !== null,
  });

// ---------- team, flow, journal, memory proposals and documents ----------
//
// Kept fresh by `team.changed`, `flow.run`, `journal.changed`, `memory.proposal` and
// `document.changed` (lib/events.ts); a member's live line is patched in place by `chat.activity`.

export const useTeam = (projectId: string | null) =>
  useQuery({
    queryKey: keys.team(projectId ?? ''),
    queryFn: ({ signal }) => api.team(projectId ?? '', { signal }),
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
  });

export const useFlow = (projectId: string | null) =>
  useQuery({
    queryKey: keys.flow(projectId ?? ''),
    queryFn: ({ signal }) => api.flow(projectId ?? '', { signal }),
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
  });

/**
 * The team's activity ("See all"): every flow run of the project, newest first, filtered by member
 * and status, a page at a time (`fetchNextPage` while `hasNextPage`).
 */
export const useFlowRuns = (projectId: string | null, query: Omit<FlowRunQuery, 'cursor'> = {}) =>
  useInfiniteQuery({
    queryKey: keys.flowRuns(projectId ?? '', query),
    queryFn: ({ signal, pageParam }) => api.flowRuns(projectId ?? '', { ...query, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: '',
    getNextPageParam: (last: FlowRunPage) => last.nextCursor ?? undefined,
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
    placeholderData: keepPreviousData,
  });

export const useJournal = (projectId: string | null, page: JournalQuery = {}) =>
  useQuery({
    queryKey: keys.journalPage(projectId ?? '', page),
    queryFn: ({ signal }) => api.journal(projectId ?? '', page, { signal }),
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
    placeholderData: keepPreviousData,
  });

/** Every status when `status` is left out; the Memory tab asks for `pending`. */
export const useMemoryProposals = (projectId: string | null, status?: MemoryProposalStatus) =>
  useQuery({
    queryKey: keys.memoryProposals(projectId ?? '', status),
    queryFn: ({ signal }) => api.memoryProposals(projectId ?? '', status, { signal }),
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
  });

export const useDocuments = (projectId: string | null) =>
  useQuery({
    queryKey: keys.documentTree(projectId ?? ''),
    queryFn: ({ signal }) => api.documents(projectId ?? '', { signal }),
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
  });

/**
 * No fallback interval: `document.changed` says when the file changed, and an editor open on it
 * compares `updatedAt` to its own before taking the new content, so an agent's write never replaces
 * what the person is typing.
 */
export const useDocumentFile = (projectId: string | null, path: string | null) =>
  useQuery({
    queryKey: keys.documentFile(projectId ?? '', path ?? ''),
    queryFn: ({ signal }) => api.documentFile(projectId ?? '', path ?? '', { signal }),
    enabled: projectId !== null && path !== null,
  });

// ---------- the project assistant ----------
//
// Kept fresh by `assistant.run` (its `read` action fills in what a running one read) and
// `assistant.proposal` (lib/events.ts); a running one's live line is patched in place by
// `chat.activity`.

/** Latest first; every kind when `kind` is left out. The latest of a kind is the one its screen shows. */
export const useAssistantRuns = (projectId: string | null, kind?: AssistantRunKind) =>
  useQuery({
    queryKey: keys.assistantRuns(projectId ?? '', kind),
    queryFn: ({ signal }) => api.assistantRuns(projectId ?? '', kind, { signal }),
    enabled: projectId !== null,
    refetchInterval: useFallbackInterval(),
  });

export const useAssistantRun = (runId: string | null) =>
  useQuery({
    queryKey: keys.assistantRun(runId ?? ''),
    queryFn: ({ signal }) => api.assistantRun(runId ?? '', { signal }),
    enabled: runId !== null,
    refetchInterval: useFallbackInterval(),
  });

/**
 * Whether the scope has a board to count: a project with its Board module on, or All projects.
 * A project whose board is switched off keeps its items but shows no count for them.
 */
export const scopeHasBoard = (project: Pick<Project, 'modules'> | null): boolean => project === null || project.modules.includes('board');

/**
 * The open items of the top bar's scope, as the sidebar and the More sheet show beside Tasks: the
 * selected project's, or every project's with All projects. Read from the unfiltered board, the
 * very entry Tasks opens on. Undefined while unknown and where there is no board.
 */
export function useOpenTaskCount(project: Project | null, settled: boolean): number | undefined {
  const counted = settled && scopeHasBoard(project);
  const board = useWorkItemBoard(project?.id ?? null, {}, counted);
  // The previous scope's board stands in while the new one loads: its figure would be wrong
  return counted && !board.isPlaceholderData ? openCount(board.data) : undefined;
}
