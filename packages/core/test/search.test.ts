import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { searchPattern, TranscriptSearch } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const line = (o: object) => JSON.stringify(o);
const user = (i: number, content: unknown, extra: object = {}) =>
  line({ type: 'user', uuid: `u${i}`, timestamp: '2026-01-01T10:00:00Z', cwd: '/work/find', message: { role: 'user', content }, ...extra });
const assistant = (i: number, content: unknown[], extra: object = {}) =>
  line({ type: 'assistant', uuid: `a${i}`, timestamp: '2026-01-01T10:00:00Z', message: { role: 'assistant', model: 'm', content }, ...extra });

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 4000): Promise<T> {
  for (let i = 0; i < ms / 20; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a query matches case-insensitively, literally, and across line breaks and indents', () => {
  const pattern = searchPattern('  Hello   (world)? ');
  assert.ok(pattern);
  assert.ok(pattern.test('say hello\n    (WORLD)? now'));
  assert.ok(!pattern.test('hello world'), 'regex characters in the query are plain text');
  assert.equal(searchPattern('   '), null);
});

test('a hit carries the match in a short snippet, and past the cap the newest hits are kept', () => {
  const search = new TranscriptSearch('needle', searchPattern('needle') as RegExp, 3);
  const long = `${'x '.repeat(200)}the NEEDLE\n\nis here ${'y '.repeat(200)}`;
  search.add(long);
  search.add(null);
  search.add('nothing to see');
  for (let i = 0; i < 4; i++) search.add(`needle ${i}`);
  const result = search.result();
  assert.equal(result.total, 7);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hits.map((h) => h.index), [4, 5, 6]);

  const one = new TranscriptSearch('needle is', searchPattern('needle is') as RegExp);
  one.add(long);
  const [hit] = one.result().hits;
  assert.ok(hit);
  assert.equal(hit.snippet.slice(hit.start, hit.start + hit.length), 'NEEDLE is');
  assert.ok(hit.snippet.startsWith('…') && hit.snippet.endsWith('…'));
  assert.ok(hit.snippet.length < 140, `short snippet, got ${hit.snippet.length} chars`);
});

test('searches a whole session in the index space of its pages, tool calls and results included', async () => {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-find');
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 300 }, (_, i) => user(i, `message ${i}`));
  // Far outside the newest page, and in the places the view only shows inside a fold
  lines[3] = assistant(3, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -r Zebra src' } }]);
  lines[4] = user(4, [{ type: 'tool_result', tool_use_id: 't1', content: 'src/a.ts: const zebra = 1' }]);
  lines[150] = assistant(150, [{ type: 'text', text: 'The **zebra** crossing' }]);
  lines[151] = assistant(151, [{ type: 'text', text: 'a subagent saw a zebra' }], { isSidechain: true });
  writeFileSync(join(dir, 'find-1.jsonl'), lines.join('\n'));
  const store = new SessionStore(config);

  const main = await store.searchSession('find-1', 'zebra');
  const page = await store.getSession('find-1');
  assert.equal(main?.total, page?.total, 'the same index space as the pages');
  assert.deepEqual(main?.hits.map((h) => h.index), [3, 4, 150]);
  assert.equal(main?.truncated, false);

  // With sidechains every later index shifts by one, exactly as the page read with them does
  const all = await store.searchSession('find-1', 'zebra', { includeSidechains: true });
  assert.deepEqual(all?.hits.map((h) => h.index), [3, 4, 150, 151]);
  const withSide = await store.getSession('find-1', { includeSidechains: true, limit: 1, before: 152 });
  assert.equal(withSide?.entries[0]?.uuid, 'a151');

  // An index points at the entry that matched, whichever page it is read from
  const hit = await store.getSession('find-1', { limit: 1, before: 151 });
  assert.equal(hit?.from, 150);
  assert.equal(hit?.entries[0]?.uuid, 'a150');

  assert.equal(await store.searchSession('no-such-session', 'zebra'), null);
  await assert.rejects(store.searchSession('find-1', '  '), /q is required/);
});

test('a chat that keeps no transcript is paged and searched over the messages its process streamed, in one index space', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  const file = join(config.dataDir, 'turn.jsonl');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(
    file,
    [
      assistant(1, [{ type: 'text', text: 'Looking for the Quokka' }]),
      assistant(2, [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'quokka' } }]),
      assistant(3, [{ type: 'text', text: 'nothing here' }]),
    ].join('\n'),
  );
  try {
    // Housekeeping runs without persistence, so there is no transcript for the chat to be read from
    const chat = core.runtime.start({ prompt: `REPLAY ${file}`, internal: true });
    await until(() => core.runtime.get(chat.id)?.status === 'idle', 'the turn');

    const result = await core.chats.search(chat.id, 'QUOKKA');
    const page = await core.chats.detail(chat.id, { limit: 1000 });
    assert.equal(result.total, page.total);
    assert.equal(result.hits.length, 2, 'the text and the tool call');
    for (const hit of result.hits) {
      const entry = page.entries[hit.index - page.from];
      assert.ok(entry, 'a hit points at an entry of the page it is read from');
      assert.equal(entry.role, 'assistant');
    }
    await assert.rejects(core.chats.search('ghost', 'quokka'), /not found/);
    await assert.rejects(core.chats.search(chat.id, '  '), /q is required/);
  } finally {
    core.shutdown();
  }
});
