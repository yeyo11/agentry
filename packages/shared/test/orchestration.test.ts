import assert from 'node:assert/strict';
import test from 'node:test';
import type { Orchestration, OrchestrationTaskState } from '../src/index.ts';
import { cleanTask, specOfOrchestration, specOfTask } from '../src/index.ts';

const node = (fields: Partial<OrchestrationTaskState> = {}): OrchestrationTaskState => ({
  id: 'agn-1',
  name: 'AGN-1 API',
  prompt: 'AGN-1: API',
  status: 'completed',
  attempts: 1,
  runId: 'worker-1',
  sessionId: 'worker-1',
  result: 'done',
  error: null,
  startedAt: null,
  endedAt: null,
  costUsd: 0,
  workItemId: 'item-1',
  ...fields,
});

test('a node relaunched, or edited and relaunched, still names the work item it works on', () => {
  assert.equal(specOfTask(node()).workItemId, 'item-1');
  assert.equal(cleanTask(specOfTask(node())).workItemId, 'item-1');
  const graph = { name: 'g', cwd: '/repo', tasks: [node()] } as unknown as Orchestration;
  assert.equal(specOfOrchestration(graph).tasks[0]?.workItemId, 'item-1');
  assert.equal('workItemId' in specOfTask(node({ workItemId: undefined })), false);
});
