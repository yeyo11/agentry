import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCron, DEFAULT_PARTS, parseCron, type CronParts } from '../src/lib/cron-builder.ts';

const parts = (patch: Partial<CronParts>): CronParts => ({ ...DEFAULT_PARTS, ...patch });

test('each shape of the builder writes the expression a person would', () => {
  assert.equal(buildCron(parts({ mode: 'minutes', every: 15 })), '*/15 * * * *');
  assert.equal(buildCron(parts({ mode: 'hourly', minute: 30 })), '30 * * * *');
  assert.equal(buildCron(parts({ mode: 'daily', hour: 9, minute: 5 })), '5 9 * * *');
  assert.equal(buildCron(parts({ mode: 'weekdays', hour: 8, minute: 0 })), '0 8 * * 1-5');
  assert.equal(buildCron(parts({ mode: 'weekly', weekday: 0, hour: 22, minute: 0 })), '0 22 * * 0');
  assert.equal(buildCron(parts({ mode: 'monthly', day: 1, hour: 6, minute: 0 })), '0 6 1 * *');
});

test('a number typed out of range is pulled back in, so the builder never writes an expression that cannot fire', () => {
  assert.equal(buildCron(parts({ mode: 'daily', hour: 99, minute: -4 })), '0 23 * * *');
  assert.equal(buildCron(parts({ mode: 'minutes', every: 0 })), '*/1 * * * *');
});

test('an expression the builder wrote reads back into the same fields', () => {
  for (const cron of ['*/10 * * * *', '15 * * * *', '5 9 * * *', '0 8 * * 1-5', '0 22 * * 0', '0 6 1 * *']) {
    assert.equal(buildCron(parseCron(cron)), cron);
    assert.notEqual(parseCron(cron).mode, 'custom');
  }
});

test('an expression written by hand stays custom, so opening it never rewrites it', () => {
  for (const cron of ['0 9 * * mon-fri', '0 9,17 * * *', '@daily', '05 9 * * *', '0 9 1 1 *', '0 9 * * 7', '61 9 * * *']) {
    const read = parseCron(cron);
    assert.equal(read.mode, 'custom', cron);
    assert.equal(buildCron(read), cron);
  }
});
