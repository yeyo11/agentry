import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Db, migrate, WEBHOOKS_SCHEMA_VERSION } from '../src/db.ts';
import { WEBHOOK_DELIVERY_KEEP_MS, WebhookStore } from '../src/webhook-store.ts';
import { tempConfig } from './helpers.ts';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function store(): { raw: DatabaseSync; hooks: WebhookStore } {
  const raw = new DatabaseSync(':memory:');
  migrate(raw);
  return { raw, hooks: new WebhookStore(raw) };
}

const input = { id: 'r1', projectId: 'p1', host: 'github', hostname: 'github.com', repoPath: 'acme/app', remoteHookId: '616000000000000001', url: 'https://x.lhr.life/webhooks/github/r1', events: ['pull_request', 'check_run'] } as const;

test('the webhook tables upgrade from the version before', () => {
  const raw = new DatabaseSync(':memory:');
  migrate(raw, WEBHOOKS_SCHEMA_VERSION - 1);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'webhook_registrations'").get(), undefined);
  migrate(raw);
  assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'webhook_deliveries'").get());
  const version = raw.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.ok(version.user_version >= WEBHOOKS_SCHEMA_VERSION);
  raw.close();
});

test('a registration round-trips, keeps a 64-bit hook id as text and has no secret column', () => {
  const { raw, hooks } = store();
  const created = hooks.create({ ...input, events: [...input.events] }, ago(5000));
  assert.deepEqual(created, {
    ...input,
    state: 'active',
    lastDeliveryAt: null,
    lastPingAt: null,
    lastResponse: null,
    createdAt: ago(5000),
    updatedAt: ago(5000),
  });
  const columns = raw.prepare("SELECT name FROM pragma_table_info('webhook_registrations')").all().map((c) => String(c.name));
  assert.ok(!columns.some((c) => /secret/.test(c)));
  const updated = hooks.update('r1', { state: 'failing', lastResponse: { code: 502, status: 'Bad Gateway' }, lastPingAt: ago(10), remoteHookId: null }, ago(1));
  assert.equal(updated?.state, 'failing');
  assert.deepEqual(updated?.lastResponse, { code: 502, status: 'Bad Gateway' });
  assert.equal(updated?.remoteHookId, null);
  assert.equal(updated?.url, input.url, 'a field the patch leaves out stays');
  assert.equal(hooks.update('nope', { state: 'stale' }), null);
  assert.equal(hooks.list('p1').length, 1);
  assert.equal(hooks.list('p2').length, 0);
  hooks.update('r1', { state: 'removed' });
  assert.equal(hooks.listLive().length, 0);
  raw.close();
});

test('a delivery id is recorded once, and the deliveries older than 7 days are pruned', () => {
  const { raw, hooks } = store();
  hooks.create({ ...input, events: [...input.events] });
  assert.equal(hooks.recordDelivery('d-old', 'r1', 'push', ago(WEBHOOK_DELIVERY_KEEP_MS + 1000)), true);
  assert.equal(hooks.recordDelivery('d-edge', 'r1', 'push', ago(WEBHOOK_DELIVERY_KEEP_MS - 1000)), true);
  assert.equal(hooks.recordDelivery('d-new', 'r1', 'ping', ago(1000)), true);
  assert.equal(hooks.recordDelivery('d-new', 'r1', 'ping', ago(500)), false, 'a replay is not new');
  assert.equal(hooks.pruneDeliveries(NOW), 1);
  assert.deepEqual(hooks.deliveries('r1').map((d) => d.delivery_id), ['d-edge', 'd-new']);
  assert.equal(hooks.delete('r1'), true);
  assert.equal(hooks.deliveries('r1').length, 0, 'removing a registration forgets its deliveries');
  assert.equal(hooks.delete('r1'), false);
  raw.close();
});

test('opening the database prunes the old deliveries, so the prune is reached without a caller', () => {
  const config = tempConfig();
  const first = new Db(config);
  const hooks = new WebhookStore(first.connection);
  hooks.recordDelivery('old', 'r1', 'push', new Date(Date.now() - WEBHOOK_DELIVERY_KEEP_MS * 2).toISOString());
  hooks.recordDelivery('fresh', 'r1', 'push', new Date().toISOString());
  first.close();
  const second = new Db(config);
  assert.deepEqual(new WebhookStore(second.connection).deliveries('r1').map((d) => d.delivery_id), ['fresh']);
  second.close();
});
