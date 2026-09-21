import type {
  Orchestration,
  OrchestrationSpec,
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

/**
 * The spec that would launch this graph as it ran, read from `GET /orchestrations/:id`: what a
 * schedule is filled from. Mirrors the server's `specOf`, so a schedule starts what a relaunch would.
 */
export function specOfOrchestration(orch: Orchestration): OrchestrationSpec {
  return {
    name: orch.name,
    ...(orch.objective ? { objective: orch.objective } : {}),
    engine: orch.engine ?? 'graph',
    ...(orch.engineReason ? { engineReason: orch.engineReason } : {}),
    cwd: orch.cwd,
    ...(orch.model ? { model: orch.model } : {}),
    permissionMode: orch.permissionMode,
    concurrency: orch.concurrency,
    synthesize: orch.synthesize,
    worktree: orch.worktree,
    maxAttempts: orch.maxAttempts,
    allowedTools: [...(orch.allowedTools ?? [])],
    permissionPrompts: orch.permissionPrompts,
    ...(orch.limits ? { limits: orch.limits } : {}),
    ...(orch.verificationSpec ? { verification: orch.verificationSpec } : {}),
    tasks: orch.tasks.map((task) => {
      const { dependsOn, ...spec } = specOfTask(task);
      return dependsOn?.length ? { ...spec, dependsOn: [...dependsOn] } : spec;
    }),
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

/**
 * How the install step before the checks is picked: detected from the lockfile (the spec leaves
 * `install` out), a command of the person's own (a string), or none (`null`).
 */
export type InstallMode = 'detected' | 'command' | 'none';

/** What the launch form holds for the verification phase, before it is a spec. */
export interface VerificationDraft {
  enabled: boolean;
  commands: string;
  fixer: boolean;
  maxAttempts: number;
  model: string;
  /** What the fixer may spend over all its attempts; no ceiling when absent */
  maxCostUsd?: number;
  install: InstallMode;
  installCommand: string;
  failGraph: boolean;
}

export const EMPTY_VERIFICATION: VerificationDraft = {
  enabled: false,
  commands: '',
  fixer: true,
  maxAttempts: 2,
  model: '',
  install: 'detected',
  installCommand: '',
  failGraph: false,
};

/** A draft with no command is no verification: checks of nothing would only add a phase that always passes. */
export function verificationOf(draft: VerificationDraft): VerificationSpec | undefined {
  const commands = parseCommands(draft.commands);
  if (!draft.enabled || commands.length === 0) return undefined;
  const installCommand = draft.installCommand.trim();
  return {
    commands,
    fixer: draft.fixer,
    maxAttempts: Math.max(1, draft.maxAttempts),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    // Only the fixer spends, so a ceiling without one would be a field nothing reads
    ...(draft.fixer && draft.maxCostUsd !== undefined && draft.maxCostUsd > 0 ? { maxCostUsd: draft.maxCostUsd } : {}),
    // The server refuses an empty command; an empty box falls back to detection instead
    ...(draft.install === 'none' ? { install: null } : draft.install === 'command' && installCommand ? { install: installCommand } : {}),
    ...(draft.failGraph ? { failGraph: true } : {}),
  };
}

export function draftOfVerification(spec: VerificationSpec | undefined): VerificationDraft {
  if (!spec) return EMPTY_VERIFICATION;
  return {
    enabled: true,
    commands: spec.commands.join('\n'),
    fixer: spec.fixer,
    maxAttempts: spec.maxAttempts,
    model: spec.model ?? '',
    ...(spec.maxCostUsd !== undefined ? { maxCostUsd: spec.maxCostUsd } : {}),
    install: spec.install === null ? 'none' : spec.install === undefined ? 'detected' : 'command',
    installCommand: typeof spec.install === 'string' ? spec.install : '',
    failGraph: spec.failGraph ?? false,
  };
}

/** The server refuses a pull request for a graph its own failed checks failed, so none is offered. */
export function pullRequestHeld(orch: Pick<Orchestration, 'verificationSpec' | 'verification'>): boolean {
  return orch.verificationSpec?.failGraph === true && orch.verification?.status === 'failed';
}
