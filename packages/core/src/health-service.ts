import type { ChatContext, ChatHealth, ChatState, HealthLevel, HealthSignal, HealthSignalKind, TaskLimits } from '@agentry/shared';
import { chatHealth, HUNG_COMMAND_MS, stateFromRun, type HealthFacts } from './chat-model.ts';
import type { ChatManager, ChatRuntime } from './chats.ts';
import { commandKind, usualDuration, type UsualDuration } from './commands.ts';
import type { Db } from './db.ts';
import { runRef } from './event-sources.ts';
import type { AgentryEventInput } from './events.ts';
import { git, headCommit, isGitRepo } from './git.ts';
import { HEALTH_REASONS } from './health-strings.ts';
import { budget, lastFileChangeAt, loop, noProgress, repeatStall, runningCommands, weakenedTests } from './health.ts';

/** What a chat's health needs beyond what its process shows: the parts only the chat service knows. */
export interface HealthBase {
  state: ChatState;
  lastEnded: HealthFacts['lastEnded'];
  context: ChatContext | null;
  failedBranches: number;
  /** For a task of an orchestration: what it may spend, and what it has spent */
  limits?: TaskLimits | null;
  taskElapsedMs?: number;
  taskSpentUsd?: number;
}

/** How long the state of a worktree is trusted between reads: `git status` is an exec, and a UI polls. */
const FINGERPRINT_TTL_MS = 10_000;

/**
 * The health of chats that have a process of Agentry's: the signals of `chat-model.ts` and
 * `health.ts`, fed with what the runtime has seen (the calls, the heartbeats), the history of how
 * long commands take, and what the worktree shows. Reading it changes nothing beyond a small cache,
 * so a UI polling for it and the monitor watching for it agree.
 */
export class HealthService {
  /** What a worktree looked like when last read, and since when it has looked like that */
  private readonly worktrees = new Map<string, { execution: string; fingerprint: string; changedAt: string; checkedAt: number }>();
  private readonly repos = new Map<string, boolean>();

  constructor(
    private readonly runtime: ChatManager,
    private readonly db: Db,
  ) {}

  /** What a kind of command usually takes here, from the runs that ended well; null while there is no history to say. */
  usualOf(kind: string): UsualDuration | null {
    try {
      return usualDuration(this.db.commandRuns(kind, 100).filter((r) => r.outcome === 'ok').map((r) => r.durationMs));
    } catch {
      return null;
    }
  }

  /**
   * A fingerprint of the working directory's state: the commit it is on, what is changed and by how
   * much. Null where it is not a git checkout, which leaves the files the worker wrote as the only
   * sign of progress.
   */
  private fingerprint(dir: string): string | null {
    let repo = this.repos.get(dir);
    if (repo === undefined) {
      repo = isGitRepo(dir);
      this.repos.set(dir, repo);
    }
    if (!repo) return null;
    try {
      return [headCommit(dir), git(dir, ['status', '--porcelain'], 10_000), git(dir, ['diff', 'HEAD', '--numstat'], 10_000)].join('\n');
    } catch {
      return null;
    }
  }

  /** The last time anything moved in the worker's checkout, or the start of the execution while nothing has. */
  private progressAt(chat: ChatRuntime, executionStartedAt: string, nowMs: number): string {
    const entry = this.worktrees.get(chat.id);
    if (entry && entry.execution === executionStartedAt && nowMs - entry.checkedAt < FINGERPRINT_TTL_MS) return entry.changedAt;
    const fingerprint = this.fingerprint(chat.workingDir);
    if (fingerprint === null) return executionStartedAt;
    if (!entry || entry.execution !== executionStartedAt) {
      this.worktrees.set(chat.id, { execution: executionStartedAt, fingerprint, changedAt: executionStartedAt, checkedAt: nowMs });
      return executionStartedAt;
    }
    if (entry.fingerprint !== fingerprint) Object.assign(entry, { fingerprint, changedAt: new Date(nowMs).toISOString() });
    entry.checkedAt = nowMs;
    return entry.changedAt;
  }

  forget(id: string): void {
    this.worktrees.delete(id);
  }

  /** The chat's health at a moment; the clock is a parameter because what it measures is a stretch of time. */
  read(id: string, base: HealthBase, nowMs = Date.now()): ChatHealth {
    const chat = this.runtime.get(id);
    const trace = this.runtime.trace(id);
    const facts: HealthFacts = {
      state: base.state,
      live: null,
      lastEnded: base.lastEnded,
      context: base.context,
      failedBranches: base.failedBranches,
    };
    if (!chat || !trace) return chatHealth(facts, nowMs);

    const usual = new Map<string, UsualDuration | null>();
    const usualOf = (kind: string): UsualDuration | null => {
      if (!usual.has(kind)) usual.set(kind, this.usualOf(kind));
      return usual.get(kind) ?? null;
    };
    facts.live = {
      lastEventAt: trace.lastEventAt,
      commands: runningCommands(trace).map((call) => {
        const command = typeof call.input.command === 'string' ? call.input.command : 'a command';
        const heartbeat = trace.heartbeats.get(call.id);
        return { command, startedAt: call.at, toolUseId: call.id, usual: usualOf(commandKind(command)), ...(heartbeat ? { heartbeat } : {}) };
      }),
    };

    const busy: Array<HealthSignal | null> = [repeatStall(trace, { fallbackMs: HUNG_COMMAND_MS, usualOf }, nowMs), loop(trace)];
    // Progress is only asked of a chat that is working: one waiting for a person is not slow
    if (base.state === 'working') {
      const written = lastFileChangeAt(trace);
      const moved = this.progressAt(chat, trace.executionStartedAt, nowMs);
      busy.push(noProgress(written && written > moved ? written : moved, nowMs));
    }
    facts.extra = busy.filter((s): s is HealthSignal => s !== null);
    // What a worker did to its tests, and how much of its allowance is left, stay true while it waits
    facts.standing = [
      ...weakenedTests(trace),
      ...(base.limits ? [budget(base.limits, { elapsedMs: base.taskElapsedMs ?? 0, costUsd: base.taskSpentUsd ?? 0 })] : []),
    ].filter((s): s is HealthSignal => s !== null);
    return chatHealth(facts, nowMs);
  }
}

// ---------- telling the feed ----------

/** The signals that say a worker is stuck or off track; the rest of a chat's health is the chat's own news. */
const STUCK: ReadonlySet<HealthSignalKind> = new Set(['hung-command', 'repeat-stall', 'no-progress', 'loop', 'weakened-test', 'silence', 'budget']);

/** What the monitor needs to know about a chat that only the orchestrator does. */
export interface TaskContext {
  taskId: string;
  taskName: string;
  limits: TaskLimits | null;
  /** How long the task has been running against its time limit */
  elapsedMs: number;
  /** What it has spent against its cost limit */
  spentUsd: number;
}

export interface HealthMonitorDeps {
  runtime: ChatManager;
  health: HealthService;
  emit: (event: AgentryEventInput) => void;
  /** The task a chat works for, when it is a worker of a graph */
  taskOf: (chat: ChatRuntime) => TaskContext | null;
}

/**
 * Watches every chat that has a process of ours and announces when one starts to look stuck, when
 * how stuck it looks changes, and when it recovers: one event each time, never one per check. The
 * notification centre turns the first into news. A chat is only judged on the signals of being
 * stuck; its other facts (the context filling, a failed branch) have events of their own.
 */
export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  /** What was last announced per chat; a chat with nothing announced is `ok` */
  private readonly announced = new Map<string, { level: HealthLevel; key: string }>();

  constructor(
    private readonly deps: HealthMonitorDeps,
    private readonly intervalMs = Number(process.env.AGENTRY_HEALTH_INTERVAL_MS ?? 15_000),
  ) {}

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the chats; exposed so that a test can drive it with a clock of its own. */
  check(nowMs = Date.now()): void {
    const live = new Set<string>();
    for (const chat of this.deps.runtime.list()) {
      if (chat.pid === null || (chat.status !== 'busy' && chat.status !== 'starting' && chat.pendingPrompts === 0)) continue;
      live.add(chat.id);
      const task = this.deps.taskOf(chat);
      const health = this.deps.health.read(
        chat.id,
        {
          state: stateFromRun({ status: chat.status, pendingPrompts: chat.pendingPrompts }),
          lastEnded: null,
          context: null,
          failedBranches: 0,
          ...(task ? { limits: task.limits, taskElapsedMs: task.elapsedMs, taskSpentUsd: task.spentUsd } : {}),
        },
        nowMs,
      );
      this.announce(chat, task, health.signals.filter((s) => STUCK.has(s.kind)));
    }
    // A chat whose process is gone is not stuck any more: say so once, so a badge does not stay lit
    for (const id of [...this.announced.keys()]) {
      if (live.has(id)) continue;
      const chat = this.deps.runtime.get(id);
      if (chat) this.announce(chat, this.deps.taskOf(chat), []);
      this.announced.delete(id);
      this.deps.health.forget(id);
    }
  }

  private announce(chat: ChatRuntime, task: TaskContext | null, signals: HealthSignal[]): void {
    const worst = signals[0];
    const level: HealthLevel = worst ? worst.level : 'ok';
    const key = `${level}|${signals.map((s) => `${s.kind}:${s.level}`).join(',')}`;
    const before = this.announced.get(chat.id) ?? { level: 'ok' as HealthLevel, key: 'ok|' };
    if (before.key === key) return;
    this.announced.set(chat.id, { level, key });
    const who = task?.taskName ?? chat.name;
    this.deps.emit({
      type: 'health.changed',
      title: worst ? `${who}: ${worst.reason}` : `${who} is working normally again`,
      ...runRef(chat),
      taskId: task?.taskId ?? null,
      taskName: task?.taskName ?? null,
      level,
      previousLevel: before.level,
      reason: worst?.reason ?? HEALTH_REASONS['health.ok'](),
      ...(worst?.reasonCode || !worst ? { reasonCode: worst?.reasonCode ?? 'health.ok' } : {}),
      ...(worst?.params ? { params: worst.params } : {}),
      signals: signals.map((s) => s.kind),
    });
  }
}
