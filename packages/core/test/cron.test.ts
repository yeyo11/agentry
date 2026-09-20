import assert from 'node:assert/strict';
import test from 'node:test';
import { describeCron, nextFire, nextFires, parseCron } from '../src/cron.ts';

const utc = (iso: string) => Date.parse(iso);
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const next = (expr: string, after: string, zone = 'UTC') => iso(nextFire(parseCron(expr), utc(after), zone));

test('a fire is strictly after the instant asked from, so a slot that just fired is not found again', () => {
  assert.equal(next('*/5 * * * *', '2026-09-20T10:05:00Z'), '2026-09-20T10:10:00.000Z');
  assert.equal(next('*/5 * * * *', '2026-09-20T10:04:59Z'), '2026-09-20T10:05:00.000Z');
});

test('lists, ranges, steps and names read the way cron people expect', () => {
  assert.equal(next('0 9 * * mon-fri', '2026-09-19T12:00:00Z'), '2026-09-21T09:00:00.000Z'); // Saturday -> Monday
  assert.equal(next('15,45 8-9 * * *', '2026-09-20T08:20:00Z'), '2026-09-20T08:45:00.000Z');
  assert.equal(next('0 0 1 jan,jul *', '2026-09-20T00:00:00Z'), '2027-01-01T00:00:00.000Z');
  assert.equal(next('10/20 * * * *', '2026-09-20T10:00:00Z'), '2026-09-20T10:10:00.000Z'); // 10, 30, 50
  assert.equal(next('0 0 * * 7', '2026-09-20T12:00:00Z'), '2026-09-27T00:00:00.000Z'); // 7 is Sunday, and the 20th is one
});

test('day of month and day of week are alternatives when both are restricted, like every cron', () => {
  // the 1st, or any Monday
  const fires = nextFires(parseCron('0 0 1 * 1'), utc('2026-09-20T00:00:00Z'), 3, 'UTC').map(iso);
  assert.deepEqual(fires, ['2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
});

test('29 February waits for a leap year and 30 February never comes', () => {
  assert.equal(next('0 0 29 2 *', '2026-09-20T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(next('0 0 30 2 *', '2026-09-20T00:00:00Z'), null);
});

test('aliases expand to their expressions', () => {
  assert.equal(next('@hourly', '2026-09-20T10:15:00Z'), '2026-09-20T11:00:00.000Z');
  assert.equal(next('@daily', '2026-09-20T10:15:00Z'), '2026-09-21T00:00:00.000Z');
  assert.equal(next('@weekly', '2026-09-20T10:15:00Z'), '2026-09-27T00:00:00.000Z');
});

test('an expression is read in its own zone, offset included', () => {
  // 09:00 in Madrid is 07:00 UTC in summer and 08:00 in winter
  assert.equal(next('0 9 * * *', '2026-07-01T00:00:00Z', 'Europe/Madrid'), '2026-07-01T07:00:00.000Z');
  assert.equal(next('0 9 * * *', '2026-01-01T00:00:00Z', 'Europe/Madrid'), '2026-01-01T08:00:00.000Z');
  // and a zone half an hour off UTC still lands on the wall-clock minute
  assert.equal(next('0 9 * * *', '2026-07-01T00:00:00Z', 'Asia/Kolkata'), '2026-07-01T03:30:00.000Z');
});

test('the hour clocks skip is shifted on and the hour they repeat fires once', () => {
  // Europe/Madrid: 29 March 02:00 -> 03:00 (skipped), 25 October 03:00 -> 02:00 (repeated)
  assert.equal(next('30 2 * * *', '2026-03-28T12:00:00Z', 'Europe/Madrid'), '2026-03-29T01:30:00.000Z'); // 03:30 CEST
  const fires = nextFires(parseCron('30 2 * * *'), utc('2026-10-24T12:00:00Z'), 2, 'Europe/Madrid').map(iso);
  assert.deepEqual(fires, ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']); // the first 02:30, then the next day's
  // asked from inside the repeated hour, the second pass does not fire again
  assert.equal(next('30 2 * * *', '2026-10-25T00:45:00Z', 'Europe/Madrid'), '2026-10-26T01:30:00.000Z');
});

test('an expression that is wrong says which field is', () => {
  assert.throws(() => parseCron('* * * *'), /five fields/);
  assert.throws(() => parseCron('61 * * * *'), /minute: 61 is outside 0-59/);
  assert.throws(() => parseCron('* 24 * * *'), /hour: 24 is outside/);
  assert.throws(() => parseCron('* * 0 * *'), /day of month: 0 is outside/);
  assert.throws(() => parseCron('* * * foo *'), /month: "foo"/);
  assert.throws(() => parseCron('5-1 * * * *'), /runs backwards/);
  assert.throws(() => parseCron('*/0 * * * *'), /step/);
  assert.throws(() => parseCron('1//2 * * * *'), /two steps/);
  assert.throws(() => parseCron('a-b-c * * * *'), /not a range|not a number/);
});

test('an expression is described in words', () => {
  const words = (expr: string) => describeCron(parseCron(expr));
  assert.equal(words('30 9 * * mon-fri'), 'At 09:30, on Monday to Friday');
  assert.equal(words('* * * * *'), 'Every minute');
  assert.equal(words('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(words('0 * * * *'), 'Every hour, on the hour');
  assert.equal(words('0 0 1 * *'), 'At 00:00, on day 1 of the month');
  assert.equal(words('0 12 25 dec *'), 'At 12:00, on day 25 of the month, in December');
  assert.equal(words('*/10 9-17 * * *'), 'Every 10 minutes of the hours 9 to 17');
});
