import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AccountsOverview,
  AuthVerification,
  ChatSummary,
  ConfigFileRoot,
  MemoryProjectSummary,
  Overview,
  PermissionDecision,
  PermissionRequest,
  ProjectSummary,
  RunWorkflowRequest,
  SwitchResult,
  SystemInfo,
  WorkflowDefinition,
  WorkLocation,
} from '@agentry/shared';
import pkg from '../package.json' with { type: 'json' };
import { AccountManager } from './accounts.ts';
import { ChatService, type Placement } from './chat-service.ts';
import { ChatManager, type ChatRuntime } from './chats.ts';
import type { TranscriptSummary } from './cli-facts.ts';
import { detectCli, execCli, getAuthStatus } from './cli.ts';
import { ConfigExplorer } from './config/explorer.ts';
import { SettingsFiles } from './config/files.ts';
import { CredentialStore, type StoredCredentials } from './credentials.ts';
import { Db } from './db.ts';
import { permissionEvents, runRef, runRefOr, SessionsWatcher } from './event-sources.ts';
import { EventBus } from './events.ts';
import { Locator } from './locations.ts';
import { PermissionBroker } from './permissions.ts';
import { McpConfig } from './config/mcp.ts';
import { MarkdownResources } from './config/resources.ts';
import { projectScope, userScope, type ConfigScope } from './config/scope.ts';
import { Plugins } from './plugins.ts';
import { UploadStore } from './uploads.ts';
import { MemoryStore } from './memory.ts';
import { Orchestrator } from './orchestrator.ts';
import { loadConfig, type CoreConfig } from './paths.ts';
import { isTemporaryPath, SessionStore } from './sessions.ts';
import { listWorkflowDefinitions } from './workflows.ts';
import { encodeProjectId, Workspace } from './workspace.ts';

export { parseMcpScope } from './config/mcp.ts';
export { RESOURCE_KINDS } from './config/resources.ts';
export { parseVariant, type ConfigScope } from './config/scope.ts';
export { loadConfig, type CoreConfig } from './paths.ts';
export type { AdoptedChat, ChatRuntime, NewChat, RunResult } from './chats.ts';
export { ChatConflictError, DEFAULT_ORIGINS, type ChatFilter, type Placement } from './chat-service.ts';
export { DEFAULT_AUTO_SWITCH } from './accounts.ts';
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
export { Db } from './db.ts';
export { EventBus, type AgentryEventInput, type Replay } from './events.ts';

// Read from the package rather than written into this file: the release tooling then only edits
// package.json files, and never has to rewrite source to bump a version.
const AGENTRY_VERSION = pkg.version;
const SYSTEM_TTL_MS = 30_000;

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
  readonly files: SettingsFiles;
  readonly explorer: ConfigExplorer;
  readonly plugins: Plugins;
  readonly memory: MemoryStore;
  readonly mcp: McpConfig;
  readonly resources: MarkdownResources;
  readonly credentials: CredentialStore;
  readonly uploads: UploadStore;
  readonly accounts: AccountManager;
  readonly workspace: Workspace;
  readonly locator = new Locator();
  private readonly startedAt = Date.now();
  private readonly sessionsWatcher: SessionsWatcher;
  private systemCache: { at: number; value: Omit<SystemInfo, 'uptimeSec'> } | null = null;

  constructor(config: CoreConfig = loadConfig()) {
    this.config = config;
    this.db = new Db(config);
    this.permissions = new PermissionBroker();
    // Must run before anything spawns the CLI: it injects stored credentials into process.env
    this.credentials = new CredentialStore(config);
    this.workspace = new Workspace(config);
    this.uploads = new UploadStore(config.dataDir);
    this.runtime = new ChatManager(config, this.db);
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
    this.sessions = new SessionStore(config);
    this.orchestrator = new Orchestrator(config, this.runtime, this.db);
    this.orchestrator.bus = this.events;
    this.orchestrator.workflowRecords = (sessionId) => this.sessions.workflows(sessionId, true);
    this.chats = new ChatService({
      config,
      runtime: this.runtime,
      sessions: this.sessions,
      orchestrator: this.orchestrator,
      place: (dir, recorded) => this.place(dir, recorded),
      environmentOf: (dir) => this.runtime.environments.get(dir),
      windowOf: (model) => this.db.modelWindow(model),
    });
    this.files = new SettingsFiles();
    this.explorer = new ConfigExplorer();
    this.plugins = new Plugins(config);
    this.memory = new MemoryStore(config);
    void this.runtime.restore(this.sessions);
    this.mcp = new McpConfig(config);
    this.resources = new MarkdownResources();
    this.accounts = new AccountManager(config, this.db);
    this.runtime.accounts = this.accounts;
    this.accounts.on('switched', (result: SwitchResult) => {
      this.systemCache = null; // the active account (and its email) changed
      this.events.emit({
        type: 'account.switched',
        title: `Switched account${result.to ? ` to ${result.to}` : ''}`,
        from: result.from,
        to: result.to,
        reason: result.reason,
      });
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
    this.systemCache = null;
  }

  /**
   * A run died against its account's rate limit: rotate to the account with the most headroom
   * left and replay the turn, which resumes the same session on the new credential.
   */
  private async rotateAndResume(run: ChatRuntime): Promise<void> {
    if (!this.accounts.autoSwitch.rotateOnLimit || !this.accounts.managed) return;
    try {
      const result = await this.accounts.rotate(`run ${run.name} hit its rate limit`);
      if (!result.switched) {
        this.runtime.notice(run.id, `Rate limit reached and no account with quota left${result.reason ? ` (${result.reason})` : ''}.`);
        return;
      }
      this.systemCache = null;
      const target = result.to ?? 'another account';
      // An orchestration worker already handed its result to the orchestrator: rotating helps the
      // tasks that come after it, but replaying this turn would fight whoever is awaiting it.
      if (run.orchestrationId) {
        this.runtime.notice(run.id, `Rate limit reached — switched to ${target}; the next tasks use it.`);
        this.announceRotation(run, result, false);
        return;
      }
      this.runtime.notice(run.id, `Rate limit reached — switched to ${target} and resuming.`);
      const replayed = await this.runtime.replayLastTurn(run.id);
      if (!replayed) this.runtime.notice(run.id, 'The turn could not be resumed automatically; send it again.');
      this.announceRotation(run, result, replayed);
    } catch (error) {
      this.runtime.notice(run.id, `Account rotation failed: ${error instanceof Error ? error.message : String(error)}`);
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

  async system(force = false): Promise<SystemInfo> {
    if (force || !this.systemCache || Date.now() - this.systemCache.at > SYSTEM_TTL_MS) {
      const cli = await detectCli(this.config);
      const auth = cli.installed
        ? await getAuthStatus(this.config)
        : { loggedIn: false, tokenSource: 'none' as const, error: 'Claude Code CLI not installed' };
      if (this.credentials.isSuspended) {
        auth.tokenSource = 'cswap';
      } else if (this.credentials.active && auth.tokenSource.startsWith('env-')) {
        auth.tokenSource = auth.tokenSource === 'env-oauth-token' ? 'wrapper-oauth-token' : 'wrapper-api-key';
      }
      this.systemCache = {
        at: Date.now(),
        value: {
          cli,
          auth,
          configDir: this.config.configDir,
          workspaceDir: this.config.workspaceDir,
          defaultPermissionMode: this.config.defaultPermissionMode,
          version: AGENTRY_VERSION,
        },
      };
    }
    return { ...this.systemCache.value, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  /** Where a directory's work belongs: its project, and the worktree when it is one. */
  locate(dir: string): WorkLocation {
    return this.locator.locate(dir);
  }

  /**
   * Where a chat belongs: its project, and the worktree when it works in one. The CLI's own record
   * of the worktree it created wins over anything guessed from the path.
   */
  private place(dir: string, recorded: TranscriptSummary['worktree']): Placement {
    if (recorded) this.locator.learn(recorded);
    const location = this.locate(dir);
    return {
      project: { id: location.projectId, name: location.projectName },
      worktree: location.worktree,
    };
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
   * config entry. The CLI owns that layout, so it does the deleting.
   */
  async purgeProject(path: string): Promise<{ detail: string }> {
    const res = await execCli(this.config, ['project', 'purge', path, '--yes'], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'claude project purge failed');
    this.sessions.invalidate();
    return { detail: res.stdout.trim() };
  }

  /**
   * Maps the `?project=` of a config route to a scope. Only projects the wrapper knows about are
   * accepted, so the API cannot be pointed at arbitrary directories.
   */
  async resolveScope(projectId?: string): Promise<ConfigScope> {
    if (!projectId || projectId === 'user') return userScope(this.config);
    const project = (await this.projects()).find((p) => p.id === projectId);
    if (!project) throw new Error('project not found');
    if (!project.exists) throw new Error('project directory is missing on disk');
    return projectScope(project.path);
  }

  /** Memory is keyed by project id; only known projects are accepted. */
  async memoryProject(projectId: string): Promise<string> {
    const known = (await this.projects()).some((p) => p.id === projectId) || (await this.memory.projectIds()).includes(projectId);
    if (!known) throw new Error('project not found');
    return projectId;
  }

  async memoryOverview(): Promise<MemoryProjectSummary[]> {
    const projects: Array<{ id: string; path: string; name: string }> = await this.projects();
    // Memory can exist for a directory that has no sessions left; its real path is unknown then
    for (const id of await this.memory.projectIds()) {
      if (!projects.some((p) => p.id === id)) projects.push({ id, path: '', name: id.replace(/^-+/, '').split('-').slice(-2).join('-') });
    }
    const summaries = await Promise.all(
      projects.map(async (p) => {
        const files = await this.memory.list(p.id);
        const lastUpdated = files.map((f) => f.updatedAt ?? '').sort().at(-1) || null;
        return { projectId: p.id, projectPath: p.path, projectName: p.name, fileCount: files.length, lastUpdated };
      }),
    );
    return summaries.sort((a, b) => b.fileCount - a.fileCount || a.projectName.localeCompare(b.projectName));
  }

  async configFileRoots(): Promise<ConfigFileRoot[]> {
    const user = userScope(this.config);
    const roots: ConfigFileRoot[] = [{ id: 'user', label: 'User', path: user.claudeDir, exists: existsSync(user.claudeDir) }];
    for (const project of await this.projects()) {
      if (!project.exists) continue;
      const { claudeDir } = projectScope(project.path);
      roots.push({ id: project.id, label: project.name, path: claudeDir, exists: existsSync(claudeDir) });
    }
    return roots;
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

  async projects(): Promise<ProjectSummary[]> {
    const projects = await this.sessions.listProjects();
    // Workspace directories that have no sessions yet are projects too
    const known = new Set(projects.map((p) => p.path));
    const bare = (path: string): ProjectSummary => ({
      id: encodeProjectId(path),
      path,
      name: basename(path),
      sessionCount: 0,
      lastActivity: null,
      activeRuns: 0,
      exists: existsSync(path),
      temporary: isTemporaryPath(path),
    });
    for (const path of await this.workspace.list()) {
      if (!known.has(path)) projects.push(bare(path));
      known.add(path);
    }

    // A worktree is part of its repository, not a project of its own: link it to its parent
    for (const p of projects) {
      if (p.parentPath) {
        this.locator.learn({ path: p.path, parentPath: p.parentPath, name: p.worktree?.name ?? null, branch: p.worktree?.branch ?? null });
      } else {
        const facts = this.locator.worktreeOf(p.path);
        if (facts?.path === p.path) {
          p.parentPath = facts.parentPath;
          p.worktree = { name: facts.name, branch: facts.branch };
        }
      }
      if (!p.parentPath) continue;
      p.parentId = encodeProjectId(p.parentPath);
      // A repository only ever worked on through worktrees still has to exist for them to nest under
      if (!known.has(p.parentPath)) {
        projects.push(bare(p.parentPath));
        known.add(p.parentPath);
      }
    }

    // The orchestration task that created each worktree, which says more than its name does
    const creators = new Map<string, NonNullable<ProjectSummary['createdBy']>>();
    for (const orch of this.orchestrator.list()) {
      for (const task of orch.tasks) {
        if (!task.branch) continue;
        const path = task.worktree ?? join(orch.cwd, '.claude', 'worktrees', task.branch.replace(/^worktree-/, ''));
        creators.set(path, { orchestrationId: orch.id, orchestrationName: orch.name, taskId: task.id, taskName: task.name });
      }
    }

    // Live work counts where it happens: the deepest project containing it, so a worker in a
    // worktree lights up the worktree, and one elsewhere in the repository lights up the repository
    const owner = (dir: string): string | undefined => {
      let best: ProjectSummary | undefined;
      for (const p of projects) {
        if ((dir === p.path || dir.startsWith(`${p.path}/`)) && p.path.length > (best?.path.length ?? -1)) best = p;
      }
      return best?.id;
    };
    const runsBy = new Map<string, number>();
    for (const r of this.runtime.list()) {
      if (r.pid === null) continue;
      const id = owner(r.workingDir ?? r.cwd);
      if (id) runsBy.set(id, (runsBy.get(id) ?? 0) + 1);
    }
    // A project someone is working in from a terminal is active too, not only one with a run
    const cliBy = new Map<string, number>();
    const driven = new Set(this.runtime.list().map((r) => r.id));
    for (const a of await this.chats.cliSessions()) {
      if (!a.live || driven.has(a.sessionId)) continue;
      const id = owner(a.cwd);
      if (id) cliBy.set(id, (cliBy.get(id) ?? 0) + 1);
    }
    return projects.map((p) => ({
      ...p,
      parentId: p.parentId ?? null,
      parentPath: p.parentPath ?? null,
      worktree: p.worktree ?? null,
      createdBy: creators.get(p.path) ?? null,
      activeRuns: runsBy.get(p.id) ?? 0,
      activeSessions: cliBy.get(p.id) ?? 0,
    }));
  }

  async overview(): Promise<Overview> {
    const [system, projects, chats] = await Promise.all([this.system(), this.projects(), this.chats.list({ origins: ['agentry', 'external', 'orchestration'] })]);
    // The same lists the screens show, so a count can never disagree with the page it links to
    const [tasks, subagents, workflows] = await Promise.all([this.chats.allBackgroundTasks(), this.chats.allSubagents(), this.chats.allWorkflows()]);
    return {
      system,
      rateLimit: this.runtime.lastRateLimit,
      accounts: this.accounts.snapshot(),
      counts: {
        projects: projects.length,
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
    this.sessionsWatcher.close();
    this.permissions.close();
    this.accounts.shutdown();
    this.runtime.stopAll();
    this.db.close();
  }
}
