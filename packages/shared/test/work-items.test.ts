import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkItemLinkRole } from '../src/index.ts';
import {
  parseWorkItemKey,
  valuesOf,
  WORK_ITEM_KEY_PREFIX_PATTERN,
  WORK_ITEM_LINK_KINDS,
  WORK_ITEM_LINK_ROLES,
  WORK_ITEM_SOURCE_KINDS,
  WORK_ITEM_STATUSES,
  workItemBranch,
  workItemKey,
} from '../src/index.ts';

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

test('a value list cannot drift from its union, in either direction', () => {
  type Column = 'todo' | 'done';
  const columns = valuesOf<Column>()(['todo', 'done']);
  assert.deepEqual(columns, ['todo', 'done']);
  // Checked by the type check of this file: each line below must fail to compile
  // @ts-expect-error a member of the union left out of the list
  valuesOf<Column>()(['todo']);
  // @ts-expect-error a value the union does not have
  valuesOf<Column>()(['todo', 'done', 'doing']);
});

test('what can act on an item is a subset of what can be linked to it, and roles follow the columns', () => {
  for (const kind of WORK_ITEM_SOURCE_KINDS) assert.ok((WORK_ITEM_LINK_KINDS as readonly string[]).includes(kind));
  const byColumn: Record<'backlog' | 'todo' | 'in_progress' | 'in_review', WorkItemLinkRole> = {
    backlog: 'refine',
    todo: 'refine',
    in_progress: 'work',
    in_review: 'verify',
  };
  for (const role of Object.values(byColumn)) assert.ok(WORK_ITEM_LINK_ROLES.includes(role));
});
