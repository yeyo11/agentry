// The split and the merged report, without a browser: `node --test e2e/shards.test.mjs`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBlockReader, createMerger } from './parallel.mjs';
import { defaultShardCount, groupSpecs, loadTimings, median, parseCount, parseShard, splitSpecs } from './shards.mjs';

const spec = (file, fake = false) => ({ file, fake });

test('parseShard takes k/N with 1 ≤ k ≤ N and nothing else', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  assert.deepEqual(parseShard(' 1 / 1 '), { index: 1, count: 1 });
  for (const bad of ['0/4', '5/4', '1/0', '2', '', 'a/b', '1.5/4', '-1/4', undefined]) assert.equal(parseShard(bad), null, String(bad));
});

test('parseCount takes a whole number of 1 or more', () => {
  assert.equal(parseCount('3'), 3);
  for (const bad of ['0', '-1', '1.5', 'x', '']) assert.equal(parseCount(bad), null, bad);
});

test('loadTimings treats a missing or broken table as empty and drops bad entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-shards-test-'));
  try {
    assert.deepEqual(loadTimings(join(dir, 'missing.json')), {});
    writeFileSync(join(dir, 'broken.json'), '{');
    assert.deepEqual(loadTimings(join(dir, 'broken.json')), {});
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ 'a.spec.mjs': 12.5, 'b.spec.mjs': 'x', 'c.spec.mjs': 0, 'd.spec.mjs': -3 }));
    assert.deepEqual(loadTimings(join(dir, 'ok.json')), { 'a.spec.mjs': 12.5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('median of the known durations, or 1 when none is known', () => {
  assert.equal(median([]), 1);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('every fakeCli spec is one group; every other spec is its own', () => {
  const groups = groupSpecs([spec('b'), spec('z', true), spec('a'), spec('y', true)], { a: 2, b: 3, y: 10, z: 20 });
  assert.deepEqual(groups, [
    { files: ['a'], weight: 2 },
    { files: ['b'], weight: 3 },
    { files: ['y', 'z'], weight: 30 },
  ]);
});

test('a spec missing from the table weighs the median of the known ones', () => {
  const groups = groupSpecs([spec('a'), spec('b'), spec('c'), spec('new')], { a: 1, b: 5, c: 9 });
  assert.equal(groups.find((g) => g.files[0] === 'new')?.weight, 5);
});

test('the split is longest first into the lightest shard, and covers every spec once', () => {
  const entries = [spec('a'), spec('b'), spec('c'), spec('d'), spec('e'), spec('f1', true), spec('f2', true)];
  const timings = { a: 50, b: 40, c: 30, d: 20, e: 10, f1: 25, f2: 20 };
  const shards = splitSpecs(entries, timings, 3);
  // a (50) → 1, the fake group (45) → 2, b (40) → 3, then each to the lightest: c → 3, d → 2, e → 1
  assert.deepEqual(
    shards.map((s) => s.files),
    [['a', 'e'], ['d', 'f1', 'f2'], ['b', 'c']],
  );
  assert.deepEqual(shards.map((s) => s.seconds), [60, 65, 70]);
  assert.deepEqual(shards.flatMap((s) => s.files).sort(), entries.map((e) => e.file).sort());
});

test('the same inputs give the same split, whatever order the specs came in', () => {
  const entries = Array.from({ length: 30 }, (_, i) => spec(`s${String(i).padStart(2, '0')}.spec.mjs`, i % 7 === 0));
  const timings = Object.fromEntries(entries.filter((_, i) => i % 3).map((e, i) => [e.file, (i * 37) % 23 + 1]));
  const once = splitSpecs(entries, timings, 4);
  const again = splitSpecs([...entries].reverse(), { ...timings }, 4);
  assert.deepEqual(again, once);
  const fakes = once.filter((s) => s.files.some((f) => entries.find((e) => e.file === f)?.fake));
  assert.equal(fakes.length, 1, 'every fakeCli spec is in one shard');
});

test('ties go to the lower shard and by file name, and no timings means equal weights', () => {
  const shards = splitSpecs([spec('c'), spec('a'), spec('b'), spec('d')], {}, 2);
  assert.deepEqual(shards.map((s) => s.files), [['a', 'c'], ['b', 'd']]);
});

test('more shards than groups leaves the extra shards empty', () => {
  const shards = splitSpecs([spec('a'), spec('b', true), spec('c', true)], {}, 4);
  assert.deepEqual(shards.map((s) => s.files), [['b', 'c'], ['a'], [], []]);
});

test('the default count is one shard per two cores, at most 4 and at most one per group', () => {
  assert.equal(defaultShardCount(1, 50), 1);
  assert.equal(defaultShardCount(2, 50), 1);
  assert.equal(defaultShardCount(6, 50), 3);
  assert.equal(defaultShardCount(12, 50), 4);
  assert.equal(defaultShardCount(64, 50), 4);
  assert.equal(defaultShardCount(12, 1), 1);
  assert.equal(defaultShardCount(12, 0), 1);
});

test('a shard’s output is cut into spec blocks, its own lines, and a summary that is dropped', () => {
  const blocks = [];
  const other = [];
  const reader = createBlockReader({ block: (file, text, ok) => blocks.push({ file, text, ok }), other: (text) => other.push(text) });
  for (const line of [
    'said by a.spec while it ran',
    '✓ a.spec.mjs (1.0s)',
    '- b.spec.mjs (skipped: set E2E_LIVE=1)',
    '- restarting the server with the fake CLI (e2e/fake-cli)',
    '✗ c.spec.mjs',
    '  assertion failed: nope',
    '  second line',
    '- stopping: the timed-out spec may still be driving the browser',
    '',
    'failed:',
    '✗ c.spec.mjs',
    '1 spec(s) failed',
  ]) reader.line(line);
  reader.end();
  assert.deepEqual(blocks, [
    { file: 'a.spec.mjs', text: 'said by a.spec while it ran\n✓ a.spec.mjs (1.0s)', ok: true },
    { file: 'b.spec.mjs', text: '- b.spec.mjs (skipped: set E2E_LIVE=1)', ok: true },
    { file: 'c.spec.mjs', text: '✗ c.spec.mjs\n  assertion failed: nope\n  second line', ok: false },
  ]);
  assert.deepEqual(other, ['- restarting the server with the fake CLI (e2e/fake-cli)', '- stopping: the timed-out spec may still be driving the browser']);
});

test('blocks are printed in the global order, each as soon as the ones before it are', () => {
  const printed = [];
  const merger = createMerger(['a', 'b', 'c', 'd'], (text) => printed.push(text));
  merger.add('c', 'C');
  merger.add('b', 'B');
  assert.deepEqual(printed, []);
  merger.add('a', 'A');
  assert.deepEqual(printed, ['A', 'B', 'C']);
  merger.add('a', 'again');
  merger.add('d', 'D');
  assert.deepEqual(printed, ['A', 'B', 'C', 'D']);
});
