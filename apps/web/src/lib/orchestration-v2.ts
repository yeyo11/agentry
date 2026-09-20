import type {
  Orchestration,
  OrchestrationTaskSpec,
  OrchestrationTaskState,
  TaskLimits,
  VerificationSpec,
} from '@agentry/shared';

/** Only what is set: an empty field means "the graph's default", which is a limit of nothing to send. */
export function limitsOf(maxMinutes: number | undefined, maxCostUsd: number | undefined): TaskLimits | undefined {
  const limits: TaskLimits = {};
  if (maxMinutes !== undefined && maxMinutes > 0) limits.maxMinutes = maxMinutes;
  if (maxCostUsd !== undefined && maxCostUsd > 0) limits.maxCostUsd = maxCostUsd;
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/** The task as it should be sent: trimmed, and without the optional fields a form leaves empty. */
export function cleanTask(task: OrchestrationTaskSpec): OrchestrationTaskSpec {
  const id = task.id.trim();
  const limits = limitsOf(task.limits?.maxMinutes, task.limits?.maxCostUsd);
  return {
    id,
    name: task.name.trim() || id,
    prompt: task.prompt.trim(),
    ...(task.dependsOn?.length ? { dependsOn: task.dependsOn } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.model?.trim() ? { model: task.model.trim() } : {}),
    ...(limits ? { limits } : {}),
  };
}

/** What a task was launched with, to edit it and launch it again: the state's own fields (chat, result…) stay behind. */
export function specOfTask(task: OrchestrationTaskState): OrchestrationTaskSpec {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    dependsOn: task.dependsOn ?? [],
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.limits ? { limits: task.limits } : {}),
  };
}

/** A finished graph on the graph engine: the only kind whose tasks can start over one by one. */
function finishedGraph(orch: Orchestration): boolean {
  return (orch.engine ?? 'graph') === 'graph' && orch.status !== 'running' && orch.status !== 'waiting';
}

/** The integration branch was pushed for a pull request: rebuilding it would leave that one behind. */
export function rerunBlockedByPullRequest(orch: Orchestration): boolean {
  return finishedGraph(orch) && Boolean(orch.worktree && orch.integration?.pullRequestUrl);
}

/**
 * Whether a finished graph can start over from one of its tasks. Mirrors the server, which refuses a
 * running or waiting graph (those are decided task by task), a workflow, a graph being integrated,
 * and one whose integration branch was already pushed.
 */
export function canRerun(orch: Orchestration): boolean {
  if (!finishedGraph(orch)) return false;
  if (orch.integration && ['merging', 'resolving'].includes(orch.integration.status)) return false;
  return !rerunBlockedByPullRequest(orch);
}

/** A graph is relaunched once it is no longer running; the original is untouched either way. */
export function canRelaunch(orch: Orchestration): boolean {
  return orch.status !== 'running';
}

/** The tasks that start over with `taskId`: itself and everything that depends on it, directly or not. */
export function dependantsOf(tasks: OrchestrationTaskState[], taskId: string): string[] {
  const affected = new Set([taskId]);
  // A fixed point rather than an ordering, so a cycle cannot loop
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (!affected.has(task.id) && (task.dependsOn ?? []).some((d) => affected.has(d))) {
        affected.add(task.id);
        grew = true;
      }
    }
  }
  return tasks.filter((t) => affected.has(t.id)).map((t) => t.id);
}

/** One command per line, blanks dropped: how the verification commands are typed. */
export function parseCommands(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** What the launch form holds for the verification phase, before it is a spec. */
export interface VerificationDraft {
  enabled: boolean;
  commands: string;
  fixer: boolean;
  maxAttempts: number;
  model: string;
}

export const EMPTY_VERIFICATION: VerificationDraft = { enabled: false, commands: '', fixer: true, maxAttempts: 2, model: '' };

/** A draft with no command is no verification: checks of nothing would only add a phase that always passes. */
export function verificationOf(draft: VerificationDraft): VerificationSpec | undefined {
  const commands = parseCommands(draft.commands);
  if (!draft.enabled || commands.length === 0) return undefined;
  return {
    commands,
    fixer: draft.fixer,
    maxAttempts: Math.max(1, draft.maxAttempts),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
  };
}

export function draftOfVerification(spec: VerificationSpec | undefined): VerificationDraft {
  if (!spec) return EMPTY_VERIFICATION;
  return { enabled: true, commands: spec.commands.join('\n'), fixer: spec.fixer, maxAttempts: spec.maxAttempts, model: spec.model ?? '' };
}
