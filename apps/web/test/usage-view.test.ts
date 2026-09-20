import assert from 'node:assert/strict';
import test from 'node:test';
import type { UsageSlice } from '@agentry/shared';
import { bucketFor, customRangeError, labelStride, niceScale, parseDay, presetRange, sumMetric, toDay, topSlices } from '../src/lib/usage-view.ts';

const slice = (key: string, costUsd: number | null, tokens = 0, chats = 1): UsageSlice => ({ key, label: key, costUsd, tokens, chats });

test('a preset covers today and the days before it, counted inclusively', () => {
  const now = new Date(2026, 4, 20, 15, 30);
  assert.deepEqual(presetRange('7d', now), { from: '2026-05-14', to: '2026-05-20' });
  assert.deepEqual(presetRange('30d', now), { from: '2026-04-21', to: '2026-05-20' });
});

test('the "all time" preset leaves both ends open so the server picks the first day with data', () => {
  assert.deepEqual(presetRange('all', new Date()), {});
});

test('a range that crosses a year end is written with the year it falls in', () => {
  assert.deepEqual(presetRange('7d', new Date(2026, 0, 3)), { from: '2025-12-28', to: '2026-01-03' });
});

test('a day that does not exist on the calendar is not accepted', () => {
  assert.ok(parseDay('2026-02-28'));
  assert.equal(parseDay('2026-02-31'), null);
  assert.equal(parseDay('2026-2-3'), null);
  assert.equal(toDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('a custom range is only asked for when both days are real and in order', () => {
  assert.equal(customRangeError('2026-05-01', '2026-05-20'), null);
  assert.equal(customRangeError('2026-05-01', ''), 'invalid');
  assert.equal(customRangeError('2026-05-21', '2026-05-20'), 'order');
});

test('a range too long for one point per day goes by the week, which the API would otherwise refuse', () => {
  assert.equal(bucketFor({ from: '2020-01-01', to: '2026-01-01' }, 'day'), 'week');
  assert.equal(bucketFor({ from: '2026-01-01', to: '2026-02-01' }, 'day'), 'day');
  assert.equal(bucketFor({}, 'day'), 'day');
});

test('a total with no reported figure is null, never zero', () => {
  assert.equal(sumMetric([{ costUsd: null, tokens: 5, chats: 1 }], 'cost'), null);
  assert.equal(sumMetric([{ costUsd: null, tokens: 5, chats: 1 }, { costUsd: 1.5, tokens: 1, chats: 1 }], 'cost'), 1.5);
  assert.equal(sumMetric([], 'tokens'), null);
});

test('the axis ceiling is a round number above the data, with evenly spaced gridlines from zero', () => {
  assert.deepEqual(niceScale(7.3), { max: 9, ticks: [0, 3, 6, 9] });
  assert.deepEqual(niceScale(0.9), { max: 0.9, ticks: [0, 0.3, 0.6, 0.9] });
  assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1 / 3, 2 / 3, 1].map((n) => Number(n.toPrecision(12))) });
});

test('a chart of whole numbers never puts a gridline between two of them', () => {
  assert.deepEqual(niceScale(1, 3, true), { max: 3, ticks: [0, 1, 2, 3] });
  assert.deepEqual(niceScale(0, 3, true), { max: 3, ticks: [0, 1, 2, 3] });
});

test('folding the tail keeps the biggest slices and sums the rest without inventing a cost', () => {
  const slices = [slice('a', 5), slice('b', 4), slice('c', 3), slice('d', null, 10), slice('e', 1)];
  const { shown, rest } = topSlices(slices, 'cost', 3);
  assert.deepEqual(shown.map((s) => s.key), ['a', 'b']);
  assert.equal(rest?.costUsd, 4);
  assert.equal(rest?.chats, 3);
  assert.equal(topSlices(slices, 'cost', 5).rest, null);
});

test('slices with no cost sort last by cost but first by tokens when tokens are what is shown', () => {
  const slices = [slice('cheap', 1, 5), slice('none', null, 900)];
  assert.deepEqual(topSlices(slices, 'cost', 5).shown.map((s) => s.key), ['cheap', 'none']);
  assert.deepEqual(topSlices(slices, 'tokens', 5).shown.map((s) => s.key), ['none', 'cheap']);
});

test('axis labels thin out so neighbours never touch', () => {
  assert.equal(labelStride(7, 700), 1);
  assert.equal(labelStride(90, 640), 9);
  assert.equal(labelStride(0, 640), 1);
});
