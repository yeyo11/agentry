import type { HealthSignal, TaskLimits } from '@agentry/shared';
import { commandKind, slowAfterMs, type UsualDuration } from './commands.ts';
import { oneLine, said, wholeMinutes } from './health-strings.ts';

// The signals that say a worker is busy and not getting anywhere, worked out from what Agentry
// already receives: the tool calls and results of its stream, and what its worktree shows. Each is a
// pure function of a trace and a clock, so the rules are tested with made-up ones. The rules that
// need only a command's age (a hung command, silence) live in `chat-model.ts` beside the rest of
// what a chat's health is made of.
//
// Every rule here prefers to say nothing over saying the wrong thing: a signal that fires on honest
// work is noise a person learns to ignore, and then it is worth nothing on the day it is right.

/** One tool call of the live execution, and what came back. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** When the call was made */
  at: string;
  /** When its result arrived; null while it runs */
  endedAt: string | null;
  isError: boolean;
  /** The start of what came back, enough to tell one answer from another */
  result: string;
}

/** What the live execution has done so far. */
export interface Trace {
  executionStartedAt: string;
  lastEventAt: string;
  /** Oldest first */
  calls: ToolCall[];
  /** The CLI's own heartbeat for a running command: how long it says it has run, and when it said so */
  heartbeats: Map<string, { elapsedSeconds: number; at: string }>;
}

/**
 * The shell commands of a trace that have had no answer yet, oldest first. A command sent to the
 * background answers at once, and what keeps running is the task, not the call.
 */
export function runningCommands(trace: Trace): ToolCall[] {
  return trace.calls.filter((c) => c.name === 'Bash' && c.endedAt === null && c.input.run_in_background !== true);
}

const ms = (iso: string): number => Date.parse(iso);

// ---------- the same stall again ----------

/** A command's run is a stall when it outlasted what is usual for its kind, or the fixed limit. */
export interface StallLimits {
  /** The fixed limit for a kind with no history */
  fallbackMs: number;
  usualOf: (kind: string) => UsualDuration | null;
}

const limitFor = (kind: string, limits: StallLimits): number => {
  const usual = limits.usualOf(kind);
  return usual ? slowAfterMs(usual) : limits.fallbackMs;
};

/**
 * The same kind of command hanging again. Only the calls of one kind are compared, in order, and
 * what counts is the unbroken run of stalls at the end of them: an ordinary run in between means
 * the worker mended what hung. A command that fails fast is not a stall — a test that fails,
 * edited, fails again is what fixing looks like — only one that outlasts its limit is.
 */
export function repeatStall(trace: Trace, limits: StallLimits, nowMs: number): HealthSignal | null {
  const byKind = new Map<string, ToolCall[]>();
  for (const call of trace.calls) {
    if (call.name !== 'Bash' || typeof call.input.command !== 'string' || call.input.run_in_background === true) continue;
    const kind = commandKind(call.input.command);
    if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), call]);
  }
  let worst: { kind: string; stalls: ToolCall[] } | null = null;
  for (const [kind, calls] of byKind) {
    const limit = limitFor(kind, limits);
    const stalled = (call: ToolCall) => (call.endedAt ? ms(call.endedAt) : nowMs) - ms(call.at) >= limit;
    const tail: ToolCall[] = [];
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i] as ToolCall;
      if (!stalled(call)) break;
      tail.unshift(call);
    }
    if (tail.length >= 2 && (!worst || tail.length > worst.stalls.length)) worst = { kind, stalls: tail };
  }
  if (!worst) return null;
  const count = worst.stalls.length;
  const first = worst.stalls[0] as ToolCall;
  const last = worst.stalls[count - 1] as ToolCall;
  return {
    kind: 'repeat-stall',
    level: count >= 3 ? 'bad' : 'warn',
    ...said('health.repeatStall', { kind: worst.kind, count, limitSeconds: Math.round(limitFor(worst.kind, limits) / 1000) }, 'health.hint.repeatStall'),
    since: first.at,
    detail: commandOf(last),
    ...(last.endedAt ? {} : { toolUseId: last.id }),
  };
}

const commandOf = (call: ToolCall): string => (typeof call.input.command === 'string' ? call.input.command : call.name);

// ---------- a loop ----------

/** Calls that only look at things, or keep the worker's own notes: repeating them says nothing. */
const BOOKKEEPING = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'ToolSearch']);
const WINDOW = 12;
/** The same call with the same answer this many times within the window is a loop. */
const LOOP_AT = 4;

const flatten = (text: string): string => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The same step over and over with nothing new coming back: one call, with the same input, that
 * gets the same answer four times in the last dozen calls — or the same error text coming back
 * four times, whatever the calls were. The answer is part of it on purpose: running the tests
 * again after an edit is the same command with a different result, and that is work, not a loop.
 */
export function loop(trace: Trace): HealthSignal | null {
  const recent = trace.calls.filter((c) => c.endedAt && !BOOKKEEPING.has(c.name)).slice(-WINDOW);
  const tally = new Map<string, { calls: ToolCall[] }>();
  for (const call of recent) {
    const key = `${call.name}\0${JSON.stringify(call.input)}\0${flatten(call.result)}`;
    const entry = tally.get(key) ?? { calls: [] };
    entry.calls.push(call);
    tally.set(key, entry);
  }
  let repeated: ToolCall[] = [];
  for (const { calls } of tally.values()) if (calls.length >= LOOP_AT && calls.length > repeated.length) repeated = calls;
  if (repeated.length) {
    const first = repeated[0] as ToolCall;
    const times = repeated.length;
    return {
      kind: 'loop',
      level: times >= LOOP_AT * 2 ? 'bad' : 'warn',
      ...(first.name === 'Bash'
        ? said('health.loop.command', { command: oneLine(commandOf(first), 60), count: times }, 'health.hint.loop')
        : said('health.loop.call', { tool: first.name, count: times }, 'health.hint.loop')),
      since: first.at,
    };
  }

  const errors = new Map<string, ToolCall[]>();
  for (const call of recent) {
    if (!call.isError || flatten(call.result).length < 12) continue;
    const key = flatten(call.result);
    errors.set(key, [...(errors.get(key) ?? []), call]);
  }
  let same: ToolCall[] = [];
  for (const calls of errors.values()) if (calls.length >= LOOP_AT && calls.length > same.length) same = calls;
  if (same.length) {
    const first = same[0] as ToolCall;
    return {
      kind: 'loop',
      level: same.length >= LOOP_AT * 2 ? 'bad' : 'warn',
      ...said('health.loop.error', { error: oneLine(first.result, 70), count: same.length }, 'health.hint.loop'),
      since: first.at,
    };
  }
  return null;
}

// ---------- tests bent to pass ----------

/** A file a test lives in: by name (`x.spec.ts`, `x_test.go`, `test_x.py`) or by directory. */
const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|e2e|specs?)\/|[._-](?:test|spec)\.[a-z]+$|_test\.(?:go|py|rb|rs)$|(?:^|\/)test_[^/]*\.py$/;

const ASSERTION =
  /\bassert(?:\.\w+)?\s*\(|\bexpect\s*\(|\bself\.assert\w*\s*\(|\bassert_\w+\s*\(|\bt\.(?:is|not|equal|deepEqual|deepEquals|true|truthy|false|falsy|throws|regex|pass)\s*\(|\.should\b|(?:^|\n)\s*assert\s+(?![.(])/g;
/** Matchers that pass for nearly anything: swapping a specific one for these is loosening. */
const WEAK =
  /\.(?:toBeTruthy|toBeDefined|toBeFalsy)\s*\(\s*\)|\.not\.(?:toBeNull|toBeUndefined)\s*\(\s*\)|\.toBeGreaterThan(?:OrEqual)?\s*\(\s*0\s*\)|\bassert\.ok\s*\(\s*[\w.]+\s*\)/g;
/** An assertion that cannot fail. */
const TAUTOLOGY = /\bexpect\s*\(\s*true\s*\)|\bassert(?:\.ok)?\s*\(\s*true\s*\)|\bassert\.(?:equal|strictEqual)\s*\(\s*(\w+|\d+)\s*,\s*\1\s*\)/g;
const SKIP = /\b(?:it|test|describe|t)\.(?:skip|todo|fixme)\b|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.skip|@unittest\.skip/g;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
/** What is left of a snippet once comments are gone: a commented-out assertion asserts nothing. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/^\s*#.*$/gm, '');

/**
 * Whether replacing `before` with `after` in a test file makes it assert less, and how. Deliberately
 * narrow — an honest edit to a test changes expected values, renames things, removes a test for
 * removed behaviour, and none of that is caught here:
 *
 *  - every assertion in the edited text is gone and the text is still there (a test that no longer
 *    checks anything), not a whole test deleted with its assertions;
 *  - a test is skipped that was not skipped;
 *  - an assertion that cannot fail was added;
 *  - specific assertions were swapped for ones that pass for nearly anything.
 */
export function weaknessOf(before: string, after: string): Weakness | null {
  const old = stripComments(before);
  const now = stripComments(after);
  const removed = count(old, ASSERTION);
  const kept = count(now, ASSERTION);
  if (removed > 0 && kept === 0 && now.trim() !== '' && count(now, /\b(?:it|test)\s*\(|\bdef test_|\bfunc Test/g) >= count(old, /\b(?:it|test)\s*\(|\bdef test_|\bfunc Test/g)) {
    return { why: 'assertionsRemoved', count: removed };
  }
  if (count(now, SKIP) > count(old, SKIP)) return { why: 'skipped' };
  if (count(now, TAUTOLOGY) > count(old, TAUTOLOGY)) return { why: 'tautology' };
  const weakBefore = count(old, WEAK);
  const weakAfter = count(now, WEAK);
  if (weakAfter > weakBefore && kept - weakAfter < removed - weakBefore) return { why: 'weakMatchers' };
  return null;
}

/** How a test was made to assert less; `count` is the assertions removed, for the first way */
export type Weakness = { why: 'assertionsRemoved'; count: number } | { why: 'skipped' | 'tautology' | 'weakMatchers' };

const WEAKNESS_TEXT: Record<Weakness['why'], (n: number) => string> = {
  assertionsRemoved: (n) => `${String(n)} ${n === 1 ? 'assertion' : 'assertions'} removed`,
  skipped: () => 'a test is skipped',
  tautology: () => 'an assertion that cannot fail was added',
  weakMatchers: () => 'specific assertions were replaced by ones that pass for almost anything',
};

/** {@link weaknessOf} in words */
export function weakening(before: string, after: string): string | null {
  const weakness = weaknessOf(before, after);
  return weakness ? WEAKNESS_TEXT[weakness.why](weakness.why === 'assertionsRemoved' ? weakness.count : 0) : null;
}

/** The edits a call makes to a file, as before/after text; a call that is not an edit of an existing file has none. */
function editsOf(call: ToolCall): Array<{ path: string; before: string; after: string }> {
  const path = typeof call.input.file_path === 'string' ? call.input.file_path : null;
  if (!path) return [];
  if (call.name === 'Edit' && typeof call.input.old_string === 'string' && typeof call.input.new_string === 'string' && call.input.old_string !== '') {
    return [{ path, before: call.input.old_string, after: call.input.new_string }];
  }
  if (call.name === 'MultiEdit' && Array.isArray(call.input.edits)) {
    return call.input.edits.flatMap((e: unknown) => {
      const edit = (e ?? {}) as Record<string, unknown>;
      return typeof edit.old_string === 'string' && typeof edit.new_string === 'string' && edit.old_string !== '' ? [{ path, before: edit.old_string, after: edit.new_string }] : [];
    });
  }
  return [];
}

/**
 * Edits to existing test files that make them assert less. An edit that failed changed nothing and
 * is not counted. One signal per file, worst first, so an editor cleaning up a spec is told once.
 */
export function weakenedTests(trace: Trace): HealthSignal[] {
  const found = new Map<string, { weakness: Weakness; call: ToolCall }>();
  for (const call of trace.calls) {
    if (call.isError) continue;
    for (const { path, before, after } of editsOf(call)) {
      if (!TEST_FILE.test(path)) continue;
      const weakness = weaknessOf(before, after);
      if (weakness && !found.has(path)) found.set(path, { weakness, call });
    }
  }
  return [...found].map(([path, { weakness, call }]) => ({
    kind: 'weakened-test' as const,
    level: 'warn' as const,
    ...(weakness.why === 'assertionsRemoved'
      ? said('health.weakenedTest.assertionsRemoved', { file: path, count: weakness.count }, 'health.hint.weakenedTest')
      : said(`health.weakenedTest.${weakness.why}`, { file: path }, 'health.hint.weakenedTest')),
    since: call.at,
    detail: path,
    toolUseId: call.id,
  }));
}

// ---------- busy without progress ----------

/** Time spent, with nothing committed and no file touched, before it is worth saying so. */
export const NO_PROGRESS_MS = 15 * 60_000;
export const NO_PROGRESS_BAD_MS = 45 * 60_000;

/** Tools that change a file: seeing one succeed is progress even where there is no git to see it in. */
export const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * A worker that has been at it for a long time without changing anything. `progressAt` is the last
 * time anything moved — a commit, a change in the worktree, a file written — or the start of the
 * execution. It stays a warning until long past what is reasonable: a task that only reads (a
 * review, a survey) changes nothing for ever, and that is fine.
 */
export function noProgress(progressAt: string, nowMs: number): HealthSignal | null {
  const idle = nowMs - ms(progressAt);
  if (idle < NO_PROGRESS_MS) return null;
  return {
    kind: 'no-progress',
    level: idle >= NO_PROGRESS_BAD_MS ? 'bad' : 'warn',
    ...said('health.noProgress', { minutes: wholeMinutes(idle) }, 'health.hint.noProgress'),
    since: progressAt,
  };
}

/** The last time a file-changing tool call succeeded in the trace, or null. */
export function lastFileChangeAt(trace: Trace): string | null {
  const done = trace.calls.filter((c) => FILE_TOOLS.has(c.name) && c.endedAt && !c.isError);
  return done.length ? (done[done.length - 1] as ToolCall).endedAt : null;
}

// ---------- a limit coming close ----------

/** The share of a limit at which the worker is told it is nearly out. */
export const SOFT_LIMIT = 0.8;

/**
 * A task past most of the time or cost it was allowed. The time is Agentry's to enforce, so past
 * the limit it is `bad` and the task is stopped; the cost is enforced by the CLI itself, and Agentry
 * only ever knows what earlier executions cost (the CLI reports cost when a turn ends), so this
 * says so only for what has been spent.
 */
export function budget(limits: TaskLimits | null | undefined, spent: { elapsedMs: number; costUsd: number }): HealthSignal | null {
  const signals: HealthSignal[] = [];
  if (limits?.maxMinutes && limits.maxMinutes > 0) {
    const share = spent.elapsedMs / (limits.maxMinutes * 60_000);
    if (share >= SOFT_LIMIT) {
      signals.push({
        kind: 'budget',
        level: share >= 1 ? 'bad' : 'warn',
        ...said(
          share >= 1 ? 'health.budget.timePast' : 'health.budget.timeNear',
          { minutes: wholeMinutes(spent.elapsedMs), limitMinutes: limits.maxMinutes },
          'health.hint.budget.time',
        ),
        detail: 'time',
      });
    }
  }
  if (limits?.maxCostUsd && limits.maxCostUsd > 0) {
    const share = spent.costUsd / limits.maxCostUsd;
    if (share >= SOFT_LIMIT) {
      signals.push({
        kind: 'budget',
        level: share >= 1 ? 'bad' : 'warn',
        ...said('health.budget.cost', { spentUsd: spent.costUsd, limitUsd: limits.maxCostUsd }, 'health.hint.budget.cost'),
        detail: 'cost',
      });
    }
  }
  return signals.sort((a, b) => Number(b.level === 'bad') - Number(a.level === 'bad'))[0] ?? null;
}
