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
  type AgentTranscript,
  type BackgroundTaskOutput,
  type SessionSummary,
  type SubagentInfo,
  type TranscriptEntry,
  type WorkflowRun,
} from '@agentry/shared';
import { AGENT_ID_RE, WORKFLOW_RUN_ID_RE, emptyAgentRead, readAgentFile } from './agents.ts';
import type { CoreConfig } from './paths.ts';
import { readSessionWorkflows, readWorkflowAgent } from './workflows.ts';

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

/** How much of a subagent's transcript is read for its working directory, which the first lines carry */
const CWD_PROBE_BYTES = 64 * 1024;

/**
 * The directory an agent works in, from the first transcript line that records one. A subagent
 * started with `isolation: worktree` works in its own worktree, not its parent's directory.
 */
async function firstCwd(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(CWD_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CWD_PROBE_BYTES, 0);
    for (const raw of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const cwd = (JSON.parse(raw) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        /* a line cut off by the probe */
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

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

/**
 * How many leading bytes of a buffer end on a character boundary. A read that stops mid-character
 * (a chunk cap, a file still being written) would otherwise decode to a replacement character and
 * make the next read, which starts at the same byte, print the rest of it as garbage.
 */
function completeUtf8(buffer: Buffer): number {
  let i = buffer.length - 1;
  for (let back = 0; i >= 0 && back < 3 && ((buffer[i] ?? 0) & 0xc0) === 0x80; back++) i--;
  if (i < 0) return buffer.length;
  const lead = buffer[i] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buffer.length - i < need ? i : buffer.length;
}

interface TaskLaunch {
  at: string;
  toolUseId: string | null;
  command: string | null;
  description: string | null;
  backgroundedByUser: boolean;
  /** The subagent whose transcript recorded the launch */
  ownerAgentId?: string;
}

interface AgentStop {
  at: string;
  status: string;
  summary: string | null;
}

/** Where an agent stands, from the stop its parent was notified of and how recently it wrote. */
function agentState(stop: AgentStop | undefined, mtime: Date | null, live: boolean): { status: SubagentInfo['status']; endedAt: string | null } {
  const lastActivityAt = mtime ? mtime.toISOString() : null;
  const resumed = stop && mtime ? mtime.getTime() > Date.parse(stop.at) + RESUMED_AFTER_MS : false;
  if (!stop || resumed) return { status: live ? 'running' : 'stopped', endedAt: live ? null : lastActivityAt };
  return { status: stop.status === 'completed' ? 'completed' : 'failed', endedAt: stop.at };
}

interface SessionActivity {
  /** agentId → when it was launched */
  agents: Map<string, string>;
  /** backgroundTaskId → the call that sent it to the background */
  tasks: Map<string, TaskLaunch>;
  /** id → the latest time it stopped, for agents and tasks alike */
  stops: Map<string, AgentStop>;
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
  /** Subagent transcript → its working dir; written once at its start, so never re-read */
  private readonly cwdCache = new Map<string, string | null>();
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
      let meta: { agentType?: string; description?: string; toolUseId?: string; requestShape?: string };
      try {
        meta = JSON.parse(await readFile(join(dir, name), 'utf8')) as typeof meta;
      } catch {
        continue;
      }
      const transcriptFile = join(dir, `agent-${agentId}.jsonl`);
      const transcript = await stat(transcriptFile).catch(() => null);
      let cwd = this.cwdCache.get(transcriptFile);
      if (cwd === undefined && transcript) {
        cwd = await firstCwd(transcriptFile);
        // Only a found value is final: an agent that has not written a line yet will
        if (cwd) this.cwdCache.set(transcriptFile, cwd);
      }
      const lastActivityAt = transcript ? transcript.mtime.toISOString() : null;
      const state = agentState(activity.stops.get(agentId), transcript?.mtime ?? null, live);
      out.push({
        toolUseId: meta.toolUseId ?? '',
        runId: '',
        runName: '',
        subagentType: meta.agentType ?? 'agent',
        description: meta.description ?? agentId,
        status: state.status,
        startedAt: activity.agents.get(agentId) ?? lastActivityAt ?? new Date(0).toISOString(),
        endedAt: state.endedAt,
        source: 'cli',
        sessionId,
        agentId,
        lastActivityAt,
        cwd: cwd ?? null,
        background: meta.requestShape === 'background',
      });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Claude Code workflows a session ran, from the records and journals beside its transcript. */
  async workflows(sessionId: string, live = true): Promise<WorkflowRun[]> {
    const found = await this.findFile(sessionId);
    return found ? readSessionWorkflows(found.file, sessionId, live) : [];
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
    const launches = new Map<string, TaskLaunch>(activity.tasks);
    const stops = new Map(activity.stops);
    // A task a subagent started is launched, and reported back, in that subagent's own transcript:
    // the session's never mentions it. (Inferred from the CLI's transcript format; no real capture
    // of a subagent-owned task was available to check it against.)
    for (const { agentId, activity: own } of await this.subagentActivity(found.file)) {
      for (const [id, launch] of own.tasks) if (!launches.has(id)) launches.set(id, { ...launch, ownerAgentId: agentId });
      for (const [id, stop] of own.stops) {
        const known = stops.get(id);
        if (!known || stop.at > known.at) stops.set(id, stop);
      }
    }
    const out: BackgroundTask[] = [];
    for (const [id, launch] of launches) {
      const stop = stops.get(id);
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
        ...(launch.ownerAgentId ? { fromSubagent: true, ownerAgentId: launch.ownerAgentId } : {}),
      });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Which subagent launched each background task, read from the subagents' transcripts. A run's
   * live stream only says a task is `owned_by_subagent`, never by which one.
   */
  async taskOwners(sessionId: string): Promise<Map<string, string>> {
    const found = await this.findFile(sessionId);
    const owners = new Map<string, string>();
    if (!found) return owners;
    for (const { agentId, activity } of await this.subagentActivity(found.file)) {
      for (const id of activity.tasks.keys()) owners.set(id, agentId);
    }
    return owners;
  }

  /** What each of a session's subagents launched and saw stop, from their own transcripts. */
  private async subagentActivity(transcript: string): Promise<Array<{ agentId: string; activity: SessionActivity }>> {
    const dir = join(transcript.slice(0, -'.jsonl'.length), 'subagents');
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: Array<{ agentId: string; activity: SessionActivity }> = [];
    for (const name of names) {
      const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
      if (!agentId) continue;
      const activity = await this.activity(join(dir, name)).catch(() => null);
      if (activity) out.push({ agentId, activity });
    }
    return out;
  }

  /**
   * What a background task wrote, from the file the CLI keeps under its temp dir. The path is
   * always derived from the ids, never taken from the transcript: a notification is just text in a
   * message, and trusting a path found there would read whatever file someone typed into one.
   */
  async taskOutput(sessionId: string, taskId: string, opts: { offset?: number } = {}): Promise<BackgroundTaskOutput> {
    if (!/^[\w-]+$/.test(taskId)) throw new Error('invalid task id');
    const found = await this.findFile(sessionId);
    if (!found) throw new Error('session not found');
    const file = join(taskDir(found.projectId, sessionId), `${taskId}.output`);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error('no output was kept for that task (it lives in the temp dir, which a reboot clears)');

    // Following a running task: `offset` is where the last read ended. Past the end means the file
    // was replaced under it, and the caller starts over from the tail.
    const resumed = opts.offset !== undefined && opts.offset <= info.size;
    const reset = opts.offset !== undefined && !resumed;
    const start = resumed ? (opts.offset as number) : Math.max(0, info.size - MAX_TASK_OUTPUT);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size - start, MAX_TASK_OUTPUT));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const read = buffer.subarray(0, bytesRead);
      const end = completeUtf8(read);
      return {
        taskId,
        output: read.subarray(0, end).toString('utf8'),
        truncated: !resumed && start > 0,
        bytes: info.size,
        offset: start + end,
        ...(reset ? { reset } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * One subagent's, or with `runId` one workflow agent's, prompt, outcome and whole conversation.
   * Ids go into file paths, so both are validated first. Null when the session or the agent is not
   * there. `after` skips the entries the caller already has, so a live panel appends instead of
   * re-reading a transcript that can run to megabytes on every update.
   */
  async agentTranscript(
    sessionId: string,
    agentId: string,
    opts: { runId?: string; after?: number; live?: boolean } = {},
  ): Promise<AgentTranscript | null> {
    if (!AGENT_ID_RE.test(agentId)) throw new Error('invalid agent id');
    if (opts.runId !== undefined && !WORKFLOW_RUN_ID_RE.test(opts.runId)) throw new Error('invalid workflow run id');
    const found = await this.findFile(sessionId);
    if (!found) return null;
    const live = opts.live ?? true;
    const base = found.file.slice(0, -'.jsonl'.length);
    const dir = opts.runId ? join(base, 'subagents', 'workflows', opts.runId) : join(base, 'subagents');
    const file = join(dir, `agent-${agentId}.jsonl`);
    const info = await stat(file).catch(() => null);
    let meta: { agentType?: string; description?: string; toolUseId?: string; requestShape?: string; workflowPhase?: string } | null;
    try {
      meta = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf8')) as NonNullable<typeof meta>;
    } catch {
      meta = null;
    }
    if (!info && !meta) return null;
    const read = info ? await readAgentFile(file) : emptyAgentRead();
    const lastActivityAt = info?.mtime.toISOString() ?? null;

    let status: AgentTranscript['status'];
    let startedAt: string | null;
    let endedAt: string | null;
    let durationMs: number | null = null;
    let description = meta?.description ?? null;
    let workflowPhase = meta?.workflowPhase ?? null;
    if (opts.runId) {
      const { agent, journalDone } = await readWorkflowAgent(found.file, opts.runId, agentId);
      status = agent?.state === 'done' || journalDone ? 'completed' : agent?.state === 'error' ? 'failed' : live ? 'running' : 'stopped';
      startedAt = agent?.startedAt ?? read.firstAt;
      const finished = status === 'completed' || status === 'failed';
      durationMs = agent?.durationMs ?? null;
      endedAt = !finished ? (live ? null : lastActivityAt) : startedAt && durationMs !== null ? new Date(Date.parse(startedAt) + durationMs).toISOString() : read.lastAt;
      description ??= agent?.label ?? null;
      workflowPhase ??= agent?.phaseTitle ?? null;
    } else {
      const activity = await this.activity(found.file);
      ({ status, endedAt } = agentState(activity.stops.get(agentId), info?.mtime ?? null, live));
      startedAt = activity.agents.get(agentId) ?? read.firstAt;
    }
    if (durationMs === null && startedAt && endedAt) durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

    const total = read.entries.length;
    const from = opts.after !== undefined && opts.after <= total ? opts.after : 0;
    return {
      agentId,
      sessionId,
      kind: opts.runId ? 'workflow' : 'subagent',
      workflowRunId: opts.runId ?? null,
      toolUseId: meta?.toolUseId ?? null,
      subagentType: meta?.agentType ?? null,
      description,
      workflowPhase,
      prompt: read.prompt,
      status,
      background: meta?.requestShape === 'background',
      startedAt,
      endedAt,
      durationMs,
      lastActivityAt,
      model: read.model,
      usage: read.usage,
      toolCalls: read.toolCalls,
      cwd: read.cwd,
      result: read.result,
      entries: read.entries.slice(from),
      from,
      total,
      tasks: opts.runId ? [] : (await this.backgroundTasks(sessionId, live)).filter((t) => t.ownerAgentId === agentId),
    };
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
