import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, Check } from '@agentry/shared';
import { checkDurationMs, checkMark, checksActions, clockOf, countChecks, fixStage, groupChecks } from '../src/lib/change-requests';
import { keys } from '../src/api';
import { targetMatches, targetsFor } from '../src/lib/events';

const check = (over: Partial<Check>): Check => ({
  id: '1', name: 'unit-tests', group: 'test', state: 'passed', allowedToFail: false, required: false,
  startedAt: null, finishedAt: null, url: null, rerunnable: true, hasLog: true, source: 'job', ...over,
});

test('the list is grouped failing, running, passed, skipped, and an empty group is left out', () => {
  const groups = groupChecks([
    check({ id: 'a', state: 'passed' }), check({ id: 'b', state: 'queued' }), check({ id: 'c', state: 'failed' }),
    check({ id: 'd', state: 'failed', allowedToFail: true }), check({ id: 'e', state: 'manual' }),
  ]);
  assert.deepEqual(groups.map((g) => g.id), ['failed', 'running', 'passed', 'skipped']);
  assert.equal(groups[0]?.allowed, 1);
  assert.deepEqual(groupChecks([check({ state: 'passed' })]).map((g) => g.id), ['passed']);
});

test('an allowed failure is a warning counted apart from failures', () => {
  const list = [check({ state: 'failed' }), check({ state: 'failed', allowedToFail: true }), check({ state: 'running' })];
  assert.deepEqual(countChecks(list), { failed: 1, allowed: 1, running: 1, passed: 0, skipped: 0 });
  assert.deepEqual(checkMark(list[1]!), { tone: 'warn', label: 'state.allowedFailure' });
  assert.equal(checkMark(list[0]!).tone, 'bad');
});

test('only a running check is live', () => {
  const states = ['queued', 'running', 'passed', 'failed', 'cancelled', 'skipped', 'manual', 'neutral'] as const;
  assert.equal(states.filter((state) => checkMark(check({ state })).tone === 'live').length, 1);
});

test('a running check keeps counting and a finished one stops', () => {
  const startedAt = '2026-10-01T10:00:00Z';
  const now = Date.parse('2026-10-01T10:02:14Z');
  assert.equal(checkDurationMs(check({ state: 'running', startedAt }), now), 134_000);
  assert.equal(checkDurationMs(check({ startedAt, finishedAt: '2026-10-01T10:00:48Z' }), now), 48_000);
  assert.equal(checkDurationMs(check({ state: 'manual' }), now), null);
  assert.equal(clockOf(134_000), '2:14');
  assert.equal(clockOf(3_723_000), '1:02:03');
});

test('the section offers only what can do something', () => {
  const failing = { checks: [check({ state: 'failed' }), check({ state: 'running' })] };
  assert.deepEqual(checksActions(failing, { fixState: null }), { rerunFailed: true, rerunAll: true, cancel: true, fix: true });
  assert.equal(checksActions(failing, { fixState: 'fixing' }).fix, false);
  assert.equal(checksActions({ checks: [check({ state: 'failed', allowedToFail: true })] }, { fixState: null }).fix, false);
  assert.equal(checksActions({ checks: [check({ state: 'failed', rerunnable: false })] }, undefined).rerunFailed, false);
  assert.equal(checksActions(undefined, undefined).cancel, false);
});

test('a fix is fixing, verifying or waiting for its push', () => {
  assert.equal(fixStage({ fixState: 'fixing' }), 'fixing');
  assert.equal(fixStage({ fixState: 'awaiting-verify' }), 'verifying');
  assert.equal(fixStage({ fixState: 'awaiting-push' }), 'push');
  assert.equal(fixStage({ fixState: null }), null);
});

test('change-request.checks refreshes the request, its list and its logs, and nothing of another', () => {
  const event = { id: 1, type: 'change-request.checks', title: 'Checks failing', changeRequestId: 'cr-1', rollup: 'failing', headSha: 'abc' } as unknown as AgentryEvent;
  const targets = targetsFor(event);
  assert.equal(targets.length, 1);
  const target = targets[0]!;
  assert.ok(targetMatches(target, keys.changeRequestChecks('cr-1')));
  assert.ok(targetMatches(target, keys.checkLog('cr-1', 'job-9')));
  assert.ok(!targetMatches(target, keys.changeRequestChecks('cr-2')));
});
