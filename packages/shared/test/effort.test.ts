import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effortRecommendation, isEffort, recommendedEffort, type EffortUse } from '../src/index.ts';

const MEDIUM_USES: EffortUse[] = ['chat', 'refine', 'verify', 'work', 'worker', 'assistant'];

test('opus is medium for every use, by alias or by id', () => {
  for (const model of ['opus', 'claude-opus-5-5', 'Claude-Opus-5-5', 'opus[1m]', 'claude-opus-5-5-20260901']) {
    for (const use of [...MEDIUM_USES, 'planner', 'fixer'] as EffortUse[]) assert.equal(recommendedEffort(model, use), 'medium', `${model} ${use}`);
  }
});

test('sonnet is medium, and high for the planner and the fixer', () => {
  for (const model of ['sonnet', 'claude-sonnet-5-5']) {
    for (const use of MEDIUM_USES) assert.equal(recommendedEffort(model, use), 'medium');
    assert.equal(recommendedEffort(model, 'planner'), 'high');
    assert.equal(recommendedEffort(model, 'fixer'), 'high');
  }
  assert.equal(effortRecommendation('sonnet', 'fixer')?.reason, 'sonnet-high');
  assert.equal(effortRecommendation('opus', 'work')?.reason, 'opus-medium');
});

test('a model it does not know gets none', () => {
  for (const model of ['haiku', 'claude-haiku-4-5-20251001', 'claude-opus-4-1', 'claude-sonnet-4-5', 'gpt-6.1-sol', '', null, undefined]) {
    assert.equal(recommendedEffort(model, 'work'), null, String(model));
    assert.equal(effortRecommendation(model, 'planner'), null);
  }
});

test('isEffort accepts the five levels only', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(isEffort(level), true);
  for (const level of ['minimal', 'HIGH', '', null, 3]) assert.equal(isEffort(level), false);
});
