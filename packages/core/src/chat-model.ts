import {
  CONTEXT_FULL,
  CONTEXT_WARN,
  type ChatContext,
  type ChatControl,
  type ChatHealth,
  type ChatOrigin,
  type ChatState,
  type Execution,
  type ExecutionOutcome,
  type HealthSignal,
  type RunStatus,
} from '@agentry/shared';

// The adapter between what the Claude Code CLI reports and Agentry's model. Everything the CLI says
// in its own words (stream statuses, `claude agents --json` fields, who has a process on a session)
// is read here and comes out as `ChatState`, `ChatControl` and `ExecutionOutcome`. Nothing beyond
// this file needs to know those words.

/** What a run of ours says about a chat it drives. */
export interface RunFacts {
  status: RunStatus;
  /** Permissions, questions and plans waiting for a person */
  pendingPrompts: number;
}

/** One entry of `claude agents --json`, reduced to what tells its state. */
export interface CliAgentFacts {
  status: string;
  state?: string;
}

/**
 * The state of a chat a run of ours drives. `starting` is half a second of work, and a run that has
 * ended is idle: how it ended is the outcome of its execution, not a state of the chat.
 */
export function stateFromRun({ status, pendingPrompts }: RunFacts): ChatState {
  if (status === 'completed' || status === 'failed' || status === 'stopped') return 'idle';
  if (pendingPrompts > 0) return 'waiting';
  return status === 'idle' ? 'idle' : 'working';
}

/**
 * The state of a chat a process the CLI itself manages holds (a terminal, a background session).
 * The CLI marks a session that needs a person as `blocked`, and one that finished as `done` while
 * its process lingers; anything it does not say is read as idle, never as work.
 */
export function stateFromCliAgent({ status, state }: CliAgentFacts): ChatState {
  if (state === 'blocked' || status === 'waiting' || status === 'blocked') return 'waiting';
  if (state === 'done') return 'idle';
  return status === 'busy' || status === 'working' || status === 'running' ? 'working' : 'idle';
}

/**
 * The state of a chat from every source that may know: a run of ours with a live process wins over
 * the CLI's own list, which only knows about processes that are not ours; with neither it is idle.
 */
export function chatState(facts: { run?: RunFacts | null; cli?: CliAgentFacts | null }): ChatState {
  if (facts.run) return stateFromRun(facts.run);
  if (facts.cli) return stateFromCliAgent(facts.cli);
  return 'idle';
}

/**
 * How an execution ended, from how its run ended. Null while the run is alive (`starting`, `busy`
 * and `idle` all mean a process is there). `restored` is a run read back after a wrapper restart:
 * a process that was alive then is gone now and nobody stopped it, which is `interrupted`.
 */
export function executionOutcome(status: RunStatus, restored = false): ExecutionOutcome | null {
  if (status === 'completed' || status === 'failed' || status === 'stopped') return status;
  return restored ? 'interrupted' : null;
}

/** Who has a process on a session right now. */
export type SessionHolder =
  /** A live process of one of our runs */
  | 'agentry'
  /** A CLI process that is not ours: a terminal, an IDE, a background session */
  | 'terminal'
  | 'nobody';

/**
 * Who holds a session, from what is known of its processes: one of ours wins, since it is the one
 * Agentry drives; a process that is not ours (the CLI's list, or the process table) holds it
 * against us; otherwise nobody does.
 */
export function sessionHolder(facts: { ownProcess: boolean; foreignProcess: boolean }): SessionHolder {
  if (facts.ownProcess) return 'agentry';
  return facts.foreignProcess ? 'terminal' : 'nobody';
}

/** What decides who may drive a chat. */
export interface ControlFacts {
  holder: SessionHolder;
  origin: ChatOrigin;
  /** For an orchestration chat: its task is still running, so the graph is waiting on its next result */
  taskRunning?: boolean;
  /** The synthesis of an orchestration: no task depends on it and it is the report, so it can be answered */
  deliverable?: boolean;
}

/**
 * What can be done with a chat now. Where it was born matters only for a chat an orchestration
 * drives: its finished result feeds tasks that already started, so it is closed for good and a
 * fork is the way forward, while a running one takes a hint from the board. The synthesis is the
 * exception: nothing follows its run, and it is the deliverable, so it is answered in place like any
 * chat. For any other chat the one question is who holds its session, which the server answers at
 * resume time.
 */
export function chatControl({ holder, origin, taskRunning = false, deliverable = false }: ControlFacts): ChatControl {
  if (origin === 'orchestration' && !deliverable) {
    return taskRunning
      ? {
          mode: 'readOnly',
          reason: 'A task of an orchestration is working on it. Send the worker a hint from the orchestration board.',
          action: 'hint',
        }
      : {
          mode: 'readOnly',
          reason: 'It belongs to a finished task of an orchestration whose other tasks used its result. Continue in a fork.',
          action: 'fork',
        };
  }
  if (holder === 'agentry') return { mode: 'interactive' };
  if (holder === 'terminal') {
    return {
      mode: 'readOnly',
      reason: 'It is open in a terminal, and two processes must not write the same conversation. Continue in a fork.',
      action: 'fork',
    };
  }
  return { mode: 'resumable' };
}

// ---------- health ----------

/**
 * A command running longer than this is worth a look, and past the second limit it is a problem: a
 * shell call carries its own timeout of at most ten minutes, so one still going after that has
 * outlived the thing that should have ended it.
 */
export const HUNG_COMMAND_MS = 3 * 60_000;
export const HUNG_COMMAND_BAD_MS = 10 * 60_000;
/** The same limits for a chat that is working and has said nothing at all. */
export const SILENCE_MS = 3 * 60_000;
export const SILENCE_BAD_MS = 10 * 60_000;

/** What health is read from. Every field is something Agentry already holds. */
export interface HealthFacts {
  state: ChatState;
  /** What Agentry's process on the chat is doing; null while there is none, which is when nothing can be silent or hung */
  live: { lastEventAt: string; commands: Array<{ command: string; startedAt: string }> } | null;
  /** How the last execution ended, when none is live now */
  lastEnded: { outcome: ExecutionOutcome; error: string | null } | null;
  context: ChatContext | null;
  failedBranches: number;
}

/**
 * How the chat's last execution ended, for whoever asks what went wrong. Null while one is live: a
 * failure a later execution has superseded is not the chat's news of now.
 */
export function lastEndedOf(executions: readonly Execution[]): HealthFacts['lastEnded'] {
  if (executions.some((e) => e.endedAt === null)) return null;
  const last = executions[executions.length - 1];
  return last?.outcome ? { outcome: last.outcome, error: last.error } : null;
}

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;
const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Whether a chat is working as it should, from the signals that can be told from what Agentry
 * receives. Worst first; a chat with none is `ok`, and says so. The clock is a parameter because a
 * hung command is a fact of the time it has been running.
 */
export function chatHealth(facts: HealthFacts, nowMs = Date.now()): ChatHealth {
  const signals: HealthSignal[] = [];
  const working = facts.state === 'working' && facts.live !== null;

  const oldest = [...(facts.live?.commands ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  if (working && oldest) {
    const age = nowMs - Date.parse(oldest.startedAt);
    if (age >= HUNG_COMMAND_MS) {
      signals.push({
        kind: 'hung-command',
        level: age >= HUNG_COMMAND_BAD_MS ? 'bad' : 'warn',
        reason: `\`${oneLine(oldest.command, 60)}\` has been running for ${minutes(age)}, past the ${minutes(HUNG_COMMAND_MS)} a command is expected to need.`,
      });
    }
  } else if (working && facts.live) {
    // A command in flight is a reason to be quiet; with none, a chat that says nothing is stalled
    const quiet = nowMs - Date.parse(facts.live.lastEventAt);
    if (quiet >= SILENCE_MS) {
      signals.push({
        kind: 'silence',
        level: quiet >= SILENCE_BAD_MS ? 'bad' : 'warn',
        reason: `Nothing has happened for ${minutes(quiet)} and no command is running: the model or an API call may be stalled.`,
      });
    }
  }

  const ended = facts.lastEnded;
  if (ended?.outcome === 'interrupted') signals.push({ kind: 'last-execution', level: 'bad', reason: 'The last execution was cut short: its process was lost.' });
  else if (ended?.outcome === 'failed') {
    signals.push({ kind: 'last-execution', level: 'bad', reason: `The last execution failed${ended.error ? `: ${ended.error}` : '.'}` });
  }
  if (facts.state === 'waiting') signals.push({ kind: 'waiting', level: 'warn', reason: 'Stopped until a person answers a permission, a question or a plan.' });
  const window = facts.context?.window ?? null;
  if (facts.context && window !== null && window > 0 && facts.context.used / window >= CONTEXT_WARN) {
    const share = facts.context.used / window;
    signals.push({
      kind: 'context',
      level: share >= CONTEXT_FULL ? 'bad' : 'warn',
      reason: `${Math.round(share * 100)}% of the context window is in use: Claude Code compacts the conversation when it fills.`,
    });
  }
  if (facts.failedBranches > 0) {
    signals.push({ kind: 'branches', level: 'warn', reason: `${facts.failedBranches} ${facts.failedBranches === 1 ? 'branch' : 'branches'} failed.` });
  }

  // Worst first; among equals the order above, which is the order of how much the clock says
  signals.sort((a, b) => Number(b.level === 'bad') - Number(a.level === 'bad'));
  const first = signals[0];
  return first ? { level: first.level, reason: first.reason, signals } : { level: 'ok', reason: 'Nothing unusual.', signals };
}
