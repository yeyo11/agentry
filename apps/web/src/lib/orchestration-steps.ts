import type { ChatWorkflow, ChatWorkflowAgent, Orchestration, OrchestrationStatus, OrchestrationTaskState } from '@agentry/shared';
import { currentStepIndex, type ProgressCounts, type StepState } from './progress';
import { pullRequestHeld } from './orchestration-v2';

/**
 * An orchestration as the steps a person follows it by: the stages of its dependency graph, then
 * what happens once the tasks are done. Pure, so which step is "now" and how each one reads is
 * decided in one tested place and not in a component.
 *
 * The phases after the stages are in the order the core runs them (`Orchestrator.finish`): the
 * branches are merged, the checks run on the merge, the synthesis reports on it, and only then is
 * the pull request a person's call.
 */
export type OrchestrationStep =
  | { id: string; kind: 'stage'; state: StepState; index: number; tasks: OrchestrationTaskState[]; completed: number }
  | { id: 'integration'; kind: 'integration'; state: StepState }
  | { id: 'verification'; kind: 'verification'; state: StepState }
  | { id: 'synthesis'; kind: 'synthesis'; state: StepState }
  | { id: 'pull-request'; kind: 'pull-request'; state: StepState }
  | { id: string; kind: 'phase'; state: StepState; phase: string | null; agents: ChatWorkflowAgent[] }
  | { id: 'workflow'; kind: 'workflow'; state: StepState };

/** Nothing runs and nothing waits for a person: what has not happened by now only happens if someone relaunches. */
function settled(status: OrchestrationStatus): boolean {
  return status !== 'running' && status !== 'waiting';
}

/** Groups tasks by topological level (longest dependency chain). Cycles are tolerated. */
export function layerTasks(tasks: OrchestrationTaskState[]): OrchestrationTaskState[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const level = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(levelOf));
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  const layers: OrchestrationTaskState[][] = [];
  for (const task of tasks) {
    const level = levelOf(task.id);
    (layers[level] ??= []).push(task);
  }
  return Array.from(layers, (layer) => layer ?? []);
}

/**
 * A stage is waiting when the graph is: a task in it failed for good or is blocked behind one, and
 * nothing moves until a person decides. Stopped or interrupted tasks leave the stage pending, since
 * resuming picks them up again.
 */
export function stageState(tasks: readonly OrchestrationTaskState[], status: OrchestrationStatus): StepState {
  if (tasks.length === 0) return 'pending';
  const has = (s: OrchestrationTaskState['status']) => tasks.some((t) => t.status === s);
  if (has('running')) return 'current';
  if (status === 'waiting' && (has('failed') || has('blocked'))) return 'waiting';
  if (has('failed')) return 'failed';
  if (tasks.every((t) => t.status === 'skipped')) return 'skipped';
  if (tasks.every((t) => t.status === 'completed' || t.status === 'skipped')) return 'done';
  // Part of it done and the rest queued behind the concurrency limit: the stage is under way
  if (status === 'running' && tasks.some((t) => t.status === 'completed')) return 'current';
  return 'pending';
}

function integrationState(orch: Orchestration): StepState {
  const integration = orch.integration;
  if (integration) {
    if (integration.status === 'merging' || integration.status === 'resolving') return 'current';
    if (integration.status === 'merged') return 'done';
    return 'failed';
  }
  if (!settled(orch.status)) return 'pending';
  // Nothing completed with a branch: there was never anything to merge
  return orch.tasks.some((t) => t.status === 'completed' && t.branch) ? 'pending' : 'skipped';
}

function verificationState(orch: Orchestration): StepState {
  const status = orch.verification?.status;
  if (status === 'running') return 'current';
  if (status === 'passed' || status === 'fixed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'pending';
  return settled(orch.status) ? 'skipped' : 'pending';
}

function synthesisState(orch: Orchestration): StepState {
  if (orch.finalResult) return 'done';
  const tasksOver = orch.tasks.every((t) => t.status !== 'running' && t.status !== 'pending');
  if (orch.status === 'running' && orch.synthesisRunId && tasksOver) return 'current';
  if (!settled(orch.status)) return 'pending';
  // It ran and left no report, or it never started because nothing completed or the graph was stopped
  return orch.synthesisRunId && orch.status !== 'stopped' ? 'failed' : 'skipped';
}

/**
 * Offered as a step only when there is one or there can be one: the server refuses a pull request
 * for a graph its own failed checks failed, and a graph without a merged branch has nothing to push.
 */
function pullRequestStep(orch: Orchestration): OrchestrationStep | null {
  if (orch.integration?.pullRequestUrl) return { id: 'pull-request', kind: 'pull-request', state: 'done' };
  if (pullRequestHeld(orch)) return null;
  if (!settled(orch.status) || orch.integration?.status === 'merged') return { id: 'pull-request', kind: 'pull-request', state: 'pending' };
  return null;
}

function workflowStatusState(status: OrchestrationStatus): StepState {
  switch (status) {
    case 'running':
      return 'current';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

function phaseState(agents: readonly ChatWorkflowAgent[], workflowStatus: ChatWorkflow['status']): StepState {
  if (agents.some((a) => a.status === 'running')) return 'current';
  if (agents.some((a) => a.status === 'failed')) return 'failed';
  if (agents.length > 0) return 'done';
  // A phase the script declared and never reached
  return workflowStatus === 'completed' ? 'skipped' : 'pending';
}

/**
 * A workflow's phases as steps, in the order its script declared them, with the agents that ran in
 * each. Agents the CLI reported without a phase make a step of their own. Null when the workflow
 * has not reported a phase or an agent yet: the orchestration is then shown as one step.
 */
export function workflowPhaseSteps(workflow: ChatWorkflow | null | undefined): OrchestrationStep[] | null {
  if (!workflow) return null;
  const groups = new Map<string | null, ChatWorkflowAgent[]>();
  for (const phase of workflow.phases) groups.set(phase, []);
  for (const agent of workflow.agents) {
    const list = groups.get(agent.phase) ?? [];
    list.push(agent);
    groups.set(agent.phase, list);
  }
  if (groups.size === 0) return null;
  return [...groups.entries()].map(([phase, agents], index) => ({
    id: `phase-${index + 1}`,
    kind: 'phase' as const,
    phase,
    agents,
    state: phaseState(agents, workflow.status),
  }));
}

/**
 * Every step of an orchestration. A graph is its stages, then integration and a pull request when
 * it gives each task a worktree, verification when it asked for checks, and synthesis when it
 * asked for a report. A workflow is its phases when `workflow` reports them, else one step.
 */
export function orchestrationSteps(orch: Orchestration, workflow?: ChatWorkflow | null): OrchestrationStep[] {
  const steps: OrchestrationStep[] = [];
  if ((orch.engine ?? 'graph') === 'workflow') {
    steps.push(...(workflowPhaseSteps(workflow) ?? [{ id: 'workflow', kind: 'workflow', state: workflowStatusState(orch.status) }]));
  } else {
    layerTasks(orch.tasks).forEach((tasks, index) => {
      steps.push({
        id: `stage-${index + 1}`,
        kind: 'stage',
        index,
        tasks,
        completed: tasks.filter((t) => t.status === 'completed').length,
        state: stageState(tasks, orch.status),
      });
    });
    if (orch.worktree) steps.push({ id: 'integration', kind: 'integration', state: integrationState(orch) });
    if (orch.verificationSpec || orch.verification) steps.push({ id: 'verification', kind: 'verification', state: verificationState(orch) });
  }
  if (orch.synthesize) steps.push({ id: 'synthesis', kind: 'synthesis', state: synthesisState(orch) });
  if ((orch.engine ?? 'graph') === 'graph' && orch.worktree) {
    const pr = pullRequestStep(orch);
    if (pr) steps.push(pr);
  }
  return steps;
}

/** The step a stepper that follows the orchestration shows: the live one, or the last once everything is behind it. */
export function followedStep(steps: readonly OrchestrationStep[]): OrchestrationStep | undefined {
  const index = currentStepIndex(steps.map((s) => s.state));
  return index === -1 ? steps.at(-1) : steps[index];
}

/**
 * The tasks as a segmented bar counts them. Blocked, stopped and interrupted tasks have not run to
 * an end, so they are still to do; a skipped one was given up on purpose and is shown apart.
 */
export function orchestrationProgress(tasks: readonly OrchestrationTaskState[]): ProgressCounts {
  const counts: ProgressCounts = {};
  const add = (key: keyof ProgressCounts) => (counts[key] = (counts[key] ?? 0) + 1);
  for (const task of tasks) {
    if (task.status === 'completed') add('done');
    else if (task.status === 'running') add('running');
    else if (task.status === 'failed') add('failed');
    else if (task.status === 'skipped') add('skipped');
    else add('pending');
  }
  return counts;
}

/**
 * The running task a one-line summary speaks for, with the stage it is in: one that reports an
 * activity if any does, since "Editing src/…" says more than a task name alone.
 */
export function liveTask(orch: Orchestration): { task: OrchestrationTaskState; stage: number } | null {
  const layers = layerTasks(orch.tasks);
  let found: { task: OrchestrationTaskState; stage: number } | null = null;
  for (const [index, layer] of layers.entries()) {
    for (const task of layer) {
      if (task.status !== 'running') continue;
      if (task.activity) return { task, stage: index + 1 };
      found ??= { task, stage: index + 1 };
    }
  }
  return found;
}
