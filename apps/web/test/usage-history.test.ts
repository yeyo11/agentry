import assert from 'node:assert/strict';
import test from 'node:test';
import type { UsageHistoryPoint } from '@agentry/shared';
import { GAP_MS, pathOf, seriesOf, sinceOf, summarise, xOf, yOf, type Frame } from '../src/lib/usage-history.ts';

const point = (account: number, at: string, pct: number): UsageHistoryPoint => ({ account, at, pct, window: '5h' });

const frame = (from: number, to: number): Frame => ({ from, to, width: 200, height: 100, left: 20, right: 20, top: 10, bottom: 10 });

test('readings are grouped per account, each oldest first, whatever order they came in', () => {
  const series = seriesOf([
    point(2, '2026-01-01T00:10:00Z', 30),
    point(1, '2026-01-01T00:20:00Z', 50),
    point(1, '2026-01-01T00:00:00Z', 10),
    point(2, '2026-01-01T00:00:00Z', 20),
  ]);
  assert.deepEqual(series.map((s) => s.account), [1, 2]);
  assert.deepEqual(series[0]?.readings.map((r) => r.pct), [10, 50]);
  assert.deepEqual(series[1]?.readings.map((r) => r.pct), [20, 30]);
});

test('a reading with a time that does not parse is left out rather than drawn at NaN', () => {
  assert.deepEqual(seriesOf([point(1, 'not a time', 10)]), []);
});

test('the chart maps time to x and usage to y, with 0 at the bottom and 100 at the top', () => {
  const f = frame(0, 1000);
  assert.equal(xOf(f, 0), 20);
  assert.equal(xOf(f, 1000), 180);
  assert.equal(yOf(f, 0), 90);
  assert.equal(yOf(f, 100), 10);
  assert.equal(yOf(f, 50), 50);
});

test('a reading outside 0-100 sits on the edge of the chart instead of off it', () => {
  const f = frame(0, 1000);
  assert.equal(yOf(f, 140), 10);
  assert.equal(yOf(f, -5), 90);
});

test('the line is lifted between two readings further apart than a gap', () => {
  const f = frame(0, 10 * GAP_MS);
  const series = { account: 1, readings: [{ t: 0, pct: 10 }, { t: 60_000, pct: 20 }, { t: 60_000 + GAP_MS + 1, pct: 30 }] };
  const path = pathOf(series, f);
  assert.equal(path.match(/M/g)?.length, 2, path);
  assert.equal(path.match(/L/g)?.length, 1, path);
});

test('readings outside the frame are not drawn', () => {
  const series = { account: 1, readings: [{ t: -10, pct: 10 }, { t: 5, pct: 20 }, { t: 5000, pct: 30 }] };
  assert.equal(pathOf(series, frame(0, 1000)).match(/[ML]/g)?.length, 1);
});

test('the summary says the latest and the peak of each line, and skips an empty one', () => {
  const summary = summarise([
    { account: 1, readings: [{ t: 1, pct: 80 }, { t: 2, pct: 40 }] },
    { account: 2, readings: [] },
  ]);
  assert.deepEqual(summary, [{ account: 1, readings: 2, latest: 40, latestAt: 2, peak: 80 }]);
});

test('a range starts that long before now', () => {
  const now = Date.parse('2026-01-31T12:00:00Z');
  assert.equal(sinceOf('24h', now), '2026-01-30T12:00:00.000Z');
  assert.equal(sinceOf('7d', now), '2026-01-24T12:00:00.000Z');
  assert.equal(sinceOf('30d', now), '2026-01-01T12:00:00.000Z');
});
