import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basename, join, resolve } from 'node:path';
import type {
  Attachment,
  ChatActivity,
  ChatContinuation,
  ChatFork,
  ChatOrigin,
  ChatToolConfig,
  EffectiveEnvironment,
  Execution,
  NewChatRequest,
  PermissionMode,
  RunEvent,
  RunStatus,
} from '@agentry/shared';
import { ChatActivityTracker } from './chat-activity.ts';
import { executionOutcome, INTERRUPTED_BY_RESTART } from './chat-model.ts';
import type { ChatRecord, StoredChat } from './chat-records.ts';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from './cli-facts.ts';
import type { Db } from './db.ts';
import type { ModelAliasIds } from './models.ts';
import type { CoreConfig } from './paths.ts';
import type { PermissionBroker } from './permissions.ts';
import type { BranchTracker, DriverEvent, DriverSession, ModelUsage, ProviderDriver } from './providers/driver.ts';
import { emptyTokenUsage } from './usage.ts';

const MAX_EVENTS_PER_RUN = 5000;
const PARTIAL_THROTTLE_MS = 50;

export interface RunResult {
  isError: boolean;
  result: string;
  structuredOutput: unknown;
  /** What the chat has cost across every execution so far */
  costUsd: number;
  /**
   * Why a failed result is not one to try again blindly: the budget ran out (the retry meets the same
   * ceiling), its provider hit its usage limit (moving the work is the rotation's job) or someone stopped it.
   */
  cause?: 'budget' | 'rate-limit' | 'stopped';
  /** The main agent's last `stop_reason` in the turn (`end_turn`, `tool_use`, `max_tokens`…), when the CLI said */
  stopReason?: string;
}

/** What starts a chat, beyond what the API takes: the housekeeping knobs the wrapper's own callers use. */
export interface NewChat extends NewChatRequest {
  name?: string;
  /** A CLI agent the session runs as (`--agent`): a team member's, for a run of the flow by column */
  agent?: string;
  /**
   * A file defining agents for the session (`--agents`). The flow hands the member's definition this
   * way because the item's worktree only has the agent files that were committed.
   */
  agentsFile?: string;
  /**
   * `off` renders the system prompt fresh on every request instead of recording it on the first
   * (`--system-prompt-snapshot off`). A member's run asks for it: its prompt is the agent's and the
   * journal as they are now, and a recorded one would outlive the run into whoever continues the chat.
   */
  systemPromptSnapshot?: 'off';
  /**
   * `false` leaves the uploads directory out (`--add-dir`): a run Agentry starts on its own carries
   * no attachment, and every person's uploads would otherwise be readable to it.
   */
  uploads?: false;
  /** Keep the process alive after each turn so more messages can be sent (default true) */
  keepAlive?: boolean;
  /** Housekeeping: no transcript is written (`--no-session-persistence`), so it cannot be resumed */
  internal?: boolean;
  /**
   * `false` leaves `AGENTRY_API_URL` out of the environment and mints no `AGENTRY_API_TOKEN`: a run
   * that never calls the API back (a decision chat) holds no credential to it.
   */
  api?: false;
  toolConfig?: ChatToolConfig | null;
  /** Held to a closed set of tools and no settings file: the project assistant's read-only runs */
  confine?: ChatConfinement;
}

/**
 * A chat that may only do what Agentry names. The allow and deny lists only rule on the tools a
 * session has, and add to whatever the person's settings files allow; this takes the rest away.
 */
export interface ChatConfinement {
  /** `--tools`: the only built-in tools the session has */
  tools: string[];
  /** `--setting-sources`: the settings files it loads; empty loads none, so no rule, hook or server of theirs applies */
  settingSources: Array<'user' | 'project' | 'local'>;
}

/**
 * What `ChatTools` made of the tool preset and MCP servers a request picked, next to the request:
 * the lists and the config file the CLI is given, and the description of them a chat keeps.
 */
export interface ResolvedTools {
  toolConfig?: ChatToolConfig | null;
}

/**
 * What one execution of a resumed chat runs with beyond the start options: the flow resumes a
 * member's chat as its agent, asking for its structured result. `null` drops what an earlier
 * execution set, so a chat a person continues by hand is not held to a schema it never asked for.
 */
export interface ExecutionExtras {
  agent?: string | null;
  agentsFile?: string | null;
  jsonSchema?: unknown;
  systemPromptSnapshot?: 'off' | null;
  uploads?: false | null;
  keepAlive?: boolean;
  /**
   * The chat goes back to a person: whatever a member's run set (its mode, its allow and deny lists,
   * its budget, the appended journal, `keepAlive: false`) is dropped before the request's own
   * options apply, so the person's chat is not held to the rules of a run that already ended. The
   * model stays: it is the chat's, shown on it and switchable.
   */
  handBack?: boolean;
  confine?: ChatConfinement | null;
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
  /** The provider whose agent runs the chat; a runtime built without a driver states none */
  provider?: string;
  /** The agent's own id for the session once it named it; null for a provider that takes Agentry's id */
  nativeSessionId?: string | null;
  name: string;
  cwd: string;
  /** Directory the CLI actually works in, which differs from `cwd` when it runs in a worktree */
  workingDir: string;
  origin: ChatOrigin;
  derivedFrom: ChatFork | null;
  continuedFrom?: ChatContinuation | null;
  continuedIn?: ChatContinuation | null;
  model: string | null;
  permissionMode: PermissionMode;
  /** The process's state, as the stream reports it: a chat's own state is derived from it */
  status: RunStatus;
  pid: number | null;
  /** When the live process started; null without one */
  processStartedAt?: string | null;
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
  /** @deprecated accounts were retired; always absent. Removed with `rotateAndResume` in `index.ts` */
  account?: null;
  permissionPrompts: 'host' | 'none';
  /** Prompts waiting for someone right now: the chat is stuck until they are answered */
  pendingPrompts: number;
  /** What the live process is doing right now; null when there is none */
  activity: ChatActivity | null;
  /** The tool preset and MCP servers Agentry started it with; null when it picked none */
  tools?: ChatToolConfig | null;
  executions: Execution[];
  backgroundTasks: BackgroundTask[];
  subagents: SubagentInfo[];
  workflows: WorkflowRun[];
}

/** A shell command the process started and has had no answer to yet. */
export interface RunningCommand {
  command: string;
  startedAt: string;
  /** The tool call, which is what cancelling one command is addressed by */
  toolUseId: string;
  /** The CLI's heartbeat for it: how long it says the command has run, as of `at` */
  heartbeat?: { elapsedSeconds: number; at: string };
}

/** What the process working on a chat is doing right now. */
export interface ChatPulse {
  /** The last thing it did, streamed text included */
  lastEventAt: string;
  commands: RunningCommand[];
}

export const now = () => new Date().toISOString();

/** Started (a failed spawn has no pid) and not exited yet */
export const processUp = (proc: ChildProcess): boolean => proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;

/**
 * What the code that reads and writes a chat's process needs of the manager that owns the chat: the
 * stores it records into, the announcements it makes and the few things only the manager can do.
 * The manager hands over one, so the functions that parse the stream and answer the CLI hold no
 * reference to the manager itself.
 */
export interface ChatHost {
  readonly db: Db;
  readonly modelIds: ModelAliasIds;
  /** Latest `init` snapshot per working directory */
  readonly environments: Map<string, EffectiveEnvironment>;
  readonly permissions: PermissionBroker | null;
  emit(event: string, ...args: unknown[]): void;
  persist(): void;
  noteActivity(chat: LiveChat): void;
  /** Folds what the chat's provider reported about its limit into the provider's reading */
  observeLimit(chat: LiveChat, event: DriverEvent): void;
  learnModelCosts(execution: Execution, modelUsage: ModelUsage[]): void;
  learnWindows(modelUsage: ModelUsage[]): void;
  maybeLimit(chat: LiveChat): void;
  /** Ends the chat's execution as failed for a protocol fault and takes the process down */
  failProtocol(chat: LiveChat, message: string): void;
}

/**
 * A chat Agentry has a record of, in memory: its live stream, whatever it delegated, its history of
 * executions and, while one is running, the process. There is one per session id, however many
 * times the chat is resumed: resuming adds an execution here, it never adds a chat.
 */
export class LiveChat {
  readonly emitter = new EventEmitter();
  readonly events: RunEvent[] = [];
  /** What the agent delegated, across every process of the chat */
  readonly branches: BranchTracker;
  /** The protocol of the live process; null without one */
  session: DriverSession | null = null;
  /** Every execution, oldest first; at most the last one is live */
  executions: Execution[] = [];
  /** The execution a wrapper restart cut off, when this chat was restored with one: its stop time is still an estimate */
  cutOff: Execution | null = null;
  proc: ChildProcessWithoutNullStreams | null = null;
  /** When `proc` was spawned: its stream reports every workflow started since, and none before */
  procStartedAt: string | null = null;
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
  /** The structured result (`--json-schema`) as its tool call streams it: raw JSON, cut wherever it has got to */
  structured: string | null = null;
  /** Prompts the CLI is holding for a person */
  pendingPrompts = 0;
  /** The turn is ending because someone interrupted it, not because it failed */
  interruptRequested = false;
  /** What the live process is doing right now, folded from the stream as it arrives */
  readonly activity: ChatActivityTracker;
  /** The last activity announced on the feed, so a line that changes nothing costs no summary */
  activityKey = '';
  /** The CLI's `tool_progress` heartbeats for the commands still running, by tool call */
  readonly heartbeats = new Map<string, { elapsedSeconds: number; at: string }>();
  /** Foreground commands started and not answered, for the history of how long each kind takes */
  readonly openCommands = new Map<string, { command: string; kind: string; startedAt: string }>();
  /** Commands a person cancelled: their failed result is the person's doing, and says nothing about how long the command takes */
  readonly cancelled = new Set<string>();
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
  /**
   * The agent's own id for the session, once a process has reported it; null before, and always
   * null for a provider that takes the id Agentry chose. Once set it never changes.
   */
  nativeId: string | null = null;
  /** The last turn sent, files included, so a turn lost to a rate limit is replayed whole */
  lastUserTurn: { text: string; attachments: string[] } | null = null;
  /** The turn died against its provider's usage limit */
  rateLimited = false;
  /**
   * The main agent's last `stop_reason` in this turn, from stream-json: a turn cut by `max_tokens`
   * can still end with JSON that parses, and a reader of the result has to know it was cut
   */
  stopReason: string | null = null;
  /** `limit-hit` was already announced for this attempt */
  limitRequested = false;
  /** Replays of the last turn for this execution: a second failure on the limit is a real one */
  limitReplays = 0;
  /** The chat this one continues after a move to another provider, and the one that continues it */
  continuedFrom: ChatContinuation | null = null;
  continuedIn: ChatContinuation | null = null;

  constructor(
    /** The session id */
    readonly id: string,
    readonly opts: NewChat,
    readonly meta: RunMeta,
    readonly origin: ChatOrigin,
    readonly derivedFrom: ChatFork | null,
    config: Pick<CoreConfig, 'workspaceDir' | 'defaultPermissionMode'>,
    readonly driver: ProviderDriver,
    created = false,
  ) {
    this.cwd = resolve(opts.cwd ?? config.workspaceDir);
    this.permissionMode = opts.permissionMode ?? config.defaultPermissionMode;
    this.model = opts.model ?? null;
    this.created = created;
    this.name = opts.name ?? `${basename(this.cwd)}-${this.id.slice(0, 6)}`;
    this.activity = new ChatActivityTracker(this.cwd);
    this.branches = driver.createBranches();
    this.branches.sessionId = id;
    this.emitter.setMaxListeners(100);
  }

  /**
   * Rebuilds a chat persisted by a previous wrapper process; it has no process until a message
   * resumes it. An execution that was live when that wrapper went away is over now, and nobody
   * stopped it: it ends as `interrupted`.
   */
  static restore({ record, executions }: StoredChat, config: CoreConfig, driver: ProviderDriver): LiveChat {
    const chat = new LiveChat(
      record.id,
      {
        prompt: record.prompt,
        cwd: record.cwd,
        name: record.name,
        ...(record.model ? { model: record.model } : {}),
        permissionMode: record.permissionMode,
        internal: record.origin === 'internal',
        permissionPrompts: record.permissionPrompts,
        // A resumed chat keeps the tools and servers it was given, not the ones the CLI would pick
        ...(record.tools ? { toolConfig: record.tools, allowedTools: record.tools.allowedTools, disallowedTools: record.tools.disallowedTools } : {}),
        ...(record.tools?.mcp?.config ? { mcp: record.tools.mcp } : {}),
      },
      { orchestrationId: record.orchestrationId ?? undefined, orchestrationTaskId: record.orchestrationTaskId ?? undefined },
      record.origin,
      record.derivedFrom,
      config,
      driver,
      true,
    );
    // `updatedAt` is a floor for when it stopped: the record is only written at a few moments of a
    // turn, so the manager refines it from the transcript, which the CLI writes as it goes
    chat.executions = executions.map((e) => {
      if (e.endedAt !== null) return e;
      const cut = { ...e, endedAt: record.updatedAt, outcome: executionOutcome('busy', true), error: e.error ?? INTERRUPTED_BY_RESTART };
      chat.cutOff = cut;
      return cut;
    });
    const last = chat.executions[chat.executions.length - 1];
    // The process's own status, for whatever still asks: nothing is running, and how it ended is
    // what the last execution says
    chat.status = last?.outcome === 'completed' || last?.outcome === 'failed' ? last.outcome : 'stopped';
    chat.continuedFrom = record.continuedFrom ?? null;
    chat.continuedIn = record.continuedIn ?? null;
    chat.createdAt = record.createdAt;
    chat.updatedAt = record.updatedAt;
    chat.endedAt = last?.endedAt ?? record.updatedAt;
    chat.lastText = record.lastText;
    chat.error = last?.error ?? null;
    chat.workingDir = record.workingDir;
    chat.nativeId = record.nativeSessionId ?? null;
    return chat;
  }

  /**
   * What the chat runs with: what was resolved from a preset and servers, or, for a chat that only
   * has tool lists (an orchestration worker), those lists, since they are what explains a refusal.
   */
  get tools(): ChatToolConfig | null {
    const { toolConfig, allowedTools, disallowedTools } = this.opts;
    if (toolConfig) return toolConfig;
    if (!allowedTools?.length && !disallowedTools?.length) return null;
    return { preset: null, allowedTools: allowedTools ?? [], disallowedTools: disallowedTools ?? [], mcp: null };
  }

  /** The provider whose agent runs the chat */
  get provider(): string {
    return this.driver.manifest.id;
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
      account: null,
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
      provider: this.provider,
      name: this.name,
      cwd: this.cwd,
      workingDir: this.workingDir ?? (this.opts.worktree ? join(this.cwd, '.claude', 'worktrees', this.opts.worktree) : this.cwd),
      origin: this.origin,
      derivedFrom: this.derivedFrom,
      continuedFrom: this.continuedFrom,
      continuedIn: this.continuedIn,
      model: this.model,
      permissionMode: this.permissionMode,
      status: this.status,
      pid: this.alive ? (this.proc?.pid ?? null) : null,
      processStartedAt: this.alive ? this.procStartedAt : null,
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
      permissionPrompts: this.opts.permissionPrompts === 'host' ? 'host' : 'none',
      ...(this.nativeId ? { nativeSessionId: this.nativeId } : {}),
      pendingPrompts: this.pendingPrompts,
      // A chat with no process of ours is doing nothing, whatever the last stream left behind
      activity: this.alive ? this.activity.current() : null,
      tools: this.tools,
      executions: this.executions,
      backgroundTasks: [...this.branches.tasks.values()],
      subagents: [...this.branches.subagents.values()],
      workflows: [...this.branches.workflows.values()],
    };
  }

  /** What the store keeps of the chat besides its executions. */
  record(): ChatRecord {
    return {
      id: this.id,
      provider: this.provider,
      name: this.name,
      cwd: this.cwd,
      workingDir: this.workingDir,
      origin: this.origin,
      orchestrationId: this.meta.orchestrationId ?? null,
      orchestrationTaskId: this.meta.orchestrationTaskId ?? null,
      derivedFrom: this.derivedFrom,
      continuedFrom: this.continuedFrom,
      continuedIn: this.continuedIn,
      prompt: this.opts.prompt,
      lastText: this.lastText,
      model: this.model,
      permissionMode: this.permissionMode,
      permissionPrompts: this.opts.permissionPrompts === 'host' ? 'host' : 'none',
      ...(this.nativeId ? { nativeSessionId: this.nativeId } : {}),
      tools: this.tools,
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
        block: this.partial.block,
        text: this.partial.text,
      } satisfies RunEvent);
    }, PARTIAL_THROTTLE_MS);
  }

  setStatus(status: RunStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.push({ kind: 'status', status });
  }
}
