import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatPendingMessage, MessageDelivery } from '@agentry/shared';
import { reconcileCards, type DeliveryFacts, type QueuedCard } from '@agentry/chat-ui/composer/queued';

// The queued cards over the composer, matched by the id each message was sent with
// (docs/chat-delivery.md): never by its words, never by a clock on the page.

const AT = 1_000_000;

const card = (id: string, over: Partial<QueuedCard> = {}): QueuedCard => ({ id, text: id, attachments: [], state: 'waiting', seenAt: AT, ...over });
const pending = (id: string, state: ChatPendingMessage['state'] = 'written'): ChatPendingMessage => ({ id, text: `said ${id}`, attachments: [], state, sentAt: '2026-10-08T12:00:00.000Z' });

function facts(over: Partial<DeliveryFacts> & { told?: MessageDelivery[] } = {}): DeliveryFacts {
  const told = new Map((over.told ?? []).map((d) => [d.id, d]));
  return { pending: [], readAt: AT, delivery: (id) => told.get(id), written: new Set(), dismissed: new Set(), ...over };
}

test('a card goes when the stream says the agent took its message, and the others stay', () => {
  const held = [card('m1'), card('m2')];
  const next = reconcileCards(held, facts({ pending: [pending('m2')], told: [{ id: 'm1', state: 'delivered' }] }));
  assert.deepEqual(next.map((c) => c.id), ['m2']);
});

test('two messages the agent read as one prompt clear both cards', () => {
  const held = [card('m1'), card('m2')];
  const next = reconcileCards(held, facts({ told: [{ id: 'm1', state: 'delivered' }, { id: 'm2', state: 'delivered' }] }));
  assert.deepEqual(next, []);
});

test('a card is called lost only when the server says so, and keeps its files', () => {
  const files = [{ id: 'u1', name: 'notes.txt', mediaType: 'text/plain', kind: 'file' as const, sizeBytes: 12 }];
  const held = [card('m1', { attachments: files })];
  // The turn ended long ago and the chat reads idle: still waiting, since nothing said otherwise
  assert.equal(reconcileCards(held, facts({ pending: [pending('m1')], readAt: AT + 60_000 })), held);
  const lost = reconcileCards(held, facts({ told: [{ id: 'm1', state: 'undelivered' }] }));
  assert.equal(lost[0]?.state, 'lost');
  assert.deepEqual(lost[0]?.attachments, files);
});

test('a reloaded page rebuilds the cards from what the chat lists as pending', () => {
  const next = reconcileCards([], facts({ pending: [pending('m1'), pending('m2', 'held'), pending('m3', 'undelivered')] }));
  assert.deepEqual(next.map((c) => [c.id, c.state, c.text]), [
    ['m1', 'waiting', 'said m1'],
    ['m2', 'held', 'said m2'],
    ['m3', 'lost', 'said m3'],
  ]);
});

test('a card stays through a read that set out before its message was sent', () => {
  const held = [card('m1')];
  assert.equal(reconcileCards(held, facts({ readAt: AT + 500 })), held);
  // A read well after it that no longer lists it: the agent has it
  assert.deepEqual(reconcileCards(held, facts({ readAt: AT + 10_000 })), []);
});

test("the agent's transcript holding the message clears its card", () => {
  const held = [card('m1')];
  assert.deepEqual(reconcileCards(held, facts({ pending: [pending('m1')], written: new Set(['m1']) })), []);
});

test('a card the person put back in the box is not brought back by the list', () => {
  assert.deepEqual(reconcileCards([], facts({ pending: [pending('m1', 'undelivered')], dismissed: new Set(['m1']) })), []);
});

test('a held message turns into a waiting one when the next process takes it into its queue', () => {
  const held = [card('m1', { state: 'held' })];
  assert.equal(reconcileCards(held, facts({ pending: [pending('m1', 'written')] }))[0]?.state, 'waiting');
});
