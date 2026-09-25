import assert from 'node:assert/strict';
import test from 'node:test';
import { usageTone } from '../src/components/motion.tsx';

test('usage bars are neutral below 60 %, warn from 60 % and bad from 75 % or when exhausted', () => {
  assert.equal(usageTone(0), 'neutral');
  assert.equal(usageTone(59.9), 'neutral');
  assert.equal(usageTone(60), 'warn');
  assert.equal(usageTone(74.9), 'warn');
  assert.equal(usageTone(75), 'bad');
  assert.equal(usageTone(100), 'bad');
  assert.equal(usageTone(10, true), 'bad');
});
