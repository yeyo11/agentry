import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatWorkflow, ChatWorkflowAgent, Orchestration, OrchestrationTaskState, VerificationState } from '@agentry/shared';
import { followedStep, layerTasks, liveTask, orchestrationProgress, orchestrationSteps, stageState, taskStage, workflowPhaseSteps } from '../src/lib/orchestration-steps.ts';

const task = (id: string, extra: Partial<OrchestrationTaskState> = {}): OrchestrationTaskState => ({
  id,
  name: id,
  prompt: 'do it',
  status: 'pending',
  attempts: 0,
  runId: null,
  sessionId: null,
  result: null,
  error: null,
  startedAt: null,
  endedAt: null,
  costUsd: 0,
  ...extra,
});

const orch = (tasks: OrchestrationTaskState[], extra: Partial<Orchestration> = {}): Orchestration => ({
  id: 'o1',
  name: 'graph',
  objective: null,
  status: 'running',
  cwd: '/repo',
  model: null,
  permissionMode: 'acceptEdits',
  concurrency: 2,
  synthesize: false,
  worktree: false,
  maxAttempts: 2,
  allowedTools: [],
  permissionPrompts: 'host',
  createdAt: '2026-01-01T00:00:00Z',
  endedAt: null,
  tasks,
  finalResult: null,
  costUsd: 0,
  engine: 'graph',
  ...extra,
});

const verification = (status: VerificationState['status']): VerificationState => ({ status, attempts: 0, commands: [], commits: [], report: '', costUsd: 0 });

const integration = (status: NonNullable<Orchestration['integration']>['status'], extra: Partial<NonNullable<Orchestration['integration']>> = {}) => ({
  branch: 'agentry/graph',
  worktree: '/wt/integration',
  status,
  merged: [],
  conflicts: [],
  commit: null,
  error: null,
  integratorRunId: null,
  ...extra,
});

const shape = (o: Orchestration, workflow?: ChatWorkflow | null) => orchestrationSteps(o, workflow).map((s) => `${s.id}:${s.state}`);

// ---------- the graph's stages ----------

test('the stages are the levels of the dependency graph, in order', () => {
  const layers = layerTasks([task('api'), task('web', { dependsOn: ['api'] }), task('docs'), task('e2e', { dependsOn: ['web', 'docs'] })]);
  assert.deepEqual(
    layers.map((l) => l.map((t) => t.id)),
    [['api', 'docs'], ['web'], ['e2e']],
  );
});

test("a task's stage is the level it sits at, out of every level of the graph", () => {
  const tasks = [task('api'), task('web', { dependsOn: ['api'] }), task('docs'), task('e2e', { dependsOn: ['web', 'docs'] })];
  assert.deepEqual(taskStage(tasks, 'docs'), { at: 1, of: 3 });
  assert.deepEqual(taskStage(tasks, 'web'), { at: 2, of: 3 });
  assert.deepEqual(taskStage(tasks, 'e2e'), { at: 3, of: 3 });
  // The chat of a task the graph no longer has (edited on a relaunch) has no stage to show
  assert.equal(taskStage(tasks, 'gone'), null);
});

test('a dependency cycle does not hang the layering', () => {
  const layers = layerTasks([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })]);
  assert.equal(layers.flat().length, 2);
});

test('a running graph shows its finished stage done, the running one current and the next pending', () => {
  const o = orch([task('a', { status: 'completed' }), task('b', { status: 'running', dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })]);
  assert.deepEqual(shape(o), ['stage-1:done', 'stage-2:current', 'stage-3:pending']);
  assert.equal(followedStep(orchestrationSteps(o))?.id, 'stage-2');
});

test('a stage part done with the rest queued behind the concurrency limit is still under way', () => {
  assert.equal(stageState([task('a', { status: 'completed' }), task('b')], 'running'), 'current');
});

test('a failed task in a waiting graph makes its stage wait for a person, and so does a blocked one', () => {
  const o = orch([task('a', { status: 'failed' }), task('b', { status: 'blocked', dependsOn: ['a'] })], { status: 'waiting' });
  assert.deepEqual(shape(o), ['stage-1:waiting', 'stage-2:waiting']);
  assert.equal(followedStep(orchestrationSteps(o))?.id, 'stage-1');
});

test('a failed task in a graph that has ended leaves its stage failed', () => {
  const o = orch([task('a', { status: 'failed' }), task('b', { status: 'completed' })], { status: 'failed' });
  assert.deepEqual(shape(o), ['stage-1:failed']);
});

test('a stage whose every task was given up is skipped, one with some given up and the rest done is done', () => {
  assert.equal(stageState([task('a', { status: 'skipped' })], 'completed'), 'skipped');
  assert.equal(stageState([task('a', { status: 'skipped' }), task('b', { status: 'completed' })], 'completed'), 'done');
});

test('stopped and interrupted tasks leave their stage pending: resuming picks them up again', () => {
  assert.equal(stageState([task('a', { status: 'completed' }), task('b', { status: 'stopped' })], 'stopped'), 'pending');
  assert.equal(stageState([task('a', { status: 'interrupted' })], 'stopped'), 'pending');
});

test('the stage counts what completed, not what merely ended', () => {
  const [stage] = orchestrationSteps(orch([task('a', { status: 'completed' }), task('b', { status: 'failed' })], { status: 'failed' }));
  assert.equal(stage?.kind === 'stage' && stage.completed, 1);
});

// ---------- integration ----------

test('a worktree graph merges its branches after the stages: pending while the tasks run, current while merging', () => {
  const running = orch([task('a', { status: 'running' })], { worktree: true });
  assert.deepEqual(shape(running), ['stage-1:current', 'integration:pending', 'pull-request:pending']);
  const merging = orch([task('a', { status: 'completed', branch: 'b/a' })], { worktree: true, integration: integration('resolving') });
  assert.deepEqual(shape(merging), ['stage-1:done', 'integration:current', 'pull-request:pending']);
  assert.equal(followedStep(orchestrationSteps(merging))?.id, 'integration');
});

test('an integration that conflicted or failed is a failed step', () => {
  for (const status of ['conflicted', 'failed'] as const) {
    const o = orch([task('a', { status: 'completed', branch: 'b/a' })], { status: 'completed', worktree: true, integration: integration(status) });
    assert.equal(orchestrationSteps(o).find((s) => s.id === 'integration')?.state, 'failed', status);
  }
});

test('a finished graph with nothing completed on a branch never had anything to integrate', () => {
  const o = orch([task('a', { status: 'failed' })], { status: 'failed', worktree: true });
  assert.equal(orchestrationSteps(o).find((s) => s.id === 'integration')?.state, 'skipped');
});

test('a finished graph whose branches were never merged can still be integrated', () => {
  const o = orch([task('a', { status: 'completed', branch: 'b/a' })], { status: 'completed', worktree: true });
  assert.equal(orchestrationSteps(o).find((s) => s.id === 'integration')?.state, 'pending');
});

// ---------- verification ----------

test('the checks come after the merge they run on, and read as the phase the verification is in', () => {
  const base = { worktree: true, verificationSpec: { commands: ['pnpm test'], fixer: true, maxAttempts: 2 } };
  const done = [task('a', { status: 'completed', branch: 'b/a' })];
  assert.deepEqual(shape(orch(done, { ...base, integration: integration('merged'), verification: verification('running') })), [
    'stage-1:done',
    'integration:done',
    'verification:current',
    'pull-request:pending',
  ]);
  assert.equal(orchestrationSteps(orch(done, { ...base, status: 'completed', integration: integration('merged'), verification: verification('fixed') })).find((s) => s.id === 'verification')?.state, 'done');
  assert.equal(orchestrationSteps(orch(done, { ...base, verification: verification('pending') })).find((s) => s.id === 'verification')?.state, 'pending');
});

test('checks that never ran on a graph that ended are skipped', () => {
  const o = orch([task('a', { status: 'stopped' })], { status: 'stopped', worktree: true, verificationSpec: { commands: ['pnpm test'], fixer: false, maxAttempts: 1 } });
  assert.equal(orchestrationSteps(o).find((s) => s.id === 'verification')?.state, 'skipped');
});

test('failed checks fail their step, and when they fail the graph no pull request is offered', () => {
  const spec = { commands: ['pnpm test'], fixer: true, maxAttempts: 2 };
  const done = [task('a', { status: 'completed', branch: 'b/a' })];
  const soft = orch(done, { status: 'completed', worktree: true, verificationSpec: spec, verification: verification('failed'), integration: integration('merged') });
  assert.deepEqual(shape(soft), ['stage-1:done', 'integration:done', 'verification:failed', 'pull-request:pending']);
  const hard = orch(done, { status: 'failed', worktree: true, verificationSpec: { ...spec, failGraph: true }, verification: verification('failed'), integration: integration('merged') });
  assert.deepEqual(shape(hard), ['stage-1:done', 'integration:done', 'verification:failed']);
  assert.equal(followedStep(orchestrationSteps(hard))?.id, 'verification');
});

// ---------- pull request ----------

test('an opened pull request is a done step, and a finished graph with a merged branch offers one', () => {
  const done = [task('a', { status: 'completed', branch: 'b/a' })];
  const opened = orch(done, { status: 'completed', worktree: true, integration: integration('merged', { pullRequestUrl: 'https://example.test/pr/1' }) });
  assert.deepEqual(shape(opened), ['stage-1:done', 'integration:done', 'pull-request:done']);
  const offered = orch(done, { status: 'completed', worktree: true, integration: integration('merged') });
  assert.equal(followedStep(orchestrationSteps(offered))?.id, 'pull-request');
});

test('a finished graph with nothing merged has no pull request step', () => {
  const o = orch([task('a', { status: 'failed' })], { status: 'failed', worktree: true });
  assert.equal(orchestrationSteps(o).some((s) => s.id === 'pull-request'), false);
});

test('a graph without worktrees has neither integration nor pull request', () => {
  assert.deepEqual(shape(orch([task('a', { status: 'running' })])), ['stage-1:current']);
});

// ---------- synthesis ----------

test('the synthesis is current once it has started on finished tasks, and done with its report', () => {
  const done = [task('a', { status: 'completed' })];
  assert.deepEqual(shape(orch(done, { synthesize: true, synthesisRunId: 'run-s' })), ['stage-1:done', 'synthesis:current']);
  assert.deepEqual(shape(orch(done, { synthesize: true, status: 'completed', finalResult: 'report' })), ['stage-1:done', 'synthesis:done']);
  // Tasks still running: the synthesis of an earlier run of the graph is not this one's
  assert.deepEqual(shape(orch([task('a', { status: 'running' })], { synthesize: true, synthesisRunId: 'old' })), ['stage-1:current', 'synthesis:pending']);
});

test('a synthesis held by a graph that waits for a decision is pending, not waiting: the tasks are what wait', () => {
  const o = orch([task('a', { status: 'failed' })], { status: 'waiting', synthesize: true });
  assert.deepEqual(shape(o), ['stage-1:waiting', 'synthesis:pending']);
});

test('a synthesis that ran without a report failed; one that never started on a stopped graph is skipped', () => {
  const done = [task('a', { status: 'completed' })];
  assert.equal(orchestrationSteps(orch(done, { synthesize: true, status: 'completed', synthesisRunId: 'run-s' })).at(-1)?.state, 'failed');
  assert.equal(orchestrationSteps(orch([task('a', { status: 'stopped' })], { synthesize: true, status: 'stopped' })).at(-1)?.state, 'skipped');
});

test('the steps of a finished graph run integration, verification, synthesis and the pull request in the order the core does', () => {
  const o = orch([task('a', { status: 'completed', branch: 'b/a' })], {
    status: 'completed',
    worktree: true,
    synthesize: true,
    finalResult: 'report',
    verificationSpec: { commands: ['pnpm test'], fixer: true, maxAttempts: 2 },
    verification: verification('passed'),
    integration: integration('merged', { pullRequestUrl: 'https://example.test/pr/1' }),
  });
  assert.deepEqual(shape(o), ['stage-1:done', 'integration:done', 'verification:done', 'synthesis:done', 'pull-request:done']);
  // Everything behind it: the stepper rests on the last step
  assert.equal(followedStep(orchestrationSteps(o))?.id, 'pull-request');
});

// ---------- the workflow engine ----------

const agent = (index: number, phase: string | null, status: ChatWorkflowAgent['status']): ChatWorkflowAgent =>
  ({ index, label: `agent ${index}`, status, id: null, phase }) as ChatWorkflowAgent;

const workflow = (phases: string[], agents: ChatWorkflowAgent[], status: ChatWorkflow['status'] = 'running'): ChatWorkflow => ({
  id: 'wf_1',
  name: 'wf',
  description: '',
  status,
  startedAt: '2026-01-01T00:00:00Z',
  endedAt: null,
  phases,
  agents,
  summary: null,
  totalTokens: null,
  script: null,
});

test('a workflow is its phases when the workflow reports them', () => {
  const o = orch([task('a')], { engine: 'workflow' });
  const wf = workflow(['Review', 'Verify', 'Report'], [agent(0, 'Review', 'completed'), agent(1, 'Verify', 'running')]);
  assert.deepEqual(shape(o, wf), ['phase-1:done', 'phase-2:current', 'phase-3:pending']);
  assert.equal(followedStep(orchestrationSteps(o, wf))?.id, 'phase-2');
});

test('a failed agent fails its phase, and a phase a finished workflow never reached is skipped', () => {
  const o = orch([task('a')], { engine: 'workflow', status: 'failed' });
  const wf = workflow(['Review', 'Report'], [agent(0, 'Review', 'failed')], 'completed');
  assert.deepEqual(shape(o, wf), ['phase-1:failed', 'phase-2:skipped']);
});

test('agents without a phase make a step of their own', () => {
  const steps = workflowPhaseSteps(workflow([], [agent(0, null, 'running')]));
  assert.equal(steps?.length, 1);
  assert.equal(steps?.[0]?.kind === 'phase' && steps[0].phase, null);
});

test('a workflow that has reported nothing yet is one step that says where the orchestration is', () => {
  assert.deepEqual(shape(orch([task('a')], { engine: 'workflow' })), ['workflow:current']);
  assert.deepEqual(shape(orch([task('a')], { engine: 'workflow', status: 'waiting' }), workflow([], [])), ['workflow:waiting']);
  assert.deepEqual(shape(orch([task('a')], { engine: 'workflow', status: 'completed', synthesize: true, finalResult: 'r' })), ['workflow:done', 'synthesis:done']);
});

// ---------- progress and the live line ----------

test('the bar counts blocked, stopped and interrupted tasks as still to do and given-up ones apart', () => {
  const counts = orchestrationProgress([
    task('a', { status: 'completed' }),
    task('b', { status: 'running' }),
    task('c', { status: 'failed' }),
    task('d', { status: 'blocked' }),
    task('e', { status: 'stopped' }),
    task('f', { status: 'interrupted' }),
    task('g', { status: 'skipped' }),
    task('h'),
  ]);
  assert.deepEqual(counts, { done: 1, running: 1, failed: 1, pending: 4, skipped: 1 });
});

test('the live line speaks for a running task that says what it is doing, with its stage', () => {
  const o = orch([
    task('a', { status: 'completed' }),
    task('b', { status: 'running', dependsOn: ['a'] }),
    task('c', { status: 'running', dependsOn: ['a'], activity: { kind: 'tool', tool: 'Edit', target: 'src/x.ts', since: '2026-01-01T00:00:00Z' } }),
  ]);
  assert.deepEqual(liveTask(o) && { id: liveTask(o)?.task.id, stage: liveTask(o)?.stage }, { id: 'c', stage: 2 });
  assert.equal(liveTask(orch([task('a', { status: 'running' })]))?.task.id, 'a');
  assert.equal(liveTask(orch([task('a', { status: 'completed' })])), null);
});
