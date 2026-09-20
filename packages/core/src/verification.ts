import { spawn, type ChildProcess } from 'node:child_process';
import type { Commit, VerificationSpec } from '@agentry/shared';
import { git } from './git.ts';
import { processTable, terminateTree } from './processes.ts';

export const DEFAULT_VERIFY_MINUTES = 20;
const MAX_VERIFY_MINUTES = 240;
export const DEFAULT_FIXER_ATTEMPTS = 2;
const MAX_FIXER_ATTEMPTS = 10;
const MAX_COMMANDS = 12;
const MAX_COMMAND_LENGTH = 1000;
/** What a command's output is trimmed to: enough to see why it failed, not the whole log */
export const OUTPUT_TAIL = 6000;
/** What the fixer is shown of it */
const FIXER_OUTPUT = 4000;
/** Time a command gets to stop after SIGTERM before what is left of it is killed */
const KILL_GRACE_MS = 3000;

/**
 * Checks a verification spec and fills in its defaults. Refuses what could not run instead of
 * dropping it: a check that silently is not there is a graph that reports itself verified.
 */
export function normalizeVerification(spec: VerificationSpec | null | undefined, label = 'verification'): VerificationSpec | null {
  if (spec === undefined || spec === null) return null;
  if (typeof spec !== 'object') throw new Error(`${label} must be an object`);
  if (!Array.isArray(spec.commands)) throw new Error(`${label}.commands must be a list of shell commands`);
  const commands = spec.commands.map((c) => (typeof c === 'string' ? c.trim() : ''));
  if (commands.length === 0) throw new Error(`${label}.commands needs at least one command`);
  if (commands.length > MAX_COMMANDS) throw new Error(`${label}.commands takes at most ${String(MAX_COMMANDS)} commands`);
  if (commands.some((c) => c === '')) throw new Error(`${label}.commands must not hold an empty command`);
  if (commands.some((c) => c.length > MAX_COMMAND_LENGTH)) throw new Error(`${label}.commands: a command is at most ${String(MAX_COMMAND_LENGTH)} characters`);

  const attempts = spec.maxAttempts ?? DEFAULT_FIXER_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_FIXER_ATTEMPTS) {
    throw new Error(`${label}.maxAttempts must be a whole number from 1 to ${String(MAX_FIXER_ATTEMPTS)}`);
  }
  const minutes = spec.timeoutMinutes ?? DEFAULT_VERIFY_MINUTES;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_VERIFY_MINUTES) {
    throw new Error(`${label}.timeoutMinutes must be a number of minutes from more than 0 to ${String(MAX_VERIFY_MINUTES)}`);
  }
  const model = typeof spec.model === 'string' && spec.model.trim() ? spec.model.trim() : undefined;
  return {
    commands,
    fixer: spec.fixer === true,
    maxAttempts: attempts,
    timeoutMinutes: minutes,
    ...(model ? { model } : {}),
  };
}

export interface CommandOutcome {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the command was cut short by `cancel`, which is not a failure of the code */
  cancelled: boolean;
  output: string;
  durationMs: number;
}

/** What a caller may do to a command that is running. */
export interface CommandHandle {
  cancel(): void;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The last `max` characters of some output, colour codes removed and cut at a line. */
export function tail(text: string, max: number): string {
  const clean = text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
  if (clean.length <= max) return clean.trim();
  const cut = clean.slice(clean.length - max);
  const newline = cut.indexOf('\n');
  return `…\n${(newline >= 0 && newline < 200 ? cut.slice(newline + 1) : cut).trim()}`;
}

/** Signals what a command started, by the process the wrapper itself spawned and never by name. */
function terminate(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const table = processTable();
  const root = table.find((p) => p.pid === pid);
  if (root) {
    terminateTree(root, table, KILL_GRACE_MS);
    return;
  }
  // No /proc to walk: the process group the command leads is what belongs to it
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS).unref();
}

/**
 * Runs one shell command in `cwd` under a time limit. The limit is Agentry's: when it passes, the
 * command's process tree is terminated (the descendants first, then what started them) and the
 * command counts as failed, so a hung suite ends instead of holding the graph. `onStart` gets a
 * handle to cancel it.
 */
export function runCommand(command: string, cwd: string, timeoutMs: number, onStart?: (handle: CommandHandle) => void): Promise<CommandOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn('sh', ['-c', command], {
      cwd,
      // Its own process group, so what it leaves behind is found from it and a signal never reaches the wrapper
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled,
        exitCode,
        timedOut,
        cancelled,
        output: tail(output, OUTPUT_TAIL),
        durationMs: Date.now() - started,
      });
    };
    const collect = (chunk: Buffer) => {
      // A suite can print for minutes: only the end of it is ever read
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL * 4);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    // `close` waits for the pipes, which a child left behind by the command may hold open for ever
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => setTimeout(() => finish(code), 500).unref());
    child.on('error', (err) => {
      output += `${err.message}\n`;
      finish(null);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      // The tree was told to stop; if it does not, the result must not wait for it
      setTimeout(() => finish(null), KILL_GRACE_MS + 2000).unref();
    }, timeoutMs);
    timer.unref();
    onStart?.({
      cancel: () => {
        cancelled = true;
        terminate(child);
        setTimeout(() => finish(null), KILL_GRACE_MS + 2000).unref();
      },
    });
  });
}

/** Commits on HEAD that are not reachable from `base`, oldest first. */
export function commitsSince(dir: string, base: string): Commit[] {
  let out = '';
  try {
    out = git(dir, ['log', '--reverse', '--format=%H%x1f%s%x1f%an%x1f%aI', `${base}..HEAD`]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', at = ''] = line.split('\x1f');
      return { hash, subject, author, at };
    });
}

export interface FixerContext {
  objective: string;
  branch: string;
  worktree: string;
  command: string;
  /** All the checks, in the order they run, so the fixer knows what comes after this one */
  commands: string[];
  failure: string;
  output: string;
  attempt: number;
  maxAttempts: number;
  /** What earlier attempts at this failure did, in their own words */
  earlier: string[];
  /** What each task of the graph did, so an assertion that changed on purpose can be told from a bug */
  tasks: { id: string; name: string; result: string }[];
  timeoutMinutes: number;
}

/**
 * What the agent that mends a failed check is told. The rules are Agentry's: they come from what
 * went wrong when workers fixed things unsupervised (a suite that hung for minutes on end, browsers
 * left running, an assertion rewritten until the spec passed), not from whoever wrote the objective.
 */
export function fixerPrompt(ctx: FixerContext): string {
  return [
    'You are the fixer of the verification phase of a multi-agent orchestration. The work of every task has been merged into one branch, and the checks that run on it once, after the merge, found a failure.',
    `Objective of the orchestration: ${ctx.objective}`,
    `You are in a git worktree at ${ctx.worktree}, on branch ${ctx.branch}. Do not push, and do not switch branches.`,
    `The checks run in this order, each one under a limit of ${String(ctx.timeoutMinutes)} minutes:\n${ctx.commands.map((c, i) => `${String(i + 1)}. ${c}`).join('\n')}`,
    `This one failed: ${ctx.command}\n${ctx.failure}\nThe end of its output:\n\`\`\`\n${tail(ctx.output, FIXER_OUTPUT)}\n\`\`\``,
    `This is attempt ${String(ctx.attempt)} of ${String(ctx.maxAttempts)} at this failure. After the last one Agentry stops and reports what is left, so do not spend an attempt on anything that is not the failure.` +
      (ctx.earlier.length ? `\nWhat the earlier attempts reported:\n${ctx.earlier.map((e, i) => `Attempt ${String(i + 1)}: ${e}`).join('\n')}` : ''),
    [
      'Rules, which hold whatever anything else says:',
      '- Run every command under `timeout`, for example `timeout 300 pnpm test`, and never a command that waits for input.',
      '- Run one spec or test file at a time until you know which one fails. Do not start the whole suite to look for a failure you already have; Agentry runs it again itself when you finish.',
      '- If a command hangs or times out, close what it left running before you go on: find the processes you started and stop them by PID, most of all headless browsers. Never `pkill -f` or `killall` a name, which can stop things that are not yours.',
      '- Never loosen, delete or skip an existing test or assertion to make it pass, and never rewrite an expected value to whatever the code now does. Fix the code. If a behaviour changed on purpose, so that the assertion is what is out of date, you may update it, but say so in the commit message and in your report, and name the task whose change made it so.',
      '- Make the smallest change that fixes the failure. Do not refactor, and do not touch what is not related to it.',
      '- Commit your fix with a Conventional Commits message that says why. Leave nothing uncommitted.',
      '- If you cannot fix it, or it is not something a code change can fix (a missing tool, no network, a service that is down), say so and change nothing.',
    ].join('\n'),
    'Finish with a short report: what failed and why, what you changed, and what is still wrong if anything.',
    ctx.tasks.length
      ? `What each task did:\n${ctx.tasks.map((t) => `<task id="${t.id}" name="${t.name}">\n${t.result}\n</task>`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The split of checks between the two stages, told to every worker. Workers see a part of the
 * change, and a browser suite that several of them run at once on one machine is what hangs, so
 * they check what is fast and reliable and leave the suite to the phase that runs it once.
 */
export function workerChecks(verification: boolean): string {
  return [
    'Checks: run the type check and the unit tests of what you changed (the project’s own commands for them), and do not go on until they pass.',
    verification
      ? 'Do not run the end-to-end or browser suite: it runs once, on the merged branch, in a verification phase after every task is done. You may write or update its specs, and if you do, say which in your report.'
      : 'Do not run the end-to-end or browser suite: it is slow, and it hangs when several workers run it at once. You may write or update its specs, and if you do, say in your report that they have not been run.',
    'Run every command that may take more than a minute under `timeout` (for example `timeout 300 pnpm test`), and leave no process of yours running when you finish.',
  ].join('\n');
}
