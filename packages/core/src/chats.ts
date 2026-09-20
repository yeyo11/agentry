import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  entryText,
  normalizeMessage,
  type Attachment,
  type ChatFork,
  type ChatOrigin,
  type ChatSettingsUpdate,
  type ChatStartOptions,
  type EffectiveEnvironment,
  type Execution,
  type NewChatRequest,
  type PermissionDecision,
  type PermissionMode,
  type PermissionUpdate,
  type RateLimitInfo,
  type ResumeChatRequest,
  type RunEvent,
  type RunStatus,
  type TranscriptEntry,
} from '@agentry/shared';
import { authFreeEnv } from './accounts.ts';
import { executionOutcome } from './chat-model.ts';
import { chatsFromRuns, type ChatRecord, type LegacyRun, type StoredChat } from './chat-records.ts';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from './cli-facts.ts';
import type { Db } from './db.ts';
import { RunEventPublisher } from './event-sources.ts';
import type { EventBus } from './events.ts';
import type { CoreConfig } from './paths.ts';
import type { PermissionBroker } from './permissions.ts';
import { drivesSession, streamJsonProcesses } from './processes.ts';
import type { SessionStore } from './sessions.ts';
import { composeContent, type UploadStore } from './uploads.ts';
import { emptyTokenUsage } from './usage.ts';
import { readProgress, workflowStatus } from './workflows.ts';

/** A control request the CLI has not answered by then is not going to be answered */
const CONTROL_TIMEOUT_MS = 15_000;
const MAX_EVENTS_PER_RUN = 5000;
const MAX_PERSISTED_CHATS = 200;
const PARTIAL_THROTTLE_MS = 50;
const IDLE_TIMEOUT_MS = Number(process.env.AGENTRY_IDLE_TIMEOUT_MS ?? 10 * 60_000);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
// High-frequency events that add nothing to the UI
const IGNORED_SUBTYPES = new Set(['thinking_tokens', 'hook_started', 'hook_response', 'commands_changed']);
/** Wording the CLI uses when the subscription window is spent (`result` text and stderr) */
const RATE_LIMIT_RE = /usage limit|rate limit|session limit|out of (?:usage|quota)|quota exceeded/i;
/** One rotate-and-resume per run: a second failure is a real one, not a quota one */
const MAX_ROTATION_RETRIES = 1;
const MAX_ATTACHMENTS = 20;

/** The CLI takes `manual` on the command line but reports that same mode as `default`. */
const reportedMode = (mode: string): PermissionMode => (mode === 'default' ? 'manual' : (mode as PermissionMode));

/** A person's decision in the shape `can_use_tool` expects; allowing always carries the input. */
function toControlDecision(decision: PermissionDecision, input: Record<string, unknown>): Record<string, unknown> {
  if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message ?? 'denied' };
  return {
    behavior: 'allow',
    updatedInput: decision.updatedInput ?? input,
    ...(decision.updatedPermissions?.length ? { updatedPermissions: decision.updatedPermissions } : {}),
  };
}

export interface RunResult {
  isError: boolean;
  result: string;
  structuredOutput: unknown;
  /** What the chat has cost across every execution so far */
  costUsd: number;
  /**
   * Why a failed result is not one to try again blindly: the budget ran out (the retry meets the same
   * ceiling), the account hit its limit (rotating accounts is the runner's job) or someone stopped it.
   */
  cause?: 'budget' | 'rate-limit' | 'stopped';
}

/** The CLI's result subtype for a ceiling set with `--max-budget-usd`. */
const BUDGET_SUBTYPE = 'error_max_budget_usd';

/** What starts a chat, beyond what the API takes: the housekeeping knobs the wrapper's own callers use. */
export interface NewChat extends NewChatRequest {
  name?: string;
  /** Keep the process alive after each turn so more messages can be sent (default true) */
  keepAlive?: boolean;
  /** Housekeeping: no transcript is written (`--no-session-persistence`), so it cannot be resumed */
  internal?: boolean;
}

export interface RunMeta {
  orchestrationId?: string;
  orchestrationTaskId?: string;
}

/** What is known of a chat that already exists when an execution resumes it from outside the store. */
export interface AdoptedChat {
  cwd: string;
  name: string;
  model: string | null;
}

/**
 * What the runtime says about a chat Agentry drives or has driven: its process, its live stream and
 * what it delegated. The chat the API serves is assembled from this, the transcript and the CLI's
 * own list of sessions (see `chat-service.ts`).
 */
export interface ChatRuntime {
  /** The session id */
  id: string;
  name: string;
  cwd: string;
  /** Directory the CLI actually works in, which differs from `cwd` when it runs in a worktree */
  workingDir: string;
  origin: ChatOrigin;
  derivedFrom: ChatFork | null;
  model: string | null;
  permissionMode: PermissionMode;
  /** The process's state, as the stream reports it: a chat's own state is derived from it */
  status: RunStatus;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  turns: number;
  costUsd: number;
  prompt: string;
  lastText: string | null;
  error: string | null;
  orchestrationId: string | null;
  orchestrationTaskId: string | null;
  account: string | null;
  permissionPrompts: 'host' | 'none';
  /** Prompts waiting for someone right now: the chat is stuck until they are answered */
  pendingPrompts: number;
  executions: Execution[];
  backgroundTasks: BackgroundTask[];
  subagents: SubagentInfo[];
  workflows: WorkflowRun[];
}

/** A shell command the process started and has had no answer to yet. */
export interface RunningCommand {
  command: string;
  startedAt: string;
}

/** What the process working on a chat is doing right now. */
export interface ChatPulse {
  /** The last thing it did, streamed text included */
  lastEventAt: string;
  commands: RunningCommand[];
}

const now = () => new Date().toISOString();

/** Started (a failed spawn has no pid) and not exited yet */
const processUp = (proc: ChildProcess): boolean => proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const named = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : ((x ?? {}) as Record<string, unknown>))) : [];

function toEnvironment(cwd: string, chatId: string, raw: Record<string, unknown>): EffectiveEnvironment {
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const memory = raw.memory_paths && typeof raw.memory_paths === 'object' ? (raw.memory_paths as Record<string, unknown>) : {};
  return {
    cwd,
    observedAt: now(),
    chatId,
    cliVersion: text(raw.claude_code_version),
    model: text(raw.model),
    permissionMode: text(raw.permissionMode),
    outputStyle: text(raw.output_style),
    tools: strings(raw.tools),
    mcpServers: named(raw.mcp_servers).map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? ''), source: text(s.source) ?? undefined })),
    // agents/skills are plain names on some versions and objects on others
    agents: named(raw.agents).map((a) => String(a.name ?? a.agentType ?? '')).filter(Boolean),
    skills: named(raw.skills).map((s) => String(s.name ?? '')).filter(Boolean),
    slashCommands: strings(raw.slash_commands),
    plugins: named(raw.plugins).map((p) => ({ name: String(p.name ?? ''), path: text(p.path) ?? undefined, source: text(p.source) ?? undefined })),
    memoryPaths: Object.fromEntries(Object.entries(memory).filter((e): e is [string, string] => typeof e[1] === 'string')),
  };
}

/**
 * A chat Agentry has a record of, in memory: its live stream, whatever it delegated, its history of
 * executions and, while one is running, the process. There is one per session id, however many
 * times the chat is resumed: resuming adds an execution here, it never adds a chat.
 */
class LiveChat {
  readonly emitter = new EventEmitter();
  readonly events: RunEvent[] = [];
  readonly tasks = new Map<string, BackgroundTask>();
  /** Long commands the CLI reports as tasks while they run in the foreground; listed once sent to the background */
  readonly foregroundTasks = new Map<string, BackgroundTask>();
  readonly subagents = new Map<string, SubagentInfo>();
  readonly workflows = new Map<string, WorkflowRun>();
  /** Every execution, oldest first; at most the last one is live */
  executions: Execution[] = [];
  proc: ChildProcessWithoutNullStreams | null = null;
  seq = 0;
  status: RunStatus = 'starting';
  model: string | null;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  createdAt = now();
  updatedAt = now();
  /** The last thing the process did, streamed text included, which `updatedAt` (stored events only) leaves out */
  activityAt = now();
  endedAt: string | null = null;
  lastText: string | null = null;
  /** Where the CLI says it works, from its init event: a worktree when it was given one */
  workingDir: string | null = null;
  error: string | null = null;
  lastResult: RunResult | null = null;
  stopRequested = false;
  idleTimer: NodeJS.Timeout | null = null;
  partial: { block: 'text' | 'thinking'; text: string } | null = null;
  partialTimer: NodeJS.Timeout | null = null;
  /** Control requests sent to the CLI, by request_id, waiting for its control_response */
  readonly controls = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  controlSeq = 0;
  /** Prompts the CLI is holding for a person */
  pendingPrompts = 0;
  /** The turn is ending because someone interrupted it, not because it failed */
  interruptRequested = false;
  /**
   * Messages that arrived while the process was on its way out (stopped, or its stdin closed and it
   * finishing background work): one process replaces it when it exits and gets all of them. Each
   * used to schedule a replacement of its own, and three messages made three processes.
   */
  queued: Array<{ text: string; attachments: Attachment[] }> = [];
  /**
   * The CLI has confirmed the session exists (its `init` arrived): from then on a process resumes
   * it. Until then the first spawn creates it, under the id Agentry chose, which is what lets a fork
   * have its id before the CLI has said anything.
   */
  created: boolean;
  /** The chat this one is a copy of, until the copy is confirmed: the first spawn forks it */
  forkFrom: string | null = null;
  /** The last turn sent, files included, so a turn lost to a rate limit is replayed whole */
  lastUserTurn: { text: string; attachments: string[] } | null = null;
  /** The turn died against the account's rate limit */
  rateLimited = false;
  /** A rotation was already asked for this attempt */
  rotationRequested = false;
  rotationRetries = 0;

  constructor(
    /** The session id */
    readonly id: string,
    readonly opts: NewChat,
    readonly meta: RunMeta,
    readonly origin: ChatOrigin,
    readonly derivedFrom: ChatFork | null,
    config: CoreConfig,
    created = false,
  ) {
    this.cwd = resolve(opts.cwd ?? config.workspaceDir);
    this.permissionMode = opts.permissionMode ?? config.defaultPermissionMode;
    this.model = opts.model ?? null;
    this.created = created;
    this.name = opts.name ?? `${basename(this.cwd)}-${this.id.slice(0, 6)}`;
    this.emitter.setMaxListeners(100);
  }

  /**
   * Rebuilds a chat persisted by a previous wrapper process; it has no process until a message
   * resumes it. An execution that was live when that wrapper went away is over now, and nobody
   * stopped it: it ends as `interrupted`.
   */
  static restore({ record, executions }: StoredChat, config: CoreConfig): LiveChat {
    const chat = new LiveChat(
      record.id,
      {
        prompt: record.prompt,
        cwd: record.cwd,
        name: record.name,
        ...(record.model ? { model: record.model } : {}),
        permissionMode: record.permissionMode,
        internal: record.origin === 'internal',
        ...(record.account ? { account: record.account } : {}),
        permissionPrompts: record.permissionPrompts,
      },
      { orchestrationId: record.orchestrationId ?? undefined, orchestrationTaskId: record.orchestrationTaskId ?? undefined },
      record.origin,
      record.derivedFrom,
      config,
      true,
    );
    chat.executions = executions.map((e) =>
      e.endedAt === null ? { ...e, endedAt: record.updatedAt, outcome: executionOutcome('busy', true) } : e,
    );
    const last = chat.executions[chat.executions.length - 1];
    // The process's own status, for whatever still asks: nothing is running, and how it ended is
    // what the last execution says
    chat.status = last?.outcome === 'completed' || last?.outcome === 'failed' ? last.outcome : 'stopped';
    chat.createdAt = record.createdAt;
    chat.updatedAt = record.updatedAt;
    chat.endedAt = last?.endedAt ?? record.updatedAt;
    chat.lastText = record.lastText;
    chat.error = last?.error ?? null;
    chat.workingDir = record.workingDir;
    return chat;
  }

  /** The live execution, when a process is working on the chat */
  get execution(): Execution | null {
    const last = this.executions[this.executions.length - 1];
    return last && last.endedAt === null ? last : null;
  }

  get turns(): number {
    return this.executions.reduce((sum, e) => sum + e.turns, 0);
  }

  /** What the chat has cost: only what the CLI reported, nothing estimated */
  get costUsd(): number {
    return this.executions.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  }

  /** A message waits for the exiting process to be replaced: its exit is not the chat's end */
  get respawnQueued(): boolean {
    return this.queued.length > 0;
  }

  /**
   * Until it has exited. `killed` only says a signal was delivered: a stopped process can take
   * seconds to go, and counting it gone let a resume start a second process beside it.
   */
  get alive(): boolean {
    return this.proc !== null && processUp(this.proc);
  }

  /** The mode and model the chat runs with now, and the live execution with it. */
  setSettings(update: { permissionMode?: PermissionMode; model?: string }): void {
    const live = this.execution;
    if (update.permissionMode) {
      this.permissionMode = update.permissionMode;
      if (live) live.permissionMode = update.permissionMode;
    }
    if (update.model) {
      this.model = update.model;
      if (live) live.model = update.model;
    }
  }

  /** Opens the execution a process starts, on top of the settings the chat has now. */
  beginExecution(): Execution {
    const execution: Execution = {
      id: randomUUID(),
      startedAt: now(),
      endedAt: null,
      outcome: null,
      error: null,
      permissionMode: this.permissionMode,
      model: this.model,
      account: this.opts.account ?? null,
      maxBudgetUsd: typeof this.opts.maxBudgetUsd === 'number' && this.opts.maxBudgetUsd > 0 ? this.opts.maxBudgetUsd : null,
      costUsd: null,
      tokens: emptyTokenUsage(),
      turns: 0,
    };
    this.executions.push(execution);
    return execution;
  }

  summary(): ChatRuntime {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      workingDir: this.workingDir ?? (this.opts.worktree ? join(this.cwd, '.claude', 'worktrees', this.opts.worktree) : this.cwd),
      origin: this.origin,
      derivedFrom: this.derivedFrom,
      model: this.model,
      permissionMode: this.permissionMode,
      status: this.status,
      pid: this.alive ? (this.proc?.pid ?? null) : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      endedAt: this.endedAt,
      turns: this.turns,
      costUsd: this.costUsd,
      prompt: this.opts.prompt,
      lastText: this.lastText,
      error: this.error,
      orchestrationId: this.meta.orchestrationId ?? null,
      orchestrationTaskId: this.meta.orchestrationTaskId ?? null,
      account: this.opts.account ?? null,
      permissionPrompts: this.opts.permissionPrompts === 'host' ? 'host' : 'none',
      pendingPrompts: this.pendingPrompts,
      executions: this.executions,
      backgroundTasks: [...this.tasks.values()],
      subagents: [...this.subagents.values()],
      workflows: [...this.workflows.values()],
    };
  }

  /** What the store keeps of the chat besides its executions. */
  record(): ChatRecord {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      workingDir: this.workingDir,
      origin: this.origin,
      orchestrationId: this.meta.orchestrationId ?? null,
      orchestrationTaskId: this.meta.orchestrationTaskId ?? null,
      derivedFrom: this.derivedFrom,
      prompt: this.opts.prompt,
      lastText: this.lastText,
      model: this.model,
      permissionMode: this.permissionMode,
      account: this.opts.account ?? null,
      permissionPrompts: this.opts.permissionPrompts === 'host' ? 'host' : 'none',
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  push(event: Omit<RunEvent, 'seq' | 'ts'>): void {
    const full: RunEvent = { ...event, seq: ++this.seq, ts: now() };
    this.events.push(full);
    if (this.events.length > MAX_EVENTS_PER_RUN) this.events.splice(0, this.events.length - MAX_EVENTS_PER_RUN);
    this.updatedAt = full.ts;
    this.activityAt = full.ts;
    this.emitter.emit('event', full);
  }

  /** Streams the in-progress block to live subscribers only: not stored, not replayed, seq untouched. */
  emitPartial(): void {
    this.activityAt = now();
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      if (!this.partial) return;
      this.emitter.emit('event', {
        seq: this.seq,
        ts: now(),
        kind: 'partial',
        type: 'stream_event',
        block: this.partial.block,
        text: this.partial.text,
      } satisfies RunEvent);
    }, PARTIAL_THROTTLE_MS);
  }

  setStatus(status: RunStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.push({ kind: 'status', type: 'status', status });
  }
}

/**
 * Manages `claude -p` processes using stream-json input/output.
 * Each LiveChat is a live conversation: it accepts multiple turns over stdin and, if the
 * process already exited, it is respawned with `--resume` when a new message arrives.
 */
/** What the runner needs to know about claude-swap, injected by Core to avoid a cycle. */
export interface AccountResolver {
  /** claude-swap is installed and has at least one account registered */
  readonly managed: boolean;
  isActive(identifier: string): boolean;
}

export class ChatManager extends EventEmitter {
  private readonly chats = new Map<string, LiveChat>();
  lastRateLimit: RateLimitInfo | null = null;
  /** Set when claude-swap manages the accounts; null leaves chats on the active credential */
  accounts: AccountResolver | null = null;
  /** Where chats with `permissionPrompts: 'host'` send what they ask; null means nobody answers */
  permissions: PermissionBroker | null = null;
  /** Files attached to messages; every chat may read them */
  uploads: UploadStore | null = null;
  /** Where changes to chats are announced; set by Core */
  bus: EventBus | null = null;
  /** Latest `init` snapshot per working directory */
  readonly environments = new Map<string, EffectiveEnvironment>();

  private readonly publisher = new RunEventPublisher((event) => this.bus?.emit(event));

  private readonly file: string;

  /**
   * CLI processes found at start still working on a restored chat's session, by chat id: a previous
   * wrapper went away without them (a crash, or `tsx watch` killing it mid-shutdown). Nothing here
   * can write to their stdin, so the chat cannot attach to them; it must not resume beside them.
   */
  private readonly leftovers = new Map<string, number[]>();

  constructor(
    private readonly config: CoreConfig,
    private readonly db: Db,
  ) {
    super();
    this.file = join(config.dataDir, 'runs.json');
    for (const env of db.loadEnvironments()) this.environments.set(env.cwd, env);
  }

  /** The CLI's per-model cost, cumulative over its process like the total, so it only ever grows. */
  private learnModelCosts(execution: Execution, modelUsage: unknown): void {
    if (!modelUsage || typeof modelUsage !== 'object') return;
    for (const [model, entry] of Object.entries(modelUsage)) {
      const usd = (entry as { costUSD?: unknown } | null)?.costUSD;
      if (typeof usd !== 'number' || !Number.isFinite(usd)) continue;
      execution.modelCosts = { ...execution.modelCosts, [model]: Math.max(execution.modelCosts?.[model] ?? 0, usd) };
    }
  }

  /** The context window the CLI reports for each model that answered: the only real source of one. */
  private learnWindows(modelUsage: unknown): void {
    if (!modelUsage || typeof modelUsage !== 'object') return;
    for (const [model, entry] of Object.entries(modelUsage)) {
      const window = (entry as { contextWindow?: unknown } | null)?.contextWindow;
      if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) continue;
      try {
        this.db.saveModelWindow(model, window);
      } catch {
        // a window that could not be written is only a percentage that shows later
      }
    }
  }

  private persist(): void {
    // Internal chats are persisted too. The origin means "housekeeping: no transcript, hidden from
    // the chat list", not "disposable": the orchestration planner is internal and costs real
    // money, and dropping it on restart took the only record of that work with it. The other
    // internal chat, the auth check, removes itself as soon as it finishes.
    const stored = [...this.chats.values()].map((chat) => ({ record: chat.record(), executions: chat.executions }));
    try {
      this.db.saveChats(stored, MAX_PERSISTED_CHATS);
    } catch {
      // persistence is best-effort: losing a save must never take the live chat down with it
    }
  }

  /** Carries a pre-SQLite `runs.json` into the store once, then renames it out of the way. */
  private importLegacy(): void {
    if (!existsSync(this.file)) return;
    try {
      this.db.saveChats(chatsFromRuns(JSON.parse(readFileSync(this.file, 'utf8')) as LegacyRun[]).chats, MAX_PERSISTED_CHATS);
    } catch {
      // corrupt file: there is nothing to carry over
    }
    try {
      renameSync(this.file, `${this.file}.migrated`);
    } catch {
      // another process got there first
    }
  }

  /**
   * Loads the chats of previous wrapper processes. Their event buffers are rebuilt from the
   * session transcripts, so a restored chat can be opened and continued like a live one.
   */
  async restore(sessions: SessionStore): Promise<void> {
    this.importLegacy();
    const stored = this.db.loadChats().filter(({ record }) => !this.chats.has(record.id));
    // Before the first await, so whoever starts the wrapper can report them as soon as Core exists
    const processes = streamJsonProcesses();
    for (const { record } of stored) {
      const pids = processes.filter((p) => drivesSession(p.argv, record.id)).map((p) => p.pid);
      if (pids.length) this.leftovers.set(record.id, pids);
    }
    for (const entry of stored) {
      const chat = LiveChat.restore(entry, this.config);
      this.chats.set(chat.id, chat);
      const page = await sessions.getSession(chat.id, { includeSidechains: true }).catch(() => null);
      for (const item of page?.entries ?? []) chat.push({ kind: 'message', type: item.role, entry: item });
      const pids = this.leftovers.get(chat.id);
      if (pids) {
        chat.push({
          kind: 'notice',
          type: 'notice',
          text:
            `A CLI process a previous wrapper started for this session is still running (pid ${pids.join(', ')}). ` +
            'It is not tracked here, so the chat cannot be resumed beside it: wait for it to finish, or stop the chat to end it.',
          data: { pids },
        });
      }
      chat.updatedAt = entry.record.updatedAt; // push() bumped it
      this.watch(chat);
    }
    // The executions the restore closed as interrupted are written down, so a second start does
    // not have to conclude it again
    if (stored.length) this.persist();
  }

  /** Processes found at start working on a restored chat's session that are still up. */
  strays(): Array<{ chatId: string; pid: number }> {
    if (this.leftovers.size === 0) return [];
    const processes = streamJsonProcesses();
    return [...this.leftovers].flatMap(([chatId, pids]) =>
      pids.filter((pid) => processes.some((p) => p.pid === pid && drivesSession(p.argv, chatId))).map((pid) => ({ chatId, pid })),
    );
  }

  /**
   * What would share the session with a process started for this chat now: any CLI process on it,
   * this wrapper's (another chat on the same session) or not, which includes whatever a previous
   * wrapper left.
   * A session that does not exist yet (a new chat, a fork) has no one on it.
   */
  private sessionHolders(chat: LiveChat): number[] {
    if (!chat.created) return [];
    return streamJsonProcesses()
      .filter((p) => drivesSession(p.argv, chat.id))
      .map((p) => p.pid);
  }

  /** Announces what changes in the chat from here on; `created` also announces the chat itself. */
  private watch(chat: LiveChat, created = false): void {
    if (created) this.publisher.created(chat.summary());
    else this.publisher.baseline(chat.summary());
    chat.emitter.on('event', (event: RunEvent) => {
      // Partials only stream text and stderr changes nothing a list shows
      if (event.kind !== 'partial' && event.kind !== 'stderr') this.publisher.observe(chat.summary());
    });
  }

  list(): ChatRuntime[] {
    return [...this.chats.values()].map((r) => r.summary()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ChatRuntime | null {
    return this.chats.get(id)?.summary() ?? null;
  }

  /**
   * What the process working on a chat is doing right now, read from the events it streamed: when
   * it last did anything, and the shell commands it started and has not had an answer to. Null
   * when Agentry has no process on the chat, which is when there is nothing to watch. Only the
   * live execution counts: a command a previous wrapper left unanswered is not running.
   */
  pulse(id: string): ChatPulse | null {
    const chat = this.chats.get(id);
    const live = chat?.execution;
    if (!chat || !live || !chat.alive) return null;
    const open = new Map<string, RunningCommand>();
    for (const event of chat.events) {
      if (event.ts < live.startedAt) continue;
      for (const block of event.entry?.blocks ?? []) {
        if (block.type === 'tool_use' && block.name === 'Bash') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          // A background command answers at once: what keeps running is the task, not the call
          if (input.run_in_background !== true) open.set(block.id, { command: typeof input.command === 'string' ? input.command : 'a command', startedAt: event.ts });
        } else if (block.type === 'tool_result') open.delete(block.toolUseId);
      }
    }
    return { lastEventAt: chat.activityAt, commands: [...open.values()] };
  }

  events(id: string, sinceSeq = 0): RunEvent[] {
    return this.chats.get(id)?.events.filter((e) => e.seq > sinceSeq) ?? [];
  }

  /**
   * The messages a chat's process streamed, oldest first: what its transcript would hold, for a
   * chat that keeps none (housekeeping ones run without persistence, and a new one has written
   * nothing yet). Null when Agentry has no such chat.
   */
  messages(id: string): TranscriptEntry[] | null {
    const chat = this.chats.get(id);
    if (!chat) return null;
    return chat.events.flatMap((e): TranscriptEntry[] => (e.kind === 'message' && e.entry ? [e.entry] : []));
  }

  activeCount(): number {
    return [...this.chats.values()].filter((r) => r.alive).length;
  }

  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    const chat = this.chats.get(id);
    if (!chat) return () => {};
    chat.emitter.on('event', listener);
    return () => chat.emitter.off('event', listener);
  }

  /**
   * Starts a new chat: a new session, under an id Agentry chooses and imposes on the CLI. Continuing
   * a conversation that exists is `resume` (the same chat) or `fork` (a new one), never this.
   */
  start(opts: NewChat, meta: RunMeta = {}): ChatRuntime {
    if (!opts.prompt?.trim() && !opts.attachments?.length) throw new Error('prompt is required');
    this.admit(opts);
    const attachments = this.resolveAttachments(opts.attachments);
    return this.begin(new LiveChat(randomUUID(), opts, meta, opts.internal ? 'internal' : meta.orchestrationId ? 'orchestration' : 'agentry', null, this.config), opts.prompt, attachments);
  }

  /**
   * Continues a chat nobody holds, in place: a new execution on the same session, which keeps its id.
   * A chat this wrapper has no record of (it was started from a terminal, say) is adopted: it
   * becomes ours to drive, and stays `external`, because that is where it was born. Whether
   * something holds the session is checked again here, on the process table, whatever the caller
   * saw a moment ago.
   */
  resume(id: string, request: ResumeChatRequest, adopt?: AdoptedChat): ChatRuntime {
    if (!request.prompt?.trim() && !request.attachments?.length) throw new Error('prompt is required');
    let chat = this.chats.get(id);
    if (chat?.alive) throw new Error('the chat already has a live execution; send it a message instead');
    this.admit(request);
    const attachments = this.resolveAttachments(request.attachments);
    if (!chat) {
      if (!adopt) throw new Error('chat not found');
      chat = new LiveChat(id, { prompt: request.prompt, cwd: adopt.cwd, name: adopt.name, ...(adopt.model ? { model: adopt.model } : {}) }, {}, 'external', null, this.config, true);
      chat.workingDir = adopt.cwd;
    }
    this.applyStartOptions(chat, request);
    const known = this.chats.has(id);
    if (!known) this.chats.set(id, chat);
    try {
      this.spawnProcess(chat, request.prompt, attachments);
    } catch (err) {
      // Refused before any process started (something else holds the session): an adopted chat is not ours yet
      if (!known) this.chats.delete(id);
      throw err;
    }
    if (!known) this.watch(chat, true);
    return chat.summary();
  }

  /**
   * Continues a chat in a copy: a new chat, with the same history, that records where it came from.
   * The copy's id is chosen here and imposed on the CLI (`--session-id` beside `--fork-session`), so
   * the chat exists under its final id from the first instant and no other row can stand for it.
   */
  fork(sourceId: string, request: ResumeChatRequest, source: AdoptedChat): ChatRuntime {
    if (!request.prompt?.trim() && !request.attachments?.length) throw new Error('prompt is required');
    this.admit(request);
    const attachments = this.resolveAttachments(request.attachments);
    const known = this.chats.get(sourceId);
    const chat = new LiveChat(
      randomUUID(),
      { prompt: request.prompt, cwd: source.cwd, name: `${source.name} (fork)`.slice(0, 60), ...(source.model ? { model: source.model } : {}) },
      {},
      'agentry',
      { chatId: sourceId, at: now() },
      this.config,
    );
    chat.forkFrom = sourceId;
    chat.workingDir = source.cwd;
    if (known) chat.permissionMode = known.permissionMode;
    this.applyStartOptions(chat, request);
    return this.begin(chat, request.prompt, attachments);
  }

  /** Refuses what cannot start, before anything is created. */
  private admit(opts: ChatStartOptions): void {
    if (opts.account && !this.accounts?.managed) {
      throw new Error('no claude-swap account is registered: a chat cannot be pinned to one');
    }
    if (this.activeCount() >= this.config.maxConcurrentRuns) {
      throw new Error(`Concurrent run limit reached (${this.config.maxConcurrentRuns})`);
    }
  }

  /** What a request chooses for the execution it starts, on top of what the chat already had. */
  private applyStartOptions(chat: LiveChat, options: ChatStartOptions): void {
    const { opts } = chat;
    chat.setSettings({ ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}), ...(options.model ? { model: options.model } : {}) });
    for (const key of ['model', 'effort', 'permissionMode', 'appendSystemPrompt', 'allowedTools', 'maxBudgetUsd', 'permissionPrompts', 'account'] as const) {
      if (options[key] !== undefined) Object.assign(opts, { [key]: options[key] });
    }
  }

  private begin(chat: LiveChat, prompt: string, attachments: Attachment[]): ChatRuntime {
    if (!existsSync(chat.cwd)) mkdirSync(chat.cwd, { recursive: true });
    this.chats.set(chat.id, chat);
    try {
      this.spawnProcess(chat, prompt, attachments);
    } catch (err) {
      this.chats.delete(chat.id);
      throw err;
    }
    // After the spawn, so the announcement carries the status the process started with
    this.watch(chat, true);
    return chat.summary();
  }

  /**
   * Sends a new turn. A chat has at most one process: a live one gets the message, one on its way
   * out hands it to the single process that replaces it, and only a chat with none resumes the
   * session with --resume.
   */
  send(id: string, text: string, attachmentIds: string[] = []): ChatRuntime {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    const attachments = this.resolveAttachments(attachmentIds);
    if (!text.trim() && attachments.length === 0) throw new Error('text is required');
    if (!chat.alive) {
      this.spawnProcess(chat, text, attachments);
    } else if (chat.stopRequested || chat.proc?.stdin.writableEnded === true || chat.respawnQueued) {
      // A message written now would never be read: it waits for the replacement, behind any
      // message already waiting, so the order they were sent in is the order they arrive in
      chat.queued.push({ text, attachments });
    } else {
      this.writeUserMessage(chat, text, attachments);
    }
    return chat.summary();
  }

  /** The process has exited: one process takes every message that waited for it. */
  private drainQueue(chat: LiveChat): void {
    const queued = chat.queued;
    chat.queued = [];
    const [next, ...rest] = queued;
    if (!next) return;
    // Something that heard the chat end may have resumed it already: then that process gets them all
    if (chat.alive) {
      for (const message of queued) this.writeUserMessage(chat, message.text, message.attachments);
      return;
    }
    try {
      this.spawnProcess(chat, next.text, next.attachments);
    } catch (err) {
      chat.error = err instanceof Error ? err.message : String(err);
      // The exit ended the chat while a message was waiting; that message is lost, and anyone
      // waiting for its result has to hear so
      chat.endedAt = null;
      this.finalize(chat, 'failed');
      return;
    }
    for (const message of rest) this.writeUserMessage(chat, message.text, message.attachments);
  }

  /** Looks the uploads up before anything starts, so a bad id fails the request, not the turn. */
  private resolveAttachments(ids: string[] = []): Attachment[] {
    if (ids.length === 0) return [];
    if (!this.uploads) throw new Error('attachments are not available');
    if (ids.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} files can be attached to one message`);
    const uploads = this.uploads;
    return ids.map((id) => uploads.get(String(id)));
  }

  stop(id: string): ChatRuntime {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    chat.stopRequested = true;
    // Stopping means none of them is wanted any more
    chat.queued = [];
    const proc = chat.proc;
    if (!chat.alive) {
      // Nothing of this wrapper's: what is left is a process a previous one started on this chat
      for (const pid of this.strays().filter((s) => s.chatId === id).map((s) => s.pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // gone in between
        }
      }
    }
    if (chat.alive && proc) {
      proc.kill('SIGTERM');
      // The process being stopped, not whatever `chat.proc` is by then: a chat resumed within these
      // seconds has a new process, and this used to kill it
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, 5000).unref();
    }
    return chat.summary();
  }

  /**
   * Ends the current turn and keeps the process: the CLI withdraws any prompt it was holding and
   * waits for the next message, unlike `stop`, which takes the process down.
   */
  async interrupt(id: string): Promise<ChatRuntime> {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    if (!chat.alive) throw new Error('the chat has no live process to interrupt');
    if (chat.status !== 'busy' && chat.status !== 'starting') return chat.summary();
    chat.interruptRequested = true;
    try {
      await this.control(chat, { subtype: 'interrupt' });
    } catch (err) {
      chat.interruptRequested = false;
      throw err;
    }
    return chat.summary();
  }

  /**
   * Changes the permission mode or the model. A live process switches at once; one that has
   * exited gets them when the next message resumes it.
   */
  async updateSettings(id: string, update: ChatSettingsUpdate): Promise<ChatRuntime> {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    const { permissionMode, model } = update;
    if (permissionMode !== undefined) {
      if (chat.alive) await this.control(chat, { subtype: 'set_permission_mode', mode: permissionMode });
      chat.setSettings({ permissionMode });
    }
    if (model !== undefined) {
      const next = model.trim();
      if (!next) throw new Error('model must not be empty');
      if (chat.alive) await this.control(chat, { subtype: 'set_model', model: next });
      chat.opts.model = next;
      chat.setSettings({ model: next });
    }
    this.persist();
    return chat.summary();
  }

  /** Sends a control request down the chat's stdin and resolves with the CLI's response. */
  private control(chat: LiveChat, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proc = chat.proc;
    const requestId = `agentry-${String(++chat.controlSeq)}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        chat.controls.delete(requestId);
        reject(new Error(`the CLI did not answer ${String(request.subtype)} in time`));
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      chat.controls.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolvePromise(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write(proc, { type: 'control_request', request_id: requestId, request });
    });
  }

  private write(proc: ChildProcessWithoutNullStreams | null, message: unknown): void {
    proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** The CLI asks the host something: a tool permission, a question, a plan to approve. */
  private handleControlRequest(chat: LiveChat, proc: ChildProcessWithoutNullStreams, requestId: string, request: Record<string, unknown>): void {
    // The answer goes to the process that asked, which is not always the chat's by the time it comes
    const reply = (response: Record<string, unknown>) =>
      this.write(proc, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    if (request.subtype !== 'can_use_tool') {
      // Hooks and SDK MCP servers are never registered, so nothing else should arrive; an answer
      // still has to, or the CLI waits for it
      this.write(proc, {
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: `Agentry does not handle ${String(request.subtype)}` },
      });
      return;
    }
    const input = (request.input ?? {}) as Record<string, unknown>;
    const broker = this.permissions;
    if (!broker || chat.opts.permissionPrompts !== 'host') {
      reply({ behavior: 'deny', message: 'Nobody is answering permission prompts for this chat' });
      return;
    }
    chat.pendingPrompts++;
    void broker
      .ask({
        id: requestId,
        runId: chat.id,
        toolName: String(request.tool_name ?? 'unknown'),
        toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : '',
        input,
        requestedAt: now(),
        ...(typeof request.description === 'string' ? { description: request.description } : {}),
        ...(Array.isArray(request.permission_suggestions) ? { suggestions: request.permission_suggestions as PermissionUpdate[] } : {}),
        ...(request.requires_user_interaction === true ? { requiresUserInteraction: true } : {}),
      })
      .then((decision) => {
        chat.pendingPrompts = Math.max(0, chat.pendingPrompts - 1);
        // Withdrawn by the CLI, or the process is gone: nobody is waiting for an answer
        if (!decision || !processUp(proc)) return;
        reply(toControlDecision(decision, input));
      });
  }

  remove(id: string): boolean {
    const chat = this.chats.get(id);
    if (!chat || chat.alive) return false;
    this.chats.delete(id);
    this.publisher.forget(id);
    this.bus?.emit({ type: 'run.removed', title: `${chat.name} removed`, runId: id });
    this.db.deleteChat(id);
    this.persist();
    return true;
  }

  stopAll(): void {
    for (const chat of this.chats.values()) if (chat.alive) this.stop(chat.id);
  }

  /** Resolves with the first `result` after the call, or when the process exits. */
  /** The result of a chat that is already over, or null while it can still produce one. */
  private static settled(chat: LiveChat): RunResult | null {
    if (chat.lastResult) return chat.lastResult;
    if (!['completed', 'failed', 'stopped'].includes(chat.status)) return null;
    return ChatManager.ended(chat, chat.status);
  }

  /** What a chat whose process ended without a result stands for. */
  private static ended(chat: LiveChat, status: string): RunResult {
    return {
      isError: true,
      result: chat.error ?? `The process ended (${status}) without a result`,
      structuredOutput: undefined,
      costUsd: chat.costUsd,
      ...(chat.stopRequested ? { cause: 'stopped' as const } : chat.rateLimited ? { cause: 'rate-limit' as const } : {}),
    };
  }

  /** Resolves once the chat has no process: at once when it has none, or when the one it has exits. */
  async exited(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (chat?.alive && chat.proc) await once(chat.proc, 'exit');
  }

  /**
   * Resolves with the next result the chat produces, ignoring one it already has: what a turn sent
   * to a chat that has answered before needs, where {@link waitForResult} would return the old one.
   * Call it before sending the turn, so nothing is missed in between.
   */
  nextResult(id: string): Promise<RunResult> {
    const chat = this.chats.get(id);
    if (!chat) return Promise.reject(new Error('chat not found'));
    const before = chat.lastResult;
    return new Promise((resolvePromise) => {
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'result' && chat.lastResult && chat.lastResult !== before) finish(chat.lastResult);
        else if (event.kind === 'status' && ['completed', 'failed', 'stopped'].includes(event.status ?? '') && !chat.respawnQueued) {
          finish(
            chat.lastResult && chat.lastResult !== before ? chat.lastResult : ChatManager.ended(chat, event.status ?? 'ended'),
          );
        }
      };
      const finish = (result: RunResult) => {
        chat.emitter.off('event', onEvent);
        resolvePromise(result);
      };
      chat.emitter.on('event', onEvent);
    });
  }

  waitForResult(id: string): Promise<RunResult> {
    const chat = this.chats.get(id);
    if (!chat) return Promise.reject(new Error('chat not found'));
    // A chat that has already ended emits nothing further, so subscribing alone would wait for an
    // event that never comes. Anything awaiting it — the planner holds an HTTP request open —
    // would hang until the process dies.
    const ended = ChatManager.settled(chat);
    if (ended) return Promise.resolve(ended);
    return new Promise((resolvePromise) => {
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'result' && chat.lastResult) finish(chat.lastResult);
        else if (event.kind === 'status' && ['completed', 'failed', 'stopped'].includes(event.status ?? '')) {
          finish(chat.lastResult ?? ChatManager.ended(chat, event.status ?? 'ended'));
        }
      };
      const finish = (result: RunResult) => {
        chat.emitter.off('event', onEvent);
        resolvePromise(result);
      };
      chat.emitter.on('event', onEvent);
    });
  }

  private buildArgs(chat: LiveChat): string[] {
    const { opts } = chat;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', chat.permissionMode,
      // Makes bypassPermissions a mode the chat can be switched to later, without starting in it: the
      // CLI refuses the switch otherwise. Starting a chat in that mode is already open to the same caller.
      '--allow-dangerously-skip-permissions',
    ];
    if (chat.forkFrom) {
      // The copy is created under the id Agentry chose; until the CLI confirms it, a respawn forks again
      args.push('--resume', chat.forkFrom, '--fork-session', '--session-id', chat.id, '--name', chat.name);
    } else if (chat.created) {
      args.push('--resume', chat.id);
    } else {
      args.push('--session-id', chat.id, '--name', chat.name);
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.allowedTools?.length) args.push(`--allowedTools=${opts.allowedTools.join(',')}`);
    // Attached files live outside every project; this is what lets Claude open them by path
    if (this.uploads) args.push('--add-dir', this.uploads.dir);
    // The CLI creates, names and locks the worktree itself, and works in it for the session
    if (opts.worktree) args.push('--worktree', opts.worktree);
    // The CLI stops the chat itself once the ceiling is reached, which no amount of watching from
    // out here could do reliably
    if (typeof opts.maxBudgetUsd === 'number' && opts.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    }
    // Prompts go to a host only when something is listening: a chat waiting on an answer that never
    // comes is worse than one told plainly that it was denied. `stdio` makes the CLI ask on its own
    // stdout as control requests, the same channel the Agent SDK uses, and read the answer on stdin.
    if (opts.permissionPrompts === 'host' && this.permissions) {
      args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'stdio');
    } else {
      args.push('--permission-prompts', 'none');
    }
    if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
    if (opts.internal) args.push('--no-session-persistence');
    return args;
  }

  /**
   * `cswap run <account> --share-history -- <claude args>` execs Claude Code against that
   * account's session profile; `--share-history` symlinks `projects/` back to the real config
   * dir, so the transcript still lands where the session store reads it. Pinning to the account
   * that is already active would create a second credential copy that can drift, so it is
   * spawned as a plain `claude` instead.
   */
  private command(chat: LiveChat, args: string[]): [string, string[]] {
    const account = chat.opts.account;
    if (!account || !this.accounts?.managed || this.accounts.isActive(account)) return [this.config.claudeBin, args];
    return [this.config.cswapBin, ['chat', account, '--share-history', '--', ...args]];
  }

  /**
   * The only place a CLI process starts, and it becomes the chat's at once: every process is tracked
   * by the chat it works for, and a chat never has two.
   */
  private spawnProcess(chat: LiveChat, prompt: string, attachments: Attachment[] = []): void {
    if (chat.alive) throw new Error('the chat already has a live process');
    const holders = this.sessionHolders(chat);
    if (holders.length) {
      throw new Error(
        `session ${chat.id} is still running in process ${holders.join(', ')}, which this chat does not track; ` +
          'a second process would carry on the same conversation beside it. Wait for it to finish, or stop it first.',
      );
    }
    const args = this.buildArgs(chat);
    chat.stopRequested = false;
    chat.endedAt = null;
    chat.error = null;
    chat.rateLimited = false;
    chat.beginExecution();
    chat.setStatus('starting');

    const [bin, argv] = this.command(chat, args);
    // A pinned chat must never inherit a token from the environment: it would override the account
    const proc = spawn(bin, argv, { cwd: chat.cwd, env: chat.opts.account ? authFreeEnv() : process.env, stdio: 'pipe' });
    chat.proc = proc;
    // The chat's status follows the process it tracks and no other: an earlier process ending late
    // used to mark the chat failed while its current one was still working
    const current = () => chat.proc === proc;

    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (current()) this.handleLine(chat, proc, line);
    });
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (!line.trim() || !current()) return;
      if (RATE_LIMIT_RE.test(line)) chat.rateLimited = true;
      chat.push({ kind: 'stderr', type: 'stderr', text: line });
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      if (!current()) return;
      chat.error = err.message;
      this.finalize(chat, 'failed');
    });
    proc.on('exit', (code) => {
      if (!current()) return;
      if (chat.stopRequested) this.finalize(chat, 'stopped');
      else if (code === 0) this.finalize(chat, 'completed');
      else {
        chat.error ??= chat.events.filter((e) => e.kind === 'stderr').slice(-3).map((e) => e.text).join('\n') || `exit code ${code}`;
        this.finalize(chat, 'failed');
      }
      this.drainQueue(chat);
    });

    // Recorded at once: a wrapper that dies from here on leaves an execution to read back as interrupted, not a gap
    this.persist();
    this.writeUserMessage(chat, prompt, attachments);
  }

  private writeUserMessage(chat: LiveChat, text: string, attachments: Attachment[] = []): void {
    chat.lastUserTurn = { text, attachments: attachments.map((a) => a.id) };
    if (chat.idleTimer) clearTimeout(chat.idleTimer);
    const uploads = this.uploads;
    const content = attachments.length && uploads ? composeContent(text, attachments, (id) => uploads.read(id).bytes) : text;
    const payload = { type: 'user', message: { role: 'user', content } };
    chat.proc?.stdin.write(`${JSON.stringify(payload)}\n`);
    chat.push({
      kind: 'message',
      type: 'user',
      entry: {
        uuid: randomUUID(),
        role: 'user',
        timestamp: now(),
        model: null,
        isSidechain: false,
        parentToolUseId: null,
        blocks: [
          ...attachments
            .filter((a) => a.kind !== 'file')
            .map((a) => ({ type: a.kind === 'image' ? ('image' as const) : ('document' as const), mediaType: a.mediaType, name: a.name, uploadId: a.id })),
          { type: 'text', text: Array.isArray(content) ? String((content.at(-1) as { text: string }).text) : text },
        ],
      },
    });
    chat.setStatus('busy');
  }

  private finalize(chat: LiveChat, status: RunStatus): void {
    if (chat.endedAt) return;
    if (chat.idleTimer) clearTimeout(chat.idleTimer);
    chat.endedAt = now();
    // A prompt still waiting belongs to a process that is gone: nobody can act on the answer.
    this.permissions?.denyAllFor(chat.id);
    for (const control of chat.controls.values()) control.reject(new Error('the chat ended before the CLI answered'));
    chat.controls.clear();
    for (const task of chat.tasks.values()) {
      if (task.status === 'running') Object.assign(task, { status: 'stopped', endedAt: chat.endedAt });
    }
    for (const sub of chat.subagents.values()) {
      if (sub.status === 'running') Object.assign(sub, { status: 'failed', endedAt: chat.endedAt });
    }
    for (const workflow of chat.workflows.values()) {
      if (workflow.status === 'running') Object.assign(workflow, { status: 'stopped', endedAt: chat.endedAt });
    }
    const execution = chat.execution;
    if (execution) {
      Object.assign(execution, { endedAt: chat.endedAt, outcome: executionOutcome(status), error: chat.error });
    }
    chat.setStatus(status);
    this.persist();
    this.maybeRotate(chat);
  }

  /**
   * Asks for one account rotation per attempt. The turn can die against the limit while the
   * process stays alive (keepAlive) or by taking it down, so both paths end up here.
   */
  private maybeRotate(chat: LiveChat): void {
    if (!chat.rateLimited || chat.rotationRequested || !chat.lastUserTurn) return;
    if (chat.rotationRetries >= MAX_ROTATION_RETRIES) return;
    chat.rotationRequested = true;
    this.emit('rate-limited', chat.summary());
  }

  /** A wrapper-generated line in the transcript (account rotations, retries). */
  notice(id: string, text: string, data?: Record<string, unknown>): void {
    this.chats.get(id)?.push({ kind: 'notice', type: 'notice', text, ...(data ? { data } : {}) });
  }

  /**
   * Re-sends the turn that died against the rate limit. The process is gone by now, so `send`
   * respawns it with `--resume` — on whichever account is active at that point.
   */
  async replayLastTurn(id: string): Promise<boolean> {
    const chat = this.chats.get(id);
    if (!chat || !chat.lastUserTurn || chat.rotationRetries >= MAX_ROTATION_RETRIES) return false;
    chat.rotationRetries++;
    chat.rateLimited = false;
    chat.rotationRequested = false;
    // A live process holds the old account's token in memory: only a respawn picks up the new one
    if (chat.alive) {
      const proc = chat.proc;
      this.stop(id);
      if (proc) await once(proc, 'exit');
    }
    this.send(id, chat.lastUserTurn.text, chat.lastUserTurn.attachments);
    return true;
  }

  private handleLine(chat: LiveChat, proc: ChildProcessWithoutNullStreams, line: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (line.trim()) chat.push({ kind: 'other', type: 'stdout', text: line });
      return;
    }
    const type = String(raw.type ?? 'unknown');
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : undefined;
    if (subtype && IGNORED_SUBTYPES.has(subtype)) return;

    if (type === 'control_request') {
      if (typeof raw.request_id === 'string') this.handleControlRequest(chat, proc, raw.request_id, (raw.request ?? {}) as Record<string, unknown>);
      return;
    }
    if (type === 'control_cancel_request') {
      if (typeof raw.request_id === 'string') this.permissions?.withdraw(raw.request_id);
      return;
    }
    if (type === 'control_response') {
      const response = (raw.response ?? {}) as Record<string, unknown>;
      const control = typeof response.request_id === 'string' ? chat.controls.get(response.request_id) : undefined;
      if (!control || typeof response.request_id !== 'string') return;
      chat.controls.delete(response.request_id);
      if (response.subtype === 'error') control.reject(new Error(String(response.error ?? 'the CLI refused the request')));
      else control.resolve((response.response ?? {}) as Record<string, unknown>);
      return;
    }

    // The mode changes under the chat's feet: set from the panel, or by the model leaving plan mode
    if (type === 'system' && subtype === 'status' && typeof raw.permissionMode === 'string') {
      chat.setSettings({ permissionMode: reportedMode(raw.permissionMode) });
      chat.updatedAt = now();
      return;
    }

    if (type === 'stream_event') {
      // Token-level deltas of the main agent; the full block follows as a regular `assistant` event
      if (raw.parent_tool_use_id != null) return;
      const event = (raw.event ?? {}) as Record<string, unknown>;
      if (event.type === 'content_block_start') {
        const blockType = (event.content_block as Record<string, unknown> | undefined)?.type;
        chat.partial = blockType === 'text' || blockType === 'thinking' ? { block: blockType, text: '' } : null;
      } else if (event.type === 'content_block_delta' && chat.partial) {
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        const chunk = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : null;
        if (typeof chunk === 'string' && chunk) {
          chat.partial.text += chunk;
          chat.emitPartial();
        }
      } else if (event.type === 'content_block_stop') {
        chat.partial = null;
      }
      return;
    }

    if (type === 'assistant' || type === 'user') {
      const entry = normalizeMessage(raw);
      if (!entry) return;
      this.trackSubagents(chat, entry);
      // The CLI can start a turn on its own (e.g. after a background task notification)
      if (entry.role === 'assistant' && chat.status === 'idle') {
        if (chat.idleTimer) clearTimeout(chat.idleTimer);
        chat.setStatus('busy');
      }
      if (entry.role === 'assistant' && !entry.isSidechain) {
        const text = entryText(entry);
        if (text) chat.lastText = text.slice(0, 2000);
        if (entry.model) chat.setSettings({ model: entry.model });
      }
      chat.push({ kind: 'message', type, entry });
      return;
    }

    if (type === 'system' && subtype === 'init') {
      // The session exists now: a respawn resumes it, and a fork is no longer waiting to be made
      chat.created = true;
      chat.forkFrom = null;
      // The id was Agentry's to choose, and the CLI takes it; if it ever answered otherwise, the
      // chat would be one row on disk and another here, so say so where the person can see it
      if (typeof raw.session_id === 'string' && raw.session_id !== chat.id) {
        chat.push({ kind: 'notice', type: 'notice', text: `The CLI reported session ${raw.session_id} for the chat ${chat.id}; its transcript is not where this chat expects it.` });
      }
      chat.setSettings({
        ...(typeof raw.permissionMode === 'string' ? { permissionMode: reportedMode(raw.permissionMode) } : {}),
        ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      });
      if (typeof raw.cwd === 'string') chat.workingDir = raw.cwd;
      const environment = toEnvironment(chat.cwd, chat.id, raw);
      this.environments.set(chat.cwd, environment);
      try {
        this.db.saveEnvironment(environment);
      } catch {
        // the panel only loses this directory until its next run
      }
      chat.push({
        kind: 'init',
        type,
        subtype,
        data: { model: raw.model, cwd: raw.cwd, permissionMode: raw.permissionMode, mcp_servers: raw.mcp_servers, tools: raw.tools },
      });
      return;
    }

    if (type === 'system' && subtype && (subtype.startsWith('task_') || subtype === 'background_tasks_changed')) {
      this.trackTask(chat, subtype, raw);
      chat.push({ kind: 'task', type, subtype, data: raw });
      return;
    }

    if (type === 'rate_limit_event') {
      const info = raw.rate_limit_info as Record<string, unknown> | undefined;
      if (String(info?.status ?? '') === 'rejected') chat.rateLimited = true;
      if (info) {
        this.lastRateLimit = {
          status: String(info.status ?? ''),
          rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
          resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
          windows: (info.unifiedWindows as RateLimitInfo['windows'] | undefined) ?? {},
          observedAt: now(),
        };
      }
      return;
    }

    if (type === 'result') {
      const execution = chat.execution;
      if (execution) {
        execution.turns += typeof raw.num_turns === 'number' ? raw.num_turns : 1;
        // The CLI's total is over its process, so per execution it only ever grows
        if (typeof raw.total_cost_usd === 'number') execution.costUsd = Math.max(execution.costUsd ?? 0, raw.total_cost_usd);
        this.learnModelCosts(execution, raw.modelUsage);
      }
      this.learnWindows(raw.modelUsage);
      const isError = raw.is_error === true;
      const result = typeof raw.result === 'string' ? raw.result : '';
      if (isError && (raw.api_error_status === 429 || RATE_LIMIT_RE.test(result))) chat.rateLimited = true;
      const cause = !isError ? undefined : chat.interruptRequested || chat.stopRequested ? 'stopped' : subtype === BUDGET_SUBTYPE ? 'budget' : chat.rateLimited ? 'rate-limit' : undefined;
      chat.lastResult = { isError, result, structuredOutput: raw.structured_output, costUsd: chat.costUsd, ...(cause ? { cause } : {}) };
      // An interrupted turn ends as an error by the CLI's account, but nothing went wrong
      if (isError && !chat.interruptRequested) chat.error = result || String(subtype ?? 'error');
      chat.interruptRequested = false;
      this.persist();
      chat.push({
        kind: 'result',
        type,
        subtype,
        text: result,
        data: {
          is_error: isError,
          num_turns: raw.num_turns,
          duration_ms: raw.duration_ms,
          total_cost_usd: raw.total_cost_usd,
          structured_output: raw.structured_output,
          permission_denials: raw.permission_denials,
        },
      });
      // Every result, where waitForResult only hands out the first: a chat continued by hand keeps
      // producing them, and whoever the chat works for has to hear about each
      this.emit('chat-result', chat.id, chat.lastResult);
      if (chat.opts.keepAlive === false) {
        chat.proc?.stdin.end();
      } else {
        chat.setStatus('idle');
        chat.idleTimer = setTimeout(() => chat.proc?.stdin.end(), IDLE_TIMEOUT_MS);
        chat.idleTimer.unref();
      }
      this.maybeRotate(chat);
      return;
    }

    chat.push({ kind: 'other', type, subtype, data: raw });
  }

  private trackSubagents(chat: LiveChat, entry: NonNullable<ReturnType<typeof normalizeMessage>>): void {
    if (entry.isSidechain) return;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name)) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        chat.subagents.set(block.id, {
          toolUseId: block.id,
          subagentType: String(input.subagent_type ?? 'general-purpose'),
          description: String(input.description ?? input.prompt ?? '').slice(0, 200),
          status: 'running',
          startedAt: now(),
          endedAt: null,
        });
      } else if (block.type === 'tool_result') {
        const sub = chat.subagents.get(block.toolUseId);
        // A background agent's tool result only says it was launched; its task notification ends it
        if (sub && sub.status === 'running' && !sub.background) {
          sub.status = block.isError ? 'failed' : 'completed';
          sub.endedAt = now();
        }
      }
    }
  }

  /**
   * Everything the CLI delegates is a task to it, told apart by `task_type`: shell commands
   * (`local_bash`, reported even while they run in the foreground), subagents (`local_agent`) and
   * workflows (`local_workflow`) each go to their own list. Anything else it runs in the background
   * (monitors, remote agents…) is listed as a background task under its own type.
   */
  private trackTask(chat: LiveChat, subtype: string, raw: Record<string, unknown>): void {
    const taskId = typeof raw.task_id === 'string' ? raw.task_id : null;
    if (!taskId) return;
    if (subtype === 'task_started') {
      const type = String(raw.task_type ?? 'unknown');
      if (type === 'local_agent') return this.startAgentTask(chat, taskId, raw);
      if (type === 'local_workflow') {
        chat.workflows.set(taskId, {
          id: taskId,
          taskId,
          name: typeof raw.workflow_name === 'string' ? raw.workflow_name : null,
          description: String(raw.description ?? raw.workflow_name ?? taskId),
          status: 'running',
          startedAt: now(),
          endedAt: null,
          sessionId: chat.id,
          phases: [],
          agents: [],
          summary: null,
          totalTokens: null,
          script: typeof raw.prompt === 'string' ? raw.prompt : null,
        });
        return;
      }
      const sessionId = typeof raw.session_id === 'string' ? raw.session_id : chat.id;
      const task: BackgroundTask = {
        id: taskId,
        type,
        description: String(raw.description ?? ''),
        status: 'running',
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : null,
        startedAt: now(),
        endedAt: null,
        summary: null,
        // The output file is found by session id, and a task read from the live stream is the one
        // the Output button needs it on: the event carries it, and the chat knows it from `init`.
        ...(sessionId ? { sessionId } : {}),
        // Only says a subagent launched it, not which one; Core resolves that from the transcripts
        ...(raw.owned_by_subagent === true ? { fromSubagent: true } : {}),
      };
      if (raw.is_backgrounded === false) chat.foregroundTasks.set(taskId, task);
      else chat.tasks.set(taskId, task);
      return;
    }

    const workflow = chat.workflows.get(taskId);
    if (workflow) return this.updateWorkflow(workflow, subtype, raw);
    const agent = [...chat.subagents.values()].find((s) => s.agentId === taskId);
    if (agent) return this.updateAgentTask(agent, subtype, raw);

    const patch = (raw.patch ?? {}) as Record<string, unknown>;
    const waiting = chat.foregroundTasks.get(taskId);
    if (waiting) {
      // Sent to the background mid-turn (by the model or the person): from now on it is one
      if (subtype === 'task_updated' && patch.is_backgrounded === true) {
        chat.foregroundTasks.delete(taskId);
        chat.tasks.set(taskId, waiting);
      } else {
        if (subtype === 'task_notification') chat.foregroundTasks.delete(taskId);
        return;
      }
    }
    const task = chat.tasks.get(taskId);
    if (!task) return;
    if (subtype === 'task_updated') {
      if (typeof patch.status === 'string') task.status = patch.status;
      if (patch.end_time != null) task.endedAt = now();
    } else if (subtype === 'task_notification') {
      if (typeof raw.status === 'string') task.status = raw.status;
      if (typeof raw.summary === 'string') task.summary = raw.summary;
      task.endedAt ??= now();
    }
  }

  /** The Agent tool call it belongs to was seen first; the task adds its id and whether it runs in the background. */
  private startAgentTask(chat: LiveChat, taskId: string, raw: Record<string, unknown>): void {
    const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
    const background = raw.is_backgrounded === true;
    const known = chat.subagents.get(toolUseId);
    if (known) {
      Object.assign(known, { agentId: taskId, background });
      if (typeof raw.subagent_type === 'string') known.subagentType = raw.subagent_type;
      // Its launch result may have closed it already; a background agent is only done when it says so
      if (background && known.status !== 'running') Object.assign(known, { status: 'running', endedAt: null });
      return;
    }
    // Spawned by a subagent rather than the main agent: no tool call of its own reached the stream
    chat.subagents.set(toolUseId || taskId, {
      toolUseId,
      subagentType: String(raw.subagent_type ?? 'general-purpose'),
      description: String(raw.description ?? '').slice(0, 200),
      status: 'running',
      startedAt: now(),
      endedAt: null,
      agentId: taskId,
      background,
    });
  }

  private updateAgentTask(agent: SubagentInfo, subtype: string, raw: Record<string, unknown>): void {
    const patch = (raw.patch ?? {}) as Record<string, unknown>;
    const status = subtype === 'task_notification' ? raw.status : subtype === 'task_updated' ? patch.status : undefined;
    if (status === 'completed') Object.assign(agent, { status: 'completed', endedAt: agent.endedAt ?? now() });
    else if (status === 'failed' || status === 'killed') Object.assign(agent, { status: status === 'killed' ? 'stopped' : 'failed', endedAt: agent.endedAt ?? now() });
  }

  private updateWorkflow(workflow: WorkflowRun, subtype: string, raw: Record<string, unknown>): void {
    const usage = (raw.usage ?? {}) as Record<string, unknown>;
    if (typeof usage.total_tokens === 'number') workflow.totalTokens = usage.total_tokens;
    if (subtype === 'task_progress') {
      // Some progress events only carry usage; the agent list comes with the others
      if (Array.isArray(raw.workflow_progress)) Object.assign(workflow, readProgress(raw.workflow_progress));
      return;
    }
    const patch = (raw.patch ?? {}) as Record<string, unknown>;
    const status = subtype === 'task_notification' ? raw.status : patch.status;
    if (typeof status === 'string') workflow.status = workflowStatus(status);
    if (workflow.status !== 'running') workflow.endedAt ??= now();
    if (subtype === 'task_notification' && typeof raw.summary === 'string') workflow.summary = raw.summary;
  }
}
