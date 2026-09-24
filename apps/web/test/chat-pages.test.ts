import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { evictRuns, joinRun, joinToPage, RUN_TAG, trimRun } from '../src/lib/chat-pages.ts';

// The pages of a transcript read further back are one run, joined by index onto the newest page.
// These rules decide what a page landing on that run does to it.

const run = (from: number, n: number) => ({ from, items: Array.from({ length: n }, (_, i) => `e${from + i}`) });
const span = (r: { from: number; items: string[] }) => [r.from, r.from + r.items.length];
const sound = (r: { from: number; items: string[] }) => r.items.every((item, i) => item === `e${r.from + i}`);

test('the page before the run goes in front of it', () => {
  const joined = joinRun(run(1867, 200), run(1667, 200));
  assert.deepEqual(span(joined), [1667, 2067]);
  assert.ok(sound(joined));
});

test('a page read twice is held once', () => {
  const held = run(1667, 400);
  const again = joinRun(held, run(1867, 200));
  assert.deepEqual(span(again), [1667, 2067]);
  assert.ok(sound(again));
});

test('after the newest page slid past the run, the next page bridges the gap or takes its place', () => {
  // The run ended at 2067 when the newest page started there; then the chat grew and the page was
  // read whole again from 2400, so the page before it is [2200, 2400)
  const orphaned = run(1667, 400);
  assert.deepEqual(span(joinRun(orphaned, run(2200, 200))), [2200, 2400], 'no contact: the run is let go');
  const bridged = joinRun(orphaned, run(2000, 200));
  assert.deepEqual(span(bridged), [1667, 2200], 'a page reaching back into the run bridges it');
  assert.ok(sound(bridged));
});

test('the page wins where they overlap, and a run around it keeps both ends', () => {
  const joined = joinRun({ from: 100, items: ['old100', 'old101', 'old102', 'old103'] }, { from: 101, items: ['new101', 'new102'] });
  assert.deepEqual(joined, { from: 100, items: ['old100', 'new101', 'new102', 'old103'] });
});

test('nothing held, or nothing read, changes nothing', () => {
  assert.deepEqual(joinRun(null, run(10, 5)), run(10, 5));
  assert.deepEqual(joinRun(run(10, 5), run(0, 0)), run(10, 5));
});

test('the run joins the newest page only where they meet', () => {
  const page = run(2067, 200);
  assert.deepEqual(span(joinToPage(run(1667, 400), page)), [1667, 2267]);
  // Overlap (the run was read up to inside the page): the page's copy is the one shown
  const over = joinToPage(run(1667, 450), page);
  assert.deepEqual(span(over), [1667, 2267]);
  assert.ok(sound(over));
  assert.deepEqual(joinToPage(run(1667, 300), page), page, 'a gap shows the newest page alone');
  assert.deepEqual(joinToPage(null, page), page);
});

test('trimming keeps the newest entries and moves the start up by what was dropped', () => {
  const trimmed = trimRun(run(0, 5000), 4000);
  assert.deepEqual(span(trimmed), [1000, 5000]);
  assert.ok(sound(trimmed));
  const small = run(0, 10);
  assert.equal(trimRun(small, 4000), small, 'under the cap it is the same object');
});

test('runs beyond what every chat may hold between them go, least recently read first, never the one on the page', () => {
  const client = new QueryClient();
  const slot = (id: string) => ['chat', id, false, RUN_TAG];
  client.setQueryData(slot('old'), run(0, 3000), { updatedAt: 1 });
  client.setQueryData(slot('older'), run(0, 3000), { updatedAt: 2 });
  client.setQueryData(slot('shown'), run(0, 3000), { updatedAt: 3 });
  client.setQueryData(['chat', 'shown', false], { entries: [] }, { updatedAt: 0 });
  evictRuns(client, slot('shown'), 6000);
  assert.equal(client.getQueryData(slot('old')), undefined, 'the least recently read run went');
  assert.ok(client.getQueryData(slot('older')), 'which brought the total under the cap, so the next stayed');
  assert.ok(client.getQueryData(slot('shown')));
  assert.ok(client.getQueryData(['chat', 'shown', false]), 'the newest page is not a run and is not counted');
  evictRuns(client, slot('shown'), 6000);
  assert.ok(client.getQueryData(slot('older')), 'under the cap nothing goes');
});
