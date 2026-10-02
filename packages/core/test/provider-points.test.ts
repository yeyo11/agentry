import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionPoint } from '../src/decisions/points.ts';

const ask = (id: 'provider.on-limit' | 'provider.pick' | 'provider.model-map', kind: 'flow_run' | 'model', data: Record<string, unknown>) =>
  decisionPoint(id)?.questions({ kind, id: 's1', data }) ?? [];

const optionIds = (questions: ReturnType<typeof ask>) => questions.flatMap((q) => (q.kind === 'choice' ? q.options.map((o) => o.id) : []));

test('provider.on-limit offers only the allowed actions, and nothing when fewer than two', () => {
  assert.deepEqual(optionIds(ask('provider.on-limit', 'flow_run', { allowed: ['wait', 'handoff'] })), ['handoff', 'wait']);
  assert.deepEqual(optionIds(ask('provider.on-limit', 'flow_run', { allowed: ['handoff', 'restart', 'wait', 'delete'] })), ['handoff', 'restart', 'wait']);
  assert.equal(ask('provider.on-limit', 'flow_run', { allowed: ['wait'] }).length, 0);
  assert.equal(ask('provider.on-limit', 'flow_run', {}).length, 0);
});

test('provider.pick options are the candidates, and a single candidate is not asked', () => {
  const candidates = [
    { id: 'claude', label: 'Claude Code', model: 'sonnet', utilization: 41.6 },
    { id: 'codex', label: 'Codex', model: 'gpt-x', utilization: 12 },
  ];
  const questions = ask('provider.pick', 'flow_run', { candidates });
  assert.deepEqual(optionIds(questions), ['claude', 'codex']);
  const first = questions[0];
  assert.ok(first?.kind === 'choice' && first.options[0]?.label === 'Claude Code: sonnet, 42 % of its limit used');
  assert.equal(ask('provider.pick', 'flow_run', { candidates: candidates.slice(0, 1) }).length, 0);
});

test('provider.model-map cuts the target list at 40 and always offers none', () => {
  const targets = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}` }));
  const ids = optionIds(ask('provider.model-map', 'model', { model: { id: 'sonnet', name: 'Sonnet' }, target: 'Codex', targets }));
  assert.equal(ids.length, 41);
  assert.equal(ids.at(-1), 'none');
  assert.equal(ask('provider.model-map', 'model', { targets: [] }).length, 0);
});

test('the catalogue declares the plan: act on-limit and pick, suggest and global model-map', () => {
  assert.equal(decisionPoint('provider.on-limit')?.kind, 'act');
  assert.equal(decisionPoint('provider.pick')?.maxStateBytes, 4 * 1024);
  assert.equal(decisionPoint('provider.model-map')?.kind, 'suggest');
  assert.equal(decisionPoint('provider.model-map')?.scope, 'global');
});
