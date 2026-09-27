import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkItemKey, WORK_ITEM_KEY_PREFIX_PATTERN, WORK_ITEM_STATUSES, workItemBranch, workItemKey } from '../src/index.ts';

test('the board has five columns, backlog first and done last', () => {
  assert.deepEqual(WORK_ITEM_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review', 'done']);
});

test('a key round-trips through its prefix and number', () => {
  const key = workItemKey('AGN', 12);
  assert.equal(key, 'AGN-12');
  assert.deepEqual(parseWorkItemKey(key), { prefix: 'AGN', number: 12 });
  // Typed by hand in a search box
  assert.deepEqual(parseWorkItemKey('agn-12'), { prefix: 'AGN', number: 12 });
});

test('what is not a key parses to null instead of a half-read one', () => {
  for (const text of ['AGN', 'AGN-', 'AGN-0', 'AGN-012', '1AB-3', 'A-3', 'AGN-12-3', 'fix the build']) {
    assert.equal(parseWorkItemKey(text), null, text);
  }
});

test('a prefix a clash left with a digit is still a valid prefix', () => {
  assert.ok(WORK_ITEM_KEY_PREFIX_PATTERN.test('AGN'));
  assert.ok(WORK_ITEM_KEY_PREFIX_PATTERN.test('AGN2'));
  assert.ok(!WORK_ITEM_KEY_PREFIX_PATTERN.test('agn'));
  assert.ok(!WORK_ITEM_KEY_PREFIX_PATTERN.test('A'));
  assert.ok(!WORK_ITEM_KEY_PREFIX_PATTERN.test('2AG'));
});

test('an item is worked on a lower case task branch', () => {
  assert.equal(workItemBranch('AGN-12'), 'task/agn-12');
});
