import type { Orchestration, OrchestrationTaskState, VerificationSpec } from '@agentry/shared';

// The spec a graph is read back as, and the rules for starting one over, are the server's too: they
// live in @agentry/shared so a schedule filled here starts what a relaunch there would.
export { canRelaunch, canRerun, cleanTask, limitsOf, rerunBlockedByPullRequest, specOfOrchestration, specOfTask } from '@agentry/shared';

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
