import type { HealthSignal } from '@agentry/shared';

// Every sentence a health signal says, keyed by a stable code and written from the figures in its
// params. The English is built from the same params a client receives, so a client that
// translates the code says exactly what the server said, and one that does not shows the text.
// A code is part of the API: renaming one breaks every translation keyed by it.

/** `81 s` up to a minute and a half, `2 min` after: how a duration in seconds reads */
export const durationText = (seconds: number): string =>
  seconds < 90 ? `${String(Math.max(1, Math.round(seconds)))} s` : `${String(Math.max(1, Math.round(seconds / 60)))} min`;

/** Whole minutes, never zero: what "for 4 min" reads as */
export const wholeMinutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const usd = (n: number): string => `$${n.toFixed(2)}`;

export const HEALTH_REASONS = {
  'health.hungCommand.usual': (p: { command: string; minutes: number; usualSeconds: number }) =>
    `\`${p.command}\` has been running for ${String(p.minutes)} min; commands like it usually take ${durationText(p.usualSeconds)}.`,
  'health.hungCommand.fixed': (p: { command: string; minutes: number; limitMinutes: number }) =>
    `\`${p.command}\` has been running for ${String(p.minutes)} min, past the ${String(p.limitMinutes)} min a command is expected to need.`,
  'health.silence': (p: { minutes: number }) =>
    `Nothing has happened for ${String(p.minutes)} min and no command is running: the model or an API call may be stalled.`,
  'health.lastExecution.interrupted': () => 'The last execution was cut short: its process was lost.',
  'health.lastExecution.failed': () => 'The last execution failed.',
  'health.lastExecution.failedWithError': (p: { error: string }) => `The last execution failed: ${p.error}`,
  'health.waiting': () => 'Stopped until a person answers a permission, a question or a plan.',
  'health.context': (p: { percent: number }) =>
    `${String(p.percent)}% of the context window is in use: Claude Code compacts the conversation when it fills.`,
  'health.branches': (p: { count: number }) => `${String(p.count)} ${p.count === 1 ? 'branch' : 'branches'} failed.`,
  'health.repeatStall': (p: { kind: string; count: number; limitSeconds: number }) =>
    `\`${p.kind}\` has hung ${String(p.count)} times in a row (${String(p.count)} runs, each past ${durationText(p.limitSeconds)}).`,
  'health.loop.command': (p: { command: string; count: number }) => `\`${p.command}\` ran ${String(p.count)} times with the same result.`,
  'health.loop.call': (p: { tool: string; count: number }) => `The same ${p.tool} call ran ${String(p.count)} times with the same result.`,
  'health.loop.error': (p: { error: string; count: number }) => `The same error came back ${String(p.count)} times: "${p.error}"`,
  'health.weakenedTest.assertionsRemoved': (p: { file: string; count: number }) =>
    `\`${p.file}\` was edited so that it asserts less: ${String(p.count)} ${p.count === 1 ? 'assertion' : 'assertions'} removed.`,
  'health.weakenedTest.skipped': (p: { file: string }) => `\`${p.file}\` was edited so that it asserts less: a test is skipped.`,
  'health.weakenedTest.tautology': (p: { file: string }) =>
    `\`${p.file}\` was edited so that it asserts less: an assertion that cannot fail was added.`,
  'health.weakenedTest.weakMatchers': (p: { file: string }) =>
    `\`${p.file}\` was edited so that it asserts less: specific assertions were replaced by ones that pass for almost anything.`,
  'health.noProgress': (p: { minutes: number }) =>
    `Working for ${String(p.minutes)} min with no commit and no change to the files (a task that only reads can be fine).`,
  'health.budget.timeNear': (p: { minutes: number; limitMinutes: number }) => `${String(p.minutes)} min of its ${String(p.limitMinutes)} min used.`,
  'health.budget.timePast': (p: { minutes: number; limitMinutes: number }) =>
    `Past its time limit: ${String(p.minutes)} min of ${String(p.limitMinutes)} min.`,
  'health.budget.cost': (p: { spentUsd: number; limitUsd: number }) => `${usd(p.spentUsd)} of its ${usd(p.limitUsd)} spent.`,
  /** What a chat with no signal says */
  'health.ok': () => 'Nothing unusual.',
} as const;

/**
 * What a person would say to a worker in each situation, so the box is never empty when the badge
 * turns. Written by Agentry: a suggestion per signal is worth more than a blank field to someone
 * who has just been told a worker is stuck.
 */
export const HEALTH_HINTS = {
  'health.hint.hungCommand': (p: { command: string }) =>
    `\`${p.command}\` is taking far longer than it should. Something may be left open (a server, a browser, a connection). ` +
    'Stop waiting on it, find out what it is waiting for, and run long commands under `timeout` from now on.',
  'health.hint.repeatStall': (p: { kind: string; count: number }) =>
    `\`${p.kind}\` has hung ${String(p.count)} times in a row. Do not run it again as it is: work out what it is waiting on first, run it under \`timeout\`, and check for processes an earlier run left behind.`,
  'health.hint.noProgress': (p: { minutes: number }) =>
    `You have not committed or changed a file for ${String(p.minutes)} min. Tell me what is blocking you. If the approach is not working, change it, and commit what already works.`,
  'health.hint.loop': () =>
    'You are repeating the same step and getting the same result. Stop and think about why it does not work: try something different, or say what is blocking you.',
  'health.hint.weakenedTest': (p: { file: string }) =>
    `You edited \`${p.file}\` so that it asserts less. Fix the code so the original assertion passes. If the behaviour changed on purpose, say so, and update the assertion to the new behaviour instead of weakening it.`,
  'health.hint.silence': (p: { minutes: number }) => `I have heard nothing from you for ${String(p.minutes)} min. Reply with what you are doing right now.`,
  'health.hint.budget.time': (p: { limitMinutes: number }) =>
    `You are close to its time limit of ${String(p.limitMinutes)} min. Wrap up: commit what works and report what is left.`,
  'health.hint.budget.cost': (p: { limitUsd: number }) =>
    `You are close to its cost limit of ${usd(p.limitUsd)}. Wrap up: commit what works and report what is left.`,
} as const;

export type HealthReasonCode = keyof typeof HEALTH_REASONS;
export type HealthHintCode = keyof typeof HEALTH_HINTS;
// A sentence with no figures takes an empty object, so it intersects with its hint's figures cleanly
type FiguresOf<F extends (...args: never[]) => string> = Parameters<F> extends [infer P] ? P : Record<never, never>;
type ReasonParams<C extends HealthReasonCode> = FiguresOf<(typeof HEALTH_REASONS)[C]>;
type HintParams<C extends HealthHintCode> = FiguresOf<(typeof HEALTH_HINTS)[C]>;

type Writer = (p: Record<string, string | number>) => string;

// Looked up by a code that came from outside the catalogue, so each sentence is read as taking any
// params: one that misses a figure writes `undefined`, which the catalogue's tests rule out.
const lookup = (catalogue: object, code: string): Writer | null =>
  Object.hasOwn(catalogue, code) ? ((catalogue as Record<string, unknown>)[code] as Writer) : null;

/** The English of a reason code, from its params; null for a code that is not in the catalogue */
export function reasonText(code: string, params: Record<string, string | number> = {}): string | null {
  return lookup(HEALTH_REASONS, code)?.(params) ?? null;
}

/** The English of a hint code, the same way */
export function hintText(code: string, params: Record<string, string | number> = {}): string | null {
  return lookup(HEALTH_HINTS, code)?.(params) ?? null;
}

type Said = Pick<HealthSignal, 'reason' | 'reasonCode' | 'hint' | 'hintCode' | 'params'>;

/**
 * The words of a signal: its reason, and its hint when it has one, each with its code, over one set
 * of params they share. A signal has one `params`, so a reason and its hint name the same figure
 * the same way.
 */
export function said<R extends HealthReasonCode>(reason: R, params: ReasonParams<R>): Said;
export function said<R extends HealthReasonCode, H extends HealthHintCode>(reason: R, params: ReasonParams<R> & HintParams<H>, hint: H): Said;
export function said(reason: HealthReasonCode, params: Record<string, string | number> | undefined, hint?: HealthHintCode): Said {
  const figures = params ?? {};
  const out: Said = { reason: reasonText(reason, figures) ?? '', reasonCode: reason };
  if (hint) {
    out.hint = hintText(hint, figures) ?? '';
    out.hintCode = hint;
  }
  if (Object.keys(figures).length) out.params = { ...figures };
  return out;
}
