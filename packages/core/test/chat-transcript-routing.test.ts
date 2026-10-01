import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { entryText, type TranscriptEntry } from '@agentry/shared';
import { ChatService, type ChatServiceDeps } from '../src/chat-service.ts';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import type { AcpDriver } from '../src/providers/acp/driver.ts';
import { ChatEntriesTranscripts } from '../src/providers/chat-entries.ts';
import { TranscriptUnavailable, type TranscriptStore } from '../src/providers/transcripts.ts';
import { acpHarness } from './acp-harness.ts';
import { tempConfig } from './helpers.ts';

// A non-Claude chat's transcript: what it streamed is stored as rows, and ChatService reads the
// chat's provider store first and those rows after it.
const harness = acpHarness('gemini');

// The fake agent is found on the PATH, as the conformance suite arranges it
let savedPath: string | undefined;
before(() => {
  savedPath = process.env.PATH;
  process.env.PATH = harness.env?.PATH ?? savedPath ?? '';
});
after(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

function rig() {
  const config = tempConfig();
  const driver = harness.driver(config) as AcpDriver;
  const db = new Db(config);
  const chats = new ChatManager(config, db, [driver]);
  const service = new ChatService({ config, runtime: chats, entries: new ChatEntriesTranscripts(db) } as unknown as ChatServiceDeps);
  const run = async (prompt: string, id?: string) => {
    const chat = id ? chats.resume(id, { prompt }) : chats.start({ prompt, name: 'routing', keepAlive: false });
    await chats.exited(chat.id);
    return chat.id;
  };
  /** A word that appears in what the chat recorded */
  const word = (id: string): string => {
    const entry = db.chatEntries(id).map((e) => e.entry as TranscriptEntry).find((e) => entryText(e).length > 0);
    return entry ? (entryText(entry).split(/\s+/)[0] ?? '') : '';
  };
  return { driver, db, chats, service, run, word, close: () => (chats.stopAll(), db.close()) };
}

test('a non-Claude chat records what it streamed, and a resume carries on after it', async () => {
  const { db, run, close } = rig();
  try {
    const id = await run('TURN');
    const first = db.chatEntries(id);
    assert.ok(first.length > 0);
    assert.deepEqual(first.map((e) => e.seq), first.map((_, i) => i));
    await run('TURN', id);
    const all = db.chatEntries(id);
    assert.ok(all.length > first.length, 'the second turn added rows');
    assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i));
    db.deleteChat(id);
    assert.deepEqual(db.chatEntries(id), []);
  } finally {
    close();
  }
});

test('with no store of its own a chat is searched in the rows it recorded', async () => {
  const { driver, service, run, word, close } = rig();
  try {
    assert.equal(driver.transcripts, null);
    const id = await run('TURN');
    assert.ok(word(id));
    assert.ok((await service.search(id, word(id))).hits.length > 0);
  } finally {
    close();
  }
});

test('the provider store is read by the native id, and the rows answer when it cannot', async () => {
  const { driver, chats, db, service, run, word, close } = rig();
  try {
    const id = await run('TURN');
    const native = chats.get(id)?.nativeSessionId ?? '';
    assert.ok(native && native !== id, 'the agent named the session');
    const asked: string[] = [];
    const stub: TranscriptStore = {
      list: async () => [],
      summary: async () => null,
      page: async () => null,
      search: async (nativeId) => {
        asked.push(nativeId);
        return { query: 'x', hits: [], truncated: false, total: 7 };
      },
    };
    driver.transcripts = stub;
    assert.equal((await service.search(id, 'x')).total, 7);
    assert.deepEqual(asked, [native]);

    driver.transcripts = {
      ...stub,
      search: async () => {
        throw new TranscriptUnavailable('busy');
      },
    };
    const w = word(id);
    assert.ok((await service.search(id, w)).hits.length > 0, 'the rows answered');
    db.deleteChat(id);
    await assert.rejects(service.search(id, w), TranscriptUnavailable);
  } finally {
    close();
  }
});
