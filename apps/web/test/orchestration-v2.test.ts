import assert from 'node:assert/strict';
import test from 'node:test';
import type { Orchestration, OrchestrationTaskState, VerificationState } from '@agentry/shared';
import {
  canRelaunch,
  canRerun,
  cleanTask,
  dependantsOf,
  draftOfVerification,
  EMPTY_VERIFICATION,
  limitsOf,
  parseCommands,
  pullRequestHeld,
  rerunBlockedByPullRequest,
  specOfTask,
  verificationOf,
} from '../src/lib/orchestration-v2.ts';

const VERIFIED: VerificationState = { status: 'passed', attempts: 0, commands: [], commits: [], report: '', costUsd: 0 };

const task = (id: string, extra: Partial<OrchestrationTaskState> = {}): OrchestrationTaskState => ({
  id,
  name: id,
  prompt: 'do it',
  status: 'completed',
  attempts: 1,
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
  status: 'completed',
  cwd: '/repo',
  model: null,
  permissionMode: 'acceptEdits',
  concurrency: 2,
  synthesize: true,
  worktree: true,
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

test('limits carry only what is set: an empty field is the default, not a limit of zero', () => {
  assert.equal(limitsOf(undefined, undefined), undefined);
  assert.equal(limitsOf(0, 0), undefined);
  assert.deepEqual(limitsOf(30, undefined), { maxMinutes: 30 });
  assert.deepEqual(limitsOf(undefined, 2.5), { maxCostUsd: 2.5 });
  assert.deepEqual(limitsOf(30, 2.5), { maxMinutes: 30, maxCostUsd: 2.5 });
});

test('a task is cleaned of whitespace and of the fields a form leaves empty', () => {
  assert.deepEqual(cleanTask({ id: ' a ', name: '  ', prompt: ' go ', dependsOn: [], model: ' ', limits: {} }), { id: 'a', name: 'a', prompt: 'go' });
  assert.deepEqual(cleanTask({ id: 'b', name: 'B', prompt: 'x', dependsOn: ['a'], model: 'opus', limits: { maxMinutes: 5 } }), {
    id: 'b',
    name: 'B',
    prompt: 'x',
    dependsOn: ['a'],
    model: 'opus',
    limits: { maxMinutes: 5 },
  });
});

test('the spec of a task leaves its chat, result and cost behind', () => {
  const spec = specOfTask(task('a', { result: 'done', costUsd: 3, sessionId: 's', dependsOn: ['z'], model: 'sonnet', limits: { maxCostUsd: 1 } }));
  assert.deepEqual(spec, { id: 'a', name: 'a', prompt: 'do it', dependsOn: ['z'], model: 'sonnet', limits: { maxCostUsd: 1 } });
});

test('a finished graph re-runs a task; a running, waiting or workflow graph does not', () => {
  const tasks = [task('a')];
  assert.equal(canRerun(orch(tasks)), true);
  assert.equal(canRerun(orch(tasks, { status: 'failed' })), true);
  assert.equal(canRerun(orch(tasks, { status: 'stopped' })), true);
  assert.equal(canRerun(orch(tasks, { status: 'running' })), false);
  assert.equal(canRerun(orch(tasks, { status: 'waiting' })), false);
  assert.equal(canRerun(orch(tasks, { engine: 'workflow' })), false);
});

test('a graph being integrated, or already pushed for a pull request, does not re-run', () => {
  const tasks = [task('a')];
  const integration = { branch: 'agentry/o1', worktree: null, status: 'merged' as const, merged: [], conflicts: [], commit: null, error: null, integratorRunId: null };
  assert.equal(canRerun(orch(tasks, { integration: { ...integration, status: 'merging' } })), false);
  const pushed = orch(tasks, { integration: { ...integration, pullRequestUrl: 'https://example.com/pr/1' } });
  assert.equal(canRerun(pushed), false);
  assert.equal(rerunBlockedByPullRequest(pushed), true);
  // Without worktrees there is no integration branch to orphan
  assert.equal(canRerun({ ...pushed, worktree: false }), true);
  assert.equal(rerunBlockedByPullRequest(orch(tasks, { status: 'running', integration: { ...integration, pullRequestUrl: 'x' } })), false);
});

test('relaunch is on offer for everything but a running graph', () => {
  assert.equal(canRelaunch(orch([task('a')], { status: 'running' })), false);
  for (const status of ['completed', 'failed', 'stopped', 'waiting'] as const) assert.equal(canRelaunch(orch([task('a')], { status }))!, true);
});

test('a re-run covers the task and everything behind it, directly or not, and nothing else', () => {
  const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] }), task('d'), task('e', { dependsOn: ['d'] })];
  assert.deepEqual(dependantsOf(tasks, 'a'), ['a', 'b', 'c']);
  assert.deepEqual(dependantsOf(tasks, 'c'), ['c']);
  assert.deepEqual(dependantsOf(tasks, 'd'), ['d', 'e']);
});

test('a dependency cycle does not loop the search', () => {
  const tasks = [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })];
  assert.deepEqual(dependantsOf(tasks, 'a'), ['a', 'b']);
});

test('verification commands are one per line, blanks dropped', () => {
  assert.deepEqual(parseCommands('pnpm build\n\n  pnpm e2e  \n'), ['pnpm build', 'pnpm e2e']);
});

test('verification is a spec only when it is on and has something to run', () => {
  assert.equal(verificationOf(EMPTY_VERIFICATION), undefined);
  assert.equal(verificationOf({ ...EMPTY_VERIFICATION, enabled: true, commands: '  \n' }), undefined);
  assert.equal(verificationOf({ ...EMPTY_VERIFICATION, enabled: false, commands: 'pnpm build' }), undefined);
  assert.deepEqual(verificationOf({ ...EMPTY_VERIFICATION, enabled: true, commands: 'pnpm build\npnpm e2e', fixer: true, maxAttempts: 0, model: ' opus ' }), {
    commands: ['pnpm build', 'pnpm e2e'],
    fixer: true,
    maxAttempts: 1,
    model: 'opus',
  });
});

test('a verification spec round-trips through the form draft', () => {
  const spec = { commands: ['pnpm build', 'pnpm e2e'], fixer: false, maxAttempts: 3, model: 'sonnet' };
  assert.deepEqual(verificationOf(draftOfVerification(spec)), spec);
  assert.equal(draftOfVerification(undefined), EMPTY_VERIFICATION);
});

test('the fixer ceiling, the install step and failGraph round-trip through the draft', () => {
  const detected = { commands: ['pnpm e2e'], fixer: true, maxAttempts: 2, maxCostUsd: 1.5, failGraph: true };
  assert.deepEqual(verificationOf(draftOfVerification(detected)), detected);
  assert.equal(draftOfVerification(detected).install, 'detected');
  const none = { commands: ['pnpm e2e'], fixer: true, maxAttempts: 2, install: null };
  assert.deepEqual(verificationOf(draftOfVerification(none)), none);
  assert.equal(draftOfVerification(none).install, 'none');
  const own = { commands: ['pnpm e2e'], fixer: true, maxAttempts: 2, install: 'pnpm i' };
  assert.deepEqual(verificationOf(draftOfVerification(own)), own);
  assert.equal(draftOfVerification(own).install, 'command');
});

test('an empty install command is detection, and a cost ceiling needs a fixer', () => {
  const base = { ...EMPTY_VERIFICATION, enabled: true, commands: 'pnpm e2e' };
  assert.equal('install' in (verificationOf({ ...base, install: 'command', installCommand: '  ' }) ?? {}), false);
  assert.equal(verificationOf({ ...base, fixer: false, maxCostUsd: 2 })?.maxCostUsd, undefined);
  assert.equal(verificationOf({ ...base, maxCostUsd: 2 })?.maxCostUsd, 2);
});

test('a pull request is held back only for a graph its failed checks failed', () => {
  const spec = { commands: ['pnpm e2e'], fixer: false, maxAttempts: 1 };
  assert.equal(pullRequestHeld({ verificationSpec: { ...spec, failGraph: true }, verification: { ...VERIFIED, status: 'failed' } }), true);
  assert.equal(pullRequestHeld({ verificationSpec: spec, verification: { ...VERIFIED, status: 'failed' } }), false);
  assert.equal(pullRequestHeld({ verificationSpec: { ...spec, failGraph: true }, verification: VERIFIED }), false);
});
