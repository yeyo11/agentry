import assert from 'node:assert/strict';
import test from 'node:test';
import { Lru } from '../src/lib/lru.ts';

test('the cache forgets what was used longest ago, and a hit counts as a use', () => {
  const cache = new Lru<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('setting a key again replaces it without growing the cache', () => {
  const cache = new Lru<string, number>(2);
  cache.set('a', 1);
  cache.set('a', 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('a'), 2);
});
