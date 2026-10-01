import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { SessionStoreTranscripts, type TranscriptStore } from '../src/providers/transcripts.ts';
import { SessionStore } from '../src/sessions.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

const line = (o: object) => JSON.stringify(o);

test('the SessionStore adapter answers by session id, and lists by project path', async () => {
  const config = tempConfig();
  const cwd = '/work/demo';
  const dir = join(config.projectsDir, encodeProjectId(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'sess-a.jsonl'),
    [
      line({ type: 'user', uuid: 'm1', timestamp: '2026-01-01T10:00:00.000Z', cwd, message: { role: 'user', content: 'find the needle' } }),
      line({ type: 'assistant', uuid: 'm2', timestamp: '2026-01-01T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'no needle here' }] } }),
    ].join('\n'),
  );
  const store: TranscriptStore = new SessionStoreTranscripts(new SessionStore(config));

  assert.deepEqual((await store.list(cwd)).map((s) => s.id), ['sess-a']);
  assert.deepEqual(await store.list('/work/other'), []);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.summary('sess-a'))?.firstPrompt, 'find the needle');
  assert.equal(await store.summary('nope'), null);
  const page = await store.page('sess-a', { limit: 1 });
  assert.equal(page?.total, 2);
  assert.equal(page?.entries.length, 1);
  assert.equal((await store.search('sess-a', 'needle'))?.hits.length, 2);
  assert.equal(await store.page('nope'), null);
});
