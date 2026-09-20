import type { ChatControl, ChatOrigin, ChatState, ExecutionOutcome, RunStatus } from '@agentry/shared';

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
