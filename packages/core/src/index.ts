import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  AccountsOverview,
  AgentryLanguage,
  AuthVerification,
  AgentryReleaseInfo,
  CliVersionInfo,
  ChatProject,
  ChatSummary,
  ChatWorktree,
  ConfigFileRoot,
  CreateProjectRequest,
  FlowRun,
  FlowRunPage,
  FlowStartWaitingResult,
  FlowWaiting,
  FlowRunQuery,
  ImportProjectRequest,
  MemoryFile,
  MemoryProjectSummary,
  Overview,
  PermissionDecision,
  PermissionRequest,
  Project,
  ProjectCandidate,
  ProjectChange,
  ProjectModule,
  ProjectSettings,
  ProjectTeamMember,
  ProjectTemplate,
  ProjectWorktree,
  RunWorkflowRequest,
  SwitchResult,
  SystemInfo,
  UpdateProjectRequest,
  Board,
  CreateWorkItemFromMessageRequest,
  CreateWorkItemLinkRequest,
  Milestone,
  OrchestrateWorkItemsRequest,
  Orchestration,
  OrchestrationSpec,
  RelaunchOrchestrationRequest,
  WorkflowDefinition,
  WorkItem,
  WorkItemRef,
  WorkItemCause,
  WorkItemChanges,
  WorkItemDetail,
  WorkItemHistoryEntry,
  WorkItemHistoryValue,
  WorkItemFilter,
  WorkItemPage,
  WorkItemPageQuery,
  BoardQuery,
  WorkItemLink,
  WorkItemOrchestrationDraft,
  WorkOnWorkItemRequest,
  WorkOnWorkItemResult,
  FileDiff,
} from '@agentry/shared';
import { AGENTRY_LANGUAGES, agentryLanguage } from '@agentry/shared';
import pkg from '../package.json' with { type: 'json' };
import { AccountManager } from './accounts.ts';
import { AppSettingsStore } from './app-settings.ts';
import { stateFromRun } from './chat-model.ts';
import { chatLinkName, WorkItemError, WorkItemService, type WorkItemLinkState } from './work-items.ts';
import { DEFAULT_DOCUMENTS_PATH, DocumentError, DocumentService, type DocumentsPlace } from './documents.ts';
import { documentsLine, ItemDocumentsError, syncItemDocuments, withDocumentsLine } from './item-documents.ts';
import { canBranch, itemWorktree, orchestrationDraft, startOptions, titleFromMessage, WORK_CAUSE, WorkItemAutomation, workItemPrompt } from './work-links.ts';
import { TunnelManager } from './tunnel.ts';
import { ChatService, ChatStartError, type Placement } from './chat-service.ts';
import { ChatManager, type ChatConfinement, type ChatRuntime, type RunResult } from './chats.ts';
import { Connectors } from './connectors.ts';
import type { TranscriptSummary } from './cli-facts.ts';
import { detectCli, execCli, getAuthStatus } from './cli.ts';
import { CliVersionWatch } from './cli-version.ts';
import { ReleaseWatch } from './release-watch.ts';
import { ConfigExplorer } from './config/explorer.ts';
import { SettingsFiles } from './config/files.ts';
import { ChangeWatcher } from './change-watcher.ts';
import { Changes, type ChangeScope, type DiffOptions } from './changes.ts';
import { CredentialStore, type StoredCredentials } from './credentials.ts';
import { Db } from './db.ts';
import { HealthMonitor, HealthService } from './health-service.ts';
import { permissionEvents, runRef, runRefOr, SessionsWatcher } from './event-sources.ts';
import { EventBus } from './events.ts';
import { Locator } from './locations.ts';
import { modelOptions } from './models.ts';
import { PermissionBroker } from './permissions.ts';
import { PushService } from './push.ts';
import { ChatTools, ToolPresetStore } from './chat-tools.ts';
import { McpConfig } from './config/mcp.ts';
import { ConfigResources } from './config/resources.ts';
import { projectScope, userScope, type ConfigScope } from './config/scope.ts';
import { Plugins } from './plugins.ts';
import { UploadStore } from './uploads.ts';
import { MemoryStore } from './memory.ts';
import { JournalService } from './journal.ts';
import { MemoryProposalService } from './memory-proposals.ts';
import { Orchestrator } from './orchestrator.ts';
import { loadConfig, type CoreConfig } from './paths.ts';
import { byStart, EXPORTED_ORIGINS, type ProjectExportSource } from './project-export.ts';
import { parseKeyPrefix, parseModules, parseProjectSettings, parseProjectSetup, ProjectSettingsStore, settingsChanges } from './project-settings.ts';
import { PROJECT_TEMPLATES } from './project-templates.ts';
import { attachProject, projectCandidates, ProjectStore, type ChatPlace, type ProjectRecord } from './projects.ts';
import { AuthStore } from './security/auth.ts';
import { Scheduler } from './schedules.ts';
import { SessionStore } from './sessions.ts';
import { readFrontmatter, readFrontmatterList, TeamService } from './team.ts';
import { FlowError, FlowService, type FlowLaunch } from './flow.ts';
import { PullRequestService, PullRequestWatcher, type ApproveResult } from './pull-requests.ts';
import { AssistantError, AssistantService, type AssistantKnown, type AssistantLaunch, type AssistantProject } from './assistant.ts';
import { assistantGit } from './assistant-sources.ts';
import { git, isGitRepo } from './git.ts';
import { DecisionEngine } from './decisions/engine.ts';
import { CliDecisionProvider } from './decisions/providers/cli.ts';
import { DecisionCredentialStore, DecisionSettingsStore } from './decisions/settings.ts';
import { DEFAULT_SUPERVISOR_PRESET, Supervisor, SupervisorSettings, type SupervisorAnswer, type SupervisorQuestion } from './supervisor.ts';
export {
  DecisionEngine,
  DEADLINE_MS,
  lowestConfidence,
  type DecisionEngineDeps,
  type DecisionOutcome,
  type DecisionProvider,
  type DecisionRequest,
  type EffectiveDecision,
  type ProviderResult,
} from './decisions/engine.ts';
export { CliDecisionProvider, decisionPrompt, decisionSchema, parseAnswers as parseDecisionAnswers } from './decisions/providers/cli.ts';
export { DECISION_POINTS, decisionPoint, type DecisionPointDefinition, type DecisionSubject } from './decisions/points.ts';
export { cutToBytes, maskSecrets, redactState, SECRET_MASK, stateBytes } from './decisions/redact.ts';
export {
  DecisionCredentialStore,
  DecisionSettingsStore,
  DEFAULT_DECISION_SETTINGS,
  parseDecisionSettings,
  parseProjectDecisions,
} from './decisions/settings.ts';
import { listWorkflowDefinitions } from './workflows.ts';
import { encodeProjectId, Workspace } from './workspace.ts';

export { parseMcpScope } from './config/mcp.ts';
export { DEFAULT_TOOL_PRESETS } from './chat-tools.ts';
export { RESOURCE_KINDS } from './config/resources.ts';
export { parseVariant, type ConfigScope } from './config/scope.ts';
export { APP_SETTING_ENV, DEFAULT_APP_SETTINGS, loadConfig, type AuthEnv, type CoreConfig } from './paths.ts';
export { AppSettingsStore, RuntimeHosts, type RunDefaults, type RuntimeHostOptions } from './app-settings.ts';
export { LOCALHOST_RUN_KNOWN_HOSTS, TunnelManager, TunnelRefusedError, parseTunnelUrl, type TunnelDeps, type TunnelTiming } from './tunnel.ts';
export type { AdoptedChat, ChatRuntime, NewChat, RunResult } from './chats.ts';
export { ChatRefusal } from './chats.ts';
export { ChatConflictError, ChatStartError, DEFAULT_ORIGINS, startFailure, type ChatFilter, type Placement } from './chat-service.ts';
export { compareVersions } from './version-check.ts';
export { ReleaseWatch, type ReleaseWatchOptions } from './release-watch.ts';
export { DEFAULT_AUTO_SWITCH } from './accounts.ts';
export { CSWAP_VERSION, UV_VERSION } from './cswap-pin.ts';
export {
  chatControl,
  chatState,
  executionOutcome,
  sessionHolder,
  stateFromCliAgent,
  stateFromRun,
  type CliAgentFacts,
  type ControlFacts,
  type RunFacts,
  type SessionHolder,
} from './chat-model.ts';
export { addTokenUsage, emptyTokenUsage, foldUsage, UsageFold, type ContextSnapshot } from './usage.ts';
export { usageReport, type ChatSpend, type DayRange } from './usage-report.ts';
export { usageBreakdown, usageSeries } from './usage-series.ts';
export { parseChangeScope, parseDiffContext, type ChangeScope, type DiffOptions } from './changes.ts';
export { chatToMarkdown, exportFilename } from './chat-export.ts';
export { deriveKeyPrefix, parseProjectSettings, parseProjectSetup } from './project-settings.ts';
export { PROJECT_TEMPLATES } from './project-templates.ts';
export { agentFileContent, roleTitleIn, TeamError, TeamService, templateTeam, type TeamRunSource } from './team.ts';
export {
  ASSISTANT_ERRORS,
  AssistantError,
  AssistantService,
  DENIED_TOOLS,
  memberFile,
  READ_EVENT_MS,
  READ_ONLY_TOOLS,
  type AssistantChatResult,
  type AssistantDeps,
  type AssistantKnown,
  type AssistantLaunch,
  type AssistantProject,
} from './assistant.ts';
export { assistantLanguage, assistantPrompt, assistantSchema, assistantTitle, parseAnswer, type AssistantAnswer, type AssistantBrief, type AssistantGit, type AssistantLanguage } from './assistant-answer.ts';
export {
  FLOW_CAUSE,
  FlowError,
  flowPrompt,
  flowTitle,
  flowResultSchema,
  FlowService,
  parseFlowRunQuery,
  parseResult,
  stageRules,
  testCommandRules,
  testCommands,
  checkCommandRules,
  type CheckCommand,
  type FlowChatResult,
  type FlowDeps,
  type FlowLaunch,
  type FlowProject,
  type FlowRules,
} from './flow.ts';
export {
  ciOf,
  PullRequestError,
  PullRequestService,
  PullRequestWatcher,
  pullRequestBody,
  pullRequestTitle,
  remoteHost,
  type ApproveResult,
  type PullRequestDeps,
} from './pull-requests.ts';
export { projectExportFilename, projectToJson, projectToMarkdown, type ProjectExportSource } from './project-export.ts';
export { Db, type PushSubscriptionRecord } from './db.ts';
export {
  WorkItemError,
  WorkItemService,
  type WorkItemCommentContext,
  type WorkItemContext,
  type WorkItemLinkInput,
  type WorkItemLinkState,
  type WorkItemProject,
  type WorkItemServiceDeps,
} from './work-items.ts';
export { DEFAULT_DOCUMENTS_PATH, DOCUMENT_CONTENT_MAX, DocumentError, DocumentService, type DocumentServiceDeps, type DocumentsPlace, type TieOptions } from './documents.ts';
export { DocumentPathError } from './document-paths.ts';
export { orchestrationDraft, titleFromMessage, WORK_CAUSE, WorkItemAutomation, workItemPrompt, type WorkItemAutomationDeps } from './work-links.ts';
export { AuthStore, DESKTOP_ACTOR } from './security/auth.ts';
export { CHAT_TOKEN_MAX_AGE_MS, CHAT_TOKEN_PREFIX, ChatTokenStore, chatActor } from './security/chat-tokens.ts';
export { OidcVerifier, type FetchLike } from './security/oidc.ts';
export { hasRedacted, redactSecrets, restoreSecrets, SECRET_MAPS } from './security/redact.ts';
export { describeCron, nextFire, nextFires, parseCron } from './cron.ts';
export { previewCron, Scheduler, SLOT_GRACE_MS, type ScheduleLauncher } from './schedules.ts';
export { EventBus, type AgentryEventInput, type Replay } from './events.ts';
export { JOURNAL_HANDOFF_BYTES, JournalService, type JournalHandoff, type JournalWrite } from './journal.ts';
export { MemoryProposalService, type ProposalOrigin } from './memory-proposals.ts';
export { idOfEndpoint, parseRegistration, payloadOf, PushService, truncateEndpoint, type PushTransport } from './push.ts';
export {
  DEFAULT_SUPERVISOR,
  parseSupervisorConfig,
  Supervisor,
  SupervisorConflictError,
  type ProposalOwner,
  type SupervisorAnswer,
  type SupervisorDeps,
  type SupervisorQuestion,
} from './supervisor.ts';

// Read from the package rather than written into this file: the release tooling then only edits
// package.json files, and never has to rewrite source to bump a version.
const AGENTRY_VERSION = pkg.version;
const SYSTEM_TTL_MS = 30_000;

/** A session's directory: the worktree the CLI recorded when it ran in one, else where it started. */
const placeOf = (s: TranscriptSummary): ChatPlace => ({ cwd: s.worktree?.path ?? s.projectPath, updatedAt: s.updatedAt });

/** Facade wiring every core service together; the API layer only talks to this. */
export class Core {
  readonly config: CoreConfig;
  readonly db: Db;
  /** Every change worth telling a client about; what `GET /api/events` streams */
  readonly events = new EventBus();
  readonly permissions: PermissionBroker;
  /** Processes and live streams of the chats Agentry drives */
  readonly runtime: ChatManager;
  /** The chats the API serves: the transcript, the runtime and the CLI's own list, as one */
  readonly chats: ChatService;
  readonly sessions: SessionStore;
  readonly orchestrator: Orchestrator;
  /** What a task, the integration branch or a chat has changed on disk */
  readonly changes: Changes;
  /** What a chat's health is read from: the calls it made, the history of how long commands take */
  readonly health: HealthService;
  private readonly healthMonitor: HealthMonitor;
  /** The optional model that drafts a hint when a worker's health turns bad; off unless `supervisor.json` says so */
  readonly supervisor: Supervisor;
  /** The decision engine's settings (`decisions.json`) and its Jev key (`decision-credentials.json`, never returned) */
  readonly decisionSettings: DecisionSettingsStore;
  readonly decisionCredentials: DecisionCredentialStore;
  /** The one door every decision point asks through; providers register themselves on it */
  readonly decisions: DecisionEngine;
  readonly schedules: Scheduler;
  /** Web Push: the VAPID keypair, the installs registered to be woken, and the sender behind them */
  readonly push: PushService;
  readonly files: SettingsFiles;
  readonly explorer: ConfigExplorer;
  readonly plugins: Plugins;
  readonly memory: MemoryStore;
  readonly mcp: McpConfig;
  readonly toolPresets: ToolPresetStore;
  readonly connectors: Connectors;
  readonly resources: ConfigResources;
  readonly credentials: CredentialStore;
  /** How the API is guarded: the auth mode, the token hash and read-only */
  readonly security: AuthStore;
  /**
   * The settings that change at runtime (`app-settings.json` under the environment), and the exact
   * hosts answered beside the allowlist. What applies now is read here, never from `config`
   */
  readonly appSettings: AppSettingsStore;
  /** The tunnel through localhost.run: lends its verified host to `appSettings.runtimeHosts` */
  readonly tunnel: TunnelManager;
  readonly uploads: UploadStore;
  readonly accounts: AccountManager;
  readonly cliVersion: CliVersionWatch;
  /** Whether a newer Agentry has been released: `release.json`, checked once a day */
  readonly release: ReleaseWatch;
  readonly workspace: Workspace;
  readonly locator = new Locator();
  private readonly projectStore: ProjectStore;
  /** What each project configures, one JSON document per project id, kept when the project is removed */
  private readonly projectSettingsStore: ProjectSettingsStore;
  /**
   * The work items of every project, kept in the shared database. Routes gate writes through
   * `workItemProject` and friends first: the store itself knows nothing of modules.
   */
  readonly workItems: WorkItemService;
  readonly documents: DocumentService;
  /** Moves items as the chats and nodes linked to them work, from the feed and the runtime's results */
  private readonly workLinks: WorkItemAutomation;
  /** Each project's team: its members' agent files plus the metadata in `settings.team` */
  readonly team: TeamService;
  /** Each project's journal: decisions, closed items and approved memory, handed to every flow run */
  readonly journal: JournalService;
  /** What the team proposes to remember, written to its target only once a person approves it */
  readonly memoryProposals: MemoryProposalService;
  /** The flow by column: a team member's run when a card enters the column its role answers for */
  readonly flow: FlowService;
  /** Approved items' pull requests: opened with git and gh on the person's request, and watched until merged */
  readonly pullRequests: PullRequestService;
  private readonly pullRequestWatcher: PullRequestWatcher;
  /** The project assistant: read-only runs that propose a team, resources and work items, each accepted on its own */
  readonly assistant: AssistantService;
  private readonly startedAt = Date.now();
  /**
   * The person's language, as their panel last said it (`noteLanguage`): what the chats Agentry
   * starts on its own, with no request of the person's behind them, are titled in.
   */
  private language: AgentryLanguage = 'en';
  /** Chats whose account rotation after a rate limit is under way: a flow run on one waits for it */
  private readonly rotations = new Set<string>();
  private readonly sessionsWatcher: SessionsWatcher;
  private readonly changeWatcher: ChangeWatcher;
  private systemCache: { at: number; gen: number; value: Omit<SystemInfo, 'uptimeSec' | 'models'> } | null = null;
  private systemPending: { gen: number; promise: Promise<Omit<SystemInfo, 'uptimeSec' | 'models'>> } | null = null;
  private systemGen = 0;

  constructor(config: CoreConfig = loadConfig()) {
    this.config = config;
    this.db = new Db(config);
    this.permissions = new PermissionBroker();
    // Must run before anything spawns the CLI: it injects stored credentials into process.env
    this.credentials = new CredentialStore(config);
    this.security = new AuthStore(config);
    if (this.security.environmentReset) {
      // A credential changed without a request, so the row is the only trace of who changed it
      this.db.appendAudit({
        at: this.security.environmentReset.at,
        actor: 'env',
        method: 'POST',
        path: '/api/security/token',
        status: 200,
        summary: 'Replace the token from AGENTRY_AUTH_TOKEN (AGENTRY_AUTH_TOKEN_RESET)',
      });
    }
    this.appSettings = new AppSettingsStore(config, {
      emit: (event) => {
        // `system()` carries the default permission mode, and a cached copy would show the old one
        this.forgetSystem();
        this.events.emit(event);
      },
    });
    this.tunnel = new TunnelManager({
      dataDir: config.dataDir,
      sshBin: config.sshBin,
      enabled: config.tunnelEnabled,
      security: this.security,
      hosts: this.appSettings.runtimeHosts,
      emit: (event) => this.events.emit(event),
      // What the tunnel does by itself; what a person asks for is audited by the API's own hook
      audit: (row) => this.db.appendAudit({ at: new Date().toISOString(), actor: 'agentry', status: 200, ...row }),
    });
    // The tunnel never outlives the guard: it is closed before the first unguarded request
    this.security.beforeUnguarded = async () => {
      await this.tunnel.stop('unguarded');
    };
    this.workspace = new Workspace(config);
    this.cliVersion = new CliVersionWatch(config);
    this.release = new ReleaseWatch(config, { current: AGENTRY_VERSION, events: this.events });
    this.projectStore = new ProjectStore(config);
    this.projectSettingsStore = new ProjectSettingsStore(config);
    this.team = new TeamService({
      dataDir: config.dataDir,
      project: async (id) => {
        const record = this.requireProject(id);
        return { ...record, settings: await this.projectSettings(id) };
      },
      saveSettings: (id, settings) => this.saveTeamSettings(id, settings),
      emit: (event) => this.events.emit(event),
    });
    this.uploads = new UploadStore(config.dataDir);
    this.runtime = new ChatManager(config, this.db);
    // One store, so the token a chat's process is handed is the one the guard accepts
    this.runtime.chatTokens = this.security.chatTokens;
    this.runtime.defaults = this.appSettings;
    this.runtime.permissions = this.permissions;
    this.runtime.bus = this.events;
    this.sessionsWatcher = new SessionsWatcher(config.projectsDir, this.events);
    this.runtime.uploads = this.uploads;
    // The UI watches a run's event stream, so the prompt has to arrive on it
    this.permissions.on('requested', (request: PermissionRequest) => {
      this.runtime.notice(request.runId, `Permission requested for ${request.toolName}`, { permission: request });
      for (const event of permissionEvents(request, this.runtime.get(request.runId))) this.events.emit(event);
    });
    this.permissions.on('resolved', (request: PermissionRequest, decision: PermissionDecision | null) => {
      const outcome = decision ? decision.behavior : 'withdrawn';
      this.events.emit({
        type: 'permission.resolved',
        title: `${request.toolName} ${outcome === 'withdrawn' ? 'was withdrawn' : outcome === 'allow' ? 'allowed' : 'denied'}`,
        ...runRefOr(request.runId, this.runtime.get(request.runId)),
        permissionId: request.id,
        toolName: request.toolName,
        outcome,
      });
    });
    // Hangs off the bus as an observer, so it hears every event without counting as a client
    this.push = new PushService({ config, db: this.db, events: this.events });
    this.sessions = new SessionStore(config);
    this.orchestrator = new Orchestrator(config, this.runtime, this.db);
    this.orchestrator.bus = this.events;
    this.orchestrator.workflowRecords = (sessionId) => this.sessions.workflows(sessionId, true);
    this.mcp = new McpConfig(config);
    this.toolPresets = new ToolPresetStore(config);
    this.health = new HealthService(this.runtime, this.db);
    this.orchestrator.health = (task) => {
      const chat = task.runId ? this.runtime.get(task.runId) : null;
      const context = task.runId ? this.orchestrator.taskContext(task.runId) : null;
      if (!chat || !context) return null;
      return this.health.read(chat.id, {
        state: stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }),
        lastEnded: null,
        context: null,
        failedBranches: 0,
        limits: context.limits,
        taskElapsedMs: context.elapsedMs,
        taskSpentUsd: context.spentUsd,
      });
    };
    this.supervisor = new Supervisor({
      settings: new SupervisorSettings(config),
      db: this.db,
      ask: (question) => this.askSupervisor(question),
      // A page is the newest entries, which is all the supervisor reads
      steps: async (chatId) => (await this.sessions.getSession(chatId, { limit: 60 }))?.entries ?? [],
      hint: async (proposal) => {
        if (proposal.orchestrationId && proposal.taskId) this.orchestrator.hintTask(proposal.orchestrationId, proposal.taskId, proposal.hint);
        else await this.chats.hint(proposal.chatId, { text: proposal.hint });
      },
      emit: (event) => this.events.emit(event),
      charge: (orchestrationId, costUsd) => this.orchestrator.chargeSupervisor(orchestrationId, costUsd),
    });
    this.decisionCredentials = new DecisionCredentialStore(config);
    this.decisionSettings = new DecisionSettingsStore(config, this.decisionCredentials);
    this.decisions = new DecisionEngine({
      settings: this.decisionSettings,
      db: this.db,
      projectDecisions: (projectId) => this.projectSettingsStore.stored(projectId, this.projectStore.get(projectId)?.name)?.decisions ?? null,
    });
    this.decisions.register(new CliDecisionProvider({ runtime: this.runtime, settings: this.decisionSettings }));
    this.decisions.startPruning();
    this.healthMonitor = new HealthMonitor({
      runtime: this.runtime,
      health: this.health,
      emit: (event) => this.events.emit(event),
      taskOf: (chat) => this.orchestrator.taskContext(chat.id),
      onBad: (chat, task, signals) => void this.supervisor.wake(chat, task, signals),
    });
    this.healthMonitor.start();
    this.chats = new ChatService({
      health: this.health,
      config,
      runtime: this.runtime,
      tools: new ChatTools(config, this.mcp, this.toolPresets),
      sessions: this.sessions,
      orchestrator: this.orchestrator,
      place: (dir, recorded) => this.place(dir, recorded),
      environmentOf: (dir) => this.runtime.environments.get(dir),
      windowOf: (model) => this.db.modelWindow(model),
      memberChat: (chatId) => this.memberChat(chatId),
    });
    this.changes = new Changes({
      orchestrator: this.orchestrator,
      chats: this.chats,
      sessions: this.sessions,
      runtime: this.runtime,
      // A chat on a work item works in the item's worktree, cut from the project's checkout
      forkedFrom: (chatId) => {
        const itemId = this.workItems.linksOfChat(chatId).find((l) => l.kind === 'chat' && l.role !== 'origin')?.itemId;
        const item = itemId ? this.workItems.find(itemId) : null;
        return item ? (this.projectStore.get(item.projectId)?.path ?? null) : null;
      },
    });
    // The CLI's list of sessions is kept a while; a process of ours that started or ended changes
    // what it says about that chat, and a stale one would read it as held by someone else
    this.events.observe((event) => {
      const started = event.type === 'run.updated' && event.status !== event.previousStatus && event.status === 'starting';
      if (started || event.type === 'run.created' || event.type === 'run.ended' || event.type === 'run.removed') this.chats.forgetHolders();
    });
    this.changeWatcher = new ChangeWatcher(this.orchestrator, this.events);
    this.changeWatcher.start();
    this.files = new SettingsFiles();
    this.explorer = new ConfigExplorer(config.configDir);
    this.plugins = new Plugins(config);
    this.memory = new MemoryStore(config);
    this.workItems = new WorkItemService({
      db: this.db,
      project: (id) => {
        const settings = this.projectSettingsStore.stored(id, this.projectStore.get(id)?.name);
        return settings ? { keyPrefix: settings.keyPrefix, columnLimits: settings.board.columnLimits } : null;
      },
      emit: (event) => this.events.emit(event),
      linkState: (link) => this.workItemLinkState(link),
    });
    this.documents = new DocumentService({
      items: this.workItems,
      place: (projectId, access) => this.documentsPlace(projectId, access),
      itemProject: async (itemId) => (await this.workItemAccess(itemId, 'write')).projectId,
      emit: (event) => this.events.emit(event),
    });
    this.workLinks = new WorkItemAutomation({
      items: this.workItems,
      writable: (id) => {
        const record = this.projectStore.get(id);
        return !!record && !!this.projectSettingsStore.stored(id, record.name)?.modules.includes('board');
      },
      orchestration: (id) => this.orchestrator.get(id),
      flowOwns: (chatId) => this.flow.ownsChat(chatId),
    });
    this.events.observe((event) => this.workLinks.observe(event));
    const itemRef = (id: string): WorkItemRef | null => {
      const item = this.workItems.find(id);
      return item ? { id: item.id, key: item.key, title: item.title, type: item.type, status: item.status } : null;
    };
    this.journal = new JournalService({
      db: this.db,
      emit: (event) => this.events.emit(event),
      item: itemRef,
      sources: (id) =>
        this.workItems
          .links(id)
          .filter((l) => l.kind === 'chat' || l.kind === 'orchestration')
          .map((l) => ({ kind: l.kind === 'orchestration' ? 'orchestration' : 'chat', chatId: l.chatId, orchestrationId: l.orchestrationId, taskId: l.taskId })),
    });
    // Every process hears its own moves only, so an item closed here is journalled here, once
    this.events.observe((event) => this.journal.observe(event));
    this.memoryProposals = new MemoryProposalService({
      db: this.db,
      journal: this.journal,
      memory: this.memory,
      project: (id) => {
        const record = this.projectStore.get(id);
        return record ? { path: record.path, memoryKey: encodeProjectId(record.path) } : null;
      },
      emit: (event) => this.events.emit(event),
      item: itemRef,
    });
    this.pullRequests = new PullRequestService({
      db: this.db,
      items: this.workItems,
      project: (id) => {
        const record = this.projectStore.get(id);
        return record ? { path: record.path } : null;
      },
      busy: (itemId) => {
        if (this.flow.itemRunning(itemId)) return true;
        return this.workItems.links(itemId).some((l) => l.role === 'work' && (l.chatState === 'working' || l.chatState === 'waiting' || l.taskStatus === 'running'));
      },
      verdicts: (itemId) => this.flow.verdicts(itemId),
      // The card's link is the address the person reaches the panel on: the tunnel when it is up
      webOrigin: () => {
        const tunnel = this.tunnel.status();
        return tunnel.state === 'active' && tunnel.url ? tunnel.url : (this.runtime.apiUrl?.replace(/\/api$/, '') ?? null);
      },
    });
    this.pullRequestWatcher = new PullRequestWatcher(this.pullRequests);
    this.events.observe((event) => this.pullRequests.observe(event));
    this.flow = new FlowService({
      db: this.db,
      pullRequests: {
        conflictOf: (itemId) => this.pullRequests.conflictOf(itemId),
        settleConflict: (itemId) => this.pullRequests.settleConflict(itemId),
        verified: (itemId) => this.pullRequests.verified(itemId),
      },
      items: this.workItems,
      project: (id) => {
        const record = this.projectStore.get(id);
        const settings = record ? this.projectSettingsStore.stored(id, record.name) : null;
        return record && settings ? { path: record.path, settings } : null;
      },
      handoff: (id) => this.journal.handoff(id).text,
      propose: (id, proposal, origin) => void this.memoryProposals.propose(id, proposal, origin),
      tie: async (itemId, document, options) => {
        await this.documents.tie(itemId, document, { ...options, requireFile: false });
      },
      launch: (launch, onStart) => this.launchFlowRun(launch, onStart),
      chatBusy: (chatId) => {
        const chat = this.runtime.get(chatId);
        return !!chat && stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) !== 'idle';
      },
      stop: (chatId) => void this.runtime.stop(chatId),
      activity: (chatId) => this.runtime.get(chatId)?.activity ?? null,
      language: () => this.language,
      rotating: (chatId) =>
        this.rotations.has(chatId) || (this.accounts.autoSwitch.rotateOnLimit && this.accounts.managed && this.runtime.rotationComing(chatId)),
      emit: (event) => this.events.emit(event),
    });
    this.team.runs = (projectId) => this.flow.runs(projectId);
    this.events.observe((event) => this.flow.observe(event));
    this.assistant = new AssistantService({
      db: this.db,
      items: this.workItems,
      project: (id) => this.assistantProject(id),
      known: (project) => this.assistantKnown(project),
      launch: (launch, onStart) => this.launchAssistantRun(launch, onStart),
      chatBusy: (chatId) => {
        const chat = this.runtime.get(chatId);
        return !!chat && stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) !== 'idle';
      },
      stop: (chatId) => void this.runtime.stop(chatId),
      activity: (chatId) => this.runtime.get(chatId)?.activity ?? null,
      cost: (chatId) => this.runtime.get(chatId)?.costUsd ?? null,
      addMember: (project, member, content) => this.addAssistantMember(project, member, content),
      resourceExists: async (project, scope, kind, name) => (await this.resources.get(this.assistantScope(project, scope), kind, name)) !== null,
      saveResource: async (project, scope, kind, name, content) => {
        await this.resources.save(this.assistantScope(project, scope), kind, name, content);
      },
      emit: (event) => this.events.emit(event),
    });
    this.events.observe((event) => this.assistant.observe(event));
    // Every result, not only a run's first: a chat worked on by hand ends many turns. The automation
    // hears it before the flow, which ends its run on it and so stops claiming the chat
    this.runtime.on('chat-result', (chatId: string, result: RunResult) => {
      this.workLinks.chatResult(chatId, result);
      void this.flow.chatResult(chatId, result);
      this.assistant.chatResult(chatId, result);
    });
    // "Create with AI" shows the file while the chat writes it, from the result it is streaming
    this.runtime.on('chat-structured', (chatId: string, raw: string) => this.assistant.chatStructured(chatId, raw));
    // The graphs a restart cut off go on in the chats it restores, so only once those are back
    // Started last of all, once the chats it may resume or start are restored, so a slot judged at
    // boot finds the runtime it launches into ready
    this.schedules = new Scheduler(config, {
      chat: (request) => this.chats.create(request),
      orchestration: (spec) => this.orchestrator.create(spec),
      // A chat waiting on a person is still in its turn: it has not ended, whatever it waits for
      running: ({ chatId, orchestrationId }) => {
        if (chatId) {
          const chat = this.runtime.get(chatId);
          return !!chat && stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) !== 'idle';
        }
        return !!orchestrationId && this.orchestrator.get(orchestrationId)?.status === 'running';
      },
    });
    this.schedules.bus = this.events;
    // A queued slot follows its predecessor as soon as it ends, not on the next tick. Not before the
    // chats are restored, though: until then a chat still going looks like one that ended
    let schedulesStarted = false;
    this.events.observe((event) => {
      if (!schedulesStarted) return;
      const ended =
        (event.type === 'run.updated' && event.status !== event.previousStatus) ||
        event.type === 'run.ended' ||
        event.type === 'run.removed' ||
        (event.type === 'orchestration.updated' && event.status !== 'running') ||
        event.type === 'orchestration.removed';
      if (ended) void this.schedules.drain().catch(() => undefined);
    });
    void this.runtime.restore(this.sessions).finally(() => {
      this.orchestrator.recover();
      try {
        this.flow.recover();
        // After the chats are back, so a merge moves an item nothing is about to resume on
        this.pullRequestWatcher.start();
      } catch {
        // Shut down before the chats came back: the database is closed, and nothing may start anyway
      }
      void this.assistant.recover().catch(() => undefined);
      this.schedules.start();
      schedulesStarted = true;
      // Every transcript is read once now rather than by whoever opens the first list, which
      // otherwise waits for seconds on a machine with hundreds of megabytes of them
      void this.sessions.listSessions().catch(() => undefined);
    });
    this.connectors = new Connectors(config);
    // A project's agent file is also a team member's: the team announces it, however it was written
    this.resources = new ConfigResources((change) => {
      if (change.kind !== 'agents' || change.scope.kind !== 'project') return;
      const path = change.scope.projectPath;
      for (const project of this.projectStore.list().filter((p) => p.path === path)) void this.team.agentFileChanged(project.id, change.name, change.action);
    });
    this.accounts = new AccountManager(config, this.db);
    this.runtime.accounts = this.accounts;
    this.accounts.projectOf = (cwd) => this.attach(cwd)?.project.id ?? null;
    this.accounts.on('switched', (result: SwitchResult) => {
      this.forgetSystem(); // the active account (and its email) changed
      this.events.emit({
        type: 'account.switched',
        title: `Switched account${result.to ? ` to ${result.to}` : ''}`,
        from: result.from,
        to: result.to,
        reason: result.reason,
      });
    });
    // A managed install (or its removal) can change who owns the credential
    this.accounts.on('cswap', () => {
      this.syncCredentialOwner();
      this.forgetSystem();
    });
    this.runtime.on('rate-limited', (run: ChatRuntime) => {
      this.events.emit({ type: 'run.rateLimited', title: `${run.name} hit its rate limit`, ...runRef(run) });
      void this.rotateAndResume(run);
    });
    void this.accounts.init().then(() => this.syncCredentialOwner());
  }

  /**
   * While claude-swap manages the accounts it owns `.credentials.json`, and Claude Code only
   * reads that file when no token is in the environment — so the wrapper stops injecting one.
   */
  private syncCredentialOwner(): void {
    const managed = this.accounts.managed;
    if (managed === this.credentials.isSuspended) return;
    this.credentials.suspend(managed);
    this.forgetSystem();
  }

  /**
   * A run died against its account's rate limit: rotate to the account with the most headroom
   * left and replay the turn, which resumes the same session on the new credential.
   */
  private async rotateAndResume(run: ChatRuntime): Promise<void> {
    if (!this.accounts.autoSwitch.rotateOnLimit || !this.accounts.managed) return;
    // Held until the rotation says how it went: a flow run waits on it rather than fail
    this.rotations.add(run.id);
    const outcome: { resumed: boolean; reason: string | null } = { resumed: false, reason: null };
    try {
      // A pinned chat leaves its account; a project with a rotation policy moves within it; everything
      // else uses the global rotation
      const reason = `run ${run.name} hit its rate limit`;
      const pinned = run.account;
      const result = pinned
        ? await this.accounts.rotatePinned({ account: pinned, cwd: run.cwd }, reason)
        : ((await this.accounts.rotateWithinPolicy({ account: null, cwd: run.cwd }, reason)) ?? (await this.accounts.rotate(reason)));
      if (!result.switched) {
        this.runtime.notice(run.id, `Rate limit reached and no account with quota left${result.reason ? ` (${result.reason})` : ''}.`);
        outcome.reason = result.reason ? `no account with quota left: ${result.reason}` : 'no account with quota left';
        return;
      }
      // Kept, the pin would respawn the replay on the account that just ran out
      if (pinned) this.runtime.unpin(run.id);
      this.forgetSystem();
      const target = result.to ?? 'another account';
      // An orchestration worker already handed its result to the orchestrator, and a turn held to a
      // schema (the assistant) to the run that started it, which has ended on it: rotating helps what
      // comes after, but replaying the turn would spend again for nobody. A flow run that waits for
      // the rotation has not ended: it goes on in its chat, as a person's chat does.
      if (run.orchestrationId || (this.runtime.heldToSchema(run.id) && !this.flow.awaitsRotation(run.id))) {
        this.runtime.notice(run.id, `Rate limit reached — switched to ${target}; the next tasks use it.`);
        this.announceRotation(run, result, false);
        return;
      }
      this.runtime.notice(run.id, `Rate limit reached — switched to ${target} and resuming.`);
      const replayed = await this.runtime.replayLastTurn(run.id);
      if (!replayed) this.runtime.notice(run.id, 'The turn could not be resumed automatically; send it again.');
      outcome.resumed = replayed;
      if (!replayed) outcome.reason = 'its turn could not be replayed';
      this.announceRotation(run, result, replayed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runtime.notice(run.id, `Account rotation failed: ${message}`);
      outcome.reason = `the rotation failed: ${message}`;
    } finally {
      this.rotations.delete(run.id);
      this.flow.rotated(run.id, outcome);
    }
  }

  private announceRotation(run: ChatRuntime, result: SwitchResult, resumed: boolean): void {
    this.events.emit({
      type: 'run.accountRotated',
      title: `${run.name} moved to ${result.to ?? 'another account'} after hitting its rate limit`,
      ...runRef(run),
      from: result.from,
      to: result.to,
      resumed,
    });
  }

  /**
   * What the CLI and the account are, as the last read left them. Reading spawns two `claude`
   * processes, so callers that ask at once share one read and a value only aged out by the clock is
   * served while its replacement is on its way: a burst costs one detection, not one per caller.
   * Only `force` and a change of account wait, because answering with the account that just went
   * would be wrong rather than merely old.
   */
  async system(force = false): Promise<SystemInfo> {
    const cached = this.systemCache;
    if (!force && cached && cached.gen === this.systemGen) {
      if (Date.now() - cached.at > SYSTEM_TTL_MS) void this.readSystem().catch(() => undefined);
      return this.withUptime(cached.value);
    }
    return this.withUptime(await this.readSystem(!force));
  }

  /**
   * What the last read saw, whatever its age, without starting one. `GET /api/health` is reachable
   * with no credential: were it to measure, a burst against it would become a burst of processes.
   */
  systemKnown(): SystemInfo | null {
    return this.systemCache ? this.withUptime(this.systemCache.value) : null;
  }

  /**
   * What the CLI and the account report changed, so the next caller measures rather than trust the
   * last reading. The reading itself is kept: it is what the liveness probe answers from, and a
   * probe that started failing on every account switch would have the container restarted under it.
   */
  private forgetSystem(): void {
    this.systemGen++;
  }

  private withUptime(value: Omit<SystemInfo, 'uptimeSec' | 'models'>): SystemInfo {
    // Read here rather than with the rest: the rest costs two `claude` processes and is kept for
    // half a minute, while this is a file the CLI writes, cached by its own mtime
    return { ...value, models: modelOptions(this.config.globalConfigFile, this.runtime.modelIds.get()), uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  private readSystem(join = true): Promise<Omit<SystemInfo, 'uptimeSec' | 'models'>> {
    const pending = this.systemPending;
    if (join && pending && pending.gen === this.systemGen) return pending.promise;
    const gen = this.systemGen;
    const at = Date.now();
    const promise: Promise<Omit<SystemInfo, 'uptimeSec' | 'models'>> = (async () => {
      const cli = await detectCli(this.config);
      const auth = cli.installed
        ? await getAuthStatus(this.config)
        : { loggedIn: false, tokenSource: 'none' as const, error: 'Claude Code CLI not installed' };
      if (this.credentials.isSuspended) {
        auth.tokenSource = 'cswap';
      } else if (this.credentials.active && auth.tokenSource.startsWith('env-')) {
        auth.tokenSource = auth.tokenSource === 'env-oauth-token' ? 'wrapper-oauth-token' : 'wrapper-api-key';
      }
      const value = {
        cli,
        auth,
        configDir: this.config.configDir,
        workspaceDir: this.config.workspaceDir,
        defaultPermissionMode: this.appSettings.defaultPermissionMode,
        version: AGENTRY_VERSION,
      };
      // A read that finished late never replaces a newer one
      if (gen === this.systemGen && (!this.systemCache || this.systemCache.at <= at)) this.systemCache = { at, gen, value };
      return value;
    })().finally(() => {
      if (this.systemPending?.promise === promise) this.systemPending = null;
    });
    this.systemPending = { gen, promise };
    return promise;
  }

  private attach(dir: string) {
    return attachProject(this.projectStore.list(), dir, (d) => this.locator.worktreeOf(d));
  }

  /**
   * The project a directory belongs to and the worktree it is in, which is what a chat records. The
   * project is null when the directory is under none that was imported: a loose chat.
   */
  projectOf(dir: string): { project: ChatProject | null; worktree: ChatWorktree | null } {
    const attached = this.attach(dir);
    const facts = attached ? attached.worktree : this.locator.worktreeOf(dir);
    return {
      project: attached ? { id: attached.project.id, name: attached.project.name } : null,
      worktree: facts ? { path: facts.path, name: facts.name, branch: facts.branch } : null,
    };
  }

  /**
   * Where a chat belongs: its project, and the worktree when it works in one. The CLI's own record
   * of the worktree it created wins over anything guessed from the path.
   */
  private place(dir: string, recorded: TranscriptSummary['worktree']): Placement {
    if (recorded) this.locator.learn(recorded);
    return this.projectOf(dir);
  }

  /** Saved workflows the Workflow tool can run by name, for a project directory and the user. */
  workflowDefinitions(cwd?: string): Promise<WorkflowDefinition[]> {
    return listWorkflowDefinitions(this.config.configDir, cwd);
  }

  /**
   * Starts a run that runs a saved workflow. The CLI has no command for it: a workflow only runs
   * through the Workflow tool, inside a session, so the run is asked to call it, and asking in
   * the user's own words is what the tool requires before it launches one.
   */
  async runWorkflow(request: RunWorkflowRequest): Promise<ChatSummary> {
    const name = request.name?.trim();
    if (!name) throw new Error('name is required');
    const known = await this.workflowDefinitions(request.cwd);
    if (!known.some((w) => w.name === name)) throw new Error(`workflow "${name}" not found in .claude/workflows/`);
    const args = request.args?.trim();
    const prompt = [
      `Run the saved workflow "${name}" with the Workflow tool (pass name: "${name}"${args ? ' and the args below' : ''}).`,
      'Wait for it to finish, then report its result.',
      ...(args ? ['', 'Args:', args] : []),
    ].join('\n');
    const started = this.runtime.start({
      prompt,
      name: `workflow-${name}`,
      permissionPrompts: 'host',
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}),
    });
    const chat = await this.chats.summaryOf(started.id);
    if (!chat) throw new Error('chat not found');
    return chat;
  }

  /**
   * Deletes every trace Claude Code keeps of a project: transcripts, tasks, file history and its
   * config entry. The CLI owns that layout, so it does the deleting. Irreversible, and separate
   * from `removeProject`, which only makes Agentry forget the directory.
   */
  async purgeProject(id: string): Promise<{ detail: string }> {
    const project = this.projectStore.get(id);
    if (!project) throw new Error('project not found');
    const res = await execCli(this.config, ['project', 'purge', project.path, '--yes'], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'claude project purge failed');
    // Only that project's transcripts went; the rest stay as they were read
    this.sessions.invalidate(encodeProjectId(project.path));
    return { detail: res.stdout.trim() };
  }

  /**
   * Maps the `?project=` of a config route to a scope. Only projects the wrapper knows about are
   * accepted, so the API cannot be pointed at arbitrary directories.
   */
  async resolveScope(projectId?: string): Promise<ConfigScope> {
    if (!projectId || projectId === 'user') return userScope(this.config);
    const project = this.projectStore.get(projectId);
    if (!project) throw new Error('project not found');
    if (!existsSync(project.path)) throw new Error('project directory is missing on disk');
    return projectScope(project.path);
  }

  /** Claude Code keys a project's memory by its directory, not by the id Agentry gives the project. */
  private memoryKey(projectId: string): string {
    const project = this.projectStore.get(projectId);
    if (!project) throw new Error('project not found');
    return encodeProjectId(project.path);
  }

  async memoryFiles(projectId: string): Promise<MemoryFile[]> {
    const files = await this.memory.list(this.memoryKey(projectId));
    return files.map((f) => ({ ...f, projectId }));
  }

  async saveMemory(projectId: string, name: string, content: unknown): Promise<MemoryFile> {
    return { ...(await this.memory.save(this.memoryKey(projectId), name, content)), projectId };
  }

  removeMemory(projectId: string, name: string): Promise<void> {
    return this.memory.remove(this.memoryKey(projectId), name);
  }

  async memoryOverview(): Promise<MemoryProjectSummary[]> {
    const summaries = await Promise.all(
      this.projectStore.list().map(async (p) => {
        const files = await this.memory.list(encodeProjectId(p.path));
        const lastUpdated = files.map((f) => f.updatedAt ?? '').sort().at(-1) || null;
        return { projectId: p.id, projectPath: p.path, projectName: p.name, fileCount: files.length, lastUpdated };
      }),
    );
    return summaries.sort((a, b) => b.fileCount - a.fileCount || a.projectName.localeCompare(b.projectName));
  }

  async configFileRoots(): Promise<ConfigFileRoot[]> {
    const user = userScope(this.config);
    const roots: ConfigFileRoot[] = [{ id: 'user', label: 'User', path: user.claudeDir, exists: existsSync(user.claudeDir) }];
    for (const project of this.projectStore.list()) {
      if (!existsSync(project.path)) continue;
      const { claudeDir } = projectScope(project.path);
      roots.push({ id: project.id, label: project.name, path: claudeDir, exists: existsSync(claudeDir) });
    }
    return roots;
  }

  /** The CLI in use against the newest published one, as the last check left it: no network here. */
  async cliVersionInfo(): Promise<CliVersionInfo> {
    return this.cliVersion.info((await this.system()).cli.version);
  }

  /** Asks the registry now; the button on the System page, not something a page load may trigger. */
  async checkCliVersion(): Promise<CliVersionInfo> {
    await this.cliVersion.check();
    return this.cliVersionInfo();
  }

  /** This Agentry against the newest release, as the last check left it: no network here. */
  releaseInfo(): AgentryReleaseInfo {
    return this.release.info();
  }

  /** Asks GitHub now, for the Check for updates button. */
  async checkRelease(): Promise<AgentryReleaseInfo> {
    await this.release.check();
    return this.release.info();
  }

  /** The version this server runs, as every client should expect it */
  get version(): string {
    return AGENTRY_VERSION;
  }

  async setCredentials(credentials: StoredCredentials): Promise<SystemInfo> {
    await this.credentials.set(credentials);
    return this.system(true);
  }

  async clearCredentials(): Promise<SystemInfo> {
    this.credentials.clear();
    return this.system(true);
  }

  /** `claude auth status` only reports what is configured; this proves it with a minimal real request. */
  async verifyAuth(): Promise<AuthVerification> {
    const run = this.runtime.start({
      prompt: 'Reply with exactly: ok',
      model: 'haiku',
      name: 'auth-check',
      keepAlive: false,
      internal: true,
      permissionMode: 'manual',
      allowedTools: [],
    });
    const result = await this.runtime.waitForResult(run.id);
    this.runtime.remove(run.id);
    const { auth } = await this.system(true);
    return { ok: !result.isError, detail: result.result.slice(0, 500), auth };
  }

  /**
   * The supervisor's question as a housekeeping chat: no transcript, the `read-only` preset (the
   * stored one, or the shipped one if it was deleted) and the configured ceiling as
   * `--max-budget-usd`. Removed once it answers, like the auth check: the proposal is its record.
   */
  private async askSupervisor(question: SupervisorQuestion): Promise<SupervisorAnswer> {
    const preset = this.toolPresets.get('read-only') ?? DEFAULT_SUPERVISOR_PRESET;
    const allowedTools = preset.allowedTools ?? [];
    const disallowedTools = preset.disallowedTools ?? [];
    const run = this.runtime.start({
      prompt: question.prompt,
      cwd: question.cwd,
      model: question.model,
      name: 'supervisor',
      keepAlive: false,
      internal: true,
      permissionMode: 'manual',
      allowedTools,
      disallowedTools,
      toolConfig: { preset, allowedTools, disallowedTools, mcp: null },
      maxBudgetUsd: question.maxCostUsd,
    });
    try {
      const result = await this.runtime.waitForResult(run.id);
      return { text: result.result, costUsd: result.costUsd, isError: result.isError };
    } finally {
      await Promise.race([this.runtime.exited(run.id), new Promise((r) => setTimeout(r, 10_000).unref())]);
      this.runtime.remove(run.id);
    }
  }

  /**
   * The projects the person imported, each with the chats under it and its worktrees. Nothing is
   * discovered here: a directory Claude Code has run in is a project only once it is imported.
   */
  async projects(): Promise<Project[]> {
    const places = await this.chatPlaces();
    // Counted from the chat list the project's page shows, so the figure agrees with it: a chat this
    // process runs (a "Work on it", a flow or an assistant chat) counts before the CLI writes its transcript
    const listed = await this.chats.list();
    const worktrees = new Map<string, Map<string, ProjectWorktree>>();
    const stats = new Map<string, { chatCount: number; lastActivity: string | null }>();
    const addWorktree = (path: string, creator: ProjectWorktree['createdBy'] = null) => {
      const attached = this.attach(path);
      const facts = this.locator.worktreeOf(path);
      if (!attached || facts?.path !== path) return;
      const known = worktrees.get(attached.project.id) ?? new Map<string, ProjectWorktree>();
      known.set(path, { path, name: facts.name, branch: facts.branch, createdBy: creator ?? known.get(path)?.createdBy ?? null });
      worktrees.set(attached.project.id, known);
    };

    for (const place of places) {
      const attached = this.attach(place.cwd);
      if (attached?.worktree) addWorktree(attached.worktree.path);
    }
    for (const chat of listed) {
      if (!chat.project) continue;
      const stat = stats.get(chat.project.id) ?? { chatCount: 0, lastActivity: null };
      stat.chatCount += 1;
      if (chat.updatedAt && (!stat.lastActivity || chat.updatedAt > stat.lastActivity)) stat.lastActivity = chat.updatedAt;
      stats.set(chat.project.id, stat);
    }

    // The orchestration task that created a worktree says more about it than its name does, and a
    // worktree no chat has run in yet is only known from there
    for (const orch of this.orchestrator.list()) {
      for (const task of orch.tasks) {
        if (!task.branch) continue;
        const path = task.worktree ?? join(orch.cwd, '.claude', 'worktrees', task.branch.replace(/^worktree-/, ''));
        addWorktree(path, { orchestrationId: orch.id, orchestrationName: orch.name, taskId: task.id, taskName: task.name });
      }
    }

    // Where the CLI puts the worktrees it makes, for those nothing above has met
    for (const project of this.projectStore.list()) {
      const root = join(project.path, '.claude', 'worktrees');
      for (const name of await readdir(root).catch(() => [] as string[])) addWorktree(join(root, name));
    }

    const records = this.projectStore.list();
    const settings = await this.projectSettingsStore.readAll(records);
    return records.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      key: settings.get(p.id)?.keyPrefix ?? '',
      modules: settings.get(p.id)?.modules ?? [],
      // A worktree removed from disk is history, kept in the chats that ran there, not a place to go
      worktrees: [...(worktrees.get(p.id)?.values() ?? [])].filter((w) => existsSync(w.path)).sort((a, b) => a.path.localeCompare(b.path)),
      exists: existsSync(p.path),
      chatCount: stats.get(p.id)?.chatCount ?? 0,
      lastActivity: stats.get(p.id)?.lastActivity ?? null,
    }));
  }

  /** The worktrees the CLI recorded in its transcripts are what let a chat in one find its repository. */
  private async chatPlaces(): Promise<ChatPlace[]> {
    const sessions = await this.sessions.listSessions();
    for (const s of sessions) if (s.worktree) this.locator.learn(s.worktree);
    return sessions.map(placeOf);
  }

  /** The directories with the most chats that are not projects yet: what a first start offers to import. */
  async projectCandidates(): Promise<ProjectCandidate[]> {
    return projectCandidates(this.projectStore.list(), await this.chatPlaces(), (d) => this.locator.worktreeOf(d));
  }

  /**
   * Imports a directory and writes its settings from the template and modules asked for. A
   * directory that was a project before takes its old id back, and with it its settings and work
   * items.
   */
  async importProject(req: ImportProjectRequest): Promise<Project> {
    const setup = parseProjectSetup(req);
    const active = () => new Set(this.projectStore.list().map((p) => p.id));
    const imported = active();
    const record = await this.projectStore.add(
      { path: req.path, ...(req.name ? { name: req.name } : {}) },
      (d) => this.locator.worktreeOf(d),
      (path) => this.projectSettingsStore.idForPath(path, active()),
    );
    const { settings, previous } = await this.projectSettingsStore.create(record, setup, this.projectStore.list());
    // A directory imported again can come back with other modules: whoever shows its tabs has to know
    if (previous) this.projectUpdated(record, settingsChanges(previous, settings), settings.modules);
    // Other tabs list projects too, and the All projects board takes the new one in
    if (!imported.has(record.id)) this.events.emit({ type: 'project.created', title: `${record.name} added`, projectId: record.id, projectName: record.name });
    return this.projectView(record.id);
  }

  /** A new directory in the workspace, imported straight away. The template is checked before the directory exists. */
  async createProject(req: CreateProjectRequest): Promise<Project> {
    const setup = parseProjectSetup(req);
    const { name, gitUrl } = req as { name?: unknown; gitUrl?: unknown };
    if (typeof name !== 'string') throw new Error('name is required: the name of the new directory');
    if (gitUrl !== undefined && gitUrl !== null && typeof gitUrl !== 'string') throw new Error('gitUrl must be a URL to clone');
    const path = await this.workspace.create(req.name ?? '', req.gitUrl || undefined);
    return this.importProject({ path, ...(setup.template ? { template: setup.template } : {}), ...(setup.modules ? { modules: setup.modules } : {}) });
  }

  /** The five built-in templates, as data a wizard draws. */
  projectTemplates(): ProjectTemplate[] {
    return structuredClone([...PROJECT_TEMPLATES]);
  }

  /**
   * Renames a project, changes its key prefix or its modules. Everything is validated before
   * anything is written, so a prefix another project holds does not leave a rename half done.
   * Switching a module off only hides it: its data stays where it is.
   */
  async updateProject(id: string, req: UpdateProjectRequest): Promise<Project> {
    const record = this.requireProject(id);
    const body: Partial<Record<keyof UpdateProjectRequest, unknown>> = req && typeof req === 'object' ? req : {};
    if (body.name === undefined && body.key === undefined && body.modules === undefined) throw new Error('name, key or modules is required');
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) throw new Error('name is required');
    const key = body.key === undefined ? undefined : parseKeyPrefix(body.key);
    const modules = body.modules === undefined ? undefined : parseModules(body.modules);

    const active = this.projectStore.list();
    const { before, after } = await this.projectSettingsStore.update(record, (current) => ({ ...current, ...(key ? { keyPrefix: key } : {}), ...(modules ? { modules } : {}) }), active);
    const changes: ProjectChange[] = settingsChanges(before, after);
    let current = record;
    if (typeof body.name === 'string' && body.name.trim() !== record.name) {
      current = await this.projectStore.rename(id, body.name);
      if (current.name !== record.name) changes.push('name');
    }
    this.projectUpdated(current, changes, after.modules);
    return this.projectView(id);
  }

  /** The project's settings document, created on first read with every module off. */
  async projectSettings(id: string): Promise<ProjectSettings> {
    return this.projectSettingsStore.read(this.requireProject(id), this.projectStore.list());
  }

  /** Replaces the settings document whole, after validating it. */
  async saveProjectSettings(id: string, input: unknown): Promise<ProjectSettings> {
    const record = this.requireProject(id);
    const settings = parseProjectSettings(input);
    const active = this.projectStore.list();
    const before = await this.projectSettingsStore.read(record, active);
    await this.projectSettingsStore.write(record, settings, active);
    this.projectUpdated(record, settingsChanges(before, settings), settings.modules);
    return settings;
  }

  /**
   * What the team writes: only its team and its flow. The team hands back the whole document it
   * read, and writing all of it would put back a module switched since that read, and replace a part
   * a hand edit broke with the default the read answered for it.
   */
  private async saveTeamSettings(id: string, settings: ProjectSettings): Promise<ProjectSettings> {
    const record = this.requireProject(id);
    const { before, after } = await this.projectSettingsStore.update(
      record,
      (current) => {
        const { team: _team, flow: _flow, ...rest } = current;
        return parseProjectSettings({ ...rest, ...(settings.team ? { team: settings.team } : {}), ...(settings.flow ? { flow: settings.flow } : {}) });
      },
      this.projectStore.list(),
    );
    this.projectUpdated(record, settingsChanges(before, after), after.modules);
    return after;
  }

  private requireProject(id: string): ProjectRecord {
    const record = this.projectStore.get(id);
    if (!record) throw new Error('project not found');
    return record;
  }

  private projectUpdated(project: ProjectRecord, changes: ProjectChange[], modules: ProjectModule[]): void {
    if (!changes.length) return;
    this.events.emit({ type: 'project.updated', title: `${project.name} updated`, projectId: project.id, projectName: project.name, changes, modules });
  }

  /**
   * Forgets a project in Agentry. What Claude Code keeps about it is `purgeProject`, and is not
   * touched; neither are its settings document and work items, which importing it again brings back.
   */
  async removeProject(id: string): Promise<void> {
    const record = this.projectStore.get(id);
    await this.projectStore.remove(id);
    if (record) this.events.emit({ type: 'project.removed', title: `${record.name} removed`, projectId: record.id, projectName: record.name });
  }

  // ---------- journal and memory proposals ----------

  /**
   * The settings of a project whose journal or memory proposals are read or decided. Both need the
   * project imported; a change also needs its Memory module on. With the module off everything
   * stays, only hidden (decision 4).
   */
  async memoryProject(projectId: string, access: 'read' | 'write'): Promise<ProjectSettings> {
    const settings = await this.projectSettings(projectId);
    if (access === 'write' && !settings.modules.includes('memory')) {
      throw new WorkItemError("the Memory module is off in this project: switch it on in the project's settings to change its memory", 409);
    }
    return settings;
  }

  // ---------- the flow by column ----------

  /** `GET /projects/:id/flow`: readable with the flow off, as a project's other modules are. */
  projectFlow(projectId: string) {
    this.requireProject(projectId);
    return this.flow.projectFlow(projectId);
  }

  /** `GET /projects/:id/flow/waiting`: the cards switching the flow on left waiting; none while it is off. */
  projectFlowWaiting(projectId: string): FlowWaiting {
    this.requireProject(projectId);
    return this.flow.waiting(projectId);
  }

  /**
   * `POST /projects/:id/flow/start-waiting`: a person starts the waiting cards, one run each, as if
   * each had entered its column. 409 while the flow is off.
   */
  startWaitingFlowRuns(projectId: string): FlowStartWaitingResult {
    this.requireProject(projectId);
    return this.flow.startWaiting(projectId);
  }

  /**
   * Keeps the language an `Accept-Language` header names, when it names one of Agentry's: the panel
   * sends the person's with every request. A header that names none (`*`, which a script's fetch
   * sends, or another language) leaves the last one as it was.
   */
  noteLanguage(header: unknown): void {
    if (typeof header !== 'string') return;
    const named = header.split(',').some((tag) => (AGENTRY_LANGUAGES as readonly string[]).includes(tag.trim().toLowerCase().split(/[-_;]/)[0] ?? ''));
    if (named) this.language = agentryLanguage(header);
  }

  /** The person's language as the panel last said it. */
  personLanguage(): AgentryLanguage {
    return this.language;
  }

  /** `GET /projects/:id/flow/runs`: the team's activity, a page at a time; readable with the flow off. */
  projectFlowRuns(projectId: string, query: FlowRunQuery = {}): FlowRunPage {
    this.requireProject(projectId);
    return this.flow.page(projectId, query);
  }

  /** `GET /work-items/:itemId/runs`: every flow run of an item, newest first, readable as the item is. */
  async workItemRuns(itemId: string): Promise<FlowRun[]> {
    await this.workItemAccess(itemId, 'read');
    return this.flow.itemRuns(itemId);
  }

  /**
   * `POST /flow-runs/:runId/retry`: queues a failed run's step again, as a person's move. Writing to
   * the item, so its project must be imported, as for any change to it.
   */
  async retryFlowRun(runId: string): Promise<FlowRun> {
    const run = this.flow.run(runId);
    if (!run) throw new FlowError('flow run not found', 404);
    await this.workItemAccess(run.itemId, 'write');
    return this.flow.retry(runId);
  }

  // ---------- the project assistant ----------

  private async assistantProject(projectId: string): Promise<AssistantProject> {
    const record = this.projectStore.get(projectId);
    if (!record) throw new AssistantError('project not found', 404);
    if (!existsSync(record.path)) throw new AssistantError("the project's directory is missing on disk", 409);
    return { id: record.id, name: record.name, path: record.path, settings: await this.projectSettings(projectId) };
  }

  /** A project's runs are listed while it is imported, whatever its directory's state. */
  assistantProjectExists(projectId: string): void {
    if (!this.projectStore.get(projectId)) throw new AssistantError('project not found', 404);
  }

  private assistantScope(project: AssistantProject, scope: 'project' | 'user'): ConfigScope {
    return scope === 'project' ? projectScope(project.path) : userScope(this.config);
  }

  /**
   * What a run is handed beside its directory. Each part is read on its own and a part that cannot be
   * read counts as none: the run can still read the directory, which is what it is for.
   */
  private async assistantKnown(project: AssistantProject): Promise<AssistantKnown> {
    const quiet = async <T>(read: () => Promise<T> | T, fallback: T): Promise<T> => {
      try {
        return await read();
      } catch {
        return fallback;
      }
    };
    const scope = projectScope(project.path);
    const [memory, agents, skills, commands, sessions] = await Promise.all([
      quiet(() => this.memory.list(encodeProjectId(project.path)), []),
      quiet(async () => (await this.resources.list(scope, 'agents')).map((r) => r.name), [] as string[]),
      quiet(async () => (await this.resources.list(scope, 'skills')).map((r) => r.name), [] as string[]),
      quiet(async () => (await this.resources.list(scope, 'commands')).map((r) => r.name), [] as string[]),
      quiet(() => this.sessions.listSessions(encodeProjectId(project.path)), []),
    ]);
    const journal = await quiet(() => this.journal.handoff(project.id), { text: '', entries: 0, bytes: 0 });
    const items = await quiet(() => this.workItems.list({ projectId: project.id }), []);
    const milestones = await quiet(() => this.workItems.milestones(project.id).filter((m) => m.state === 'open').map((m) => m.name), [] as string[]);
    const commits = !isGitRepo(project.path) ? null : await quiet(() => Number(git(project.path, ['rev-list', '--count', 'HEAD'], 10_000)) || 0, 0);
    const chats = [...sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const instructions = await quiet(async () => {
      const file = join(project.path, 'CLAUDE.md');
      return existsSync(file) ? await readFile(file, 'utf8') : null;
    }, null);
    return {
      facts: {
        memoryFiles: memory.length,
        journalEntries: journal.entries,
        workItems: items.length,
        milestones,
        teamMembers: project.settings.team?.members.length ?? 0,
        resources: [...agents, ...skills, ...commands],
        chats: chats.length,
        commits,
      },
      journal: journal.text,
      chats: chats.map((c) => (c.firstPrompt ?? c.title).replace(/\s+/g, ' ').trim().slice(0, 140)).filter(Boolean),
      resources: { agents, skills, commands },
      instructions,
      git: await quiet(() => assistantGit(project.path), null),
    };
  }

  /**
   * Starts an assistant run's chat in the project's directory: confined to the read tools (the only
   * ones it has, kept to the directory) in `dontAsk`, with no settings source, MCP server, preset or
   * uploads directory, the journal and CLAUDE.md appended but never recorded, the result held to the
   * run's schema, and one turn. A run a restart cut off continues in its own chat, confined again.
   */
  private async launchAssistantRun(launch: AssistantLaunch, onStart: (chatId: string) => void): Promise<void> {
    const options = {
      model: launch.model,
      appendSystemPrompt: launch.appendSystemPrompt || undefined,
      permissionMode: launch.permissionMode,
      allowedTools: launch.allowedTools,
      disallowedTools: launch.disallowedTools,
      toolPreset: null,
      mcp: { servers: [] },
      permissionPrompts: 'none' as const,
    };
    const confine: ChatConfinement = { tools: launch.tools, settingSources: [] };
    // Not recorded, as for a member's run: the CLI would otherwise send the run's prompt, rendered
    // for a confined session, to a person who continues the chat after the run
    const extras = { jsonSchema: launch.jsonSchema, keepAlive: false, confine, systemPromptSnapshot: 'off' as const };
    if (launch.resumeChatId) {
      onStart(launch.resumeChatId);
      await this.chats.resume(launch.resumeChatId, { ...options, prompt: launch.prompt }, extras);
      return;
    }
    await this.chats.create({ ...options, ...extras, prompt: launch.prompt, cwd: launch.cwd }, (started) => onStart(started.id));
  }

  /**
   * A member the assistant proposed, added through the team service. When the run wrote its own
   * instructions, their file is written first, where no file of that name exists, so the team keeps
   * it as the person's; if the team then refuses the member, the file goes with it.
   */
  private async addAssistantMember(project: AssistantProject, member: ProjectTeamMember, content: string | null): Promise<void> {
    const dir = join(project.path, '.claude', 'agents');
    const file = join(dir, `${member.agent}.md`);
    let wrote = false;
    if (content !== null && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(member.agent) && !existsSync(file)) {
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(file, content, { flag: 'wx' });
        wrote = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    try {
      await this.team.putMember(project.id, member.agent, { ...member, createFile: true });
    } catch (err) {
      if (wrote) await rm(file, { force: true });
      throw err;
    }
  }

  /**
   * A chat Agentry started for a run of its own, the flow's or the assistant's: a person who
   * continues it gets it back without the run's rules (`ChatService.resume`).
   */
  private memberChat(chatId: string): boolean {
    try {
      return this.flow.ranChat(chatId) || !!this.db.connection.prepare('SELECT 1 FROM assistant_runs WHERE chat_id = ? LIMIT 1').get(chatId);
    } catch {
      return false;
    }
  }

  /**
   * Starts a flow run's chat, as the member's agent with its model, the journal appended to the
   * system prompt, the stage's rules and budget, and the result held to the run's schema. Working
   * and verifying happen in the item's own worktree, which first gets the item's tied documents from
   * the checkout, where the refine wrote them (`syncItemDocuments`); refining in the checkout. A
   * Developer's run continues its own chat from an earlier round, or starts one if that chat cannot
   * be continued; a run a restart cut off continues in its chat or fails.
   */
  private async launchFlowRun(launch: FlowLaunch, onStart: (chatId: string) => void): Promise<void> {
    const { item, member, run } = launch;
    const record = this.requireProject(item.projectId);
    if (!existsSync(record.path)) throw new Error(`the project's directory ${record.path} is missing`);
    const agentsFile = await this.flowAgentsFile(record.path, member);
    const place = launch.inWorktree ? itemWorktree(record.path, item) : null;
    if (place && (place.worktree !== item.worktree || place.branch !== item.branch)) {
      this.workItems.setWorktree(item.id, { worktree: place.worktree, branch: place.branch });
    }
    let prompt = launch.prompt;
    if (place) {
      // Before any chat: a resumed Developer's chat, or one a restart cut off, needs the spec too
      const settings = await this.projectSettings(item.projectId);
      const sync = await syncItemDocuments({
        item,
        links: this.workItems.links(item.id),
        projectPath: record.path,
        documentsRoot: settings.documents?.path ?? DEFAULT_DOCUMENTS_PATH,
        place,
      }).catch((err: unknown) => {
        throw new ItemDocumentsError(`the item's documents could not be brought into its worktree: ${err instanceof Error ? err.message : String(err)}`);
      });
      for (const s of sync.skipped) console.warn(`[flow] ${item.key}: document ${s.path} not brought into the worktree: ${s.reason}`);
      const line = documentsLine(sync.present);
      // The short "carry on" prompt of a restart keeps to itself: the chat was already told
      if (line && !launch.continuing) prompt = withDocumentsLine(prompt, line);
    }
    const options = {
      model: member.model,
      appendSystemPrompt: launch.appendSystemPrompt || undefined,
      permissionMode: launch.permissionMode,
      allowedTools: launch.allowedTools,
      disallowedTools: launch.disallowedTools,
      ...(launch.maxBudgetUsd !== null ? { maxBudgetUsd: launch.maxBudgetUsd } : {}),
      toolPreset: null,
      permissionPrompts: 'none' as const,
    };
    const extras = { agent: member.agent, agentsFile, jsonSchema: launch.jsonSchema, systemPromptSnapshot: 'off' as const, uploads: false as const, keepAlive: false };
    const link = (chatId: string): void => {
      try {
        this.workItems.link(item.id, { kind: 'chat', role: run.stage, chatId, teamRole: member.role }, { actor: { kind: 'agent', role: member.role } });
      } catch {
        // The run knows its chat, and its result still lands; only the item's list of chats misses it
      }
    };
    if (launch.resumeChatId) {
      const chatId = launch.resumeChatId;
      // Told first: the result is matched to the run by its chat, and may not wait for the resume to return
      onStart(chatId);
      try {
        await this.chats.resume(chatId, { ...options, prompt }, extras);
        link(chatId);
        return;
      } catch (err) {
        // A new chat would know nothing of the run it is meant to carry on
        if (launch.continuing) throw err;
        // otherwise falls through to a chat of its own
      }
    }
    await this.chats.create({ ...options, ...extras, prompt, cwd: place?.cwd ?? record.path }, (started) => {
      onStart(started.id);
      link(started.id);
    });
  }

  /**
   * The member's definition for `--agents`, from the agent file in the project's checkout: the item's
   * worktree only has the agent files that were committed, and the file a person edits in Agentry is
   * the one that should run. It carries what the file says of the agent (its tools, the tools it is
   * denied, as a list in either YAML form) and the member's model, which is Agentry's to set, so a
   * file's `model` never runs a role on a model its screen does not show. Named by its content, so
   * the same definition is one file.
   */
  private async flowAgentsFile(projectPath: string, member: ProjectTeamMember): Promise<string> {
    const { agent } = member;
    const source = join(projectPath, '.claude', 'agents', `${agent}.md`);
    let content: string;
    try {
      content = await readFile(source, 'utf8');
    } catch {
      throw new Error(`the agent file .claude/agents/${agent}.md is missing: write it again from the Team screen`);
    }
    const fields = readFrontmatter(content);
    const prompt = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
    const tools = readFrontmatterList(content, 'tools');
    const disallowedTools = readFrontmatterList(content, 'disallowedTools');
    const definition = {
      [agent]: {
        description: fields.description || agent,
        prompt: prompt || fields.description || agent,
        model: member.model,
        ...(tools?.length ? { tools } : {}),
        ...(disallowedTools?.length ? { disallowedTools } : {}),
      },
    };
    const body = `${JSON.stringify(definition, null, 2)}\n`;
    const dir = join(this.config.dataDir, 'flow-agents');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`);
    await writeFile(file, body, { mode: 0o600 });
    return file;
  }

  // ---------- work items ----------
  //
  // A project whose Board module is off keeps its items, and they stay readable so nothing looks
  // lost; what it refuses is a change. A project removed from Agentry keeps them too, for the day
  // its directory is imported again, but it is not a place anything is created in.

  /**
   * The settings of a project its work items are read or written in. A write needs the project
   * imported and its Board module on; a read only needs it imported.
   */
  async workItemProject(projectId: string, access: 'read' | 'write'): Promise<ProjectSettings> {
    const settings = await this.projectSettings(projectId);
    if (access === 'write' && !settings.modules.includes('board')) {
      throw new WorkItemError("the Board module is off in this project: switch it on in the project's settings to change its work items", 409);
    }
    return settings;
  }

  /**
   * The documents folder of an imported project. A write needs its Documents module on; a read does
   * not, as the board's reads do not need the Board module.
   */
  private async documentsPlace(projectId: string, access: 'read' | 'write'): Promise<DocumentsPlace> {
    const record = this.requireProject(projectId);
    const settings = await this.projectSettings(projectId);
    if (access === 'write' && !settings.modules.includes('documents')) {
      throw new DocumentError("the Documents module is off in this project: switch it on in the project's settings to change its documents", 409);
    }
    return { projectPath: record.path, root: settings.documents?.path ?? DEFAULT_DOCUMENTS_PATH };
  }

  /** The item, after the same check on the project it belongs to. Reads of a removed project's items still work. */
  async workItemAccess(itemId: string, access: 'read' | 'write'): Promise<WorkItem> {
    const item = this.workItems.find(itemId);
    if (!item) throw new WorkItemError('work item not found', 404);
    await this.ownerAccess(item.projectId, access);
    return item;
  }

  /** The milestone, after the same check on its project. */
  async milestoneAccess(milestoneId: string, access: 'read' | 'write'): Promise<Milestone> {
    const milestone = this.workItems.milestone(milestoneId);
    await this.ownerAccess(milestone.projectId, access);
    return milestone;
  }

  private async ownerAccess(projectId: string, access: 'read' | 'write'): Promise<void> {
    if (this.projectStore.get(projectId)) await this.workItemProject(projectId, access);
    else if (access === 'write') throw new WorkItemError('its project is not imported: import the directory again to change it', 409);
  }

  /**
   * The All projects list: the items of every imported project whose Board module is on, as cards
   * (descriptions left out).
   */
  async allWorkItems(filter: Omit<WorkItemFilter, 'projectId'> = {}): Promise<WorkItem[]> {
    return this.workItems.cards(filter, await this.boardProjects());
  }

  /** The All projects list a page at a time. */
  async allWorkItemsPage(filter: Omit<WorkItemFilter, 'projectId'> = {}, query: WorkItemPageQuery = {}): Promise<WorkItemPage> {
    return this.workItems.page(filter, query, await this.boardProjects());
  }

  /**
   * The All projects board, counted over the projects shown only: the store's own counts would take
   * in the hidden ones, projects removed or with their board off.
   */
  async allWorkItemsBoard(filter: Omit<WorkItemFilter, 'projectId'> = {}, query: BoardQuery = {}): Promise<Board> {
    return this.workItems.board(null, filter, query, await this.boardProjects());
  }

  /**
   * The item a key names, with its page. An imported project's item wins over a removed project's
   * that had the same prefix; a removed project's item is still found when it is the only one, as
   * it is still readable by id.
   */
  async workItemByKey(key: string): Promise<WorkItemDetail> {
    const imported = new Set(this.projectStore.list().map((p) => p.id));
    const found = this.workItems.withKey(key);
    const item = found.find((i) => imported.has(i.projectId)) ?? found[0];
    if (!item) throw new WorkItemError('work item not found', 404);
    return this.workItemDetail(item.id);
  }

  private async boardProjects(): Promise<Set<string>> {
    const records = this.projectStore.list();
    const settings = await this.projectSettingsStore.readAll(records);
    return new Set([...settings].filter(([, s]) => s.modules.includes('board')).map(([id]) => id));
  }

  /**
   * What a link points at now, from what this process holds in memory: a chat it runs, a task of an
   * orchestration it knows. A chat that is not live here reads with no name and no state.
   */
  private workItemLinkState(link: WorkItemLink): WorkItemLinkState | null {
    const chat = link.chatId ? this.runtime.get(link.chatId) : null;
    const chatState = chat ? stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }) : null;
    if (link.kind === 'orchestration' && link.orchestrationId) {
      const task = this.orchestrator.get(link.orchestrationId)?.tasks.find((t) => t.id === link.taskId);
      return { name: task?.name ?? null, taskStatus: task?.status ?? null, chatState };
    }
    return { name: chat ? chatLinkName(chat) : null, chatState };
  }

  /**
   * A chat link this process does not run (a terminal chat an item was created from, say) read from
   * the chat list, which is asynchronous and so cannot be what the store fills links with.
   */
  private async namedLinks(links: WorkItemLink[]): Promise<WorkItemLink[]> {
    return Promise.all(
      links.map(async (link) => {
        if (link.kind !== 'chat' || !link.chatId || link.name) return link;
        const chat = await this.chats.summaryOf(link.chatId).catch(() => null);
        return chat ? { ...link, name: chat.title, chatState: chat.state } : link;
      }),
    );
  }

  /**
   * The history with every chat named by its title. A chat link's entry is written with the name
   * this process knew, and a chat it does not run (a terminal chat an item was created from) had
   * none then, so it was written as `chat <id>`: its title is looked up now, when it is read.
   */
  private async namedHistory(entries: WorkItemHistoryEntry[]): Promise<WorkItemHistoryEntry[]> {
    const unnamed = (value: WorkItemHistoryValue): string | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('label' in value) || 'key' in value) return null;
      return /^chat (\S+)$/.exec(value.label)?.[1] ?? null;
    };
    const ids = [...new Set(entries.filter((e) => e.change === 'link').flatMap((e) => [unnamed(e.from), unnamed(e.to)]).filter((id): id is string => !!id))];
    if (!ids.length) return entries;
    const titles = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        const title = (await this.chats.summaryOf(id).catch(() => null))?.title?.trim();
        if (title) titles.set(id, title);
      }),
    );
    const named = (value: WorkItemHistoryValue): WorkItemHistoryValue => {
      const id = unnamed(value);
      const title = id ? titles.get(id) : undefined;
      return title && value && typeof value === 'object' && 'label' in value ? { ...value, label: title } : value;
    };
    return entries.map((e) => (e.change === 'link' ? { ...e, from: named(e.from), to: named(e.to) } : e));
  }

  /** `GET /work-items/:itemId/history`, with every chat named. */
  async workItemHistory(itemId: string): Promise<WorkItemHistoryEntry[]> {
    await this.workItemAccess(itemId, 'read');
    return this.namedHistory(this.workItems.history(itemId));
  }

  /** The item's page, with every link and every chat of its history named. */
  async workItemDetail(itemId: string): Promise<WorkItemDetail> {
    await this.workItemAccess(itemId, 'read');
    const detail = this.workItems.get(itemId);
    const path = this.projectStore.get(detail.projectId)?.path;
    const [links, history, pullRequestReadiness] = await Promise.all([
      this.namedLinks(detail.links),
      this.namedHistory(detail.history),
      path ? this.pullRequests.readiness(path).catch(() => null) : Promise.resolve(null),
    ]);
    return { ...detail, links, history, pullRequestReadiness };
  }

  /**
   * A project's board, with whether approving opens a pull request and how its checkout stands
   * against the default branch: both from git and gh, the second from local git only.
   */
  async workItemBoard(projectId: string, filter: Omit<WorkItemFilter, 'projectId'> = {}, query: BoardQuery = {}): Promise<Board> {
    await this.workItemProject(projectId, 'read');
    const board = this.workItems.board(projectId, filter, query);
    const path = this.projectStore.get(projectId)?.path;
    const readiness = path ? await this.pullRequests.readiness(path).catch(() => null) : null;
    const checkout = path && readiness?.status === 'ready' && readiness.defaultBranch ? this.pullRequests.checkout(path, readiness.defaultBranch) : null;
    return { ...board, pullRequestReadiness: readiness, checkout };
  }

  /** `POST /work-items/:itemId/pull-request`: the person's approval opens the item's pull request. */
  async approveWorkItem(itemId: string): Promise<ApproveResult> {
    await this.workItemAccess(itemId, 'write');
    return this.pullRequests.approve(itemId);
  }

  /** `POST /work-items/:itemId/pull-request/refresh`: asks gh about the item's open PR now. */
  async refreshWorkItemPullRequest(itemId: string): Promise<WorkItem> {
    await this.workItemAccess(itemId, 'read');
    return this.pullRequests.refresh(itemId);
  }

  async workItemLinks(itemId: string): Promise<WorkItemLink[]> {
    await this.workItemAccess(itemId, 'read');
    return this.namedLinks(this.workItems.links(itemId));
  }

  /**
   * "Work on it": a chat in the project, in the item's own worktree (made the first time, found
   * again after), prompted with the item. The chat is linked in the tick it is spawned, before any
   * of its output can arrive, so the item follows it from its very first status.
   */
  async workOnItem(itemId: string, request?: WorkOnWorkItemRequest): Promise<WorkOnWorkItemResult> {
    const item = await this.workItemAccess(itemId, 'write');
    const record = this.requireProject(item.projectId);
    this.checkWorkable(item);
    const options = startOptions(request);
    if (!existsSync(record.path)) throw new WorkItemError(`the project's directory ${record.path} is missing`, 409);
    const place = itemWorktree(record.path, item);
    if (place && (place.worktree !== item.worktree || place.branch !== item.branch)) {
      this.workItems.setWorktree(itemId, { worktree: place.worktree, branch: place.branch });
    }
    const linked: { link?: WorkItemLink } = {};
    const chat = await this.chats.create({ ...options, prompt: workItemPrompt(item), cwd: place?.cwd ?? record.path }, (started) => {
      try {
        linked.link = this.workItems.link(itemId, { kind: 'chat', role: 'work', chatId: started.id });
      } catch (err) {
        // A chat nobody can find from its item would work unseen: it goes with the failed request
        this.runtime.stop(started.id);
        throw err;
      }
      this.workLinks.chatStarted(started.id);
    });
    if (!linked.link) throw new ChatStartError('the chat started without being linked to its work item');
    return { item: this.workItems.find(itemId) ?? item, chat, link: linked.link };
  }

  /**
   * What "Work on it", a draft and a launch all refuse, the same way: an epic, which groups work
   * rather than being it; an item in done, which nothing an agent does may take out of it; and an
   * item a chat or a node is working on now, which a second one would pull two ways.
   */
  private checkWorkable(item: WorkItem, label = ''): void {
    if (item.type === 'epic') throw new WorkItemError(`${label}${item.key} is an epic, which groups work items: work on one of them instead`, 400);
    if (item.status === 'done') throw new WorkItemError(`${label}${item.key} is already done: move it back first to work on it again`, 409);
    const busy = this.workItems.links(item.id).find((l) => l.role === 'work' && (l.chatState === 'working' || l.chatState === 'waiting' || l.taskStatus === 'running'));
    if (busy) throw new WorkItemError(`${label}${item.key} is already being worked on${busy.name ? ` by ${busy.name}` : ''}`, 409);
  }

  /**
   * The graph a selection of one project's items becomes, for the person to review: nothing is
   * launched. The existing launch route takes it as it is and links each node to its item.
   */
  async orchestrateWorkItems(projectId: string, request?: OrchestrateWorkItemsRequest, language: AgentryLanguage = 'en'): Promise<WorkItemOrchestrationDraft> {
    await this.workItemProject(projectId, 'write');
    const record = this.requireProject(projectId);
    const ids: unknown = request?.itemIds;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) {
      throw new WorkItemError('itemIds must list the work items to orchestrate', 400);
    }
    if (new Set(ids).size !== ids.length) throw new WorkItemError('a work item is selected twice', 400);
    const items = (ids as string[]).map((id) => {
      const item = this.workItems.find(id);
      if (!item || item.projectId !== projectId) throw new WorkItemError(`${id} is not a work item of this project`, 400);
      this.checkWorkable(item);
      return item;
    });
    return orchestrationDraft(record, items, canBranch(record.path), language);
  }

  /**
   * Launches a graph. A node that names a work item must name one that may be changed, and only one
   * node per item: the item follows its node, and two nodes would pull it two ways.
   */
  async launchOrchestration(spec: OrchestrationSpec): Promise<Orchestration> {
    await this.checkWorkItemNodes(spec?.tasks, spec?.cwd);
    return this.orchestrator.create(spec);
  }

  /** A relaunch names its items as the first launch did, and is held to the same checks. */
  async relaunchOrchestration(id: string, changes: RelaunchOrchestrationRequest = {}): Promise<Orchestration> {
    const spec = this.orchestrator.relaunchSpec(id, changes);
    await this.checkWorkItemNodes(spec.tasks, spec.cwd);
    return this.orchestrator.create(spec, { relaunchedFrom: id });
  }

  private async checkWorkItemNodes(tasks: unknown, cwd: unknown): Promise<void> {
    const seen = new Set<string>();
    for (const task of Array.isArray(tasks) ? (tasks as Array<Partial<OrchestrationSpec['tasks'][number]> | null>) : []) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new WorkItemError('every task must be an object with an id and a prompt', 400);
      const itemId: unknown = task?.workItemId;
      if (itemId === undefined) continue;
      const label = `task '${String(task?.id)}'`;
      if (typeof itemId !== 'string' || !itemId) throw new WorkItemError(`${label}: workItemId must name a work item`, 400);
      if (seen.has(itemId)) throw new WorkItemError(`${label}: another node already works on that work item`, 400);
      seen.add(itemId);
      const item = this.workItems.find(itemId);
      if (!item) throw new WorkItemError(`${label}: work item ${itemId} not found`, 400);
      await this.ownerAccess(item.projectId, 'write');
      // A node moves its item as it works, so it must work in the item's project: a link made by
      // hand is held to the same
      const dir = typeof task.cwd === 'string' && task.cwd ? task.cwd : typeof cwd === 'string' && cwd ? cwd : this.config.workspaceDir;
      if (this.projectOf(resolve(dir)).project?.id !== item.projectId) {
        throw new WorkItemError(`${label}: ${item.key} is a work item of another project, and the graph does not run in its project`, 400);
      }
      // As "Work on it" is held to: a launch is the other way to put an agent on the item
      this.checkWorkable(item, `${label}: `);
    }
  }

  /**
   * A chat or a task linked to an item by hand. It must exist and belong to the item's project:
   * a link to nothing reads as work that is not there, and one to another project's chat would move
   * the item with work done elsewhere.
   */
  async linkWorkItem(itemId: string, request: CreateWorkItemLinkRequest): Promise<WorkItemLink> {
    const item = await this.workItemAccess(itemId, 'write');
    const input: Partial<Record<keyof CreateWorkItemLinkRequest, unknown>> = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
    if (input.kind === 'chat' && typeof input.chatId === 'string' && input.chatId) {
      const chat = await this.chats.summaryOf(input.chatId);
      if (!chat) throw new WorkItemError(`chat ${input.chatId} not found`, 400);
      if (chat.project?.id !== item.projectId) throw new WorkItemError(`chat ${input.chatId} is not a chat of this item's project`, 400);
    }
    if (input.kind === 'orchestration' && typeof input.orchestrationId === 'string' && input.orchestrationId) {
      const orch = this.orchestrator.get(input.orchestrationId);
      if (!orch) throw new WorkItemError(`orchestration ${input.orchestrationId} not found`, 400);
      if (typeof input.taskId === 'string' && !orch.tasks.some((t) => t.id === input.taskId)) {
        throw new WorkItemError(`orchestration ${orch.name} has no task ${input.taskId}`, 400);
      }
      if (this.projectOf(orch.cwd).project?.id !== item.projectId) throw new WorkItemError(`orchestration ${orch.name} does not run in this item's project`, 400);
    }
    return this.workItems.link(itemId, request);
  }

  /** "Create a task from this message": an item in `backlog` of the chat's project, linked to the chat it came from. */
  async workItemFromMessage(chatId: string, request?: CreateWorkItemFromMessageRequest): Promise<WorkItem> {
    const text: unknown = request?.text;
    if (typeof text !== 'string' || !text.trim()) throw new WorkItemError('text is required: the message the task is made from', 400);
    const chat = await this.chats.summaryOf(chatId);
    if (!chat) throw new Error('chat not found');
    const projectId = chat.project?.id;
    if (!projectId) throw new WorkItemError('this chat is not in an imported project, so there is no board to add the task to', 409);
    await this.workItemProject(projectId, 'write');
    const cause: WorkItemCause = {
      kind: 'chat',
      chatId,
      orchestrationId: chat.orchestration?.id ?? null,
      taskId: chat.orchestration?.taskId ?? null,
      event: WORK_CAUSE.message,
    };
    const item = this.workItems.create(
      projectId,
      {
        title: typeof request?.title === 'string' && request.title.trim() ? request.title : titleFromMessage(text),
        description: text,
        status: 'backlog',
        ...(request?.type !== undefined ? { type: request.type } : {}),
        ...(request?.priority !== undefined ? { priority: request.priority } : {}),
      },
      { cause },
    );
    this.workItems.link(item.id, { kind: 'chat', role: 'origin', chatId }, { cause });
    return this.workItems.find(item.id) ?? item;
  }

  /** The items a chat worked on or created, for its header. Those of projects no longer imported are left out. */
  workItemsOfChat(chatId: string): WorkItem[] {
    const imported = new Set(this.projectStore.list().map((p) => p.id));
    const ids = [...new Set(this.workItems.linksOfChat(chatId).map((l) => l.itemId))];
    return this.workItems.cardsOf(ids).filter((item) => imported.has(item.projectId));
  }

  /** What the item's own branch changed, read as a chat's worktree is. */
  async workItemChanges(itemId: string, scope: ChangeScope = {}): Promise<WorkItemChanges> {
    const item = await this.workItemAccess(itemId, 'read');
    const path = this.projectStore.get(item.projectId)?.path ?? item.worktree ?? '';
    return { worktree: item.worktree, branch: item.branch, summary: this.changes.itemChanges(path, item, scope) };
  }

  async workItemDiff(itemId: string, path: string, opts: DiffOptions = {}): Promise<FileDiff> {
    const item = await this.workItemAccess(itemId, 'read');
    return this.changes.itemDiff(this.projectStore.get(item.projectId)?.path ?? item.worktree ?? '', item, path, opts);
  }

  /**
   * A project and its chats, oldest first, for an export written one chat at a time. An unknown
   * project fails here, before anything is written, so it can still be answered with a 404.
   */
  async projectExport(id: string): Promise<ProjectExportSource> {
    const project = await this.projectView(id);
    const chats = (await this.chats.list({ project: id, origins: EXPORTED_ORIGINS })).sort(byStart);
    return { exportedAt: new Date().toISOString(), project, chats, load: (chatId) => this.chats.export(chatId) };
  }

  private async projectView(id: string): Promise<Project> {
    const project = (await this.projects()).find((p) => p.id === id);
    if (!project) throw new Error('project not found');
    return project;
  }

  async overview(): Promise<Overview> {
    // The same lists the screens show, so a count can never disagree with the page it links to; read
    // in one pass, not once per kind
    const [system, chats, { tasks, subagents, workflows }] = await Promise.all([
      this.system(),
      this.chats.list({ origins: ['agentry', 'external', 'orchestration'] }),
      this.chats.allActivity(),
    ]);
    return {
      system,
      rateLimit: this.runtime.lastRateLimit,
      accounts: this.accounts.snapshot(),
      counts: {
        projects: this.projectStore.list().length,
        chats: chats.length,
        chatsWorking: chats.filter((c) => c.state === 'working').length,
        chatsWaiting: chats.filter((c) => c.state === 'waiting').length,
        backgroundTasks: tasks.filter((t) => t.status === 'running').length,
        subagents: subagents.filter((s) => s.status === 'running').length,
        workflows: workflows.filter((w) => w.status === 'running').length,
        orchestrationsRunning: this.orchestrator.runningCount(),
      },
      recentChats: chats.slice(0, 10),
    };
  }

  /** Reads through to claude-swap and keeps the credential ownership in sync. */
  async accountsOverview(refresh = false): Promise<AccountsOverview> {
    const overview = await this.accounts.overview(refresh);
    this.syncCredentialOwner();
    return overview;
  }

  shutdown(): void {
    this.pullRequestWatcher.stop();
    // First, while the database is still open for the row that says its host left
    this.tunnel.shutdown();
    this.cliVersion.stop();
    this.release.stop();
    this.healthMonitor.stop();
    this.decisions.stop();
    this.orchestrator.close();
    this.schedules.close();
    this.sessionsWatcher.close();
    this.changeWatcher.close();
    this.permissions.close();
    this.push.close();
    this.accounts.shutdown();
    this.runtime.stopAll();
    this.db.close();
  }
}
