import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ChatTokenStore } from './security/chat-tokens.ts';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type Attachment,
  type ChatContinuation,
  type ChatToolConfig,
  type ChatSettingsUpdate,
  type ChatStartOptions,
  type EffectiveEnvironment,
  type Execution,
  type ProviderId,
  type PermissionMode,
  type ProviderLimit,
  type ProvidersSettings,
  type ResumeChatRequest,
  type RunEvent,
  type RunStatus,
  type TranscriptEntry,
} from '@agentry/shared';
import { activityKey } from './chat-activity.ts';
import { executionOutcome } from './chat-model.ts';
import { foldEvent } from './chat-fold.ts';
import { chatsFromRuns, type LegacyRun, type StoredChat } from './chat-records.ts';
import type { Db } from './db.ts';
import { RunEventPublisher } from './event-sources.ts';
import type { EventBus } from './events.ts';
import type { RunDefaults } from './app-settings.ts';
import {
  LiveChat,
  now,
  processUp,
  type AdoptedChat,
  type ChatHost,
  type ChatPulse,
  type ChatRuntime,
  type ExecutionExtras,
  type NewChat,
  type ResolvedTools,
  type RunMeta,
  type RunResult,
} from './live-chat.ts';
import type { CoreConfig } from './paths.ts';
import type { PermissionBroker } from './permissions.ts';
import { runningCommands, type ToolCall, type Trace } from './health.ts';
import { ModelAliasIds } from './models.ts';
import { cliProcessOf, commandRoots, processTable, terminateTree } from './processes.ts';
import { ClaudeCodeDriver } from './providers/claude-code/driver.ts';
import type { ModelUsage, ProviderDriver, SessionLaunch } from './providers/driver.ts';
import { ProviderLimits } from './providers/limits.ts';
import { PROVIDER_MANIFESTS, ProviderRegistry } from './providers/registry.ts';
import type { SessionStore } from './sessions.ts';
import type { UploadStore } from './uploads.ts';

// Every name `chats.ts` has ever exported stays importable from here
export type { AdoptedChat, ChatConfinement, ChatPulse, ChatRuntime, ExecutionExtras, NewChat, ResolvedTools, RunMeta, RunningCommand, RunResult } from './live-chat.ts';
/** What a move to another provider starts the new chat with; the caller has already chosen all of it. */
export interface ChatContinuationSpec {
  provider: ProviderId;
  /** A model of the target provider; null takes the target's own default */
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode;
  /** The handoff, or the original prompt */
  prompt: string;
  attachments?: string[];
  action: ChatContinuation['action'];
  moveId: string;
  appendSystemPrompt?: string;
  /** The policy and its rules in the target's words, and the MCP servers when it takes them */
  toolConfig?: ChatToolConfig | null;
  maxBudgetUsd?: number;
}

export { STRUCTURED_OUTPUT_TOOL } from './providers/claude-code/stream.ts';

const MAX_PERSISTED_CHATS = 200;
/**
 * What starting or continuing a chat refuses on purpose (no prompt, the runtime full, the session
 * held elsewhere, a bad upload): the caller's to fix, with its 4xx. Anything else that goes wrong
 * while a chat starts is the server's (`ChatStartError`).
 */
export class ChatRefusal extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** One replay of a turn lost to a limit per execution: a second failure is a real one, not a quota one */
const MAX_LIMIT_REPLAYS = 1;

/** What a request that still sends `account` is told: pinning an account went away with claude-swap */
const ACCOUNTS_RETIRED = 'accounts were retired; see Settings → Providers';
const MAX_ATTACHMENTS = 20;

/** A chat as it was last written: its record and each execution, as JSON. */
interface SavedChat {
  record: string;
  executions: Map<string, string>;
}

/**
 * Manages `claude -p` processes using stream-json input/output.
 * Each LiveChat is a live conversation: it accepts multiple turns over stdin and, if the
 * process already exited, it is respawned with `--resume` when a new message arrives.
 */
export class ChatManager extends EventEmitter {
  private readonly chats = new Map<string, LiveChat>();
  /** What was last written of each chat, so that a save writes only what changed since */
  private readonly saved = new Map<string, SavedChat>();
  /** One reading per provider, shared through the database with every process on the data directory */
  readonly limits: ProviderLimits;
  /** The code half of each provider that can run chats */
  readonly providers: ProviderRegistry;
  /**
   * Which providers the person turned on, and in what order: read as each chat starts, so a change
   * applies to the next one. Core sets it; without it the manifests' own order is the person's.
   */
  providerSettings: (() => Pick<ProvidersSettings, 'order' | 'defaultProvider'>) | null = null;
  /**
   * Where this wrapper's REST API answers, once it listens. Handed to every chat as
   * `AGENTRY_API_URL`: with a desktop app and a dev server on one machine, an agent that guessed a
   * port drove the other wrapper and its orchestrations never showed up in the one it ran in.
   */
  apiUrl: string | null = null;
  /**
   * The per-process credentials handed over as `AGENTRY_API_TOKEN` beside `AGENTRY_API_URL`, so a
   * chat can call a guarded API. Core replaces it with the one its guard reads.
   */
  chatTokens = new ChatTokenStore();
  /** Where chats with `permissionPrompts: 'host'` send what they ask; null means nobody answers */
  permissions: PermissionBroker | null = null;
  /** Files attached to messages; every chat may read them */
  uploads: UploadStore | null = null;
  /** Where changes to chats are announced; set by Core */
  bus: EventBus | null = null;
  /** Read as each run starts, so a change in the settings applies to the next one; Core sets the layered store */
  defaults: RunDefaults;
  /** Latest `init` snapshot per working directory */
  readonly environments = new Map<string, EffectiveEnvironment>();

  private readonly publisher = new RunEventPublisher((event) => this.bus?.emit(event));

  private readonly file: string;

  /** What the code that reads a chat's process needs of this manager */
  private readonly host: ChatHost;

  /** The model id each alias last ran as, which names the aliases in the model picker */
  readonly modelIds: ModelAliasIds;

  /**
   * CLI processes found at start still working on a restored chat's session, by chat id: a previous
   * wrapper went away without them (a crash, or `tsx watch` killing it mid-shutdown). Nothing here
   * can write to their stdin, so the chat cannot attach to them; it must not resume beside them.
   */
  private readonly leftovers = new Map<string, number[]>();

  constructor(
    private readonly config: CoreConfig,
    private readonly db: Db,
    drivers: readonly ProviderDriver[] = [new ClaudeCodeDriver(config.claudeBin)],
  ) {
    super();
    this.providers = new ProviderRegistry(PROVIDER_MANIFESTS, drivers);
    this.limits = new ProviderLimits(db);
    this.defaults = config;
    this.file = join(config.dataDir, 'runs.json');
    this.modelIds = new ModelAliasIds(config.dataDir);
    for (const driver of drivers) {
      if (driver instanceof ClaudeCodeDriver) driver.modelSource = { file: config.globalConfigFile, seen: () => this.modelIds.get() };
    }
    for (const env of db.loadEnvironments()) this.environments.set(env.cwd, env);
    const manager = this;
    this.host = {
      db,
      modelIds: this.modelIds,
      environments: this.environments,
      // Set by Core after construction, so read as it is when asked
      get permissions() {
        return manager.permissions;
      },
      emit: (event, ...args) => this.emit(event, ...args),
      persist: () => this.persist(),
      noteActivity: (chat) => this.noteActivity(chat),
      observeLimit: (chat, event) => {
        try {
          this.limits.observe(chat.provider, event);
        } catch {
          // Output still draining after the database closed (shutdown): losing a limit reading must not become an uncaught error
        }
      },
      learnModelCosts: (execution, modelUsage) => this.learnModelCosts(execution, modelUsage),
      learnWindows: (modelUsage) => this.learnWindows(modelUsage),
      maybeLimit: (chat) => this.maybeLimit(chat),
      failProtocol: (chat, message) => this.failProtocol(chat, message),
    };
  }

  /** The driver a request asks for, or the person's default; refused when that provider cannot run chats. */
  driverFor(provider: ProviderId | undefined): ProviderDriver {
    const settings = this.providerSettings?.() ?? { order: this.providers.list().map((m) => m.id), defaultProvider: null };
    const id = provider ?? this.providers.defaultSessionProvider(settings);
    const driver = id ? this.providers.driverFor(id) : null;
    if (!driver) throw new ChatRefusal('this provider cannot run chats yet');
    return driver;
  }

  /** The CLI's per-model cost, cumulative over its process like the total, so it only ever grows. */
  private learnModelCosts(execution: Execution, modelUsage: ModelUsage[]): void {
    for (const { model, costUsd: usd } of modelUsage) {
      if (usd === undefined) continue;
      execution.modelCosts = { ...execution.modelCosts, [model]: Math.max(execution.modelCosts?.[model] ?? 0, usd) };
    }
  }

  /** The context window the CLI reports for each model that answered: the only real source of one. */
  private learnWindows(modelUsage: ModelUsage[]): void {
    for (const { model, contextWindow: window } of modelUsage) {
      if (window === undefined || window <= 0) continue;
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
    //
    // Every chat is compared with what was last written of it and only what changed is written:
    // this runs on every turn of every chat, and rewriting all of them each time was most of its
    // cost. The table is trimmed only when a chat is new to it, the only way it can grow.
    const candidates: Array<{ chat: LiveChat; record: StoredChat['record']; recordJson: string; executionJson: Map<string, string>; known: SavedChat | undefined }> = [];
    for (const chat of this.chats.values()) {
      const record = chat.record();
      const known = this.saved.get(chat.id);
      const recordJson = JSON.stringify(record);
      const executionJson = new Map(chat.executions.map((e) => [e.id, JSON.stringify(e)]));
      const same = known !== undefined && known.record === recordJson && chat.executions.every((e) => known.executions.get(e.id) === executionJson.get(e.id));
      if (!same) candidates.push({ chat, record, recordJson, executionJson, known });
    }
    if (candidates.length === 0) return;
    try {
      // A chat trimmed from the table since it was written, by a trim of ours or of another process
      // sharing the file, is written whole again: its executions went with it, and writing only
      // the ones that changed would bring it back with part of its history
      const stored = this.db.storedChats(candidates.filter((c) => c.known).map((c) => c.chat.id));
      let added = false;
      const changed: StoredChat[] = candidates.map(({ chat, record, executionJson, known }) => {
        const kept = known && stored.has(chat.id) ? known : undefined;
        added ||= !kept;
        return { record, executions: chat.executions.filter((e) => kept?.executions.get(e.id) !== executionJson.get(e.id)) };
      });
      this.db.saveChats(changed, added ? MAX_PERSISTED_CHATS : null);
      for (const { chat, recordJson, executionJson } of candidates) this.saved.set(chat.id, { record: recordJson, executions: executionJson });
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
    for (const manifest of this.providers.list()) {
      const driver = this.providers.driverFor(manifest.id);
      if (driver instanceof ClaudeCodeDriver) driver.useSessions(sessions);
    }
    this.importLegacy();
    // A chat of a provider that has no driver here cannot be driven, so it is left in the store as it is
    const stored = this.db.loadChats().filter(({ record }) => !this.chats.has(record.id) && this.providers.driverFor(record.provider ?? ''));
    // Before the first await, so whoever starts the wrapper can report them as soon as Core exists
    const live = this.liveSessions();
    for (const { record } of stored) {
      const pids = live.filter((p) => p.sessionId === record.id).map((p) => p.pid);
      if (pids.length) this.leftovers.set(record.id, pids);
    }
    for (const entry of stored) {
      const driver = this.providers.driverFor(entry.record.provider ?? '');
      if (!driver) continue;
      const chat = LiveChat.restore(entry, this.config, driver);
      this.chats.set(chat.id, chat);
      const page = await sessions.getSession(chat.id, { includeSidechains: true }).catch(() => null);
      for (const item of page?.entries ?? []) chat.push({ kind: 'message', entry: item });
      // The transcript is written as the CLI works, so its last line is when the process really
      // stopped; the stored record can be older than that
      const heard = page?.summary.updatedAt;
      const cut = chat.cutOff;
      if (cut?.endedAt && heard && heard > cut.endedAt && heard <= now()) {
        cut.endedAt = heard;
        chat.endedAt = heard;
      }
      const pids = this.leftovers.get(chat.id);
      if (pids) {
        chat.push({
          kind: 'notice',
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
    const live = this.liveSessions();
    return [...this.leftovers].flatMap(([chatId, pids]) =>
      pids.filter((pid) => live.some((p) => p.pid === pid && p.sessionId === chatId)).map((pid) => ({ chatId, pid })),
    );
  }

  /** The processes of every driver that hold a session, read once so matching many chats costs one pass. */
  private liveSessions(): Array<{ pid: number; sessionId: string }> {
    return this.providers.list().flatMap((m) => this.providers.driverFor(m.id)?.liveSessions() ?? []);
  }

  /**
   * What would share the session with a process started for this chat now: any CLI process on it,
   * this wrapper's (another chat on the same session) or not, which includes whatever a previous
   * wrapper left.
   * A session that does not exist yet (a new chat, a fork) has no one on it.
   */
  private sessionHolders(chat: LiveChat): number[] {
    return chat.created ? chat.driver.sessionHolders(chat.id) : [];
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

  /**
   * Announces what the chat is doing, when it changed. Called after every line the CLI writes, so
   * the comparison comes first: a chat streaming a paragraph produces dozens of lines a second and
   * none of them changes the one word the ticker shows.
   */
  private noteActivity(chat: LiveChat): void {
    const key = activityKey(chat.alive ? chat.activity.current() : null);
    if (key === chat.activityKey) return;
    chat.activityKey = key;
    this.publisher.activity(chat.summary());
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
    const trace = this.trace(id);
    if (!trace) return null;
    return {
      lastEventAt: trace.lastEventAt,
      commands: runningCommands(trace).map((call) => {
        const beat = trace.heartbeats.get(call.id);
        return {
          command: typeof call.input.command === 'string' ? call.input.command : 'a command',
          startedAt: call.at,
          toolUseId: call.id,
          ...(beat ? { heartbeat: beat } : {}),
        };
      }),
    };
  }

  /**
   * Every tool call the live execution has made and what came back, with the CLI's heartbeats for
   * the ones still running: what the signals of a worker that is busy and getting nowhere are read
   * from. Null when Agentry has no process on the chat. A turn that ended closes whatever was still
   * open in it, so a call an interrupt left without an answer is not a command running for ever.
   */
  trace(id: string): Trace | null {
    const chat = this.chats.get(id);
    const live = chat?.execution;
    if (!chat || !live || !chat.alive) return null;
    const calls = new Map<string, ToolCall>();
    for (const event of chat.events) {
      if (event.ts < live.startedAt) continue;
      if (event.kind === 'result') {
        for (const call of calls.values()) call.endedAt ??= event.ts;
        continue;
      }
      for (const block of event.entry?.blocks ?? []) {
        if (block.type === 'tool_use') {
          const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
          calls.set(block.id, { id: block.id, name: block.name, input, at: event.ts, endedAt: null, isError: false, result: '' });
        } else if (block.type === 'tool_result') {
          const call = calls.get(block.toolUseId);
          if (call) Object.assign(call, { endedAt: event.ts, isError: block.isError, result: block.content.slice(0, 300) });
        }
      }
    }
    return { executionStartedAt: live.startedAt, lastEventAt: chat.activityAt, calls: [...calls.values()], heartbeats: new Map(chat.heartbeats) };
  }

  /**
   * Kills the process tree of one command a chat is running, and only that: the turn goes on, the
   * CLI writes a failed result for the call and the worker carries on with it. Which processes are
   * the command's is worked out from the tree under the CLI's pid and from when each started (see
   * {@link commandRoots}); nothing is matched on a command line. Refuses rather than guesses when
   * the command has no process of its own to be found.
   */
  cancelCommand(id: string, toolUseId: string): { command: string; processes: number } {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    const trace = this.trace(id);
    if (!trace || !chat.proc?.pid) throw new Error('the chat has no live process, so it runs no command');
    const open = runningCommands(trace);
    const at = open.findIndex((c) => c.id === toolUseId);
    const call = open[at];
    if (!call) throw new Error(`the call ${toolUseId} is not a command that is running: it may have ended already`);
    const table = processTable();
    if (table.length === 0) throw new Error('a command can only be cancelled where /proc lists the processes, which this system does not');
    const cli = cliProcessOf(table, chat.proc.pid, chat.id);
    if (!cli) throw new Error('the CLI process is gone');
    const { roots, unclaimed } = commandRoots(table, cli.pid, open.map((c) => Date.parse(c.at)));
    const root = roots[at];
    if (!root) throw new Error('no process of this command was found: it has not started yet, or has ended');
    // Never the CLI itself, whatever the clock says: that is stopping the chat, which has its own action
    if (root.argv.includes('stream-json')) throw new Error('the process found for this command is a CLI, not a command');
    // A background command also leaves a child of the CLI behind, and nothing says which one is whose
    const earliest = Date.parse(open[0]?.at ?? call.at);
    if (unclaimed > 0 && trace.calls.some((c) => c.name === 'Bash' && c.input.run_in_background === true && Date.parse(c.at) >= earliest - 2000)) {
      throw new Error('cannot tell this command\'s process from a background command\'s started beside it: stop the chat or wait');
    }
    chat.cancelled.add(toolUseId);
    const command = typeof call.input.command === 'string' ? call.input.command : 'a command';
    return { command, processes: terminateTree(root, table) };
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
    if (!opts.prompt?.trim() && !opts.attachments?.length) throw new ChatRefusal('prompt is required');
    const driver = this.driverFor(opts.provider);
    this.admit(opts, driver);
    const attachments = this.resolveAttachments(opts.attachments);
    return this.begin(new LiveChat(randomUUID(), opts, meta, opts.internal ? 'internal' : meta.orchestrationId ? 'orchestration' : 'agentry', null, this.chatDefaults(), driver), opts.prompt, attachments);
  }

  /**
   * Continues a chat nobody holds, in place: a new execution on the same session, which keeps its id.
   * A chat this wrapper has no record of (it was started from a terminal, say) is adopted: it
   * becomes ours to drive, and stays `external`, because that is where it was born. Whether
   * something holds the session is checked again here, on the process table, whatever the caller
   * saw a moment ago.
   */
  resume(id: string, request: ResumeChatRequest & ResolvedTools & ExecutionExtras, adopt?: AdoptedChat): ChatRuntime {
    if (!request.prompt?.trim() && !request.attachments?.length) throw new ChatRefusal('prompt is required');
    let chat = this.chats.get(id);
    if (chat?.alive) throw new ChatRefusal('the chat already has a live execution; send it a message instead');
    const driver = chat?.driver ?? this.driverFor(request.provider);
    this.admit(request, driver);
    const attachments = this.resolveAttachments(request.attachments);
    if (!chat) {
      if (!adopt) throw new ChatRefusal('chat not found', 404);
      chat = new LiveChat(id, { prompt: request.prompt, cwd: adopt.cwd, name: adopt.name, ...(adopt.model ? { model: adopt.model } : {}) }, {}, 'external', null, this.chatDefaults(), driver, true);
      chat.workingDir = adopt.cwd;
    }
    this.applyStartOptions(chat, request);
    // A new execution is a new turn to see through: the replay it may need is its own, not one an
    // earlier execution of the chat already spent (a flow run continues its member's chat this way)
    chat.limitReplays = 0;
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
  fork(sourceId: string, request: ResumeChatRequest & ResolvedTools & Pick<ExecutionExtras, 'handBack'>, source: AdoptedChat): ChatRuntime {
    if (!request.prompt?.trim() && !request.attachments?.length) throw new ChatRefusal('prompt is required');
    const known = this.chats.get(sourceId);
    const driver = known?.driver ?? this.driverFor(request.provider);
    this.admit(request, driver);
    const attachments = this.resolveAttachments(request.attachments);
    const chat = new LiveChat(
      randomUUID(),
      { prompt: request.prompt, cwd: source.cwd, name: `${source.name} (fork)`.slice(0, 60), ...(source.model ? { model: source.model } : {}) },
      {},
      'agentry',
      { chatId: sourceId, at: now() },
      this.chatDefaults(),
      driver,
    );
    // An agent that names its own sessions is asked to copy by the name it gave, not the chat's
    chat.forkFrom = driver.sessionIds === 'assigned' ? (known?.nativeId ?? sourceId) : sourceId;
    chat.workingDir = source.cwd;
    if (known) chat.permissionMode = known.permissionMode;
    this.applyStartOptions(chat, request);
    return this.begin(chat, request.prompt, attachments);
  }

  /** Refuses what cannot start, before anything is created. */
  private admit(opts: ChatStartOptions, driver: ProviderDriver): void {
    // A body is whatever was sent: the field is gone from the type, the refusal is not
    if ('account' in opts && (opts as { account?: unknown }).account !== undefined) throw new ChatRefusal(ACCOUNTS_RETIRED);
    const limit = this.defaults.maxConcurrentRuns;
    if (this.activeCount() >= limit) {
      throw new ChatRefusal(`Concurrent run limit reached (${limit})`);
    }
  }

  /** What a new chat starts from: the configured workspace, and the default mode as it stands now */
  private chatDefaults(): Pick<CoreConfig, 'workspaceDir' | 'defaultPermissionMode'> {
    return { workspaceDir: this.config.workspaceDir, defaultPermissionMode: this.defaults.defaultPermissionMode };
  }

  /** What a request chooses for the execution it starts, on top of what the chat already had. */
  private applyStartOptions(chat: LiveChat, options: ChatStartOptions & ResolvedTools & ExecutionExtras): void {
    const { opts } = chat;
    if (options.handBack) {
      for (const key of ['agent', 'agentsFile', 'jsonSchema', 'systemPromptSnapshot', 'uploads', 'confine', 'keepAlive', 'permissionMode', 'appendSystemPrompt', 'allowedTools', 'disallowedTools', 'maxBudgetUsd', 'permissionPrompts', 'toolConfig', 'mcp'] as const) {
        delete opts[key];
      }
      chat.setSettings({ permissionMode: options.permissionMode ?? this.defaults.defaultPermissionMode });
    }
    if (options.agent !== undefined) {
      if (options.agent === null) delete opts.agent;
      else opts.agent = options.agent;
    }
    if (options.agentsFile !== undefined) {
      if (options.agentsFile === null) delete opts.agentsFile;
      else opts.agentsFile = options.agentsFile;
    }
    if (options.jsonSchema !== undefined) {
      if (options.jsonSchema === null) delete opts.jsonSchema;
      else opts.jsonSchema = options.jsonSchema;
    }
    if (options.systemPromptSnapshot !== undefined) {
      if (options.systemPromptSnapshot === null) delete opts.systemPromptSnapshot;
      else opts.systemPromptSnapshot = options.systemPromptSnapshot;
    }
    if (options.uploads !== undefined) {
      if (options.uploads === null) delete opts.uploads;
      else opts.uploads = options.uploads;
    }
    if (options.keepAlive !== undefined) opts.keepAlive = options.keepAlive;
    if (options.confine !== undefined) {
      if (options.confine === null) delete opts.confine;
      else opts.confine = options.confine;
    }
    chat.setSettings({ ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}), ...(options.model ? { model: options.model } : {}) });
    for (const key of ['model', 'effort', 'permissionMode', 'appendSystemPrompt', 'allowedTools', 'disallowedTools', 'maxBudgetUsd', 'permissionPrompts'] as const) {
      if (options[key] !== undefined) Object.assign(opts, { [key]: options[key] });
    }
    // `null` takes the chat back to the servers the CLI loads on its own
    if (options.mcp === null) delete opts.mcp;
    else if (options.mcp) opts.mcp = options.mcp;
    if (options.toolConfig !== undefined) opts.toolConfig = options.toolConfig;
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
    if (!this.uploads) throw new ChatRefusal('attachments are not available');
    if (ids.length > MAX_ATTACHMENTS) throw new ChatRefusal(`at most ${MAX_ATTACHMENTS} files can be attached to one message`);
    const uploads = this.uploads;
    return ids.map((id) => {
      try {
        return uploads.get(String(id));
      } catch (err) {
        throw new ChatRefusal(err instanceof Error ? err.message : String(err), 404);
      }
    });
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
    if (!chat.alive || !chat.session) throw new Error('the chat has no live process to interrupt');
    if (chat.status !== 'busy' && chat.status !== 'starting') return chat.summary();
    chat.interruptRequested = true;
    try {
      await chat.session.interrupt();
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
      if (chat.alive) await chat.session?.setOption({ permissionMode });
      chat.setSettings({ permissionMode });
    }
    if (model !== undefined) {
      const next = model.trim();
      if (!next) throw new Error('model must not be empty');
      if (chat.alive) await chat.session?.setOption({ model: next });
      chat.opts.model = next;
      chat.setSettings({ model: next });
    }
    this.persist();
    return chat.summary();
  }

  remove(id: string): boolean {
    const chat = this.chats.get(id);
    if (!chat || chat.alive) return false;
    this.chats.delete(id);
    this.publisher.forget(id);
    this.bus?.emit({ type: 'run.removed', title: `${chat.name} removed`, runId: id });
    this.db.deleteChat(id);
    this.saved.delete(id);
    this.persist();
    return true;
  }

  stopAll(): void {
    for (const chat of this.chats.values()) if (chat.alive) this.stop(chat.id);
    // The processes take a moment to exit; their credentials go now, with the wrapper
    this.chatTokens.revokeAll();
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

  /** Resolves once the chat has no process and has read its output to the end: at once when it has none, or when the one it has closes. */
  async exited(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (chat?.alive && chat.proc) await once(chat.proc, 'close');
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

  /** What a process of the chat is started from: the driver turns it into a command line. */
  private launchSpec(chat: LiveChat): SessionLaunch {
    const { opts } = chat;
    return {
      id: chat.id,
      nativeId: chat.nativeId,
      created: chat.created,
      forkFrom: chat.forkFrom,
      name: chat.name,
      cwd: chat.cwd,
      permissionMode: chat.permissionMode,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      ...(opts.mcp?.config ? { mcpConfig: opts.mcp.config } : {}),
      ...(opts.confine ? { confine: opts.confine } : {}),
      // Attached files live outside every project: a session that may read them is told where they are
      ...(this.uploads && opts.uploads !== false ? { uploadsDir: this.uploads.dir } : {}),
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
      ...(typeof opts.maxBudgetUsd === 'number' ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      // Prompts go to a host only when something is listening: a chat waiting on an answer that never
      // comes is worse than one told plainly that it was denied
      permissionPrompts: opts.permissionPrompts === 'host' && this.permissions ? 'host' : 'none',
      ...(opts.jsonSchema !== undefined ? { jsonSchema: opts.jsonSchema } : {}),
      ...(opts.systemPromptSnapshot ? { systemPromptSnapshot: opts.systemPromptSnapshot } : {}),
      ...(opts.internal ? { internal: true } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.agentsFile ? { agentsFile: opts.agentsFile } : {}),
      policy: opts.toolConfig?.policy ?? null,
    };
  }

  /**
   * The only place a CLI process starts, and it becomes the chat's at once: every process is tracked
   * by the chat it works for, and a chat never has two.
   */
  private spawnProcess(chat: LiveChat, prompt: string, attachments: Attachment[] = []): void {
    if (chat.alive) throw new ChatRefusal('the chat already has a live process');
    const holders = this.sessionHolders(chat);
    if (holders.length) {
      throw new ChatRefusal(
        `session ${chat.id} is still running in process ${holders.join(', ')}, which this chat does not track; ` +
          'a second process would carry on the same conversation beside it. Wait for it to finish, or stop it first.',
      );
    }
    const plan = chat.driver.launch(this.launchSpec(chat));
    chat.stopRequested = false;
    chat.endedAt = null;
    chat.error = null;
    chat.rateLimited = false;
    chat.limitRequested = false;
    chat.stopReason = null;
    // Whatever the last process left open went with it
    chat.heartbeats.clear();
    chat.openCommands.clear();
    chat.cancelled.clear();
    chat.beginExecution();
    // Whatever the last process was doing went with it
    chat.activity.clear();
    chat.setStatus('starting');

    const env: NodeJS.ProcessEnv = { ...plan.env, AGENTRY_CHAT_ID: chat.id };
    for (const name of plan.unsetEnv) delete env[name];
    // One inherited from the wrapper that started this one points at the wrong wrapper, and its
    // token is another wrapper's credential: neither is ever passed through
    delete env.AGENTRY_API_TOKEN;
    let token: string | null = null;
    if (this.apiUrl && chat.opts.api !== false) {
      env.AGENTRY_API_URL = this.apiUrl;
      // Minted whatever the mode: a guard switched on mid-turn still finds the turn holding a credential
      token = this.chatTokens.mint(chat.id);
      env.AGENTRY_API_TOKEN = token;
    } else delete env.AGENTRY_API_URL;
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(plan.bin, plan.args, { cwd: chat.cwd, env, stdio: 'pipe' });
    } catch (error) {
      if (token) this.chatTokens.revoke(token);
      throw error;
    }
    // Keyed by this process's own token, so an earlier process ending late never revokes the current one
    const revokeToken = () => {
      if (token) this.chatTokens.revoke(token);
    };
    if (token) this.chatTokens.attach(token, proc.pid);
    chat.proc = proc;
    chat.procStartedAt = now();
    // The chat's status follows the process it tracks and no other: an earlier process ending late
    // used to mark the chat failed while its current one was still working
    const current = () => chat.proc === proc;

    const session = chat.driver.attach(
      { write: (text) => proc.stdin.write(text), end: () => proc.stdin.end(), up: () => processUp(proc) },
      (event) => foldEvent(this.host, chat, event),
      chat.branches,
    );
    chat.session = session;
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!current()) return;
      session.readLine(line);
      this.noteActivity(chat);
    });
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (!line.trim() || !current()) return;
      session.readError(line);
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      revokeToken();
      if (!current()) return;
      chat.error = err.message;
      this.finalize(chat, 'failed');
    });
    // The token goes as soon as the process is gone; what the chat becomes waits for `close`, which
    // comes after stdout and stderr have been read to the end, so the last lines of stderr, the reason
    // an execution failed, are in the chat's events before they are read back
    proc.on('exit', () => revokeToken());
    proc.on('close', (code) => {
      revokeToken();
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
    const shown = chat.session?.send({ text, attachments, ...(uploads ? { read: (id: string) => uploads.read(id).bytes } : {}) }) ?? text;
    chat.push({
      kind: 'message',
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
          { type: 'text', text: shown },
        ],
      },
    });
    chat.setStatus('busy');
  }

  /** A fault in what the agent said about itself: the execution fails with the reason, and nothing carries on beside it. */
  private failProtocol(chat: LiveChat, message: string): void {
    chat.error = message;
    this.finalize(chat, 'failed');
    chat.proc?.kill('SIGTERM');
  }

  private finalize(chat: LiveChat, status: RunStatus): void {
    if (chat.endedAt) return;
    if (chat.idleTimer) clearTimeout(chat.idleTimer);
    chat.endedAt = now();
    // A prompt still waiting belongs to a process that is gone: nobody can act on the answer.
    this.permissions?.denyAllFor(chat.id);
    chat.session?.dispose('the chat ended before the CLI answered');
    chat.branches.endAll(chat.endedAt);
    const execution = chat.execution;
    if (execution) {
      Object.assign(execution, { endedAt: chat.endedAt, outcome: executionOutcome(status), error: chat.error });
    }
    chat.activity.clear();
    chat.setStatus(status);
    this.noteActivity(chat);
    this.persist();
    this.maybeLimit(chat);
  }

  /**
   * Announces that the chat's provider is at its limit, once per attempt. The turn can die against the limit while the
   * process stays alive (keepAlive) or by taking it down, so both paths end up here.
   */
  private maybeLimit(chat: LiveChat): void {
    if (!chat.rateLimited || chat.limitRequested || !chat.lastUserTurn) return;
    if (chat.limitReplays >= MAX_LIMIT_REPLAYS) return;
    chat.limitRequested = true;
    this.emit('limit-hit', chat.summary(), this.limits.get(chat.provider));
  }

  /** A wrapper-generated line in the transcript (account rotations, retries). */
  notice(id: string, text: string, data?: Record<string, unknown>): void {
    this.chats.get(id)?.push({ kind: 'notice', text, ...(data ? { data } : {}) });
  }

  /**
   * The chat's turns are held to a structured result, which only a run Agentry started on its own
   * asks for (a flow run, the assistant): whoever started it heard its result already.
   */
  heldToSchema(id: string): boolean {
    return this.chats.get(id)?.opts.jsonSchema !== undefined;
  }

  /**
   * The chat's turn died against its provider's limit and `limit-hit` will be announced for it: what
   * a run held to a schema waits on rather than fail. True from the limit until the announcement.
   */
  limitComing(id: string): boolean {
    const chat = this.chats.get(id);
    return !!chat && chat.rateLimited && !chat.limitRequested && !!chat.lastUserTurn && chat.limitReplays < MAX_LIMIT_REPLAYS;
  }

  /** The chat's last turn died on its provider's limit and nothing has started on it since. */
  atLimit(id: string): boolean {
    return this.chats.get(id)?.rateLimited === true;
  }

  /** The provider's reading as it stands for the chat's provider; null for a chat Agentry does not drive. */
  limitOf(id: string): ProviderLimit | null {
    const chat = this.chats.get(id);
    return chat ? this.limits.get(chat.provider) : null;
  }

  /**
   * Re-sends the turn that died against the limit, on the same chat and provider: what `wait` does
   * once the reset has passed. The process is gone by now, so `send` respawns it with `--resume`.
   */
  async replayLastTurn(id: string): Promise<boolean> {
    const chat = this.chats.get(id);
    if (!chat || !chat.lastUserTurn || chat.limitReplays >= MAX_LIMIT_REPLAYS) return false;
    chat.limitReplays++;
    chat.rateLimited = false;
    chat.limitRequested = false;
    // A live process may hold state from before the reset: a respawn starts clean
    if (chat.alive) {
      const proc = chat.proc;
      this.stop(id);
      if (proc) await once(proc, 'close');
    }
    this.send(id, chat.lastUserTurn.text, chat.lastUserTurn.attachments);
    return true;
  }

  /**
   * Moves the work to a new chat on another provider (decision P4-1): the old chat's process is
   * stopped if it is still up, and the new chat starts in the same directory and worktree with the
   * handoff or the original prompt as its first turn. The two chats link to each other; each keeps
   * its own provider, session and transcript. Nothing of the old session travels: a session belongs to
   * its provider.
   */
  async continueOn(fromId: string, spec: ChatContinuationSpec): Promise<ChatRuntime> {
    const from = this.chats.get(fromId);
    if (!from) throw new ChatRefusal('chat not found', 404);
    if (from.continuedIn) throw new ChatRefusal('this chat was already continued on another provider', 409);
    const driver = this.driverFor(spec.provider);
    const proc = from.alive ? from.proc : null;
    if (from.alive) this.stop(fromId);
    if (proc) await once(proc, 'close');
    this.admit({}, driver);
    const attachments = this.resolveAttachments(spec.attachments);
    const { opts } = from;
    const toolConfig = spec.toolConfig ?? null;
    const next: NewChat = {
      prompt: spec.prompt,
      cwd: from.cwd,
      name: from.name,
      provider: spec.provider,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      permissionMode: spec.permissionMode,
      ...(spec.appendSystemPrompt ? { appendSystemPrompt: spec.appendSystemPrompt } : {}),
      ...(toolConfig ? { toolConfig, allowedTools: toolConfig.allowedTools, disallowedTools: toolConfig.disallowedTools } : {}),
      ...(toolConfig?.mcp?.config ? { mcp: toolConfig.mcp } : {}),
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
      ...(opts.jsonSchema !== undefined ? { jsonSchema: opts.jsonSchema } : {}),
      ...(typeof spec.maxBudgetUsd === 'number' ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
      ...(opts.permissionPrompts ? { permissionPrompts: opts.permissionPrompts } : {}),
      ...(opts.internal ? { internal: true } : {}),
      ...(opts.uploads !== undefined ? { uploads: opts.uploads } : {}),
      ...(opts.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : {}),
    };
    const chat = new LiveChat(randomUUID(), next, from.meta, from.origin, null, this.chatDefaults(), driver);
    chat.workingDir = from.workingDir;
    const at = now();
    chat.continuedFrom = { chatId: from.id, provider: from.provider, action: spec.action, at, moveId: spec.moveId };
    from.continuedIn = { chatId: chat.id, provider: chat.provider, action: spec.action, at, moveId: spec.moveId };
    try {
      return this.begin(chat, spec.prompt, attachments);
    } catch (err) {
      from.continuedIn = null;
      throw err;
    }
  }
}
