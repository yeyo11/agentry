import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionsOf } from '../src/pages/home/ProjectDecisions';

// The project's Decisions override (D3 u3): what is written back into the project's settings.

test('nothing that differs from the global writes no decisions field', () => {
  assert.equal(decisionsOf('inherit', {}), undefined);
  assert.equal(decisionsOf('inherit', { 'flow.bounce': {} }), undefined);
});

test('the provider is kept only when it is not inherited', () => {
  assert.deepEqual(decisionsOf('jev', {}), { provider: 'jev' });
  assert.deepEqual(decisionsOf('cli', {}), { provider: 'cli' });
});

test('an override keeps only the fields that were set, and drops emptied points', () => {
  assert.deepEqual(decisionsOf('inherit', { 'flow.bounce': { mode: 'active', threshold: 0.9 }, 'team.assign': { mode: 'shadow' }, 'flow.restart': {} }), {
    points: { 'flow.bounce': { mode: 'active', threshold: 0.9 }, 'team.assign': { mode: 'shadow' } },
  });
});
