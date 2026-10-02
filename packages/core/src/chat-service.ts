import { dirname, resolve } from 'node:path';
import {
  entrySearchText,
  searchPattern,
  TranscriptSearch,
  TRANSCRIPT_PAGE_MAX,
  type AgentTranscript,
  type BackgroundTaskOutput,
  type CancelCommandRequest,
  type CancelCommandResult,
  type Chat,
  type ChatBackgroundTaskEntry,
  type ChatControl,
  type ChatDetail,
  type ChatMessageRequest,
  type ChatOrchestration,
  type ChatOrigin,
  type ChatProject,
  type ChatRef,
  type ChatSettingsUpdate,
  type ChatState,
  type ChatSubagentEntry,
  type ChatSummary,
  type ChatWorkflowEntry,
  type ChatWorktree,
  type ChatExport,
  type Execution,
  type ChatStartOptions,
  type ChatToolConfig,
  type ToolPolicy,
  type HandoffPreview,
  type MoveChatRequest,
  type ProjectProvidersSettings,
  type ProviderMove,
  type ProviderMoveDecider,
  type ProviderMoveSubjectKind,
  type ProviderStatus,
  type ProvidersSettings,
  type EditStep,
  type ForkChatRequest,
  type ProviderCapability,
  type ProviderId,
  type HintRequest,
  type NewChatRequest,
  type ResumeChatRequest,
  type RunEvent,
  type TranscriptEntry,
  type TranscriptSearchResult,
  type UsageBreakdown,
  type UsageBucket,
  type UsageReport,
  type UsageSeries,
} from '@agentry/shared';
import { randomUUID } from 'node:crypto';
import { buildHandoff } from './handoff.ts';
import { editStepsFromEntries, editStepsOf } from './edit-steps.ts';
import { gitRaw } from './git.ts';
import type { Db } from './db.ts';
import { candidatesFor, type CandidateProvider, type CandidateResult, type RunNeeds } from './providers/candidates.ts';
import { runRef } from './event-sources.ts';
import { rulesOnDriver } from './tool-policy.ts';
import { pageSize } from './sessions.ts';
import { toChatEnvironment, toChildren, type BranchFacts } from './chat-branches.ts';
import { mergeLiveWorkflows } from './workflows.ts';
import { chatControl, chatState, lastEndedOf, sessionHolder, type SessionHolder } from './chat-model.ts';
import type { ChatTools } from './chat-tools.ts';
import { LEGACY_PROVIDER } from './chat-records.ts';
import type { AdoptedChat, ChatManager, ChatRuntime, ExecutionExtras, NewChat } from './chats.ts';
import type { CliSession, TranscriptSummary } from './cli-facts.ts';
import type { HealthService } from './health-service.ts';
import { backgroundLogs, isLiveCliSession, listActiveCliSessions, stopBackgroundSession } from './cli.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { CoreConfig } from './paths.ts';
import { drivesSession, forgetStreamJsonProcesses, recentStreamJsonProcesses, streamJsonProcesses, type CliProcess } from './processes.ts';
import type { SessionStore } from './sessions.ts';
import { OpencodeTranscripts } from './providers/opencode/transcripts.ts';
import { SessionStoreTranscripts, TranscriptUnavailable, type TranscriptStore } from './providers/transcripts.ts';
import { emptyTokenUsage, localDay } from './usage.ts';
import { usageReport, type ChatSpend, type DayRange } from './usage-report.ts';
import { usageBreakdown, usageSeries } from './usage-series.ts';

/**
 * How long `claude agents --json` is trusted between reads: it is an exec of about half a second,
 * and lists poll. Past `CLI_FRESH_MS` the list is still served while a new read runs in the
 * background; past `CLI_STALE_MS` a caller waits for the new one. Our own chats starting and ending
 * drop it at once.
 */
const CLI_FRESH_MS = 1_500;
const CLI_STALE_MS = 10_000;
/** Ended chats whose delegated work is still listed; each costs a stat per poll. */
const RECENT_ENDED_CHATS = 30;
/**
 * Chats from a terminal that ended, listed with the live ones: what they delegated is still worth
 * seeing afterwards, the same way an ended chat's is. Bounded, and only recent ones.
 */
const RECENT_ENDED_EXTERNAL = 20;
const RECENT_ENDED_WINDOW_MS = 24 * 3_600_000;

/** The origins a chat list shows unless asked for more: workers and housekeeping have their own homes. */
export const DEFAULT_ORIGINS: readonly ChatOrigin[] = ['agentry', 'external'];

/**
 * A chat that could not start for a reason of the server's (the CLI could not be spawned, a callback
 * failed on the way): a 500, whose message is still the person's to read, since it is what they
 * would report. `expose` tells the API's error handler to send it rather than "internal error".
 */
export class ChatStartError extends Error {
  readonly statusCode = 500;
  readonly expose = true;
}

/**
 * Whatever starting a chat threw, as the API should answer it: a refusal (a 4xx it chose, a
 * `ChatRefusal`, a work item's refusal) as it is; anything else, bare `Error`s included, which the
 * API would otherwise read as the caller's fault, as a 500 that says what went wrong.
 */
export function startFailure(err: unknown): Error {
  if (err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number') return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ChatStartError(`the chat could not start: ${message}`, { cause: err });
}

/** An action the chat's control refuses: the person is told why, and the way forward. */
export class ChatConflictError extends Error {
  readonly statusCode = 409;
  constructor(
    message: string,
    /** What can be done instead, when there is one */
    readonly action: 'fork' | 'hint' | null,
  ) {
    super(message);
  }
}

/** A request that asks for something its provider's driver does not declare: the caller's to change. */
export class CapabilityRefusal extends Error {
  readonly statusCode = 400;
  constructor(
    readonly provider: ProviderId,
    readonly capability: ProviderCapability,
    what: string,
  ) {
    super(`${what} needs the "${capability}" capability, which ${provider} does not have`);
  }
}

/** A request that still pins a chat to an account: they went away with claude-swap. */
export class AccountsRetired extends Error {
  readonly statusCode = 400;
  constructor() {
    super('accounts were retired; see Settings → Providers');
  }
}

/** Where a directory belongs. Supplied by whoever knows the projects, so this file does not. */
export interface Placement {
  project: ChatProject | null;
  worktree: ChatWorktree | null;
}

export interface ChatServiceDeps {
  config: CoreConfig;
  runtime: ChatManager;
  /** Turns the tool preset and MCP servers a request picks into what the CLI is given */
  tools: ChatTools;
  sessions: SessionStore;
  /** What a non-Claude chat streamed, read as its transcript when its provider keeps none Agentry can read */
  entries?: TranscriptStore;
  orchestrator: Orchestrator;
  place: (dir: string, recorded: TranscriptSummary['worktree']) => Placement;
  /** What Claude loaded in a directory, from the init event of the last chat started there */
  environmentOf: (dir: string) => Parameters<typeof toChatEnvironment>[0] | undefined;
  /** The context window the CLI reported for this exact model id; null when it never has */
  windowOf: (model: string) => number | null;
  health: HealthService;
  /**
   * A chat Agentry started for one of its own runs (a flow member's, the assistant's), now or
   * before: a person who continues it gets it back without the run's rules.
   */
  memberChat?: (chatId: string) => boolean;
  /** What moving a chat to another provider reads; without it a chat cannot be moved */
  move?: ChatMoveDeps;
}

/** What the work a chat does for adds to a move: a flow run's or a task's own prompt, limits and rules. */
export interface ChatWork {
  kind: Exclude<RunNeeds['kind'], 'chat'>;
  subjectKind: ProviderMoveSubjectKind;
  subjectId: string;
  /** The prompt Agentry sent for the run or the task, when it is not the chat's first one */
  prompt?: string | null;
  /** Acceptance criteria not yet met, or the task's open items */
  openItems?: string[];
  /** The stage's or the task's closing instructions */
  closing?: string | null;
  /** The flow member's agent file, inlined as instructions where the target cannot take it as a subagent */
  agent?: { name: string; prompt: string } | null;
  /** Capabilities the work needs beyond what the chat shows (`workflowTool`) */
  needs?: ProviderCapability[];
  /** What is left of the work's budget; null when it has none */
  remainingBudgetUsd?: number | null;
}

export interface ChatMoveDeps {
  /** `providers.json`, as it stands now */
  settings: () => ProvidersSettings;
  /** The detector's last reading of every provider */
  statuses: () => ProviderStatus[];
  /** A project's own providers settings (its order and its on-limit overrides); null when it sets none */
  projectProviders: (projectId: string) => ProjectProvidersSettings | null;
  /** The move rows: written when a chat moves, read for the chain */
  moves: Pick<Db, 'insertProviderMove' | 'providerMoves'>;
  /** The run or task a chat works for; null for a person's chat */
  work?: (chatId: string) => ChatWork | null;
}

/** Who chose a move, and what it is a move of; a person's click on a chat is `{ decidedBy: 'person' }`. */
export interface MoveOrigin {
  decidedBy: ProviderMoveDecider;
  decisionId?: string | null;
  reason?: string | null;
  /** The reset the work was at when it moved; kept on the row */
  resetsAt?: string | null;
}

/** A move that cannot happen now: the chat is not at a limit, was moved already, or no candidate takes it. */
export class MoveRefusal extends Error {
  readonly statusCode = 409;
}

export interface ChatFilter {
  /** Only chats of this project; null for the ones under no project */
  project?: string | null;
  /** Origins to include; workers and housekeeping are left out unless asked for */
  origins?: readonly ChatOrigin[];
  /**
   * `false` leaves out the workers of orchestrations while keeping their syntheses, which share the
   * `orchestration` origin: a list that hides workers need not download them
   */
  workers?: boolean;
  state?: ChatState;
  limit?: number;
}

/** What is known of every chat at one moment, gathered once so that listing many costs one pass. */
interface Facts {
  transcripts: Map<string, TranscriptSummary>;
  cli: Map<string, CliSession>;
  processes: CliProcess[];
  orchestrations: Map<string, ChatOrchestration & { taskRunning: boolean }>;
}

/** Who holds a chat, and the origin and state that follow from it. */
interface Standing {
  own: boolean;
  foreignProcess: boolean;
  orchestration: (ChatOrchestration & { taskRunning: boolean }) | null;
  origin: ChatOrigin;
  state: ChatState;
}

/**
 * Assembles the chats the API serves from what is known of them: the transcript the CLI wrote, the
 * runtime of the ones Agentry drives, the CLI's own list of sessions and the orchestrations that
 * own some. There is one chat per session id whatever it is read from, so a chat is never listed
 * twice however many of those know it.
 */
export class ChatService {
  private cliCache: { at: number; value: CliSession[] } | null = null;
  /** The read under way, shared by whoever asks meanwhile; `gen` tells one started before an invalidation */
  private cliPending: { gen: number; promise: Promise<CliSession[]> } | null = null;
  private cliGen = 0;

  constructor(private readonly deps: ChatServiceDeps) {}

  // ---------- reading ----------

  /** CLI sessions alive on the machine, each marked with whether it is really open for work. */
  async cliSessions(fresh = false): Promise<CliSession[]> {
    const cached = this.cliCache;
    const age = cached ? Date.now() - cached.at : Infinity;
    if (!fresh && cached && age <= CLI_FRESH_MS) return cached.value;
    if (!fresh && cached && age <= CLI_STALE_MS) {
      void this.readCliSessions().catch(() => undefined);
      return cached.value;
    }
    // A decision waits for a read begun after it was asked: one already under way may predate
    // the change it hangs on, a terminal that just let go of the session, say
    return this.readCliSessions(!fresh);
  }

  /**
   * Forgets what was last read of who holds each session, the CLI's list and the process table, so
   * the next caller reads them again: a chat of ours that ended would otherwise read as held by the
   * process it no longer has.
   */
  forgetHolders(): void {
    this.cliGen++;
    this.cliCache = null;
    forgetStreamJsonProcesses();
  }

  private readCliSessions(join = true): Promise<CliSession[]> {
    const pending = this.cliPending;
    if (join && pending && pending.gen === this.cliGen) return pending.promise;
    const gen = this.cliGen;
    const at = Date.now();
    const promise: Promise<CliSession[]> = (async () => {
      const agents = await listActiveCliSessions(this.deps.config);
      const value = await Promise.all(
        agents.map(async (agent) => ({
          ...agent,
          live: isLiveCliSession(agent, await this.deps.sessions.summary(agent.sessionId).catch(() => null)),
        })),
      );
      // A read that finished late never replaces a newer one
      if (gen === this.cliGen && (!this.cliCache || this.cliCache.at <= at)) this.cliCache = { at, value };
      return value;
    })().finally(() => {
      if (this.cliPending?.promise === promise) this.cliPending = null;
    });
    this.cliPending = { gen, promise };
    return promise;
  }

  /** The orchestration each of its chats works for, keyed by session id. */
  private chatOrchestrations(): Map<string, ChatOrchestration & { taskRunning: boolean }> {
    const orchestrations = new Map<string, ChatOrchestration & { taskRunning: boolean }>();
    for (const orch of this.deps.orchestrator.list()) {
      for (const task of orch.tasks) {
        if (task.sessionId) orchestrations.set(task.sessionId, { id: orch.id, name: orch.name, taskId: task.id, taskName: task.name, taskRunning: task.status === 'running' });
      }
      if (orch.synthesisRunId) orchestrations.set(orch.synthesisRunId, { id: orch.id, name: orch.name, taskId: null, taskName: null, taskRunning: false });
    }
    return orchestrations;
  }

  private async facts(fresh = false, all = true): Promise<Facts> {
    const [transcripts, cli] = await Promise.all([all ? this.deps.sessions.listSessions() : Promise.resolve([]), this.cliSessions(fresh)]);
    return {
      transcripts: new Map(transcripts.map((t) => [t.id, t])),
      cli: new Map(cli.map((c) => [c.sessionId, c])),
      // A decision reads the table as it is now; what is only shown can be a second old
      processes: fresh ? streamJsonProcesses() : recentStreamJsonProcesses(),
      orchestrations: this.chatOrchestrations(),
    };
  }

  /** Who holds a chat and what that makes of it: what a list filters on, before the rest is assembled. */
  private standing(id: string, facts: Facts, runtime: ChatRuntime | null): Standing {
    const own = runtime?.pid != null;
    const cli = facts.cli.get(id);
    const foreignCli = cli !== undefined && cli.live && cli.pid !== runtime?.pid;
    const foreignProcess = foreignCli || facts.processes.some((p) => p.pid !== runtime?.pid && drivesSession(p.argv, id));
    const orchestration = facts.orchestrations.get(id) ?? null;
    const origin: ChatOrigin = runtime?.origin ?? (orchestration ? 'orchestration' : 'external');
    // A process of ours wins over the CLI's list, which only knows about the ones that are not ours
    const state = chatState({
      run: own && runtime ? { status: runtime.status, pendingPrompts: runtime.pendingPrompts } : null,
      cli: !own && foreignCli && cli ? { status: cli.status, ...(cli.state ? { state: cli.state } : {}) } : null,
    });
    return { own, foreignProcess, orchestration, origin, state };
  }

  /** One chat, from every source that knows it. Null when none does. */
  private assemble(id: string, facts: Facts, runtime: ChatRuntime | null, summary: TranscriptSummary | null, known?: Standing): ChatSummary | null {
    if (!summary && !runtime) return null;
    const { own, foreignProcess, orchestration, origin, state } = known ?? this.standing(id, facts, runtime);
    const holder: SessionHolder = sessionHolder({ ownProcess: own, foreignProcess });
    const control: ChatControl = chatControl({ holder, origin, taskRunning: orchestration?.taskRunning === true, deliverable: orchestration !== null && orchestration.taskId === null });

    const dir = summary?.worktree?.path ?? summary?.projectPath ?? runtime?.workingDir ?? runtime?.cwd ?? '';
    const placement = this.deps.place(dir, summary?.worktree ?? null);
    const executions: Execution[] = runtime?.executions ?? [];
    const live = executions.find((e) => e.endedAt === null) ?? null;
    const costs = executions.map((e) => e.costUsd).filter((c): c is number => c !== null);
    const usage = summary?.usage;

    return {
      id,
      title: summary?.title ?? runtime?.name ?? id,
      // A chat read from Claude's transcripts is a Claude Code one
      provider: runtime?.provider ?? LEGACY_PROVIDER,
      providerSessionId: null,
      firstPrompt: summary?.firstPrompt ?? runtime?.prompt ?? null,
      messageCount: summary?.messageCount ?? 0,
      startedAt: summary?.startedAt ?? runtime?.createdAt ?? null,
      updatedAt: summary?.updatedAt ?? runtime?.updatedAt ?? null,
      model: runtime?.model ?? summary?.model ?? null,
      cliVersion: summary?.cliVersion ?? null,
      project: placement.project,
      cwd: dir,
      worktree: placement.worktree,
      origin,
      orchestration: orchestration ? { id: orchestration.id, name: orchestration.name, taskId: orchestration.taskId, taskName: orchestration.taskName } : null,
      derivedFrom: runtime?.derivedFrom ?? null,
      continuedFrom: runtime?.continuedFrom ?? null,
      continuedIn: runtime?.continuedIn ?? null,
      state,
      control,
      execution: live,
      // Only a process of ours streams what it is doing; a chat a terminal holds says nothing
      activity: (own && runtime?.activity) || null,
      executions,
      context: usage?.context ? { used: usage.context.used, window: usage.context.model ? this.deps.windowOf(usage.context.model) : null } : null,
      // Dollars exist only where the CLI reported them, so a chat nobody launched from here has none
      // and is not priced from its tokens
      cost: { usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null, tokens: usage?.tokens ?? [], total: usage?.total ?? emptyTokenUsage() },
    };
  }

  async list(filter: ChatFilter = {}): Promise<ChatSummary[]> {
    const facts = await this.facts();
    const runtimes = new Map(this.deps.runtime.list().map((r) => [r.id, r]));
    const ids = new Set([...facts.transcripts.keys(), ...runtimes.keys()]);
    const origins = filter.origins ?? DEFAULT_ORIGINS;
    const out: ChatSummary[] = [];
    for (const id of ids) {
      const runtime = runtimes.get(id) ?? null;
      // What is filtered out is never assembled: a sidebar asking for the few working chats would
      // otherwise pay for placing every chat on the machine
      const standing = this.standing(id, facts, runtime);
      if (!origins.includes(standing.origin)) continue;
      if (filter.state && standing.state !== filter.state) continue;
      const chat = this.assemble(id, facts, runtime, facts.transcripts.get(id) ?? null, standing);
      if (!chat) continue;
      // Every chat of an orchestration but its synthesis is a worker, one whose graph is gone included
      if (filter.workers === false && chat.origin === 'orchestration' && chat.orchestration?.taskId !== null) continue;
      if (filter.project !== undefined && (chat.project?.id ?? null) !== filter.project) continue;
      out.push(chat);
    }
    out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return filter.limit && filter.limit > 0 ? out.slice(0, filter.limit) : out;
  }

  /**
   * What every chat spent, per day, per project and per orchestration. Housekeeping and worker chats
   * are in the totals whatever the list hides: they were paid for. A cost is put on the day its
   * execution ended (or today, while it runs), because the CLI reports it as one figure per process.
   */
  async usage(range: DayRange = {}): Promise<UsageReport> {
    return usageReport(await this.spends(), range);
  }

  /** Cost and tokens over time, cut by day or by week. */
  async usageSeries(bucket: UsageBucket, range: DayRange = {}): Promise<UsageSeries> {
    return usageSeries(await this.spends(), bucket, range);
  }

  /** The same range cut by project and by model. */
  async usageBreakdown(range: DayRange = {}): Promise<UsageBreakdown> {
    return usageBreakdown(await this.spends(), range);
  }

  private async spends(): Promise<ChatSpend[]> {
    const transcripts = new Map((await this.deps.sessions.listSessions()).map((t) => [t.id, t]));
    const runtimes = new Map(this.deps.runtime.list().map((r) => [r.id, r]));
    const orchestrations = this.chatOrchestrations();
    const spend: ChatSpend[] = [];
    for (const id of new Set([...transcripts.keys(), ...runtimes.keys()])) {
      const summary = transcripts.get(id) ?? null;
      const runtime = runtimes.get(id) ?? null;
      const dir = summary?.worktree?.path ?? summary?.projectPath ?? runtime?.workingDir ?? runtime?.cwd ?? '';
      const orch = orchestrations.get(id);
      const costs: ChatSpend['costs'] = [];
      const modelCosts: NonNullable<ChatSpend['modelCosts']> = [];
      for (const e of runtime?.executions ?? []) {
        const day = localDay(e.endedAt ?? new Date().toISOString());
        if (e.costUsd === null || !day) continue;
        costs.push({ day, usd: e.costUsd });
        const split = Object.entries(e.modelCosts ?? {});
        if (split.length) for (const [model, usd] of split) modelCosts.push({ day, model, usd });
        else modelCosts.push({ day, model: e.model, usd: e.costUsd });
      }
      if (costs.length === 0 && runtime?.nativeSessionId) {
        // ACP reports no cost, so OpenCode's own record of the session is what the usage page reads
        const own = this.deps.runtime.providers.driverFor(runtime.provider ?? LEGACY_PROVIDER)?.transcripts;
        const spent = own instanceof OpencodeTranscripts ? await own.cost(runtime.nativeSessionId).catch(() => null) : null;
        const day = localDay(runtime.executions.at(-1)?.endedAt ?? runtime.updatedAt);
        if (spent && spent.cost > 0 && day) {
          costs.push({ day, usd: spent.cost });
          modelCosts.push({ day, model: runtime.model ?? null, usd: spent.cost });
        }
      }
      spend.push({
        chatId: id,
        project: this.deps.place(dir, summary?.worktree ?? null).project,
        orchestration: orch ? { id: orch.id, name: orch.name } : null,
        days: summary?.usage.days ?? [],
        costs,
        modelCosts,
      });
    }
    return spend;
  }

  /** A chat as its own page shows it, branches and environment included. Null when there is none. */
  async get(id: string, opts: { fresh?: boolean } = {}): Promise<Chat | null> {
    const facts = await this.facts(opts.fresh, false);
    const summary = await this.summaryWith(id, facts);
    if (!summary) return null;
    const runtime = this.deps.runtime.get(id);
    const heldByAnother = facts.cli.get(id)?.live === true && facts.cli.get(id)?.pid !== runtime?.pid;
    const children = toChildren(await this.branchFacts(id, runtime, runtime?.pid != null || heldByAnother), id);
    const env = this.deps.environmentOf(runtime?.cwd ?? summary.cwd);
    const task = this.deps.orchestrator.taskContext(id);
    const health = this.deps.health.read(id, {
      state: summary.state,
      lastEnded: lastEndedOf(summary.executions),
      context: summary.context,
      failedBranches: [...children.subagents, ...children.backgroundTasks, ...children.workflows].filter((b) => b.status === 'failed').length,
      ...(task ? { limits: task.limits, taskElapsedMs: task.elapsedMs, taskSpentUsd: task.spentUsd } : {}),
    });
    return { ...summary, children, environment: env ? toChatEnvironment(env) : null, health, tools: runtime?.tools ?? null };
  }

  /** The list's view of one chat, read fresh when a decision hangs on it. */
  async summaryOf(id: string, fresh = false): Promise<ChatSummary | null> {
    return this.summaryWith(id, await this.facts(fresh, false));
  }

  private async summaryWith(id: string, facts: Facts): Promise<ChatSummary | null> {
    const transcript = await this.deps.sessions.summary(id).catch(() => null);
    if (transcript) facts.transcripts.set(id, transcript);
    return this.assemble(id, facts, this.deps.runtime.get(id), transcript);
  }

  /**
   * Where a chat's transcript is read from, best first, each with the id it knows the chat by. A
   * Claude chat reads Claude's JSONL by its id; any other reads its provider's own store by the
   * native id when the provider has one, then what Agentry recorded of the stream.
   */
  private storesOf(id: string): Array<{ store: TranscriptStore; key: string }> {
    const runtime = this.deps.runtime.get(id);
    const provider = runtime?.provider ?? LEGACY_PROVIDER;
    if (provider === LEGACY_PROVIDER) return [{ store: new SessionStoreTranscripts(this.deps.sessions), key: id }];
    const own = this.deps.runtime.providers.driverFor(provider)?.transcripts;
    const stores: Array<{ store: TranscriptStore; key: string }> = [];
    if (own && runtime?.nativeSessionId) stores.push({ store: own, key: runtime.nativeSessionId });
    if (this.deps.entries) stores.push({ store: this.deps.entries, key: id });
    return stores;
  }

  /**
   * The first of a chat's stores that holds an answer. A store that cannot read right now is
   * passed over for the next; when none answers and one said so, that is what the caller hears,
   * never an empty chat.
   */
  private async fromStores<T>(id: string, read: (store: TranscriptStore, key: string) => Promise<T | null>): Promise<T | null> {
    let unavailable: TranscriptUnavailable | null = null;
    for (const { store, key } of this.storesOf(id)) {
      try {
        const found = await read(store, key);
        if (found) return found;
      } catch (err) {
        if (!(err instanceof TranscriptUnavailable)) throw err;
        unavailable = err;
      }
    }
    if (unavailable) throw unavailable;
    return null;
  }

  /**
   * A page of a chat's transcript with the chat. A chat that has no transcript (a housekeeping one,
   * or one that has not written its first line yet) reads from what its process streamed.
   */
  async detail(id: string, opts: { includeSidechains?: boolean; limit?: number; before?: number } = {}): Promise<ChatDetail> {
    const chat = await this.get(id);
    if (!chat) throw new Error('chat not found');
    const page = await this.fromStores(id, (store, key) => store.page(key, opts));
    if (page) return { chat, entries: page.entries, from: page.from, total: page.total };
    const messages = this.deps.runtime.messages(id) ?? [];
    const visible = opts.includeSidechains ? messages : messages.filter((m) => !m.isSidechain);
    const limit = pageSize(opts.limit);
    const until = opts.before !== undefined && Number.isFinite(opts.before) ? Math.max(0, Math.min(Math.trunc(opts.before), visible.length)) : visible.length;
    const from = Math.max(0, until - limit);
    return { chat, entries: visible.slice(from, until), from, total: visible.length };
  }

  /**
   * Every entry of a chat's transcript, subagents included, with the chat: what an export is made
   * of. Read a page at a time from the newest back, so a transcript of tens of megabytes is never
   * one read. A chat with no transcript is read from what its process streamed.
   */
  async export(id: string): Promise<ChatExport> {
    const chat = await this.get(id);
    if (!chat) throw new Error('chat not found');
    const pages: TranscriptEntry[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = await this.fromStores(id, (store, key) => store.page(key, { includeSidechains: true, limit: TRANSCRIPT_PAGE_MAX, ...(before !== undefined ? { before } : {}) }));
      if (!page) break;
      pages.unshift(page.entries);
      if (page.from === 0 || page.entries.length === 0) return { exportedAt: new Date().toISOString(), chat, entries: pages.flat() };
      before = page.from;
    }
    return { exportedAt: new Date().toISOString(), chat, entries: this.deps.runtime.messages(id) ?? [] };
  }

  /** The whole transcript searched, in the index space `detail` pages in; a chat with none, over what its process streamed. */
  async search(id: string, query: string, opts: { includeSidechains?: boolean } = {}): Promise<TranscriptSearchResult> {
    const found = await this.fromStores(id, (store, key) => store.search(key, query, opts));
    if (found) return found;
    const messages = this.deps.runtime.messages(id);
    if (!messages) throw new Error('chat not found');
    const pattern = searchPattern(query);
    if (!pattern) throw new Error('q is required');
    const search = new TranscriptSearch(query, pattern);
    for (const entry of messages) if (opts.includeSidechains || !entry.isSidechain) search.add(entrySearchText(entry));
    return search.result();
  }

  // ---------- acting ----------

  /**
   * The provider a request runs on, refused with a 400 when it has no session driver, and the
   * capability gates: what the request asks for must be declared by that provider. Claude declares
   * them all, so nothing refuses today.
   */
  private gate(
    requested: ProviderId | undefined,
    options: Pick<ChatStartOptions, 'maxBudgetUsd' | 'permissionPrompts'> & { account?: unknown },
    asks: { schema?: boolean; worktree?: boolean; fork?: boolean; interrupt?: boolean; setModel?: boolean } = {},
  ): ProviderId {
    if (options.account !== undefined) throw new AccountsRetired();
    const provider = this.deps.runtime.driverFor(requested).manifest.id;
    const has = new Set(this.deps.runtime.providers.capabilities(provider));
    const need = (capability: ProviderCapability, asked: boolean, what: string): void => {
      if (asked && !has.has(capability)) throw new CapabilityRefusal(provider, capability, what);
    };
    need('structuredOutput', asks.schema === true, 'A JSON schema');
    need('interrupt', asks.interrupt === true, 'An interrupt');
    need('setModel', asks.setModel === true, 'Switching the model');
    need('worktreeFlag', asks.worktree === true, 'A worktree');
    need('budgetLimit', options.maxBudgetUsd !== undefined, 'A budget');
    need('interactivePermissions', options.permissionPrompts === 'host', 'Host prompts');
    need('fork', asks.fork === true, 'A fork');
    return provider;
  }

  /**
   * Starts a new chat. `onStart` hears of it in the same tick the process is spawned, before any of
   * its output can arrive: for a caller that has to tie the chat to something before it answers.
   */
  async create(
    request: NewChatRequest & Pick<NewChat, 'agent' | 'agentsFile' | 'systemPromptSnapshot' | 'uploads' | 'keepAlive' | 'confine'> & { policy?: ToolPolicy },
    onStart?: (chat: ChatRuntime) => void,
  ): Promise<ChatSummary> {
    // Refused before anything is resolved or spawned: no driver is a 400, and so is a gate
    const provider = this.gate(request.provider, request, { schema: request.jsonSchema !== undefined && request.jsonSchema !== null, worktree: request.worktree !== undefined });
    // `--agents` reads the file it is given: only the definitions the flow writes, never a path a
    // request body names, since the API hands its body here as it came
    if (request.agentsFile !== undefined && dirname(resolve(request.agentsFile)) !== resolve(this.deps.config.dataDir, 'flow-agents')) {
      throw new Error('agentsFile is not a file Agentry wrote');
    }
    // For the same reason, each value of a confinement becomes a flag's argument only in its known shape
    if (request.confine !== undefined && !confinementShape(request.confine)) throw new Error('confine is not a set of tool names and setting sources');
    // `toolPreset: null` is how a request says it wants no preset, the default included
    const fallback = request.toolPreset === undefined && request.allowedTools === undefined ? this.deps.tools.presets.defaultPreset() : null;
    const picked = fallback ? { ...request, toolPreset: fallback.id } : request;
    const chosen = await this.deps.tools.resolve(picked, resolve(request.cwd ?? this.deps.config.workspaceDir), null);
    // What the request asked for is checked above and by the runtime's refusals; past that, a failure
    // is the server's, and answers as one
    let started: ChatRuntime;
    try {
      // Automated work states its policy beside the rules: a move translates it for the next provider
      const toolConfig: ChatToolConfig | undefined = request.policy
        ? { ...(chosen?.toolConfig ?? { preset: null, allowedTools: request.allowedTools ?? [], disallowedTools: request.disallowedTools ?? [], mcp: null }), policy: request.policy }
        : undefined;
      started = this.deps.runtime.start({ ...request, ...chosen, ...(toolConfig ? { toolConfig } : {}), provider });
      onStart?.(started);
    } catch (err) {
      throw startFailure(err);
    }
    return this.require(started.id);
  }

  /**
   * Sends a live chat a nudge: the text reaches the worker as its next user message, with no more
   * ceremony than that. It is for a chat whose process is up; anything else would start one, which
   * is what a message to a resumable chat is for, and a person should choose that knowing it.
   */
  async hint(id: string, request: HintRequest): Promise<ChatSummary> {
    const text = request?.text?.trim();
    if (!text) throw new Error('text is required');
    const runtime = this.deps.runtime.get(id);
    if (!runtime) throw new Error('chat not found');
    if (runtime.pid === null) throw new ChatConflictError('The chat has no live process to nudge. Send it a message to continue it.', null);
    this.deps.runtime.send(id, `A hint from the person following this chat:\n\n${text}`);
    return this.require(id);
  }

  /**
   * Stops one command a chat is running without ending its turn: the command's process tree is
   * killed, the CLI hands the worker a failed result for that call, and the worker goes on. The worker
   * is told a person did it, since a bare exit status looks like the command's own crash.
   */
  async cancelCommand(id: string, toolUseId: string, request: CancelCommandRequest = {}): Promise<CancelCommandResult> {
    if (!this.deps.runtime.get(id)) throw new Error('chat not found');
    let cancelled: { command: string; processes: number };
    try {
      cancelled = this.deps.runtime.cancelCommand(id, toolUseId);
    } catch (err) {
      throw new ChatConflictError(err instanceof Error ? err.message : String(err), null);
    }
    const reason = request?.reason?.trim();
    this.deps.runtime.notice(id, `A person cancelled the command \`${cancelled.command.slice(0, 120)}\`${reason ? `: ${reason}` : '.'}`, { toolUseId });
    try {
      this.deps.runtime.send(
        id,
        `A person cancelled the command \`${cancelled.command.slice(0, 200)}\` while it was running${reason ? `: ${reason}` : '.'} It did not fail by itself.`,
      );
    } catch {
      // the process went with it: there is nobody left to tell
    }
    return { toolUseId, command: cancelled.command, processes: cancelled.processes };
  }

  /**
   * Continues a chat in place. Whether that may be done is decided here, now, from a fresh read of
   * what holds the session — the CLI's own list and the process table — and not from what a client
   * last saw: a chat a terminal opened a second ago is closed to this, and one nobody holds any
   * more, even if it was born in a terminal, is adopted.
   */
  async resume(id: string, request: ResumeChatRequest, extras: ExecutionExtras = {}): Promise<ChatSummary> {
    const chat = await this.summaryOf(id, true);
    if (!chat) throw new Error('chat not found');
    if (chat.origin === 'internal') throw new ChatConflictError('This chat is housekeeping and keeps no transcript to resume.', null);
    if (chat.control.mode === 'readOnly') throw new ChatConflictError(chat.control.reason, chat.control.action);
    if (chat.control.mode === 'interactive') throw new ChatConflictError('This chat already has a live execution: send it a message instead.', null);
    const provider = this.gate(this.deps.runtime.get(id)?.provider ?? request.provider, request, { schema: extras.jsonSchema !== undefined && extras.jsonSchema !== null });
    const adoption = await this.adoptionOf(chat);
    // A person continuing a chat a member ran gets a chat again: none of the run's rules, and the
    // tools a new chat would get, since the member's allow list is not theirs to inherit
    const handBack = !extras.agent && (this.deps.memberChat?.(id) ?? false);
    const fallback = handBack && request.toolPreset === undefined && request.allowedTools === undefined ? this.deps.tools.presets.defaultPreset() : null;
    const picked = fallback ? { ...request, toolPreset: fallback.id } : request;
    const chosen = await this.deps.tools.resolve(picked, adoption.cwd, handBack ? null : (this.deps.runtime.get(id)?.tools ?? null));
    this.deps.runtime.resume(
      id,
      {
        ...request,
        ...chosen,
        provider,
        agent: extras.agent ?? null,
        agentsFile: extras.agentsFile ?? null,
        jsonSchema: extras.jsonSchema ?? null,
        systemPromptSnapshot: extras.systemPromptSnapshot ?? null,
        uploads: extras.uploads ?? null,
        confine: extras.confine ?? null,
        ...(extras.keepAlive !== undefined ? { keepAlive: extras.keepAlive } : {}),
        ...(handBack ? { handBack } : {}),
      },
      adoption,
    );
    return this.require(id);
  }

  /**
   * Continues a chat in a copy, which is a new chat that records where it came from. The copy runs
   * with the source's tools and servers unless the request picks others: it carries on the same
   * work, and a fork that quietly gained tools the source was denied would be a way around them.
   * The rules of a flow or assistant run were never the person's, though: a copy of such a chat is
   * handed back as `resume` hands it back, with the mode and tools a new chat gets.
   */
  async fork(id: string, request: ForkChatRequest): Promise<ChatSummary> {
    const chat = await this.summaryOf(id);
    if (!chat) throw new Error('chat not found');
    if (chat.origin === 'internal') throw new ChatConflictError('This chat is housekeeping and keeps no transcript to fork.', null);
    const provider = this.gate(this.deps.runtime.get(id)?.provider ?? request.provider, request, { fork: true });
    const adoption = await this.adoptionOf(chat);
    const handBack = this.deps.memberChat?.(id) ?? false;
    const fallback = handBack && request.toolPreset === undefined && request.allowedTools === undefined ? this.deps.tools.presets.defaultPreset() : null;
    const picked = fallback ? { ...request, toolPreset: fallback.id } : request;
    const chosen = handBack
      ? await this.deps.tools.resolve(picked, adoption.cwd, null)
      : await this.deps.tools.resolve(request, adoption.cwd, this.deps.runtime.get(id)?.tools ?? null, { fresh: true });
    const forked = this.deps.runtime.fork(id, { ...request, ...chosen, provider, ...(handBack ? { handBack } : {}) }, adoption);
    return this.require(forked.id);
  }

  // ---------- moving a chat to another provider ----------

  private moveDeps(): ChatMoveDeps {
    const move = this.deps.move;
    if (!move) throw new MoveRefusal('moving a chat between providers is not available here');
    return move;
  }

  /** The chats this one continues, nearest first: the providers it already left and how many moves it made. */
  private chainOf(id: string): { left: ProviderId[]; moves: number } {
    const left: ProviderId[] = [];
    const seen = new Set<string>([id]);
    for (let link = this.deps.runtime.get(id)?.continuedFrom; link && !seen.has(link.chatId); link = this.deps.runtime.get(link.chatId)?.continuedFrom) {
      seen.add(link.chatId);
      left.push(link.provider);
    }
    return { left, moves: left.length };
  }

  /** What the registry, the detector and the limits say of every provider, in the shape the candidates read. */
  private candidateProviders(deps: ChatMoveDeps): Record<ProviderId, CandidateProvider | undefined> {
    const { providers: registry, limits } = this.deps.runtime;
    const statuses = deps.statuses();
    const out: Record<ProviderId, CandidateProvider | undefined> = {};
    for (const manifest of registry.list()) {
      const status = statuses.find((s) => s.id === manifest.id);
      if (!status) continue;
      const driver = registry.driverFor(manifest.id);
      // This process saw the newest reading; the detector's copy may be a poll behind
      const limit = limits.get(manifest.id) ?? status.limit ?? null;
      out[manifest.id] = {
        status: { ...status, limit },
        hasDriver: driver !== null,
        capabilities: registry.capabilities(manifest.id),
        translate: driver ? (policy) => driver.translatePolicy(policy) : null,
        models: driver?.models() ?? [],
      };
    }
    return out;
  }

  /** What a chat needs of the provider that continues it, read from the chat and from the work behind it. */
  private needsOf(id: string, work: ChatWork | null): { needs: RunNeeds; tools: ChatToolConfig | null } {
    const runtime = this.deps.runtime.get(id);
    if (!runtime) throw new Error('chat not found');
    const tools = runtime.tools ?? null;
    const provider = runtime.provider ?? LEGACY_PROVIDER;
    const capabilities: ProviderCapability[] = [...(work?.needs ?? [])];
    if (this.deps.runtime.heldToSchema(id)) capabilities.push('structuredOutput');
    if (runtime.executions.some((e) => e.maxBudgetUsd !== null)) capabilities.push('budgetLimit');
    if (runtime.permissionPrompts === 'host') capabilities.push('interactivePermissions');
    const policy = tools?.policy ?? null;
    const { moves, left } = this.chainOf(id);
    return {
      tools,
      needs: {
        kind: work?.kind ?? 'chat',
        from: { provider, model: runtime.model },
        model: runtime.model ? { provider, id: runtime.model, names: this.deps.runtime.providers.driverFor(provider)?.modelNames?.(runtime.model) ?? [runtime.model] } : null,
        needs: [...new Set(capabilities)],
        policy,
        nativeRules: policy === null && ((tools?.allowedTools.length ?? 0) > 0 || (tools?.disallowedTools.length ?? 0) > 0),
        automated: work !== null,
        exclude: left,
        moves,
      },
    };
  }

  /**
   * Which providers can take the chat's work from where it stands, and why each of the others cannot:
   * what the limit banner and the move sheet list. The same function starting work uses.
   */
  candidates(id: string): CandidateResult {
    const deps = this.moveDeps();
    const runtime = this.deps.runtime.get(id);
    if (!runtime) throw new Error('chat not found');
    const work = deps.work?.(id) ?? null;
    const { needs } = this.needsOf(id, work);
    const project = this.deps.place(runtime.workingDir, null).project;
    return candidatesFor(needs, {
      settings: deps.settings(),
      project: project ? deps.projectProviders(project.id) : null,
      providers: this.candidateProviders(deps),
      now: Date.now(),
    });
  }

  /** Every entry of a chat's transcript, the main thread only, oldest first. */
  private async mainEntriesOf(id: string): Promise<TranscriptEntry[]> {
    const pages: TranscriptEntry[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = await this.fromStores(id, (store, key) => store.page(key, { limit: TRANSCRIPT_PAGE_MAX, ...(before !== undefined ? { before } : {}) }));
      if (!page) return pages.length > 0 ? pages.flat() : (this.deps.runtime.messages(id) ?? []).filter((e) => !e.isSidechain);
      pages.unshift(page.entries);
      if (page.from === 0 || page.entries.length === 0) return pages.flat();
      before = page.from;
    }
  }

  /** The handoff for moving `id` to `provider`: built by code from the transcript and the worktree's git state. */
  private async buildHandoffFor(id: string, provider: ProviderId, work: ChatWork | null): Promise<ReturnType<typeof buildHandoff>> {
    const runtime = this.deps.runtime.get(id);
    if (!runtime) throw new Error('chat not found');
    const entries = await this.mainEntriesOf(id);
    const steps = editStepsOf(editStepsFromEntries(entries), { root: runtime.workingDir, running: false });
    const results = new Map<string, { isError: boolean; content: string }>();
    for (const entry of entries) {
      for (const block of entry.blocks) if (block.type === 'tool_result') results.set(block.toolUseId, { isError: block.isError, content: block.content });
    }
    const commands: Array<{ command: string; exitCode: number | null }> = [];
    let checklist: Array<{ text: string; done: boolean }> = [];
    let lastMessage: string | null = null;
    for (const entry of entries) {
      for (const block of entry.blocks) {
        if (block.type === 'text' && entry.role === 'assistant' && block.text.trim()) lastMessage = block.text.trim();
        if (block.type !== 'tool_use' || typeof block.input !== 'object' || block.input === null) continue;
        const input = block.input as Record<string, unknown>;
        if (typeof input.command === 'string') {
          const result = results.get(block.id);
          const code = result?.isError ? Number(/Exit code (\d+)/.exec(result.content)?.[1] ?? 1) : result ? 0 : null;
          commands.push({ command: input.command, exitCode: code });
        } else if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
          checklist = input.todos.flatMap((todo): Array<{ text: string; done: boolean }> => {
            const item = todo as { content?: unknown; status?: unknown };
            return typeof item.content === 'string' ? [{ text: item.content, done: item.status === 'completed' }] : [];
          });
        }
      }
    }
    const git = (args: string[]): string | null => {
      try {
        return gitRaw(runtime.workingDir, args, { timeout: 15_000 });
      } catch {
        return null;
      }
    };
    return buildHandoff({
      prompt: work?.prompt ?? runtime.prompt,
      steps: steps.map((s): Pick<EditStep, 'path' | 'tool' | 'additions' | 'deletions' | 'created' | 'intent'> => ({ path: s.path, tool: s.tool, additions: s.additions, deletions: s.deletions, created: s.created, intent: s.intent })),
      commands,
      checklist,
      gitStatus: git(['status', '--porcelain', '--untracked-files=all']),
      gitDiffStat: git(['diff', '--stat']),
      lastMessage,
      openItems: [...(work?.openItems ?? []), ...checklist.filter((c) => !c.done).map((c) => c.text)],
      closing: work?.closing ?? null,
      agent: work?.agent ?? null,
      target: { subagents: this.deps.runtime.providers.capabilities(provider).includes('subagents') },
    });
  }

  /** The candidate that would take the chat on `provider`, or the reason it cannot. */
  private targetFor(id: string, provider: ProviderId, model?: string): CandidateResult['candidates'][number] {
    const result = this.candidates(id);
    const found = result.candidates.find((c) => c.provider === provider);
    if (!found) {
      const why = result.movesCapped ? 'the work has made all the moves it may' : (result.excluded.find((e) => e.provider === provider)?.excluded ?? 'not-in-order');
      throw new MoveRefusal(`${provider} cannot take this chat: ${why}`);
    }
    if (!model) return found;
    const catalog = this.deps.runtime.providers.driverFor(provider)?.models() ?? [];
    if (catalog.length > 0 && !catalog.some((m) => m.value === model && !m.disabled)) throw new MoveRefusal(`${provider} does not offer the model ${model}`);
    return { ...found, model };
  }

  /** The handoff text exactly as `move` would send it, built locally and sent nowhere. */
  async handoff(id: string, provider: ProviderId, model?: string): Promise<HandoffPreview> {
    const deps = this.moveDeps();
    const target = this.targetFor(id, provider, model);
    const built = await this.buildHandoffFor(id, provider, deps.work?.(id) ?? null);
    return { text: built.text, bytes: built.bytes, provider, model: target.model, sections: built.sections };
  }

  /**
   * Moves a chat to a new chat on another provider, linked both ways (decision P4-1). A handoff
   * starts the new chat from the record of what was done; a restart, from the original prompt. The
   * move is a row, and the run, task or item the chat works for is re-pointed by whoever called.
   */
  async continueOn(id: string, request: MoveChatRequest, origin: MoveOrigin = { decidedBy: 'person' }): Promise<{ chat: ChatSummary; move: ProviderMove }> {
    const deps = this.moveDeps();
    const runtime = this.deps.runtime.get(id);
    if (!runtime) throw new Error('chat not found');
    if (runtime.continuedIn) throw new MoveRefusal('this chat was already continued on another provider');
    // A live chat that has not reached its limit is working: moving it would throw away a running turn
    if (runtime.pid !== null && !this.deps.runtime.atLimit(id)) throw new MoveRefusal('this chat is working and has not reached a limit');
    const work = deps.work?.(id) ?? null;
    const target = this.targetFor(id, request.provider, request.model);
    const driver = this.deps.runtime.driverFor(request.provider);
    const capabilities = this.deps.runtime.providers.capabilities(request.provider);

    const handoff = request.action === 'handoff' ? await this.buildHandoffFor(id, request.provider, work) : null;
    // Where the target cannot take the agent file as a subagent its prompt leads a restart's first turn
    const agentLead = request.action === 'restart' && work?.agent && !capabilities.includes('subagents') ? `${work.agent.prompt.trim()}\n\n` : '';
    const prompt = handoff?.text ?? `${agentLead}${work?.prompt ?? runtime.prompt}`;

    const { tools } = this.needsOf(id, work);
    const rules = tools?.policy ? rulesOnDriver(driver, request.provider, tools.policy) : null;
    const mcp = capabilities.includes('mcp') ? (tools?.mcp ?? null) : null;
    const toolConfig: ChatToolConfig | null =
      rules || mcp ? { preset: tools?.preset ?? null, allowedTools: rules?.allowedTools ?? [], disallowedTools: rules?.disallowedTools ?? [], mcp, ...(tools?.policy ? { policy: tools.policy } : {}) } : null;

    // Never a more permissive mode than the chat had: one the target does not list becomes `manual`
    const permissionMode = driver.permissionModes().some((m) => m.mode === runtime.permissionMode) ? runtime.permissionMode : 'manual';
    const budgets = runtime.executions.map((e) => e.maxBudgetUsd).filter((b): b is number => b !== null);
    const spent = runtime.executions.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    const remaining = work?.remainingBudgetUsd ?? (budgets.length ? Math.max(0, Math.max(...budgets) - spent) : null);

    const moveId = randomUUID();
    const started = await this.deps.runtime.continueOn(id, {
      provider: request.provider,
      model: target.model,
      effort: target.effort,
      permissionMode,
      prompt,
      action: request.action,
      moveId,
      toolConfig,
      ...(typeof remaining === 'number' ? { maxBudgetUsd: remaining } : {}),
    });
    const at = new Date().toISOString();
    const move: ProviderMove = {
      id: moveId,
      at,
      subjectKind: work?.subjectKind ?? 'chat',
      subjectId: work?.subjectId ?? id,
      projectId: this.deps.place(runtime.workingDir, null).project?.id ?? null,
      fromChat: id,
      toChat: started.id,
      fromProvider: runtime.provider ?? LEGACY_PROVIDER,
      toProvider: request.provider,
      fromModel: runtime.model,
      toModel: target.model,
      action: request.action,
      state: 'moved',
      decidedBy: origin.decidedBy,
      decisionId: origin.decisionId ?? null,
      resetsAt: origin.resetsAt ?? null,
      reason: origin.reason ?? null,
      updatedAt: at,
    };
    deps.moves.insertProviderMove(move);
    const label = this.deps.runtime.providers.list().find((m) => m.id === request.provider)?.label ?? request.provider;
    this.deps.runtime.bus?.emit({
      type: 'run.providerMoved',
      title: `${runtime.name} moved to ${label}`,
      ...runRef(runtime),
      from: move.fromProvider,
      to: request.provider,
      action: request.action,
      decidedBy: origin.decidedBy,
    });
    return { chat: await this.require(started.id), move };
  }

  /**
   * Where the CLI has to be started to find the session: the directory it began in, which is where
   * its transcript is filed, not the worktree it may have moved into since.
   */
  private async adoptionOf(chat: ChatSummary): Promise<AdoptedChat> {
    const transcript = await this.deps.sessions.summary(chat.id).catch(() => null);
    return { cwd: this.deps.runtime.get(chat.id)?.cwd ?? transcript?.projectPath ?? chat.cwd, name: chat.title.slice(0, 60), model: chat.model };
  }

  /** A message to a chat with a live execution. */
  async send(id: string, request: ChatMessageRequest): Promise<ChatSummary> {
    const chat = await this.summaryOf(id);
    if (!chat) throw new Error('chat not found');
    if (chat.control.mode !== 'interactive') {
      throw new ChatConflictError(chat.control.mode === 'readOnly' ? chat.control.reason : 'This chat has no live execution: resume it to continue.', chat.control.mode === 'readOnly' ? chat.control.action : null);
    }
    this.deps.runtime.send(id, request.text ?? '', request.attachments ?? []);
    return this.require(id);
  }

  /**
   * Stops what is working on a chat: the execution Agentry runs, or, for a session the CLI itself
   * holds in the background, the CLI's own `stop`, which keeps the conversation resumable.
   */
  async stop(id: string): Promise<ChatSummary> {
    const runtime = this.deps.runtime.get(id);
    if (runtime && (runtime.pid !== null || this.deps.runtime.strays().some((s) => s.chatId === id))) {
      this.deps.runtime.stop(id);
    } else {
      const cli = (await this.cliSessions(true)).find((c) => c.sessionId === id && c.live);
      if (!cli) throw new Error('nothing is running on this chat');
      await stopBackgroundSession(this.deps.config, id);
      this.forgetHolders();
    }
    return this.require(id);
  }

  async interrupt(id: string): Promise<ChatSummary> {
    this.gate(this.deps.runtime.get(id)?.provider, {}, { interrupt: true });
    await this.deps.runtime.interrupt(id);
    return this.require(id);
  }

  async updateSettings(id: string, update: ChatSettingsUpdate): Promise<ChatSummary> {
    if (update.model !== undefined) this.gate(this.deps.runtime.get(id)?.provider, {}, { setModel: true });
    await this.deps.runtime.updateSettings(id, update);
    return this.require(id);
  }

  /** Deletes the chat: its transcript and sidecar files, and Agentry's record of it. */
  async remove(id: string): Promise<void> {
    if (!(await this.summaryOf(id, true))) throw new Error('chat not found');
    if (await this.liveIn(id)) throw new ChatConflictError('Something is running on this chat: stop it before deleting.', null);
    // Only Claude's transcript is Agentry's to delete: another vendor's history stays where its
    // CLI keeps it, and Agentry's own rows go with the chat's record
    if ((this.deps.runtime.get(id)?.provider ?? LEGACY_PROVIDER) === LEGACY_PROVIDER) {
      await this.deps.sessions.deleteSession(id).catch((err: unknown) => {
        // A chat that never wrote a transcript has only Agentry's record to delete
        if (!(err instanceof Error && /not found/.test(err.message))) throw err;
      });
    }
    this.deps.runtime.remove(id);
  }

  /** Terminal output of a background session, which only the CLI itself keeps. */
  logs(id: string): Promise<string> {
    return backgroundLogs(this.deps.config, id);
  }

  private async require(id: string): Promise<ChatSummary> {
    const chat = await this.summaryOf(id);
    if (!chat) throw new Error('chat not found');
    return chat;
  }

  // ---------- live stream ----------

  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    return this.deps.runtime.subscribe(id, listener);
  }

  events(id: string, sinceSeq = 0): RunEvent[] {
    return this.deps.runtime.events(id, sinceSeq);
  }

  /** Whether Agentry has a live stream for the chat to follow. */
  streams(id: string): boolean {
    return this.deps.runtime.get(id) !== null;
  }

  // ---------- branches ----------

  /**
   * What a chat delegated. A chat Agentry has a process on reports from its live stream: the
   * freshest, and the only source for one whose transcript is not kept. Everything else comes from
   * the files the CLI writes beside the transcript, which is also what shows a chat started from a
   * terminal, whose stream Agentry never sees, and one that ended, whose in-memory lists a restart
   * empties. `live` says whether something is still around for its work to be running in.
   *
   * A live chat's workflows need both: the stream only has the runs of its current process, under
   * the task id, while the files have the runs of earlier ones and the `wf_…` id an agent's
   * transcript is filed under.
   */
  private async branchFacts(id: string, runtime: ChatRuntime | null, live: boolean): Promise<BranchFacts> {
    if (runtime && runtime.pid !== null) {
      const needsOwners = runtime.backgroundTasks.some((t) => t.fromSubagent && !t.ownerAgentId);
      const [owners, onDisk] = await Promise.all([
        needsOwners ? this.deps.sessions.taskOwners(id) : null,
        this.deps.sessions.workflows(id, false).catch(() => []),
      ]);
      return {
        subagents: runtime.subagents,
        workflows: mergeLiveWorkflows(runtime.workflows, onDisk, runtime.processStartedAt ?? null),
        // Only a subagent's own transcript says which subagent launched a task
        tasks: runtime.backgroundTasks.map((t) => {
          const owner = t.ownerAgentId ?? (t.fromSubagent ? owners?.get(t.id) : undefined);
          return { ...t, sessionId: t.sessionId ?? id, ...(owner ? { ownerAgentId: owner } : {}) };
        }),
      };
    }
    const { sessions } = this.deps;
    const [subagents, tasks, workflows] = await Promise.all([
      sessions.subagents(id, live).catch(() => []),
      sessions.backgroundTasks(id, live).catch(() => []),
      sessions.workflows(id, live).catch(() => []),
    ]);
    return { subagents, tasks, workflows };
  }

  private async liveIn(id: string): Promise<boolean> {
    if (this.deps.runtime.get(id)?.pid != null) return true;
    return (await this.cliSessions()).some((c) => c.sessionId === id && c.live);
  }

  async subagents(id: string): Promise<ChatSubagentEntry[]> {
    return (await this.entriesOf([id])).subagents;
  }

  async backgroundTasks(id: string): Promise<ChatBackgroundTaskEntry[]> {
    return (await this.entriesOf([id])).tasks;
  }

  async workflows(id: string): Promise<ChatWorkflowEntry[]> {
    return (await this.entriesOf([id])).workflows;
  }

  private async entriesOf(ids: string[]) {
    // Gathered once for every chat: each would otherwise read the CLI's list and the process table
    const facts = await this.facts(false, false);
    const per = await Promise.all(
      ids.map(async (id) => {
        const runtime = this.deps.runtime.get(id);
        const ref = await this.refOf(id, facts);
        if (!ref) throw new Error('chat not found');
        const children = toChildren(await this.branchFacts(id, runtime, await this.liveIn(id)), id);
        return { ref, children };
      }),
    );
    const byRunning = (a: { status: string; startedAt: string }, b: { status: string; startedAt: string }) =>
      Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt);
    return {
      subagents: per.flatMap(({ ref, children }) => children.subagents.map((s) => ({ ...s, chat: ref }))).sort(byRunning),
      // A command a subagent launched is listed under the subagent too; the inbox wants every one of them
      tasks: per
        .flatMap(({ ref, children }) => [...children.backgroundTasks, ...children.subagents.flatMap((s) => s.tasks)].map((t) => ({ ...t, chat: ref })))
        .sort(byRunning),
      workflows: per.flatMap(({ ref, children }) => children.workflows.map((w) => ({ ...w, chat: ref }))).sort(byRunning),
    };
  }

  private async refOf(id: string, facts: Facts): Promise<ChatRef | null> {
    const chat = await this.summaryWith(id, facts);
    return chat ? { id: chat.id, title: chat.title, firstPrompt: chat.firstPrompt, project: chat.project, cwd: chat.cwd, worktree: chat.worktree } : null;
  }

  /**
   * The chats whose delegated work is read for the aggregates: every one with a process, the
   * recently ended ones of Agentry, the terminal sessions live now and the recent ended ones of
   * those. Every list and every count reads through here, so no screen can show work another misses.
   */
  private async activityChats(): Promise<string[]> {
    const runtimes = this.deps.runtime.list();
    const ids = new Set<string>();
    for (const r of runtimes) if (r.pid !== null) ids.add(r.id);
    for (const r of runtimes.filter((x) => x.pid === null && x.origin !== 'internal').slice(0, RECENT_ENDED_CHATS)) ids.add(r.id);
    const owned = new Set(runtimes.map((r) => r.id));
    for (const c of await this.cliSessions()) if (c.live && !owned.has(c.sessionId)) ids.add(c.sessionId);
    const since = new Date(Date.now() - RECENT_ENDED_WINDOW_MS).toISOString();
    const recent = (await this.deps.sessions.listSessions()).filter((s) => !ids.has(s.id) && !owned.has(s.id) && (s.updatedAt ?? '') >= since);
    for (const s of recent.slice(0, RECENT_ENDED_EXTERNAL)) ids.add(s.id);
    return [...ids];
  }

  /** Everything every chat delegated, read in one pass for whoever needs more than one kind of it. */
  async allActivity(): Promise<{ tasks: ChatBackgroundTaskEntry[]; subagents: ChatSubagentEntry[]; workflows: ChatWorkflowEntry[] }> {
    return this.entriesOf(await this.activityChats());
  }

  /** Background commands of every chat, running ones first: the inbox sees a hung one wherever it is. */
  async allBackgroundTasks(): Promise<ChatBackgroundTaskEntry[]> {
    return (await this.allActivity()).tasks;
  }

  async allSubagents(): Promise<ChatSubagentEntry[]> {
    return (await this.allActivity()).subagents;
  }

  async allWorkflows(): Promise<ChatWorkflowEntry[]> {
    return (await this.allActivity()).workflows;
  }

  // ---------- what a chat's branches wrote ----------

  taskOutput(id: string, taskId: string, opts: { offset?: number } = {}): Promise<BackgroundTaskOutput> {
    return this.deps.sessions.taskOutput(id, taskId, opts);
  }

  /** A subagent's whole conversation; with `workflowId`, a workflow agent's. */
  async agentTranscript(id: string, agentId: string, opts: { workflowId?: string; after?: number } = {}): Promise<AgentTranscript | null> {
    return this.deps.sessions.agentTranscript(id, agentId, {
      ...(opts.workflowId !== undefined ? { runId: opts.workflowId } : {}),
      ...(opts.after !== undefined ? { after: opts.after } : {}),
      live: await this.liveIn(id),
    });
  }
}

function confinementShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { tools, settingSources } = value as Record<string, unknown>;
  return (
    Array.isArray(tools) &&
    tools.every((t) => typeof t === 'string' && /^[A-Za-z]+$/.test(t)) &&
    Array.isArray(settingSources) &&
    settingSources.every((x) => x === 'user' || x === 'project' || x === 'local')
  );
}
