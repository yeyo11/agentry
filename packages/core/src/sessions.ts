import { createReadStream, existsSync } from 'node:fs';
import { open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  entryText,
  normalizeMessage,
  type ProjectSummary,
  type SessionDetail,
  type BackgroundTask,
  type BackgroundTaskOutput,
  type SessionSummary,
  type SubagentInfo,
  type TranscriptEntry,
} from '@agentry/shared';
import type { CoreConfig } from './paths.ts';

/** The slash command inside a synthetic user message, e.g. `<command-name>/resume</command-name>`. */
const COMMAND_RE = /<command-name>\s*([^<]+)<\/command-name>/;

interface CacheItem {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

/** A line's text whether the CLI stored it as a plain string or as content blocks. */
function lineText(o: Record<string, unknown>): string {
  if (typeof o.content === 'string') return o.content;
  const message = o.message as { content?: unknown } | undefined;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n');
  }
  return '';
}

/**
 * A stop notification is written to the parent just after the agent's last write, so an agent only
 * counts as resumed once it writes clearly later than that — otherwise a clock tick between the two
 * would read a finished agent as running.
 */
const RESUMED_AFTER_MS = 2000;

/** Only the end of a long task output is returned: it is what says how the command finished. */
const MAX_TASK_OUTPUT = 64 * 1024;

/** One field out of a `<task-notification>` block. */
function tag(text: string, name: string): string | null {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null;
}

/**
 * Where the CLI keeps a session's task output: its own temp dir, per user, project and session.
 * The wrapper runs as the same user as the CLI, in and out of the container, so it resolves the
 * same directory.
 */
function taskDir(projectId: string, sessionId: string): string {
  return join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, projectId, sessionId, 'tasks');
}

interface TaskLaunch {
  at: string;
  toolUseId: string | null;
  command: string | null;
  description: string | null;
  backgroundedByUser: boolean;
}

interface SessionActivity {
  /** agentId → when it was launched */
  agents: Map<string, string>;
  /** backgroundTaskId → the call that sent it to the background */
  tasks: Map<string, TaskLaunch>;
  /** id → the latest time it stopped, for agents and tasks alike */
  stops: Map<string, { at: string; status: string; summary: string | null }>;
}

async function* readJsonl(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // half-written line from a live session
    }
  }
}

export function isTemporaryPath(path: string): boolean {
  const tmp = tmpdir();
  return path === tmp || path.startsWith(`${tmp}/`) || path.startsWith('/tmp/') || path.startsWith('/var/tmp/');
}

/** Reads projects and sessions from ~/.claude/projects (.jsonl transcripts written by the CLI). */
export class SessionStore {
  private readonly cache = new Map<string, CacheItem>();
  private readonly activityCache = new Map<string, { mtimeMs: number; size: number; activity: SessionActivity }>();

  constructor(private readonly config: CoreConfig) {}

  private async projectDirs(): Promise<string[]> {
    if (!existsSync(this.config.projectsDir)) return [];
    const entries = await readdir(this.config.projectsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  private async summarize(projectId: string, file: string): Promise<SessionSummary | null> {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;

    const summary: SessionSummary = {
      id: basename(file, '.jsonl'),
      projectId,
      projectPath: '',
      title: '',
      firstPrompt: null,
      messageCount: 0,
      startedAt: null,
      updatedAt: null,
      model: null,
      gitBranch: null,
      cliVersion: null,
      sizeBytes: info.size,
      origin: { kind: 'cli' }, // refined by Core, which knows the wrapper's runs
    };
    let customTitle: string | null = null;
    let command: string | undefined;

    for await (const o of readJsonl(file)) {
      if (typeof o.timestamp === 'string') {
        summary.startedAt ??= o.timestamp;
        summary.updatedAt = o.timestamp;
      }
      if (!summary.projectPath && typeof o.cwd === 'string') summary.projectPath = o.cwd;
      if (typeof o.gitBranch === 'string') summary.gitBranch = o.gitBranch;
      if (typeof o.version === 'string') summary.cliVersion = o.version;
      if (o.type === 'summary' && typeof o.summary === 'string') customTitle = o.summary;
      if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle;
      // Written when the CLI starts a session in a worktree it created: which one, and whose
      if (o.type === 'worktree-state' && !summary.worktree) {
        const w = o.worktreeSession as Record<string, unknown> | null | undefined;
        if (w && typeof w.worktreePath === 'string' && typeof w.originalCwd === 'string') {
          summary.worktree = {
            path: w.worktreePath,
            parentPath: w.originalCwd,
            name: typeof w.worktreeName === 'string' ? w.worktreeName : null,
            branch: typeof w.worktreeBranch === 'string' ? w.worktreeBranch : null,
          };
        }
      }

      const entry = normalizeMessage(o);
      if (!entry || entry.isSidechain) continue;
      summary.messageCount++;
      if (entry.model) summary.model = entry.model;
      if (!summary.firstPrompt && entry.role === 'user') {
        const text = entryText(entry).trim();
        // Skip synthetic messages (<command-name>, <system-reminder>, …)
        if (text && !text.startsWith('<')) summary.firstPrompt = text.slice(0, 300);
        // …but remember the command, the only readable thing a session nobody typed in ever has
        else command ??= COMMAND_RE.exec(text)?.[1]?.trim();
      }
    }
    if (summary.messageCount === 0) return null;
    // A session with no user turn (the spare `claude attach` pre-warms) would otherwise be
    // titled with its own uuid, which reads like an id and tells nobody what it is.
    summary.title = customTitle ?? summary.firstPrompt?.split('\n')[0]?.slice(0, 100) ?? command ?? summary.id;
    summary.updatedAt ??= info.mtime.toISOString();
    this.cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, summary });
    return summary;
  }

  async listSessions(projectId?: string): Promise<SessionSummary[]> {
    const dirs = projectId ? [projectId] : await this.projectDirs();
    const all: SessionSummary[] = [];
    for (const dir of dirs) {
      const full = join(this.config.projectsDir, dir);
      const files = await readdir(full).catch(() => [] as string[]);
      const summaries = await Promise.all(
        files.filter((f) => f.endsWith('.jsonl')).map((f) => this.summarize(dir, join(full, f))),
      );
      for (const s of summaries) if (s) all.push(s);
    }
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const sessions = await this.listSessions();
    const byProject = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const list = byProject.get(s.projectId) ?? [];
      list.push(s);
      byProject.set(s.projectId, list);
    }
    const projects: ProjectSummary[] = [];
    for (const [id, list] of byProject) {
      const path = list.find((s) => s.projectPath)?.projectPath ?? id;
      const worktree = list.find((s) => s.worktree?.path === path)?.worktree;
      projects.push({
        ...(worktree ? { parentPath: worktree.parentPath, worktree: { name: worktree.name, branch: worktree.branch } } : {}),
        id,
        path,
        name: basename(path) || path,
        sessionCount: list.length,
        lastActivity: list[0]?.updatedAt ?? null,
        activeRuns: 0,
        temporary: isTemporaryPath(path),
        exists: existsSync(path),
      });
    }
    return projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  }

  private async findFile(sessionId: string): Promise<{ projectId: string; file: string } | null> {
    if (!/^[\w-]+$/.test(sessionId)) return null;
    for (const dir of await this.projectDirs()) {
      const file = join(this.config.projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return { projectId: dir, file };
    }
    return null;
  }

  /** Drops the cache after something outside this store changed the transcripts on disk. */
  invalidate(): void {
    this.cache.clear();
  }

  /** The cached summary of one session, without reading its transcript. */
  async summary(sessionId: string): Promise<SessionSummary | null> {
    const found = await this.findFile(sessionId);
    return found ? this.summarize(found.projectId, found.file) : null;
  }

  /**
   * What a session launched in the background and when each piece stopped, from one pass over its
   * transcript. Cached by mtime and size like the summaries: the lists that use it are polled every
   * couple of seconds, and a transcript can run to megabytes.
   */
  private async activity(file: string): Promise<SessionActivity> {
    const info = await stat(file);
    const cached = this.activityCache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.activity;

    const activity: SessionActivity = { agents: new Map(), tasks: new Map(), stops: new Map() };
    const bashInputs = new Map<string, Record<string, unknown>>();
    for await (const o of readJsonl(file)) {
      const at = typeof o.timestamp === 'string' ? o.timestamp : null;
      const message = o.message as { content?: unknown } | undefined;
      let resultFor: string | null = null;
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        const b = block as { type?: string; name?: string; id?: unknown; input?: unknown; tool_use_id?: unknown };
        if (b.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string') bashInputs.set(b.id, (b.input ?? {}) as Record<string, unknown>);
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') resultFor = b.tool_use_id;
      }
      const result = o.toolUseResult as Record<string, unknown> | undefined;
      if (at && result && typeof result === 'object') {
        if (typeof result.agentId === 'string' && !activity.agents.has(result.agentId)) activity.agents.set(result.agentId, at);
        // A task stopped on request never gets a notification: all it leaves is TaskStop's result.
        // Without this it would read as running for as long as its session lived.
        if (typeof result.task_id === 'string' && typeof result.message === 'string' && /stopped/i.test(result.message)) {
          activity.stops.set(result.task_id, { at, status: 'stopped', summary: result.message });
        }
        if (typeof result.backgroundTaskId === 'string' && !activity.tasks.has(result.backgroundTaskId)) {
          const input = (resultFor ? bashInputs.get(resultFor) : undefined) ?? {};
          activity.tasks.set(result.backgroundTaskId, {
            at,
            toolUseId: resultFor,
            command: typeof input.command === 'string' ? input.command : null,
            description: typeof input.description === 'string' ? input.description : null,
            backgroundedByUser: result.backgroundedByUser === true,
          });
        }
      }
      const text = lineText(o);
      if (!at || !text.includes('<task-notification>')) continue;
      const id = tag(text, 'task-id');
      // Later lines win: an agent can be resumed and stop again, notifying each time
      if (id) activity.stops.set(id, { at, status: tag(text, 'status') ?? 'completed', summary: tag(text, 'summary') });
    }
    this.activityCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, activity });
    return activity;
  }

  /**
   * Background agents a session spawned, read from what the CLI writes beside its transcript. This
   * is what makes them visible for a session started from a terminal, whose live stream the
   * wrapper never sees — and for a run after a restart, whose in-memory list is gone.
   *
   * The CLI gives no explicit "running" flag. It notifies the parent each time an agent stops, and
   * an agent can be resumed and stop again, so the state is: running until the first notification,
   * and running again whenever the agent writes after its latest one. `live` says whether the
   * session is still around: an agent of a session that ended cannot still be working.
   */
  async subagents(sessionId: string, live = true): Promise<SubagentInfo[]> {
    const found = await this.findFile(sessionId);
    if (!found) return [];
    const dir = join(found.file.slice(0, -'.jsonl'.length), 'subagents');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // no subagents yet
    }
    const activity = await this.activity(found.file);

    const out: SubagentInfo[] = [];
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const agentId = name.slice('agent-'.length, -'.meta.json'.length);
      let meta: { agentType?: string; description?: string; toolUseId?: string };
      try {
        meta = JSON.parse(await readFile(join(dir, name), 'utf8')) as typeof meta;
      } catch {
        continue;
      }
      const transcript = await stat(join(dir, `agent-${agentId}.jsonl`)).catch(() => null);
      const lastActivityAt = transcript ? transcript.mtime.toISOString() : null;
      const stop = activity.stops.get(agentId);
      const resumed = stop && transcript ? transcript.mtimeMs > Date.parse(stop.at) + RESUMED_AFTER_MS : false;
      const running = !stop || resumed;
      out.push({
        toolUseId: meta.toolUseId ?? '',
        runId: '',
        runName: '',
        subagentType: meta.agentType ?? 'agent',
        description: meta.description ?? agentId,
        status: running ? (live ? 'running' : 'stopped') : stop?.status === 'completed' ? 'completed' : 'failed',
        startedAt: activity.agents.get(agentId) ?? lastActivityAt ?? new Date(0).toISOString(),
        endedAt: running ? (live ? null : lastActivityAt) : (stop?.at ?? null),
        source: 'cli',
        sessionId,
        agentId,
        lastActivityAt,
      });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Shell commands a session sent to the background — by the model or by the person at the
   * terminal. Agents are background tasks to the CLI too, under the same ids; they are left to
   * {@link subagents} so nothing is listed twice.
   */
  async backgroundTasks(sessionId: string, live = true): Promise<BackgroundTask[]> {
    const found = await this.findFile(sessionId);
    if (!found) return [];
    const activity = await this.activity(found.file);
    const out: BackgroundTask[] = [];
    for (const [id, launch] of activity.tasks) {
      const stop = activity.stops.get(id);
      out.push({
        id,
        runId: '',
        runName: '',
        type: 'local_bash',
        description: launch.description ?? launch.command ?? id,
        // A command whose session ended without reporting it back was taken down with it
        status: stop ? stop.status : live ? 'running' : 'stopped',
        toolUseId: launch.toolUseId,
        startedAt: launch.at,
        endedAt: stop?.at ?? null,
        summary: stop?.summary ?? null,
        source: 'disk',
        sessionId,
        command: launch.command,
        backgroundedByUser: launch.backgroundedByUser,
      });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * What a background task wrote, from the file the CLI keeps under its temp dir. The path is
   * always derived from the ids, never taken from the transcript: a notification is just text in a
   * message, and trusting a path found there would read whatever file someone typed into one.
   */
  async taskOutput(sessionId: string, taskId: string): Promise<BackgroundTaskOutput> {
    if (!/^[\w-]+$/.test(taskId)) throw new Error('invalid task id');
    const found = await this.findFile(sessionId);
    if (!found) throw new Error('session not found');
    const file = join(taskDir(found.projectId, sessionId), `${taskId}.output`);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error('no output was kept for that task (it lives in the temp dir, which a reboot clears)');
    const start = Math.max(0, info.size - MAX_TASK_OUTPUT);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return { taskId, output: buffer.toString('utf8'), truncated: start > 0, bytes: info.size };
    } finally {
      await handle.close();
    }
  }

  /** Deletes the transcript and the session's sidecar directory (subagent transcripts, tool results). */
  async deleteSession(sessionId: string): Promise<void> {
    const found = await this.findFile(sessionId);
    if (!found) throw new Error('session not found');
    await rm(found.file);
    await rm(found.file.slice(0, -'.jsonl'.length), { recursive: true, force: true });
    this.cache.delete(found.file);
  }

  async getSession(sessionId: string, opts: { includeSidechains?: boolean } = {}): Promise<SessionDetail | null> {
    const found = await this.findFile(sessionId);
    if (!found) return null;
    const summary = await this.summarize(found.projectId, found.file);
    if (!summary) return null;
    const entries: TranscriptEntry[] = [];
    for await (const o of readJsonl(found.file)) {
      const entry = normalizeMessage(o);
      if (!entry) continue;
      if (entry.isSidechain && !opts.includeSidechains) continue;
      entries.push(entry);
    }
    return { summary, entries };
  }
}
