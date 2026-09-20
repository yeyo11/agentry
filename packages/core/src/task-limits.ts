import type { OrchestrationTaskState, TaskLimits } from '@agentry/shared';
import { SOFT_LIMIT } from './health.ts';

// What a task of an orchestration may spend. The cost ceiling is the CLI's (`--max-budget-usd` ends
// the turn itself); the time ceiling is Agentry's, since the CLI has no flag for it, and is enforced
// by the orchestrator with a warning to the worker before the stop.

/**
 * Checks limits that came in from a request and drops the fields that are not set. A limit that is
 * zero, negative or not a number would either stop the task at once or never, and neither is what
 * anyone meant, so it is refused where it is given.
 */
export function normalizeLimits(limits: TaskLimits | null | undefined, where: string): TaskLimits | undefined {
  if (limits === undefined || limits === null) return undefined;
  const out: TaskLimits = {};
  for (const key of ['maxMinutes', 'maxCostUsd'] as const) {
    const value = limits[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${where}: ${key} must be a number greater than zero`);
    out[key] = value;
  }
  return out.maxMinutes === undefined && out.maxCostUsd === undefined ? undefined : out;
}

/** What applies to a task: its own limits, field by field, over the graph's defaults. */
export function effectiveLimits(graph: TaskLimits | null | undefined, task: TaskLimits | null | undefined): TaskLimits | null {
  const maxMinutes = task?.maxMinutes ?? graph?.maxMinutes;
  const maxCostUsd = task?.maxCostUsd ?? graph?.maxCostUsd;
  if (maxMinutes === undefined && maxCostUsd === undefined) return null;
  return { ...(maxMinutes !== undefined ? { maxMinutes } : {}), ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) };
}

/**
 * Where a task's allowance starts: when it was first launched, or when a person last sent it round
 * again. `startedAt` survives a retry, so the limit would trip the moment the person decided the task
 * was worth another go.
 */
export function startClock(task: OrchestrationTaskState, nowIso: string): void {
  task.clockStartedAt = nowIso;
  task.clockCostUsd = task.costUsd;
}

/** How long the task has been running against its time limit, across the attempts of one allowance. */
export function elapsedMs(task: OrchestrationTaskState, nowMs: number): number {
  const from = task.clockStartedAt ?? task.startedAt;
  return from ? Math.max(0, nowMs - Date.parse(from)) : 0;
}

/** What the task has spent against its cost limit: the chat's total less what it had spent when the allowance began. */
export function spentUsd(task: OrchestrationTaskState): number {
  return Math.max(0, task.costUsd - (task.clockCostUsd ?? 0));
}

/**
 * What is left of the cost limit for the next execution, or null with no limit. The CLI's ceiling is
 * per process, so a task given the whole limit again on every attempt would spend a multiple of it.
 */
export function remainingUsd(limits: TaskLimits | null, task: OrchestrationTaskState): number | null {
  return limits?.maxCostUsd === undefined ? null : limits.maxCostUsd - spentUsd(task);
}

/** What the worker is told when it has used most of its time. */
export function timeWarning(elapsed: number, limits: TaskLimits): string {
  const used = Math.round(elapsed / 60_000);
  return (
    `You have used ${String(used)} of the ${String(limits.maxMinutes)} minutes this task is allowed, and Agentry will stop it at the limit. ` +
    'Wrap up now: commit what works, and report what is done and what is left.'
  );
}

/** Whether a task is past the point where the worker is warned. */
export const pastSoftLimit = (elapsed: number, limits: TaskLimits): boolean =>
  limits.maxMinutes !== undefined && elapsed >= limits.maxMinutes * 60_000 * SOFT_LIMIT;

export const pastHardLimit = (elapsed: number, limits: TaskLimits): boolean =>
  limits.maxMinutes !== undefined && elapsed >= limits.maxMinutes * 60_000;
