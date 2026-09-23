import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonlCache, type JsonlFold } from '../src/jsonl-cache.ts';

// The fold records every line it is handed, so a test can tell what was parsed again and what was not.
interface Seen {
  ids: number[];
}

function counting(): { fold: JsonlFold<Seen>; added: number[] } {
  const added: number[] = [];
  return {
    added,
    fold: {
      init: () => ({ ids: [] }),
      clone: (s) => ({ ids: [...s.ids] }),
      add: (s, line) => {
        const id = Number(line.id);
        added.push(id);
        s.ids.push(id);
      },
    },
  };
}

const lines = (...ids: number[]) => ids.map((id) => `${JSON.stringify({ id })}\n`).join('');

function tempFile(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'file.jsonl');
}

test('a file that grew is read only for what was appended', async (t) => {
  const file = tempFile(t);
  const { fold, added } = counting();
  const cache = new JsonlCache(fold);
  writeFileSync(file, lines(1, 2));
  assert.deepEqual((await cache.read(file))?.ids, [1, 2]);
  appendFileSync(file, lines(3));
  assert.deepEqual((await cache.read(file))?.ids, [1, 2, 3]);
  assert.deepEqual(added, [1, 2, 3]);
  // Unchanged, nothing is parsed at all
  await cache.read(file);
  assert.deepEqual(added, [1, 2, 3]);
});

test('a rewritten or shrunk file is read again from the start', async (t) => {
  const file = tempFile(t);
  const { fold } = counting();
  const cache = new JsonlCache(fold);
  writeFileSync(file, lines(1, 2, 3));
  await cache.read(file);
  writeFileSync(file, lines(7));
  assert.deepEqual((await cache.read(file))?.ids, [7]);
  // Longer than before, but with other bytes where the last read ended: rewritten, not grown
  writeFileSync(file, lines(4, 5));
  await cache.read(file);
  writeFileSync(file, lines(6, 5, 9));
  assert.deepEqual((await cache.read(file))?.ids, [6, 5, 9]);
});

test('a half-written last line counts once it parses, and is folded in only once', async (t) => {
  const file = tempFile(t);
  const { fold } = counting();
  const cache = new JsonlCache(fold);
  writeFileSync(file, `${lines(1)}{"id":2}`);
  assert.deepEqual((await cache.read(file))?.ids, [1, 2]);
  appendFileSync(file, `\n${lines(3)}{"id":`);
  assert.deepEqual((await cache.read(file))?.ids, [1, 2, 3]);
});

test('reads of one file at the same time share one pass, and a missing file is null', async (t) => {
  const file = tempFile(t);
  const { fold, added } = counting();
  const cache = new JsonlCache(fold);
  writeFileSync(file, lines(1, 2));
  const [a, b] = await Promise.all([cache.read(file), cache.read(file)]);
  assert.equal(a, b);
  assert.deepEqual(added, [1, 2]);
  assert.equal(await cache.read(`${file}.missing`), null);
});

test('lines without the text a fold asks for are not parsed, and the cache forgets the oldest file past its bound', async (t) => {
  const file = tempFile(t);
  const other = `${file}.2`;
  const { fold, added } = counting();
  const cache = new JsonlCache({ ...fold, mentions: '"keep"' }, 1);
  writeFileSync(file, `${JSON.stringify({ id: 1, keep: true })}\n${JSON.stringify({ id: 2 })}\n`);
  writeFileSync(other, lines(3));
  assert.deepEqual((await cache.read(file))?.ids, [1]);
  await cache.read(other);
  await cache.read(file);
  // `file` was dropped to make room for `other`, so it was parsed a second time
  assert.deepEqual(added, [1, 1]);
});
