import assert from 'node:assert/strict';
import test from 'node:test';
import { rankBetween, spreadRanks } from '../src/work-item-rank.ts';

test('a rank always falls strictly between its neighbours, at either end and in the middle', () => {
  const first = rankBetween(null, null);
  const before = rankBetween(null, first);
  const after = rankBetween(first, null);
  const middle = rankBetween(first, after);
  assert.ok(before < first && first < middle && middle < after);
});

test('inserting again and again at the same spot keeps finding room', () => {
  // The worst case for a person dragging: every card dropped right after the same one
  let low = rankBetween(null, null);
  const high = rankBetween(low, null);
  for (let i = 0; i < 200; i++) {
    const next = rankBetween(low, high);
    assert.ok(low < next && next < high, `${low} < ${next} < ${high}`);
    assert.doesNotMatch(next, /0$/);
    low = next;
  }
  let top = rankBetween(null, null);
  for (let i = 0; i < 200; i++) {
    const next = rankBetween(null, top);
    assert.ok(next < top);
    top = next;
  }
});

test('refuses neighbours given in the wrong order', () => {
  assert.throws(() => rankBetween('b', 'a'));
  assert.throws(() => rankBetween('a', 'a'));
});

test('refuses to answer a rank outside its bounds, rather than one that sorts in the wrong place', () => {
  // A rank ending in the lowest digit leaves nothing strictly before it past its prefix
  assert.throws(() => rankBetween('a', 'a0'));
  assert.throws(() => rankBetween(null, '0'));
  assert.throws(() => rankBetween('a!', null));
});

test('appending at the end again and again grows a rank one character per sixty cards', () => {
  let last = rankBetween(null, null);
  for (let i = 0; i < 1000; i++) {
    const next = rankBetween(last, null);
    assert.ok(last < next, `${last} < ${next}`);
    assert.doesNotMatch(next, /0$/);
    last = next;
  }
  assert.ok(last.length <= 18, `${last} after 1000 appends`);
});

test('spread ranks are increasing, short and leave room between each other', () => {
  for (const count of [1, 2, 10, 61, 62, 500, 5000]) {
    const ranks = spreadRanks(count);
    assert.equal(ranks.length, count);
    for (let i = 1; i < ranks.length; i++) {
      const a = ranks[i - 1] ?? '';
      const b = ranks[i] ?? '';
      assert.ok(a < b, `${a} < ${b}`);
      const between = rankBetween(a, b);
      assert.ok(a < between && between < b);
    }
    assert.ok(ranks.every((r) => r.length > 0 && r.length <= 4 && !r.endsWith('0')));
  }
});
