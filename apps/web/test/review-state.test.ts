import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveMode, isSeen, markSeen, MODE_KEY, readMode, readSeen, writeMode, writeSeen, type KeyValueStore } from '../src/lib/review-state.ts';

// What the review remembers lives in the browser only, and a storage that fails must never break
// the screen: it only forgets.

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const broken: KeyValueStore = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

const file = (path: string, additions = 3, deletions = 1) => ({ path, status: 'modified' as const, additions, deletions });

test('Reading is the default mode, and a chosen mode is remembered', () => {
  const s = memory();
  assert.equal(readMode(s), 'reading');
  writeMode('split', s);
  assert.equal(s.data.get(MODE_KEY), 'split');
  assert.equal(readMode(s), 'split');
  s.data.set(MODE_KEY, 'sideways');
  assert.equal(readMode(s), 'reading', 'an unknown value falls back to Reading');
});

test('a storage that throws only forgets', () => {
  assert.equal(readMode(broken), 'reading');
  assert.doesNotThrow(() => writeMode('unified', broken));
  assert.deepEqual(readSeen('chat:x', broken), {});
  assert.doesNotThrow(() => writeSeen('chat:x', { 'a.ts': { sig: 'modified:1:1', hash: null } }, broken));
});

test('Side by side needs room, a phone and a one-sided file fall back to Unified', () => {
  assert.equal(effectiveMode('split', { width: 1200, phone: false, status: 'modified' }), 'split');
  assert.equal(effectiveMode('split', { width: 900, phone: false, status: 'modified' }), 'unified');
  assert.equal(effectiveMode('split', { width: 1400, phone: true, status: 'modified' }), 'unified');
  assert.equal(effectiveMode('split', { width: 1400, phone: false, status: 'deleted' }), 'unified');
  assert.equal(effectiveMode('split', { width: 1400, phone: false, status: 'added' }), 'unified');
  assert.equal(effectiveMode('reading', { width: 300, phone: true, status: 'deleted' }), 'reading');
});

test('seen is kept per source and file, and a file that changes again is unseen', () => {
  const s = memory();
  const a = file('src/a.ts');
  let seen = markSeen({}, a, 'h1', true);
  writeSeen('chat:1', seen, s);
  seen = readSeen('chat:1', s);
  assert.equal(isSeen(seen, a), true);
  assert.equal(isSeen(seen, a, 'h1'), true);
  assert.equal(isSeen(seen, a, 'h2'), false, 'a different diff is unseen');
  assert.equal(isSeen(seen, file('src/a.ts', 4, 1)), false, 'different counts are unseen');
  assert.deepEqual(readSeen('chat:2', s), {}, 'another source has its own');
  seen = markSeen(seen, a, null, false);
  writeSeen('chat:1', seen, s);
  assert.equal(s.data.has('agentry-review-seen:v1:chat:1'), false, 'an empty map is removed');
});

test('a mark made before the diff was read holds whatever the diff is', () => {
  const a = file('a.ts');
  const seen = markSeen({}, a, null, true);
  assert.equal(isSeen(seen, a, 'anything'), true);
});

test('garbage in the store reads as nothing seen', () => {
  const s = memory();
  s.data.set('agentry-review-seen:v1:chat:1', '{not json');
  assert.deepEqual(readSeen('chat:1', s), {});
  s.data.set('agentry-review-seen:v1:chat:1', JSON.stringify({ 'a.ts': 5, 'b.ts': { sig: 'modified:1:0', hash: 7 } }));
  assert.deepEqual(readSeen('chat:1', s), { 'b.ts': { sig: 'modified:1:0', hash: null } });
});

test('the oldest sources are forgotten past the cap', () => {
  const s = memory();
  for (let i = 0; i < 65; i++) writeSeen(`chat:${i}`, { 'a.ts': { sig: 'x', hash: null } }, s);
  assert.equal(s.data.has('agentry-review-seen:v1:chat:0'), false);
  assert.equal(s.data.has('agentry-review-seen:v1:chat:64'), true);
  assert.equal((JSON.parse(s.data.get('agentry-review-seen:v1') ?? '[]') as string[]).length, 60);
});
