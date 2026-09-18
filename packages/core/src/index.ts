import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  AccountsOverview,
  ActiveCliSession,
  AuthVerification,
  ConfigFileRoot,
  MemoryProjectSummary,
  Overview,
  ProjectSummary,
  RunSummary,
  SessionOrigin,
  SessionSummary,
  SystemInfo,
} from '@agentry/shared';
import { AccountManager } from './accounts.ts';
import { detectCli, getAuthStatus, isLiveCliSession, listActiveCliSessions } from './cli.ts';
import { ConfigExplorer } from './config/explorer.ts';
import { SettingsFiles } from './config/files.ts';
import { CredentialStore, type StoredCredentials } from './credentials.ts';
import { Db } from './db.ts';
import { McpConfig } from './config/mcp.ts';
import { MarkdownResources } from './config/resources.ts';
import { projectScope, userScope, type ConfigScope } from './config/scope.ts';
import { Plugins } from './plugins.ts';
import { MemoryStore } from './memory.ts';
import { Orchestrator } from './orchestrator.ts';
import { loadConfig, type CoreConfig } from './paths.ts';
import { RunManager } from './runner.ts';
import { isTemporaryPath, SessionStore } from './sessions.ts';
import { encodeProjectId, Workspace } from './workspace.ts';

export { parseMcpScope } from './config/mcp.ts';
export { RESOURCE_KINDS } from './config/resources.ts';
export { parseVariant, type ConfigScope } from './config/scope.ts';
export { loadConfig, type CoreConfig } from './paths.ts';
export type { RunResult } from './runner.ts';
export { DEFAULT_AUTO_SWITCH } from './accounts.ts';
export { Db } from './db.ts';

const AGENTRY_VERSION = '0.1.0';
const SYSTEM_TTL_MS = 30_000;
const ACTIVE_TTL_MS = 1_500;

/** Facade wiring every core service together; the API layer only talks to this. */
export class Core {
  readonly config: CoreConfig;
  readonly db: Db;
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
  readonly accounts: AccountManager;
  readonly workspace: Workspace;
  private readonly startedAt = Date.now();
  private systemCache: { at: number; value: Omit<SystemInfo, 'uptimeSec'> } | null = null;
  private activeCache: { at: number; value: ActiveCliSession[] } | null = null;

  constructor(config: CoreConfig = loadConfig()) {
    this.config = config;
    this.db = new Db(config);
    // Must run before anything spawns the CLI: it injects stored credentials into process.env
    this.credentials = new CredentialStore(config);
    this.workspace = new Workspace(config);
    this.runs = new RunManager(config, this.db);
    this.sessions = new SessionStore(config);
    this.orchestrator = new Orchestrator(config, this.runs, this.db);
    this.files = new SettingsFiles();
    this.explorer = new ConfigExplorer();
    this.plugins = new Plugins(config);
    this.memory = new MemoryStore(config);
    void this.runs.restore(this.sessions);
    this.mcp = new McpConfig(config);
    this.resources = new MarkdownResources();
    this.accounts = new AccountManager(config, this.db);
    this.runs.accounts = this.accounts;
    this.accounts.on('switched', () => {
      this.systemCache = null; // the active account (and its email) changed
    });
    this.runs.on('rate-limited', (run: RunSummary) => void this.rotateAndResume(run));
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
        return;
      }
      this.runs.notice(run.id, `Rate limit reached — switched to ${target} and resuming.`);
      const replayed = await this.runs.replayLastTurn(run.id);
      if (!replayed) this.runs.notice(run.id, 'The turn could not be resumed automatically; send it again.');
    } catch (error) {
      this.runs.notice(run.id, `Account rotation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
          wrapperVersion: AGENTRY_VERSION,
        },
      };
    }
    return { ...this.systemCache.value, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) };
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
          return { ...agent, runId: runBySession.get(agent.sessionId), live: isLiveCliSession(agent, summary) };
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

  /** Session summaries annotated with liveness (wrapper run or plain CLI process). */
  async sessionsWithLive(projectId?: string): Promise<SessionSummary[]> {
    const [sessions, active] = await Promise.all([this.sessions.listSessions(projectId), this.activeCliSessions()]);
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

  async projects(): Promise<ProjectSummary[]> {
    const projects = await this.sessions.listProjects();
    // Workspace directories that have no sessions yet are projects too
    const known = new Set(projects.map((p) => p.path));
    for (const path of await this.workspace.list()) {
      if (known.has(path)) continue;
      projects.push({ id: encodeProjectId(path), path, name: basename(path), sessionCount: 0, lastActivity: null, activeRuns: 0, exists: true, temporary: isTemporaryPath(path) });
    }
    const liveRuns = this.runs.list().filter((r) => r.pid !== null);
    return projects.map((p) => ({ ...p, activeRuns: liveRuns.filter((r) => r.cwd === p.path).length }));
  }

  async overview(): Promise<Overview> {
    const [system, projects, sessions, active] = await Promise.all([
      this.system(),
      this.projects(),
      this.sessionsWithLive(),
      this.activeCliSessions(),
    ]);
    const runs = this.runs.list();
    return {
      system,
      rateLimit: this.runs.lastRateLimit,
      accounts: this.accounts.snapshot(),
      counts: {
        projects: projects.length,
        sessions: sessions.length,
        activeRuns: runs.filter((r) => r.pid !== null).length,
        activeCliSessions: active.filter((a) => a.live).length,
        backgroundTasks: runs.flatMap((r) => r.backgroundTasks).filter((t) => t.status === 'running').length,
        subagents: runs.flatMap((r) => r.subagents).filter((s) => s.status === 'running').length,
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
    this.accounts.shutdown();
    this.runs.stopAll();
    this.db.close();
  }
}
