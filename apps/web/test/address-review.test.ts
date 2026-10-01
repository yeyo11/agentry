import assert from 'node:assert/strict';
import test from 'node:test';
import { triageMarksOf } from '../src/pages/tasks/item/AddressReview';

test('review.triage answers become marks by thread id; anything else is left unmarked', () => {
  const choice = (value: string) => ({ kind: 'choice' as const, value, probabilities: null, confidence: null });
  const marks = triageMarksOf({
    answers: {
      a: choice('agent'),
      b: choice('person'),
      c: choice('no-action'),
      d: choice('something-new'),
      e: { kind: 'noul', value: true, probability: null, confidence: null },
    },
  });
  assert.deepEqual(marks, { a: 'agent', b: 'person', c: 'no-action' });
  assert.deepEqual(triageMarksOf(null), {});
  assert.deepEqual(triageMarksOf({ answers: null }), {});
});
