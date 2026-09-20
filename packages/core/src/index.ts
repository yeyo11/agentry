import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AccountsOverview,
  AuthVerification,
  ChatProject,
  ChatSummary,
  ChatWorktree,
  ConfigFileRoot,
  ImportProjectRequest,
  MemoryFile,
  MemoryProjectSummary,
  Overview,
  PermissionDecision,
  PermissionRequest,
  Project,
  ProjectCandidate,
  ProjectWorktree,
  RunWorkflowRequest,
  SwitchResult,
  SystemInfo,
  WorkflowDefinition,
} from '@agentry/shared';
import pkg from '../package.json' with { type: 'json' };
import { AccountManager } from './accounts.ts';
import { ChatService, type Placement } from './chat-service.ts';
import { ChatManager, type ChatRuntime } from './chats.ts';
import { Connectors } from './connectors.ts';
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
import { ConfigResources } from './config/resources.ts';
import { projectScope, userScope, type ConfigScope } from './config/scope.ts';
import { Plugins } from './plugins.ts';
import { UploadStore } from './uploads.ts';
import { MemoryStore } from './memory.ts';
import { Orchestrator } from './orchestrator.ts';
import { loadConfig, type CoreConfig } from './paths.ts';
import { attachProject, projectCandidates, ProjectStore, type ChatPlace } from './projects.ts';
import { SessionStore } from './sessions.ts';
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
  readonly files: SettingsFiles;
  readonly explorer: ConfigExplorer;
  readonly plugins: Plugins;
  readonly memory: MemoryStore;
  readonly mcp: McpConfig;
  readonly connectors: Connectors;
  readonly resources: ConfigResources;
  readonly credentials: CredentialStore;
  readonly uploads: UploadStore;
  readonly accounts: AccountManager;
  readonly workspace: Workspace;
  readonly locator = new Locator();
  private readonly projectStore: ProjectStore;
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
    this.projectStore = new ProjectStore(config);
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
    // The graphs a restart cut off go on in the chats it restores, so only once those are back
    void this.runtime.restore(this.sessions).finally(() => this.orchestrator.recover());
    this.mcp = new McpConfig(config);
    this.connectors = new Connectors(config);
    this.resources = new ConfigResources();
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
    this.sessions.invalidate();
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
   * The projects the person imported, each with the chats under it and its worktrees. Nothing is
   * discovered here: a directory Claude Code has run in is a project only once it is imported.
   */
  async projects(): Promise<Project[]> {
    const places = await this.chatPlaces();
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
      if (!attached) continue;
      const stat = stats.get(attached.project.id) ?? { chatCount: 0, lastActivity: null };
      stat.chatCount += 1;
      if (place.updatedAt && (!stat.lastActivity || place.updatedAt > stat.lastActivity)) stat.lastActivity = place.updatedAt;
      stats.set(attached.project.id, stat);
      if (attached.worktree) addWorktree(attached.worktree.path);
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

    return this.projectStore.list().map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
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

  async importProject(req: ImportProjectRequest): Promise<Project> {
    const record = await this.projectStore.add(req, (d) => this.locator.worktreeOf(d));
    return this.projectView(record.id);
  }

  async renameProject(id: string, name: string): Promise<Project> {
    await this.projectStore.rename(id, name);
    return this.projectView(id);
  }

  /** Forgets a project in Agentry. What Claude Code keeps about it is `purgeProject`, and is not touched. */
  removeProject(id: string): Promise<void> {
    return this.projectStore.remove(id);
  }

  private async projectView(id: string): Promise<Project> {
    const project = (await this.projects()).find((p) => p.id === id);
    if (!project) throw new Error('project not found');
    return project;
  }

  async overview(): Promise<Overview> {
    const [system, chats] = await Promise.all([this.system(), this.chats.list({ origins: ['agentry', 'external', 'orchestration'] })]);
    // The same lists the screens show, so a count can never disagree with the page it links to
    const [tasks, subagents, workflows] = await Promise.all([this.chats.allBackgroundTasks(), this.chats.allSubagents(), this.chats.allWorkflows()]);
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
    this.sessionsWatcher.close();
    this.permissions.close();
    this.accounts.shutdown();
    this.runtime.stopAll();
    this.db.close();
  }
}
