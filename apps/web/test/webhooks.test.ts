import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, ChangeRequestFreshness, WebhookRegistration } from '@agentry/shared';
import { api, keys } from '../src/api';
import { targetsFor } from '../src/lib/events';
import { freshnessLine, isHealthy, lastHeardAt, liveRegistration, publicOrigin, responseWord, rowKind, spanWords, webhookActions, webhookTone } from '../src/lib/webhooks';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const reg = (over: Partial<WebhookRegistration> = {}): WebhookRegistration =>
  ({ id: 'r1', projectId: 'p1', host: 'github', state: 'active', lastDeliveryAt: null, lastPingAt: null, lastResponse: null, ...over }) as WebhookRegistration;

test('one colour per state, and a removed hook reads as none', () => {
  assert.equal(webhookTone('active'), 'ok');
  assert.equal(webhookTone('failing'), 'bad');
  assert.equal(webhookTone('stale'), 'warn');
  assert.equal(webhookTone('removed'), 'muted');
  assert.equal(liveRegistration([reg({ state: 'removed' })]), null);
});

test('a row is unavailable before anything else, then off or the registration state', () => {
  assert.equal(rowKind(undefined), 'unavailable');
  assert.equal(rowKind({ available: false, registrations: [reg()] }), 'unavailable');
  assert.equal(rowKind({ available: true, registrations: [] }), 'off');
  assert.equal(rowKind({ available: true, registrations: [reg({ state: 'stale' })] }), 'stale');
  assert.equal(rowKind({ available: true, registrations: [reg({ state: 'failing' })] }), 'failing');
});

test('the actions: none when unavailable, register when off, test and remove when registered; never redelivery', () => {
  assert.deepEqual(webhookActions({ available: false, registrations: [] }), []);
  assert.deepEqual(webhookActions({ available: true, registrations: [] }), ['register']);
  assert.deepEqual(webhookActions({ available: true, registrations: [reg()] }), ['test', 'remove']);
});

test('healthy means active and heard from in the last 30 minutes', () => {
  assert.equal(isHealthy(reg({ lastDeliveryAt: ago(5 * 60_000) }), NOW), true);
  assert.equal(isHealthy(reg({ lastPingAt: ago(29 * 60_000) }), NOW), true);
  assert.equal(isHealthy(reg({ lastDeliveryAt: ago(31 * 60_000) }), NOW), false);
  assert.equal(isHealthy(reg(), NOW), false);
  assert.equal(isHealthy(reg({ state: 'failing', lastDeliveryAt: ago(1000) }), NOW), false);
});

test('last heard is the later of delivery and ping; the response is its code or its status', () => {
  assert.equal(lastHeardAt(reg({ lastDeliveryAt: ago(5000), lastPingAt: ago(1000) })), ago(1000));
  assert.equal(lastHeardAt(reg()), null);
  assert.equal(responseWord(reg({ lastResponse: { code: 204, status: 'OK' } })), '204');
  assert.equal(responseWord(reg({ lastResponse: { code: null, status: 'timeout' } })), 'timeout');
  assert.equal(responseWord(reg()), null);
});

test('the public origin drops the receiver path and survives garbage', () => {
  assert.equal(publicOrigin('https://x.lhr.life/webhooks/github/abc'), 'https://x.lhr.life');
  assert.equal(publicOrigin('nope'), null);
  assert.equal(publicOrigin(null), null);
});

test('spans are whole seconds, minutes, then hours', () => {
  assert.deepEqual(spanWords(40_000), { unit: 's', value: 40 });
  assert.deepEqual(spanWords(120_000), { unit: 'min', value: 2 });
  assert.deepEqual(spanWords(3 * 3600_000), { unit: 'h', value: 3 });
});

test('the freshness line says instant only for a webhook read with a healthy hook', () => {
  const f = (over: Partial<ChangeRequestFreshness>): ChangeRequestFreshness => ({ checkedAt: ago(12_000), nextCheckAt: new Date(NOW + 60_000).toISOString(), source: 'poll', ...over });
  assert.equal(freshnessLine(null, true, NOW), null);
  assert.equal(freshnessLine(f({ source: 'webhook' }), true, NOW)?.kind, 'instant');
  assert.equal(freshnessLine(f({ source: 'webhook' }), false, NOW)?.kind, 'checked');
  assert.equal(freshnessLine(f({}), true, NOW)?.kind, 'checked');
  assert.equal(freshnessLine(f({ nextCheckAt: null }), false, NOW)?.kind, 'paused');
  assert.equal(freshnessLine(f({ checkedAt: null }), false, NOW)?.kind, 'unchecked');
  assert.equal(freshnessLine(f({}), false, NOW)?.sinceMs, 12_000);
});

test('webhook.changed refreshes that project\'s registrations', () => {
  const event = { type: 'webhook.changed', projectId: 'p1', registration: reg() } as AgentryEvent;
  const targets = targetsFor(event);
  assert.deepEqual(targets.map((t) => t[0]), [keys.projectWebhooks('p1')]);
  assert.equal(typeof api.projectWebhooks, 'function');
});
