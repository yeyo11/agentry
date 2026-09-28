import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryKey } from '@tanstack/react-query';
import { FLOW_STEP_OF_COLUMN, flowStepOf } from '@agentry/shared';
import { api, keys } from '../src/api';

// The contract of orchestration 7 (docs/plans/project-ecosystem.md, "ecosystem-design") as the web
// reads it: the Team activity filtered by role, outcome and a moment, and "Reintentar" on a failed run.

const realFetch = globalThis.fetch;

async function asked<T>(call: () => Promise<T>): Promise<{ requests: Array<{ path: string; method: string }>; result: T }> {
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ path: String(input), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ id: 'r2' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return { requests, result: await call() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('"Reintentar" posts to the run\'s retry route and gets the new run back', async () => {
  const retry = await asked(() => api.retryFlowRun('r 1'));
  assert.deepEqual(retry.requests, [{ path: '/api/flow-runs/r%201/retry', method: 'POST' }]);
  assert.deepEqual(retry.result, { id: 'r2' });
});

test('the Team activity asks by role and from a moment, and each filter is its own cache entry under the project', async () => {
  const page = await asked(() => api.flowRuns('p1', { role: ['qa'], status: ['failed'], before: '2026-09-28T00:00:00.000Z', limit: 50 }));
  assert.deepEqual(page.requests.map((r) => r.path), ['/api/projects/p1/flow/runs?role=qa&status=failed&before=2026-09-28T00%3A00%3A00.000Z&limit=50']);
  const under = (prefix: QueryKey, key: QueryKey) => prefix.every((part, i) => JSON.stringify(part) === JSON.stringify(key[i]));
  assert.ok(under(keys.flowRunsOf('p1'), keys.flowRuns('p1', { role: ['qa'], before: 'x' })));
  assert.notDeepEqual(keys.flowRuns('p1', { role: ['qa'] }), keys.flowRuns('p1', { agent: ['qa'] }));
  assert.notDeepEqual(keys.flowRuns('p1', { before: 'a' }), keys.flowRuns('p1'));
  assert.deepEqual(keys.flowRuns('p1', { role: ['qa', 'developer'] }), keys.flowRuns('p1', { role: ['developer', 'qa'] }));
});

test("the Product Owner's refine is named by its column: refining in backlog, checking in todo", () => {
  assert.deepEqual(FLOW_STEP_OF_COLUMN, { backlog: 'refine', todo: 'check', in_progress: 'work', in_review: 'verify', done: null });
  assert.equal(flowStepOf('refine', 'todo'), 'check');
  assert.equal(flowStepOf('refine', 'backlog'), 'refine');
  // A stage stored against a column that is not its own keeps the stage's name
  assert.equal(flowStepOf('verify', 'todo'), 'verify');
  assert.equal(flowStepOf('work', 'done'), 'work');
});
