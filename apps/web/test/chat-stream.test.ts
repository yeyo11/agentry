import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat, ChatDetail, TranscriptEntry } from '@agentry/shared';
import { appendStreamed, ChatStreamStore, spliceTail, streamMark, unconfirmedTail } from '../src/lib/chat-stream.ts';

// A live chat's page is kept current from its stream and read back a short tail at a time. These
// rules decide whether a message said a moment ago shows, shows twice or vanishes.

const entry = (uuid: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid,
  role: 'assistant',
  timestamp: null,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text: uuid }],
  ...extra,
});

const chat = {} as Chat;
const page = (from: number, uuids: string[], total = from + uuids.length): ChatDetail => ({ chat, from, total, entries: uuids.map((u) => entry(u)) });
const uuids = (detail: ChatDetail | null) => detail?.entries.map((e) => e.uuid);

test('a stored message goes on the end of the page once, and a subagent’s is left to the next read', () => {
  const held = page(0, ['a', 'b']);
  const added = appendStreamed(held, entry('c'));
  assert.equal(added.outcome, 'appended');
  assert.deepEqual(uuids(added.page), ['a', 'b', 'c']);
  assert.equal(added.page.total, 3);
  assert.equal(unconfirmedTail(added.page), 1);

  const again = appendStreamed(added.page, entry('c'));
  assert.equal(again.outcome, 'present');
  assert.equal(again.page, added.page);

  const sidechain = appendStreamed(held, entry('s', { isSidechain: true }));
  assert.equal(sidechain.outcome, 'skipped');
  assert.equal(sidechain.page, held);
});

test('a replayed message older than the page’s end is not put at the end', () => {
  const held: ChatDetail = { ...page(0, []), entries: [entry('new', { timestamp: '2026-09-22T10:00:00.000Z' })], total: 1 };
  assert.equal(appendStreamed(held, entry('old', { timestamp: '2026-09-22T09:00:00.000Z' })).outcome, 'skipped');
  assert.equal(appendStreamed(held, entry('next', { timestamp: '2026-09-22T10:00:01.000Z' })).outcome, 'appended');
});

test('a short read from the end replaces what the stream put there and keeps what is older', () => {
  const held = appendStreamed(appendStreamed(page(100, ['a', 'b', 'c']), entry('echo')).page, entry('d')).page;
  // The transcript names the wrapper's copy of a user message differently: the read's version wins
  const fresh = page(101, ['b', 'c', 'user', 'd']);
  const merged = spliceTail(held, fresh, Number.POSITIVE_INFINITY, Date.now() + 60_000);
  assert.ok(merged);
  assert.deepEqual(uuids(merged), ['a', 'b', 'c', 'user', 'd']);
  assert.equal(merged.from, 100);
  assert.equal(merged.total, 105);
  assert.equal(unconfirmedTail(merged), 0);
});

test('reads that do not meet what is held, or disagree with it, ask for a whole page', () => {
  const held = page(100, ['a', 'b', 'c']);
  // grew by more than the read holds
  assert.equal(spliceTail(held, page(110, ['x'])), null);
  // rewritten under the same indices
  assert.equal(spliceTail(held, page(101, ['z', 'c'])), null);
  // shorter than what was read before
  assert.equal(spliceTail(held, page(100, ['a'])), null);
  // starts before the page
  assert.equal(spliceTail(held, page(99, ['0', 'a', 'b', 'c'])), null);
});

test('an overlap only counts on entries a read confirmed, never on ones the stream guessed', () => {
  const held = appendStreamed(page(0, ['a']), entry('b')).page;
  // Starts at the streamed entry: nothing confirmed to agree on
  assert.equal(spliceTail(held, page(1, ['b', 'c'])), null);
  assert.deepEqual(uuids(spliceTail(held, page(0, ['a', 'b', 'c']))), ['a', 'b', 'c']);
});

test('what the stream appended while the read was on its way is kept after it', () => {
  const held = page(0, ['a', 'b']);
  const since = streamMark();
  const later = appendStreamed(held, entry('c')).page;
  const merged = spliceTail(later, page(1, ['b']), since);
  assert.deepEqual(uuids(merged), ['a', 'b', 'c']);
  assert.equal(merged?.total, 3);
  // A read that has it drops the kept copy
  assert.deepEqual(uuids(spliceTail(later, page(1, ['b', 'c']), since)), ['a', 'b', 'c']);
});

test('a message the CLI has not written yet is not taken back by a read that just missed it', () => {
  const at = 1_000_000;
  const held = appendStreamed(page(0, ['a']), entry('b'), at).page;
  // The read started after the stream said it, but the transcript's line was not there yet
  assert.deepEqual(uuids(spliceTail(held, page(0, ['a']), Number.POSITIVE_INFINITY, at + 100)), ['a', 'b']);
  // Long after, a read without it is believed
  assert.deepEqual(uuids(spliceTail(held, page(0, ['a']), Number.POSITIVE_INFINITY, at + 60_000)), ['a']);
});

test('a message a person sent stays on the page until the chat writes it down, however long the turn takes', () => {
  const at = 2_000_000;
  const sent = entry('sent', { role: 'user', blocks: [{ type: 'text', text: 'and one more thing' }] });
  const held = appendStreamed(page(0, ['a']), sent, at).page;
  // The CLI reads its stdin when the turn ends: minutes of reads land without the message in them
  assert.deepEqual(uuids(spliceTail(held, page(0, ['a']), Number.POSITIVE_INFINITY, at + 120_000)), ['a', 'sent']);
  // Once the turn takes it, the transcript's own copy replaces the wrapper's
  const written: ChatDetail = { chat, from: 0, total: 2, entries: [entry('a'), entry('written', { role: 'user', blocks: [{ type: 'text', text: 'and one more thing' }] })] };
  assert.deepEqual(uuids(spliceTail(held, written, Number.POSITIVE_INFINITY, at + 120_000)), ['a', 'written']);
});

test('a user message sent while the read was on its way is not kept twice under two names', () => {
  const held = page(0, ['a']);
  const since = streamMark();
  const said = (uuid: string) => entry(uuid, { role: 'user', blocks: [{ type: 'text', text: 'hi' }] });
  const later = appendStreamed(held, said('wrapper-copy')).page;
  const fresh: ChatDetail = { chat, from: 0, total: 2, entries: [entry('a'), said('transcript-copy')] };
  assert.deepEqual(uuids(spliceTail(later, fresh, since)), ['a', 'transcript-copy']);
});

test('a stored block stays on screen until the transcript shows it, and a quiet one does not stay forever', () => {
  const store = new ChatStreamStore('c1');
  let renders = 0;
  store.subscribe(() => renders++);
  store.setPartial({ block: 'text', text: 'hel', since: 'now' }, 1000);
  store.endPartial();
  assert.equal(store.get().partial?.text, 'hel');
  store.settle(1001);
  assert.equal(store.get().partial, null);

  store.setPartial({ block: 'text', text: 'still going', since: 'now' }, 2000);
  store.settle(2500);
  assert.equal(store.get().partial?.text, 'still going', 'a block still being written is not cleared');
  store.settle(3500);
  assert.equal(store.get().partial, null, 'one gone quiet is');

  const before = renders;
  store.setConnected(false);
  assert.equal(renders, before, 'nothing that did not change is announced');
});
