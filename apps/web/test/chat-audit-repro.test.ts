import assert from 'node:assert/strict';
import test from 'node:test';
import { entryText } from '@agentry/shared';
import type { Chat, ChatDetail, TranscriptEntry } from '@agentry/shared';
import { appendStreamed, spliceTail, streamMark } from '@agentry/chat-ui/lib/chat-stream';

// Reproductions added by docs/reports/chat-audit/repro.md for findings that had none. Each test
// asserts what the chat should do and is marked `todo` with the finding's id: it fails today, and the
// suite stays green until the finding is fixed.

const chat = {} as Chat;

const entry = (uuid: string, role: 'user' | 'assistant', text: string): TranscriptEntry => ({
  uuid,
  role,
  timestamp: null,
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text }],
});

const detail = (entries: TranscriptEntry[]): ChatDetail => ({ chat, from: 0, total: entries.length, entries });

test('S-5: two queued messages the CLI read as one prompt are shown once, not twice', () => {
  const at = Date.now();
  // Turn 1 runs; the person sends two messages, which the wrapper streams under uuids of its own
  let page = detail([entry('u1', 'user', 'run the tests'), entry('a1', 'assistant', 'Running them.')]);
  page = appendStreamed(page, entry('wrapper-1', 'user', 'also check the lint'), at).page;
  page = appendStreamed(page, entry('wrapper-2', 'user', 'and the types'), at + 1).page;
  const since = streamMark();
  // "Send now": the interrupt ends turn 1 and the CLI reads every queued message as one prompt, which
  // it writes as one `user` line with the texts joined by a newline (session f7ddba36…, lines 884-890)
  const fresh = detail([
    entry('u1', 'user', 'run the tests'),
    entry('a1', 'assistant', 'Running them.'),
    entry('cli-merged', 'user', 'also check the lint\nand the types'),
    entry('a2', 'assistant', 'Checking the lint and the types.'),
  ]);
  const read = spliceTail(page, fresh, since, at + 2_000);
  const said = (read?.entries ?? []).filter((e) => e.role === 'user').map((e) => entryText(e));
  // Today: both streamed copies are kept as unconfirmed and put after the answer, so the two
  // messages are on the page twice: once merged where the CLI read them, once each at the bottom
  assert.deepEqual(said, ['run the tests', 'also check the lint\nand the types']);
});
