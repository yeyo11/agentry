import assert from 'node:assert/strict';
import test from 'node:test';
import { currentStepIndex, progressBlocks, progressSegments, progressTotal, stepCounts, type StepState } from '../src/lib/progress.ts';

// A segmented bar is read at a glance: it has to fill its track exactly, and a single failure among
// seventeen tasks has to be visible even when the bar is five characters wide.

test('the segments of a bar always add up to the whole track', () => {
  for (const counts of [{ done: 11, running: 1, failed: 1, pending: 4 }, { done: 1, pending: 2 }, { done: 1, running: 1, failed: 1, pending: 1, skipped: 1 }, { done: 7 }]) {
    const segments = progressSegments(counts);
    assert.equal(
      segments.reduce((sum, s) => sum + s.percent, 0),
      100,
      JSON.stringify(counts),
    );
  }
});

test('the segments keep the drawing order and drop the statuses with nothing in them', () => {
  const segments = progressSegments({ pending: 4, done: 11, failed: 1 });
  assert.deepEqual(
    segments.map((s) => s.status),
    ['done', 'failed', 'pending'],
  );
});

test('nothing to show is no segments at all, not a bar of zeroes', () => {
  assert.deepEqual(progressSegments({}), []);
  assert.deepEqual(progressSegments({ done: 0, pending: 0 }), []);
  assert.equal(progressTotal({ done: 0 }), 0);
});

test('a negative or fractional count cannot bend the bar', () => {
  assert.equal(progressTotal({ done: -3, pending: 2.7 }), 2);
});

test('blocks fill from done and leave the rest pending', () => {
  assert.deepEqual(progressBlocks({ done: 2, pending: 2 }, 4), ['done', 'done', 'pending', 'pending']);
  assert.deepEqual(progressBlocks({ done: 4 }, 4), ['done', 'done', 'done', 'done']);
  assert.deepEqual(progressBlocks({}, 5), ['pending', 'pending', 'pending', 'pending', 'pending']);
});

test('one failure among many still takes a block, and the blocks never overflow', () => {
  const cells = progressBlocks({ done: 11, running: 1, failed: 1, pending: 4 }, 5);
  assert.equal(cells.length, 5);
  assert.ok(cells.includes('failed'), cells.join(''));
  assert.ok(cells.includes('done'), cells.join(''));
});

test('a step in flight or blocked on a person counts as running in the bar', () => {
  const states: StepState[] = ['done', 'done', 'current', 'waiting', 'pending', 'failed', 'skipped'];
  assert.deepEqual(stepCounts(states), { done: 2, running: 2, pending: 1, failed: 1, skipped: 1 });
});

test('the stepper follows what is being worked on, then what waits, then what is next', () => {
  assert.equal(currentStepIndex(['done', 'current', 'pending']), 1);
  assert.equal(currentStepIndex(['done', 'waiting', 'pending']), 1);
  assert.equal(currentStepIndex(['done', 'failed', 'pending']), 1);
  assert.equal(currentStepIndex(['done', 'done', 'pending']), 2);
  assert.equal(currentStepIndex(['done', 'done']), -1);
});
