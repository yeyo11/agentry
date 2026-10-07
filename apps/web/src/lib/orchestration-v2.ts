import type { Orchestration, OrchestrationPullRequest, OrchestrationTaskState, VerificationSpec } from '@agentry/shared';

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

/** The mark of a line that runs at the same time as the one above: no shell command starts with `&`. */
const PARALLEL = /^&\s+/;

/**
 * One command per line, blanks dropped: how the verification commands are typed. A line that starts
 * with `& ` runs at the same time as the line above it, and they make one parallel group.
 */
export function parseCommands(text: string): Array<string | string[]> {
  const entries: string[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const joins = PARALLEL.test(line);
    const command = line.replace(PARALLEL, '').trim();
    if (!command || command === '&') continue;
    const last = entries.at(-1);
    // A mark on the first command has nothing to join, so it starts the list
    if (joins && last) last.push(command);
    else entries.push([command]);
  }
  return entries.map((group) => (group.length === 1 ? (group[0] as string) : group));
}

/** The commands box's text for a spec's commands: `parseCommands` read backwards. */
export function commandsText(commands: ReadonlyArray<string | readonly string[]>): string {
  return commands.map((entry) => (typeof entry === 'string' ? entry : entry.join('\n& '))).join('\n');
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
  /** The browser specs the changes touch, run by a task of the graph before the merge (on unless turned off) */
  e2eSpecs: boolean;
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
  e2eSpecs: true,
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
    ...(draft.e2eSpecs ? {} : { e2eSpecs: false }),
  };
}

export function draftOfVerification(spec: VerificationSpec | undefined): VerificationDraft {
  if (!spec) return EMPTY_VERIFICATION;
  return {
    enabled: true,
    commands: commandsText(spec.commands),
    fixer: spec.fixer,
    maxAttempts: spec.maxAttempts,
    model: spec.model ?? '',
    ...(spec.maxCostUsd !== undefined ? { maxCostUsd: spec.maxCostUsd } : {}),
    install: spec.install === null ? 'none' : spec.install === undefined ? 'detected' : 'command',
    installCommand: typeof spec.install === 'string' ? spec.install : '',
    failGraph: spec.failGraph ?? false,
    e2eSpecs: spec.e2eSpecs !== false,
  };
}

/** The server refuses a pull request for a graph its own failed checks failed, so none is offered. */
export function pullRequestHeld(orch: Pick<Orchestration, 'verificationSpec' | 'verification'>): boolean {
  return orch.verificationSpec?.failGraph === true && orch.verification?.status === 'failed';
}

type WithRow = Pick<OrchestrationPullRequest, 'id' | 'phase'> & { id: string };

/** The checks are listed while the change request is open and the server named its row. */
export function checksShown(pr: Pick<OrchestrationPullRequest, 'id' | 'phase'> | null | undefined): pr is WithRow {
  return Boolean(pr?.id) && pr?.phase === 'open';
}

/**
 * An orchestration has no QA stage, so its fix is `fixing` and then waits for the person: `push`
 * is where **Push the fix** is the zone's one action, `fixing` where an agent is on it.
 */
export function orchestrationFix(pr: Pick<OrchestrationPullRequest, 'fixState'> | null | undefined): 'fixing' | 'push' | null {
  if (pr?.fixState === 'fixing') return 'fixing';
  return pr?.fixState === 'awaiting-push' ? 'push' : null;
}

/** The lines of a log tail that say why it failed: GitHub's `##[error]`, GitLab's `ERROR:` and a non-zero exit code. */
const ERROR_LINE = /##\[error\]|^\s*ERROR:|exit code [1-9]\d*/;

export const isErrorLine = (line: string): boolean => ERROR_LINE.test(line);
