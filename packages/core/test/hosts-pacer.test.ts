import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PER_CLI } from '../src/hosts/limits.ts';
import {
  FAILURE_STEPS_MS,
  PAUSED_RECHECK_MS,
  Pacer,
  QUIET_AFTER_MS,
  TIER_ACTIVE_MS,
  TIER_QUIET_MS,
  TIER_VIEWING_MS,
  TIER_WAITING_MS,
  TIER_WEBHOOK_MS,
  WEBHOOK_HEALTHY_MS,
  webhookHealthy,
  type PaceInput,
} from '../src/hosts/pacer.ts';
import { HostRateLimiter } from '../src/hosts/rate-limit.ts';
import { PullRequestWatcher, WATCH_PASS_MS, type WatchRow, type WatchSource } from '../src/pull-requests.ts';
import { cleanup, opened, reviewed, setup, view } from './fixtures/pr-harness.ts';

const MIN = 60_000;

test('the tiers are the plan’s, and the 4-per-CLI cap is unchanged', () => {
  assert.equal(TIER_ACTIVE_MS, 30_000);
  assert.equal(TIER_VIEWING_MS, 20_000);
  assert.equal(TIER_WAITING_MS, 2 * MIN);
  assert.equal(TIER_QUIET_MS, 10 * MIN);
  assert.equal(QUIET_AFTER_MS, 60 * MIN);
  assert.equal(TIER_WEBHOOK_MS, 15 * MIN);
  assert.equal(WEBHOOK_HEALTHY_MS, 30 * MIN);
  assert.deepEqual(FAILURE_STEPS_MS, [1 * MIN, 2 * MIN, 4 * MIN, 8 * MIN, 15 * MIN]);
  assert.equal(DEFAULT_PER_CLI, 4);
});

function clock(start = Date.parse('2026-10-02T10:00:00Z')) {
  const t = { now: start };
  return { t, pacer: new Pacer(() => t.now) };
}

const input = (t: { now: number }, over: Partial<PaceInput> = {}): PaceInput => ({ checkedAt: t.now, ci: 'passing', signature: 'a', since: t.now, ...over });

test('each tier sets the interval of its row', () => {
  const { t, pacer } = clock();
  const next = (over: Partial<PaceInput>, key: string) => pacer.nextAt(key, input(t, over)) - t.now;
  assert.equal(next({}, 'waiting'), TIER_WAITING_MS);
  assert.equal(next({ ci: 'pending' }, 'active'), TIER_ACTIVE_MS);
  assert.equal(next({ mergeWaiting: true }, 'merge'), TIER_ACTIVE_MS);
  assert.equal(next({ webhookHealthy: true }, 'webhook'), TIER_WEBHOOK_MS);
  assert.equal(next({ since: t.now - QUIET_AFTER_MS }, 'quiet'), TIER_QUIET_MS);
  pacer.view('viewed');
  assert.equal(next({ webhookHealthy: true }, 'viewed'), TIER_VIEWING_MS);
});

test('a row that changes stops being quiet, and a view lapses after a minute', () => {
  const { t, pacer } = clock();
  const quiet = (): PaceInput => input(t, { since: t.now - 2 * QUIET_AFTER_MS });
  assert.equal(pacer.tier('r', quiet()), 'quiet');
  assert.equal(pacer.tier('r', { ...quiet(), signature: 'b' }), 'waiting');
  pacer.view('r');
  assert.equal(pacer.tier('r', quiet()), 'viewing');
  t.now += 61_000;
  assert.equal(pacer.tier('r', quiet()), 'waiting');
});

test('a webhook is healthy for 30 minutes after a delivery or a ping, and only while active', () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(webhookHealthy({ state: 'active', lastDeliveryAt: ago(29 * MIN), lastPingAt: null }, now), true);
  assert.equal(webhookHealthy({ state: 'active', lastDeliveryAt: null, lastPingAt: ago(10 * MIN) }, now), true);
  assert.equal(webhookHealthy({ state: 'active', lastDeliveryAt: ago(31 * MIN), lastPingAt: null }, now), false);
  assert.equal(webhookHealthy({ state: 'failing', lastDeliveryAt: ago(MIN), lastPingAt: null }, now), false);
  assert.equal(webhookHealthy({ state: 'stale', lastDeliveryAt: ago(MIN), lastPingAt: null }, now), false);
  assert.equal(webhookHealthy(null, now), false);
});

test('failures step 1, 2, 4, 8 and then 15 minutes, and a read starts over', () => {
  const { t, pacer } = clock();
  const read = (): PaceInput => input(t, { checkedAt: null });
  const waited: number[] = [];
  for (let i = 0; i < 6; i++) {
    pacer.begin('r', read());
    pacer.settle('r', 'failed');
    waited.push(pacer.nextAt('r', read()) - t.now);
    t.now += waited[i] ?? 0;
  }
  assert.deepEqual(waited, [...FAILURE_STEPS_MS, 15 * MIN]);
  pacer.begin('r', read());
  pacer.settle('r', 'read');
  assert.equal(pacer.nextAt('r', input(t)) - t.now, TIER_WAITING_MS);
});

test('a read by someone else ends a failure streak', () => {
  const { t, pacer } = clock();
  pacer.begin('r', input(t, { checkedAt: null }));
  pacer.settle('r', 'failed');
  t.now += 10_000;
  // a person's refresh wrote checked_at
  assert.equal(pacer.nextAt('r', input(t)) - t.now, TIER_WAITING_MS);
});

test('a row held back by the host’s floor looks again in a minute', () => {
  const { t, pacer } = clock();
  pacer.begin('r', input(t, { checkedAt: null }));
  pacer.settle('r', 'paused');
  assert.equal(pacer.nextAt('r', input(t, { checkedAt: null })) - t.now, PAUSED_RECHECK_MS);
});

test('a storm of deliveries against a failing host keeps the back-off; a healthy row still comes forward', () => {
  const { t, pacer } = clock();
  const read = (): PaceInput => input(t, { checkedAt: null });
  pacer.begin('r', read());
  pacer.settle('r', 'failed');
  const due = pacer.nextAt('r', read());
  for (let i = 0; i < 20; i++) {
    t.now += 1_000;
    pacer.nudge('r');
    assert.equal(pacer.isDue('r', read()), false);
    assert.equal(pacer.nextAt('r', read()), due);
  }
  // the back-off ends, the row is read, and it reads well: a nudge now moves it to now
  t.now = due;
  pacer.begin('r', read());
  pacer.settle('r', 'read');
  t.now += 1_000;
  pacer.nudge('r');
  assert.equal(pacer.isDue('r', read()), true);
});

test('only the floor pauses a row, and no skip resets a failure streak', () => {
  const { t, pacer } = clock();
  const read = (): PaceInput => input(t, { checkedAt: null });
  pacer.begin('r', read());
  pacer.settle('r', 'failed');
  pacer.begin('r', read());
  pacer.settle('r', 'failed');
  t.now += 2 * MIN;
  // the claim was lost to another process, or the project's path is gone: nothing about the row changes
  pacer.begin('r', read());
  pacer.settle('r', 'skipped');
  assert.equal(pacer.nextAt('r', read()) - t.now, 2 * MIN, 'still on the second step of the back-off');
  // held back by the floor: paused, and the streak is still there
  pacer.begin('r', read());
  pacer.settle('r', 'paused');
  pacer.begin('r', read());
  pacer.settle('r', 'failed');
  assert.equal(pacer.nextAt('r', read()) - t.now, 4 * MIN, 'the streak went on after the pause');
  // a skip of another kind never pauses a healthy row
  const other = clock();
  const healthy = (): PaceInput => input(other.t, { checkedAt: null });
  other.pacer.begin('h', healthy());
  other.pacer.settle('h', 'skipped');
  assert.equal(other.pacer.nextAt('h', healthy()) - other.t.now, TIER_WAITING_MS);
});

test('a delivery or a refresh sets the next read to now', () => {
  const { t, pacer } = clock();
  const row = (): PaceInput => input(t, { webhookHealthy: true });
  pacer.begin('r', row());
  pacer.settle('r', 'read');
  assert.equal(pacer.isDue('r', row()), false);
  t.now += 1_000;
  pacer.nudge('r');
  assert.equal(pacer.isDue('r', row()), true);
  // the read that answers the nudge clears it, and one that lands while it runs does not get lost
  pacer.begin('r', row());
  t.now += 1_000;
  pacer.nudge('r');
  pacer.settle('r', 'read');
  assert.equal(pacer.isDue('r', row()), true);
  pacer.begin('r', row());
  pacer.settle('r', 'read');
  assert.equal(pacer.isDue('r', row()), false);
  // a refresh writes checked_at: the schedule restarts from it
  t.now += 5 * MIN;
  assert.equal(pacer.isDue('r', row()), false);
  assert.equal(pacer.nextAt('r', input(t, { webhookHealthy: true })) - t.now, TIER_WEBHOOK_MS);
});

test('rows that are not open any more are forgotten', () => {
  const { t, pacer } = clock();
  pacer.nudge('gone');
  pacer.nudge('open');
  pacer.retain(new Set(['open']));
  assert.equal(pacer.isDue('gone', input(t)), false);
  assert.equal(pacer.isDue('open', input(t)), true);
});

// ---------- the watcher loop ----------

function source(rows: WatchRow[], reads: string[], outcome: 'read' | 'failed' | void = 'read'): WatchSource {
  return {
    openRows: () => rows,
    check: async (id) => {
      reads.push(id);
      return outcome;
    },
  };
}

test('a pass reads only the rows that are due; a tick reads them all', async () => {
  const t = { now: Date.parse('2026-10-02T10:00:00Z') };
  const at = (ms: number) => new Date(t.now - ms).toISOString();
  const rows: WatchRow[] = [
    { id: 'fresh', ci: 'passing', checked_at: at(10_000), created_at: at(MIN) },
    { id: 'stale', ci: 'passing', checked_at: at(3 * MIN), created_at: at(MIN) },
    { id: 'never', ci: null, checked_at: null, created_at: at(MIN) },
  ];
  const reads: string[] = [];
  const watcher = new PullRequestWatcher(source(rows, reads), { pacer: new Pacer(() => t.now) });
  await watcher.pass();
  assert.deepEqual(reads.sort(), ['never', 'stale']);
  reads.length = 0;
  await watcher.tick();
  assert.deepEqual(reads.sort(), ['fresh', 'never', 'stale']);
});

test('a webhook delivery names a row and its next read is the next pass', async () => {
  const t = { now: Date.now() };
  const rows: WatchRow[] = [{ id: 'r', ci: 'passing', checked_at: new Date(t.now).toISOString(), created_at: new Date(t.now).toISOString() }];
  const reads: string[] = [];
  const watcher = new PullRequestWatcher(source(rows, reads), { pacer: new Pacer(() => t.now), signals: { webhookHealthy: () => true } });
  await watcher.pass();
  assert.deepEqual(reads, []);
  watcher.nudge('r');
  await watcher.pass();
  assert.deepEqual(reads, ['r']);
  await watcher.pass();
  assert.deepEqual(reads, ['r']);
});

test('a failing source is retried on the failure steps, not on every pass', async () => {
  const t = { now: Date.parse('2026-10-02T10:00:00Z') };
  const rows: WatchRow[] = [{ id: 'r', ci: null, checked_at: null, created_at: new Date(t.now).toISOString() }];
  const reads: string[] = [];
  const watcher = new PullRequestWatcher(source(rows, reads, 'failed'), { pacer: new Pacer(() => t.now) });
  await watcher.pass();
  t.now += WATCH_PASS_MS;
  await watcher.pass();
  assert.equal(reads.length, 1);
  t.now += MIN;
  await watcher.pass();
  assert.equal(reads.length, 2);
  t.now += MIN;
  await watcher.pass();
  assert.equal(reads.length, 2);
  t.now += MIN;
  await watcher.pass();
  assert.equal(reads.length, 3);
});

test('a source that throws counts as a failure and does not stop the pass', async () => {
  const reads: string[] = [];
  const throwing: WatchSource = {
    openRows: () => [{ id: 'bad' }],
    check: async () => {
      throw new Error('boom');
    },
  };
  await new PullRequestWatcher([throwing, source([{ id: 'good' }], reads)]).pass();
  assert.deepEqual(reads, ['good']);
});

test('the page read by the web puts the row in the viewing tier', async () => {
  const t = { now: Date.now() };
  const rows: WatchRow[] = [{ id: 'r', ci: 'passing', checked_at: new Date(t.now - 30_000).toISOString(), created_at: new Date(t.now - MIN).toISOString() }];
  const reads: string[] = [];
  const watcher = new PullRequestWatcher(source(rows, reads), { pacer: new Pacer(() => t.now) });
  await watcher.pass();
  assert.deepEqual(reads, []);
  watcher.view('r');
  await watcher.pass();
  assert.deepEqual(reads, ['r']);
});

// ---------- the service: the claim, the floor, the outcome ----------

const readsOf = (s: ReturnType<typeof setup>): number => {
  const file = join(s.r.state, 'calls');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((c) => c.startsWith('pr view')).length : 0;
};

test('the per-row claim holds: a row being read is not read twice, and a floor holds back a background read only', async () => {
  const s = setup();
  try {
    const item = reviewed(s);
    await opened(s, item);
    const id = (s.db.connection.prepare('SELECT id FROM work_item_pull_requests WHERE item_id = ?').get(item.id) as { id: string }).id;
    view(s.r, 'OPEN');

    const before = readsOf(s);
    const [a, b] = await Promise.all([s.service.check(id), s.service.check(id)]);
    assert.deepEqual([a, b].sort(), ['read', 'skipped']);
    assert.equal(readsOf(s) - before, 1);

    // below the floor (50 left in core), background polling stays away and a person's refresh goes through
    new HostRateLimiter(s.db.connection).observe('github.com', 'core', { limit: 5000, remaining: 10, resetAt: new Date(Date.now() + 10 * MIN) });
    const held = readsOf(s);
    assert.equal(await s.service.check(id), 'paused');
    assert.equal(readsOf(s), held);
    assert.equal(await s.service.check(id, true), 'read');
    assert.equal(readsOf(s), held + 1);
  } finally {
    cleanup(s);
  }
});
