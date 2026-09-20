import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AccountsOverview,
  ActiveCliSession,
  AuthVerification,
  BackgroundTask,
  ChatProject,
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
  RunSummary,
  RunWorkflowRequest,
  SessionOrigin,
  SessionSummary,
  SubagentInfo,
  SwitchResult,
  SystemInfo,
  WorkflowDefinition,
  WorkflowRun,
  WorkLocation,
} from '@agentry/shared';
import pkg from '../package.json' with { type: 'json' };
import { AccountManager } from './accounts.ts';
import { backgroundLogs, detectCli, execCli, getAuthStatus, isLiveCliSession, listActiveCliSessions, stopBackgroundSession } from './cli.ts';
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
import { RunManager } from './runner.ts';
import { attachProject, projectCandidates, ProjectStore, type ChatPlace } from './projects.ts';
import { SessionStore } from './sessions.ts';
import { listWorkflowDefinitions } from './workflows.ts';
import { encodeProjectId, Workspace } from './workspace.ts';

export { parseMcpScope } from './config/mcp.ts';
export { RESOURCE_KINDS } from './config/resources.ts';
export { parseVariant, type ConfigScope } from './config/scope.ts';
export { loadConfig, type CoreConfig } from './paths.ts';
export type { RunResult } from './runner.ts';
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
export { Db } from './db.ts';
export { EventBus, type AgentryEventInput, type Replay } from './events.ts';

// Read from the package rather than written into this file: the release tooling then only edits
// package.json files, and never has to rewrite source to bump a version.
const AGENTRY_VERSION = pkg.version;
const SYSTEM_TTL_MS = 30_000;
const ACTIVE_TTL_MS = 1_500;
/** Ended runs whose background work is still listed; each costs a stat per poll. */
const RECENT_ENDED_RUNS = 30;
/**
 * Terminal sessions that ended, listed alongside the live ones: what they delegated is still worth
 * seeing afterwards, the same way an ended run's is. Bounded like the runs, and only recent ones.
 */
const RECENT_ENDED_CLI_SESSIONS = 20;
const RECENT_ENDED_CLI_WINDOW_MS = 24 * 3_600_000;

const byRunningThenNewest = (a: { status: string; startedAt: string }, b: { status: string; startedAt: string }) =>
  Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt);

/** A session's directory: the worktree the CLI recorded when it ran in one, else where it started. */
const placeOf = (s: SessionSummary): ChatPlace => ({ cwd: s.worktree?.path ?? s.projectPath, updatedAt: s.updatedAt });

/** Facade wiring every core service together; the API layer only talks to this. */
export class Core {
  readonly config: CoreConfig;
  readonly db: Db;
  /** Every change worth telling a client about; what `GET /api/events` streams */
  readonly events = new EventBus();
  readonly permissions: PermissionBroker;
  readonly runs: RunManager;
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
  private readonly projectStore: ProjectStore;
  private readonly startedAt = Date.now();
  private readonly sessionsWatcher: SessionsWatcher;
  private systemCache: { at: number; value: Omit<SystemInfo, 'uptimeSec'> } | null = null;
  private activeCache: { at: number; value: ActiveCliSession[] } | null = null;

  constructor(config: CoreConfig = loadConfig()) {
    this.config = config;
    this.db = new Db(config);
    this.permissions = new PermissionBroker();
    // Must run before anything spawns the CLI: it injects stored credentials into process.env
    this.credentials = new CredentialStore(config);
    this.workspace = new Workspace(config);
    this.projectStore = new ProjectStore(config);
    this.uploads = new UploadStore(config.dataDir);
    this.runs = new RunManager(config, this.db);
    this.runs.permissions = this.permissions;
    this.runs.bus = this.events;
    this.sessionsWatcher = new SessionsWatcher(config.projectsDir, this.events);
    this.runs.uploads = this.uploads;
    // The UI watches a run's event stream, so the prompt has to arrive on it
    this.permissions.on('requested', (request: PermissionRequest) => {
      this.runs.notice(request.runId, `Permission requested for ${request.toolName}`, { permission: request });
      for (const event of permissionEvents(request, this.runs.get(request.runId))) this.events.emit(event);
    });
    this.permissions.on('resolved', (request: PermissionRequest, decision: PermissionDecision | null) => {
      const outcome = decision ? decision.behavior : 'withdrawn';
      this.events.emit({
        type: 'permission.resolved',
        title: `${request.toolName} ${outcome === 'withdrawn' ? 'was withdrawn' : outcome === 'allow' ? 'allowed' : 'denied'}`,
        ...runRefOr(request.runId, this.runs.get(request.runId)),
        permissionId: request.id,
        toolName: request.toolName,
        outcome,
      });
    });
    this.sessions = new SessionStore(config);
    this.orchestrator = new Orchestrator(config, this.runs, this.db);
    this.orchestrator.bus = this.events;
    this.orchestrator.workflowRecords = (sessionId) => this.sessions.workflows(sessionId, true);
    this.files = new SettingsFiles();
    this.explorer = new ConfigExplorer();
    this.plugins = new Plugins(config);
    this.memory = new MemoryStore(config);
    void this.runs.restore(this.sessions);
    this.mcp = new McpConfig(config);
    this.resources = new MarkdownResources();
    this.accounts = new AccountManager(config, this.db);
    this.runs.accounts = this.accounts;
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
    this.runs.on('rate-limited', (run: RunSummary) => {
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
  private async rotateAndResume(run: RunSummary): Promise<void> {
    if (!this.accounts.autoSwitch.rotateOnLimit || !this.accounts.managed) return;
    try {
      const result = await this.accounts.rotate(`run ${run.name} hit its rate limit`);
      if (!result.switched) {
        this.runs.notice(run.id, `Rate limit reached and no account with quota left${result.reason ? ` (${result.reason})` : ''}.`);
        return;
      }
      this.systemCache = null;
      const target = result.to ?? 'another account';
      // An orchestration worker already handed its result to the orchestrator: rotating helps the
      // tasks that come after it, but replaying this turn would fight whoever is awaiting it.
      if (run.orchestrationId) {
        this.runs.notice(run.id, `Rate limit reached — switched to ${target}; the next tasks use it.`);
        this.announceRotation(run, result, false);
        return;
      }
      this.runs.notice(run.id, `Rate limit reached — switched to ${target} and resuming.`);
      const replayed = await this.runs.replayLastTurn(run.id);
      if (!replayed) this.runs.notice(run.id, 'The turn could not be resumed automatically; send it again.');
      this.announceRotation(run, result, replayed);
    } catch (error) {
      this.runs.notice(run.id, `Account rotation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private announceRotation(run: RunSummary, result: SwitchResult, resumed: boolean): void {
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
    const location = this.locator.locate(dir);
    const attached = this.attach(dir);
    return attached
      ? { ...location, projectId: attached.project.id, projectName: attached.project.name, projectPath: attached.project.path }
      : location;
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

  /** Where a session works, preferring the worktree the CLI recorded over anything guessed. */
  private locateSummary(summary: SessionSummary | null, fallback: string): WorkLocation {
    if (summary?.worktree) this.locator.learn(summary.worktree);
    return this.locate(summary?.worktree?.path ?? (summary?.projectPath || fallback));
  }

  private async locateSession(sessionId: string, fallback = ''): Promise<WorkLocation | null> {
    const summary = await this.sessions.summary(sessionId).catch(() => null);
    if (!summary && !fallback) return null;
    return this.locateSummary(summary, fallback);
  }

  /** Runs with where each one actually works. */
  runList(): RunSummary[] {
    return this.runs.list().map((r) => ({ ...r, location: this.locate(r.workingDir ?? r.cwd) }));
  }

  /**
   * Where background work is read from, one entry per session. A run that is alive reports from its
   * live stream: freshest, and the only source for a run whose transcript is not kept. Everything
   * else comes from disk — the CLI sessions live right now, whose stream the wrapper never sees,
   * and runs that have ended, whose in-memory lists a restart empties. Every list and every count
   * reads through here, so no screen can show work another one misses.
   */
  private async activitySources(): Promise<
    Array<{ kind: 'stream'; run: RunSummary } | { kind: 'disk'; sessionId: string; runId: string; runName: string; live: boolean }>
  > {
    const runs = this.runs.list();
    const ownedByRun = new Set(runs.map((r) => r.sessionId).filter((id): id is string => Boolean(id)));
    const sources: Awaited<ReturnType<Core['activitySources']>> = [];
    for (const run of runs) {
      if (run.pid !== null) sources.push({ kind: 'stream', run });
    }
    // Ended runs, most recent first and bounded: every one costs a stat on each poll
    for (const run of runs.filter((r) => r.pid === null && r.sessionId && !r.internal).slice(0, RECENT_ENDED_RUNS)) {
      sources.push({ kind: 'disk', sessionId: run.sessionId as string, runId: run.id, runName: run.name, live: false });
    }
    const liveCli = new Set<string>();
    for (const agent of await this.activeCliSessions()) {
      if (agent.live && !ownedByRun.has(agent.sessionId)) {
        liveCli.add(agent.sessionId);
        sources.push({ kind: 'disk', sessionId: agent.sessionId, runId: '', runName: agent.name, live: true });
      }
    }
    const since = new Date(Date.now() - RECENT_ENDED_CLI_WINDOW_MS).toISOString();
    const ended = (await this.sessions.listSessions())
      .filter((s) => !ownedByRun.has(s.id) && !liveCli.has(s.id) && (s.updatedAt ?? '') >= since)
      .slice(0, RECENT_ENDED_CLI_SESSIONS);
    for (const session of ended) {
      sources.push({ kind: 'disk', sessionId: session.id, runId: '', runName: session.title, live: false });
    }
    return sources;
  }

  /** Whether something is still running in a session: a live run or a live CLI process. */
  async isSessionLive(sessionId: string): Promise<boolean> {
    if (this.runs.list().some((r) => r.sessionId === sessionId && r.pid !== null)) return true;
    return (await this.activeCliSessions()).some((a) => a.sessionId === sessionId && a.live);
  }

  /** Subagents from every source, running ones first. */
  async allSubagents(): Promise<SubagentInfo[]> {
    const lists = await Promise.all(
      (await this.activitySources()).map(async (source) =>
        {
          if (source.kind === 'stream') {
            const location = this.locate(source.run.workingDir ?? source.run.cwd);
            // The session is what a subagent's transcript is looked up by
            const sessionId = source.run.sessionId;
            return source.run.subagents.map((s) => ({ ...s, source: 'run' as const, location, ...(sessionId ? { sessionId } : {}) }));
          }
          const location = await this.locateSession(source.sessionId);
          return (await this.sessions.subagents(source.sessionId, source.live).catch(() => [])).map((s) => ({
            ...s,
            runId: source.runId,
            runName: source.runName,
            // Its own directory when it has one: an isolated subagent works in a worktree of its own
            location: s.cwd ? this.locate(s.cwd) : location,
          }));
        },
      ),
    );
    return lists.flat().sort(byRunningThenNewest);
  }

  /** Claude Code workflows from every source, running ones first. */
  async allWorkflows(): Promise<WorkflowRun[]> {
    const lists = await Promise.all(
      (await this.activitySources()).map(async (source) => {
        if (source.kind === 'stream') {
          const location = this.locate(source.run.workingDir ?? source.run.cwd);
          const sessionId = source.run.sessionId;
          return (source.run.workflows ?? []).map((w) => ({ ...w, location, ...(sessionId ? { sessionId } : {}) }));
        }
        const location = await this.locateSession(source.sessionId);
        return (await this.sessions.workflows(source.sessionId, source.live).catch(() => [])).map((w) => ({
          ...w,
          runId: source.runId,
          runName: source.runName,
          location,
        }));
      }),
    );
    return lists.flat().sort(byRunningThenNewest);
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
  async runWorkflow(request: RunWorkflowRequest): Promise<RunSummary> {
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
    return this.runs.start({
      prompt,
      name: `workflow-${name}`,
      permissionPrompts: 'host',
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}),
    });
  }

  /** Backgrounded shell commands from every source, running ones first. */
  async allBackgroundTasks(): Promise<BackgroundTask[]> {
    const lists = await Promise.all(
      (await this.activitySources()).map(async (source) =>
        {
          if (source.kind === 'stream') {
            const location = this.locate(source.run.workingDir ?? source.run.cwd);
            const sessionId = source.run.sessionId;
            const owners = sessionId && source.run.backgroundTasks.some((t) => t.fromSubagent && !t.ownerAgentId) ? await this.sessions.taskOwners(sessionId) : null;
            return source.run.backgroundTasks.map((t) => {
              const ownerAgentId = t.ownerAgentId ?? (t.fromSubagent ? owners?.get(t.id) : undefined);
              return {
                ...t,
                source: 'run' as const,
                location,
                ...(!t.sessionId && sessionId ? { sessionId } : {}),
                ...(ownerAgentId ? { ownerAgentId } : {}),
              };
            });
          }
          const location = await this.locateSession(source.sessionId);
          return (await this.sessions.backgroundTasks(source.sessionId, source.live).catch(() => [])).map((t) => ({
            ...t,
            runId: source.runId,
            runName: source.runName,
            location,
          }));
        },
      ),
    );
    return lists.flat().sort(byRunningThenNewest);
  }

  /** Recent terminal output of a background CLI session, which only the CLI itself keeps. */
  backgroundLogs(id: string): Promise<string> {
    return backgroundLogs(this.config, id);
  }

  /**
   * Stops a background CLI session through the CLI, so its conversation stays resumable. Doing it
   * by signalling the pid would race with pid reuse and could hit an unrelated process.
   */
  async stopBackgroundSession(id: string): Promise<{ detail: string }> {
    const detail = await stopBackgroundSession(this.config, id);
    this.activeCache = null;
    return { detail };
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
   * Live CLI sessions, each marked with whether it is really open for work. The CLI lists two
   * kinds of process that are not: one it reports as `done`, and the spare the daemon pre-warms
   * for an attach, which holds a session id but never received a user turn. Both stay in the list
   * — a pid that lingers is worth seeing — but neither counts as live, so neither blocks a delete.
   */
  async activeCliSessions(): Promise<ActiveCliSession[]> {
    if (!this.activeCache || Date.now() - this.activeCache.at > ACTIVE_TTL_MS) {
      const agents = await listActiveCliSessions(this.config);
      const runBySession = new Map(this.runs.list().map((r) => [r.sessionId, r.id]));
      const value = await Promise.all(
        agents.map(async (agent) => {
          const summary = await this.sessions.summary(agent.sessionId).catch(() => null);
          return {
            ...agent,
            runId: runBySession.get(agent.sessionId),
            live: isLiveCliSession(agent, summary),
            location: this.locateSummary(summary, agent.cwd),
          };
        }),
      );
      this.activeCache = { at: Date.now(), value };
    }
    return this.activeCache.value;
  }

  /**
   * Attributes sessions to the wrapper run / orchestration that created them. Orchestrations keep
   * their task session ids on disk, so attribution survives even when the run list is pruned.
   */
  private sessionOrigins(): Map<string, SessionOrigin> {
    const origins = new Map<string, SessionOrigin>();
    const orchestrations = new Map(this.orchestrator.list().map((o) => [o.id, o]));
    for (const orch of orchestrations.values()) {
      for (const task of orch.tasks) {
        if (!task.sessionId) continue;
        origins.set(task.sessionId, {
          kind: 'orchestration',
          orchestrationId: orch.id,
          orchestrationName: orch.name,
          taskId: task.id,
          taskName: task.name,
          runId: task.runId ?? undefined,
        });
      }
    }
    for (const run of this.runs.list()) {
      if (!run.sessionId) continue;
      if (run.internal) {
        origins.set(run.sessionId, { kind: 'internal', runId: run.id, runName: run.name });
      } else if (run.orchestrationId) {
        const orch = orchestrations.get(run.orchestrationId);
        const taskId = run.orchestrationTaskId ?? undefined;
        origins.set(run.sessionId, {
          kind: 'orchestration',
          orchestrationId: run.orchestrationId,
          orchestrationName: orch?.name,
          taskId,
          taskName: taskId === '__synthesis__' ? 'Synthesis' : orch?.tasks.find((t) => t.id === taskId)?.name,
          runId: run.id,
          runName: run.name,
        });
      } else {
        origins.set(run.sessionId, { kind: 'run', runId: run.id, runName: run.name });
      }
    }
    return origins;
  }

  /**
   * Every session, or those of one project (worktrees included: it is the same work, split for
   * isolation), or with `null` the loose ones, whose directory is under no project.
   */
  private async listSessionsIn(projectId?: string | null): Promise<SessionSummary[]> {
    const sessions = await this.sessions.listSessions();
    if (projectId === undefined) return sessions;
    if (projectId !== null && !this.projectStore.get(projectId)) throw new Error('project not found');
    this.learnWorktrees(sessions);
    return sessions.filter((s) => (this.attach(placeOf(s).cwd)?.project.id ?? null) === projectId);
  }

  /** The worktrees the CLI recorded in its transcripts are what let a session in one find its repository. */
  private learnWorktrees(sessions: readonly SessionSummary[]): void {
    for (const s of sessions) if (s.worktree) this.locator.learn(s.worktree);
  }

  /** Session summaries annotated with liveness (wrapper run or plain CLI process). */
  async sessionsWithLive(projectId?: string | null): Promise<SessionSummary[]> {
    const [sessions, active] = await Promise.all([this.listSessionsIn(projectId), this.activeCliSessions()]);
    const liveRuns = new Map(
      this.runs
        .list()
        .filter((r) => r.sessionId && r.pid !== null)
        .map((r) => [r.sessionId as string, r]),
    );
    const liveCli = new Map(active.filter((a) => a.live).map((a) => [a.sessionId, a]));
    const origins = this.sessionOrigins();
    return sessions.map((session) => {
      const s = { ...session, origin: origins.get(session.id) ?? session.origin };
      const run = liveRuns.get(s.id);
      if (run) return { ...s, live: { source: 'wrapper' as const, status: run.status, runId: run.id, pid: run.pid ?? undefined } };
      const cli = liveCli.get(s.id);
      if (cli) return { ...s, live: { source: 'cli' as const, status: cli.status, pid: cli.pid } };
      return s;
    });
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
    const run = this.runs.start({
      prompt: 'Reply with exactly: ok',
      model: 'haiku',
      name: 'auth-check',
      keepAlive: false,
      internal: true,
      permissionMode: 'manual',
      allowedTools: [],
    });
    const result = await this.runs.waitForResult(run.id);
    this.runs.remove(run.id);
    const { auth } = await this.system(true);
    return { ok: !result.isError, detail: result.result.slice(0, 500), auth };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const live = (await this.sessionsWithLive()).find((s) => s.id === sessionId)?.live;
    if (live) throw new Error(`session is live (${live.source}); stop it before deleting`);
    await this.sessions.deleteSession(sessionId);
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

  private async chatPlaces(): Promise<ChatPlace[]> {
    const sessions = await this.sessions.listSessions();
    this.learnWorktrees(sessions);
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
    const [system, sessions, active] = await Promise.all([
      this.system(),
      this.sessionsWithLive(),
      this.activeCliSessions(),
    ]);
    const runs = this.runs.list();
    // The same lists the screens show, so a count can never disagree with the page it links to
    const [tasks, subagents, workflows] = await Promise.all([this.allBackgroundTasks(), this.allSubagents(), this.allWorkflows()]);
    return {
      system,
      rateLimit: this.runs.lastRateLimit,
      accounts: this.accounts.snapshot(),
      counts: {
        projects: this.projectStore.list().length,
        sessions: sessions.length,
        activeRuns: runs.filter((r) => r.pid !== null).length,
        activeCliSessions: active.filter((a) => a.live).length,
        liveSessions: sessions.filter((s) => s.live).length,
        backgroundTasks: tasks.filter((t) => t.status === 'running').length,
        subagents: subagents.filter((s) => s.status === 'running').length,
        workflows: workflows.filter((w) => w.status === 'running').length,
        orchestrationsRunning: this.orchestrator.runningCount(),
      },
      runs: runs.slice(0, 20),
      recentSessions: sessions.slice(0, 10),
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
    this.runs.stopAll();
    this.db.close();
  }
}
