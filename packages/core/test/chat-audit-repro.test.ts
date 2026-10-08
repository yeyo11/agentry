import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { entryText } from '@agentry/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { tempConfig } from './helpers.ts';

// Reproductions added by docs/reports/chat-audit/repro.md for server findings that had none. Each
// test states what a fix should give and is marked `todo` with the finding's id, so the suite stays
// green while the bug stands.

const FAKE_QUEUE = fileURLToPath(new URL('./fixtures/fake-claude-queue.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Op = { op: string; prompt?: string; text?: string; uuid?: string | null; subtype?: string };

test('S-5: the id the page knows a queued message by reaches the CLI, so a merged prompt can be told apart', { todo: 'S-5' }, async () => {
  const config = tempConfig();
  const scratch = mkdtempSync(join(tmpdir(), 'agentry-repro-'));
  const queueLog = join(scratch, 'queue.jsonl');
  const saved = { log: process.env.FAKE_QUEUE_LOG, ids: process.env.FAKE_QUEUE_LOG_IDS };
  process.env.FAKE_QUEUE_LOG = queueLog;
  process.env.FAKE_QUEUE_LOG_IDS = '1';
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_QUEUE)]);
  const ops = (): Op[] => (existsSync(queueLog) ? readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Op) : []);
  try {
    const chat = chats.start({ prompt: `HOLD ${join(scratch, 'f1')}` });
    await until(() => ops().some((o) => o.op === 'turn'), 'the first turn');
    chats.send(chat.id, 'also check the lint');
    chats.send(chat.id, 'and the types');
    await until(() => ops().filter((o) => o.op === 'enqueue').length === 2, 'the CLI to queue both');
    // "Send now" on the page: an interrupt, after which the CLI reads its whole queue as one prompt
    await chats.interrupt(chat.id);
    const second = await until(() => ops().filter((o) => o.op === 'turn')[1], 'the turn that reads the queue');
    assert.equal(second.prompt, 'also check the lint\nand the types', 'the CLI read both messages as one prompt');
    // What the page holds of each message: the entry the wrapper streamed, under a uuid of its own
    const streamed = chats
      .events(chat.id)
      .flatMap((e) => (e.kind === 'message' && e.entry?.role === 'user' && ['also check the lint', 'and the types'].includes(entryText(e.entry)) ? [e.entry.uuid] : []));
    assert.equal(streamed.length, 2);
    const given = ops().flatMap((o) => (o.op === 'stdin' && o.uuid ? [o.uuid] : []));
    // Today the stdin line has no uuid: nothing the CLI writes back can name the message it read, so
    // the page can only match by text, and the merged text matches neither card
    for (const uuid of streamed) assert.ok(given.includes(uuid), `the CLI was never told the id ${uuid}; it received ${JSON.stringify(given)}`);
  } finally {
    writeFileSync(join(scratch, 'f1'), '');
    chats.stopAll();
    await new Promise((r) => setTimeout(r, 100));
    db.close();
    for (const [name, value] of [['FAKE_QUEUE_LOG', saved.log], ['FAKE_QUEUE_LOG_IDS', saved.ids]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});

/** The Claude driver, with the CLI session's other holders set by the test: how a respawn gets refused. */
class HeldSessionDriver extends ClaudeCodeDriver {
  holders: number[] = [];
  override sessionHolders(): number[] {
    return this.holders;
  }
}

test('C-8: a message held for a replacement process that cannot start is reported as not delivered', { todo: 'C-8' }, async () => {
  const config = tempConfig();
  const scratch = mkdtempSync(join(tmpdir(), 'agentry-repro-'));
  const queueLog = join(scratch, 'queue.jsonl');
  const saved = { log: process.env.FAKE_QUEUE_LOG, linger: process.env.FAKE_LINGER_MS };
  process.env.FAKE_QUEUE_LOG = queueLog;
  process.env.FAKE_LINGER_MS = '1500';
  const db = new Db(config);
  const driver = new HeldSessionDriver(FAKE_QUEUE);
  const chats = new ChatManager(config, db, [driver]);
  const ops = (): Op[] => (existsSync(queueLog) ? readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Op) : []);
  try {
    // keepAlive false, as flow runs, workers and decisions have: the result closes stdin and the CLI
    // lingers on its way out, so a message sent now is held for the process that replaces it
    const chat = chats.start({ prompt: 'first', keepAlive: false });
    await until(() => ops().some((o) => o.op === 'eof'), 'stdin to close');
    chats.send(chat.id, 'held for the next process');
    // The replacement is refused: here the session is held by a process the chat does not track,
    // one of the refusals `spawnProcess` throws (chats.ts:958-965)
    driver.holders = [424242];
    await until(() => !chats.get(chat.id)?.pid, 'the old process to exit');
    await until(() => chats.get(chat.id)?.status === 'failed', 'the chat to fail', 4000).catch(() => undefined);
    const runtime = chats.get(chat.id);
    assert.equal(ops().filter((o) => o.op === 'turn').length, 1, 'the CLI never read the held message');
    const said = chats.events(chat.id).some((e) => JSON.stringify(e).includes('held for the next process'));
    // Today: the chat fails with the refusal's reason, and nothing anywhere names the message
    assert.ok(said, `the held message vanished without an event (status ${runtime?.status}, error ${JSON.stringify(runtime?.error)})`);
  } finally {
    chats.stopAll();
    await new Promise((r) => setTimeout(r, 100));
    db.close();
    for (const [name, value] of [['FAKE_QUEUE_LOG', saved.log], ['FAKE_LINGER_MS', saved.linger]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});
