import assert from 'node:assert/strict';
import test from 'node:test';
import { entryText, normalizeMessage } from '@agentry/shared';
import type { Chat, ChatDetail, TranscriptEntry } from '@agentry/shared';
import { appendStreamed, spliceTail, streamMark } from '@agentry/chat-ui/lib/chat-stream';

// Reproductions for docs/reports/chat-audit/client.md. Each test asserts what the chat should do and
// is marked `todo` with the finding's id: it fails today, and the suite stays green until it is fixed.

const chat = {} as Chat;

const assistant = (uuid: string): TranscriptEntry => ({
  uuid,
  role: 'assistant',
  timestamp: null,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text: uuid }],
});

const user = (uuid: string, text: string): TranscriptEntry => ({ ...assistant(uuid), role: 'user', blocks: [{ type: 'text', text }] });

const detail = (entries: TranscriptEntry[], from = 0): ChatDetail => ({ chat, from, total: from + entries.length, entries });

const uuids = (page: ChatDetail | null) => page?.entries.map((entry) => entry.uuid);

/**
 * A message sent while Claude works, streamed by the wrapper under its own uuid, then two answers
 * streamed after it. The CLI reads the message within the running turn and writes it to the
 * transcript only as a `queued_command` attachment line, so no read ever confirms it.
 */
function sentMidTurn(at: number) {
  let page = detail([assistant('a')]);
  page = appendStreamed(page, user('wrapper-u', 'please also run lint'), at).page;
  page = appendStreamed(page, assistant('A1'), at + 1).page;
  page = appendStreamed(page, assistant('A2'), at + 2).page;
  const since = streamMark();
  const fresh = detail([assistant('a'), assistant('A1'), assistant('A2')]);
  return { page, since, fresh };
}

test('C-1: the line the CLI writes for a message it read mid-turn is an entry of the transcript', { todo: 'C-1' }, () => {
  // Shape copied from a real transcript (CLI 2.1.286): the message has no `user` line at all
  const line = {
    type: 'attachment',
    uuid: 'c484d0a7-854a-4f3b-a134-9b135abf6549',
    timestamp: '2026-10-01T12:26:56.793Z',
    isSidechain: false,
    attachment: { type: 'queued_command', prompt: 'please also run lint', commandMode: 'prompt' },
  };
  const entry = normalizeMessage(line);
  assert.ok(entry, 'the message the agent read is dropped from the transcript');
  assert.equal(entry.role, 'user');
  assert.equal(entryText(entry), 'please also run lint');
});

test('C-7: a sent message no read confirms keeps its place instead of sinking below the answers', { todo: 'C-7' }, () => {
  const at = Date.now();
  const { page, since, fresh } = sentMidTurn(at);
  const read = spliceTail(page, fresh, since, at + 5_000);
  // Today: ['a', 'A1', 'A2', 'wrapper-u']: the message drops under what was said after it
  assert.deepEqual(uuids(read), ['a', 'wrapper-u', 'A1', 'A2']);
});

test('C-7: a sent message no read confirms is still on the page ten minutes later', { todo: 'C-7' }, () => {
  const at = Date.now();
  const { page, since, fresh } = sentMidTurn(at);
  const read = spliceTail(page, fresh, since, at + 10 * 60_000 + 1);
  // Today: ['a', 'A1', 'A2']: SENT_GRACE_MS ran out and the message is gone without a trace
  assert.ok(uuids(read)?.includes('wrapper-u'), 'the message the person sent vanished from the page');
});

test('C-6: a message just sent is not taken for an earlier one with the same words', { todo: 'C-6' }, () => {
  const at = Date.now();
  // The person said "ok" a few entries ago, and says it again now
  let page = detail([user('cli-1', 'ok'), assistant('A1')]);
  page = appendStreamed(page, user('wrapper-2', 'ok'), at).page;
  const since = streamMark();
  // The read lands before the CLI has written the second "ok" (or never will: it was read mid-turn)
  const fresh = detail([user('cli-1', 'ok'), assistant('A1')]);
  const read = spliceTail(page, fresh, since, at + 1_500);
  // Today: ['cli-1', 'A1']: the earlier "ok" in the read counts as this one's confirmation
  assert.deepEqual(uuids(read), ['cli-1', 'A1', 'wrapper-2']);
});
