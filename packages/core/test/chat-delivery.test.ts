import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { Execution, MessageDelivery } from '@agentry/shared';
import { ChatManager, ChatRefusal } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import { LiveChat } from '../src/live-chat.ts';
import type { AcpDriver } from '../src/providers/acp/driver.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { acpHarness } from './acp-harness.ts';
import { tempConfig } from './helpers.ts';

// How a message is followed from the send to the agent taking it (docs/chat-delivery.md), over the
// queueing fake, which reads messages back as the CLI does with `--replay-user-messages`.

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

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Op = { op: string; prompt?: string; text?: string; uuid?: string | null; subtype?: string };

/** Sets environment variables for one test and gives back the old values on close. */
function withEnv(vars: Record<string, string>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function rig(env: Record<string, string> = {}, setup?: (config: ReturnType<typeof tempConfig>) => void) {
  const config = tempConfig();
  setup?.(config);
  const scratch = mkdtempSync(join(tmpdir(), 'agentry-delivery-'));
  const queueLog = join(scratch, 'queue.jsonl');
  const restore = withEnv({ FAKE_QUEUE_LOG: queueLog, FAKE_QUEUE_LOG_IDS: '1', ...env });
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_QUEUE)]);
  const ops = (): Op[] => (existsSync(queueLog) ? readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Op) : []);
  const deliveries = (id: string): MessageDelivery[] => chats.events(id).flatMap((e) => (e.kind === 'delivery' && e.delivery ? [e.delivery] : []));
  const release = (name: string) => writeFileSync(join(scratch, name), '');
  const close = async () => {
    for (const name of ['f1', 'f2', 'f3']) release(name);
    chats.stopAll();
    await pause(150);
    db.close();
    restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  };
  return { config, db, chats, scratch, ops, deliveries, release, close };
}

test('a prompt the CLI made of several messages yields one delivered event per message', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${join(r.scratch, 'f1')}` });
    // The fake logs its turn before it reads the prompt back: until the chat has heard the read-back,
    // the first prompt is rightly still pending, ahead of the two below
    await until(() => r.ops().some((o) => o.op === 'turn') && r.chats.get(chat.id)?.pending?.length === 0, 'the agent to take the first prompt');
    const a = r.chats.sendMessage(chat.id, 'also check the lint');
    const b = r.chats.sendMessage(chat.id, 'and the types');
    assert.deepEqual([a.taken, b.taken], ['written', 'written']);
    await until(() => r.ops().filter((o) => o.op === 'enqueue').length === 2, 'both queued');
    assert.deepEqual(r.chats.get(chat.id)?.pending?.map((m) => m.id), [a.id, b.id]);
    await r.chats.interrupt(chat.id);
    await until(() => r.ops().filter((o) => o.op === 'turn')[1], 'the merged turn');
    await until(() => r.deliveries(chat.id).length >= 3, 'the deliveries');
    const delivered = r.deliveries(chat.id).filter((d) => d.state === 'delivered').map((d) => d.id);
    assert.ok(delivered.includes(a.id) && delivered.includes(b.id), JSON.stringify(delivered));
    assert.equal(delivered.filter((id) => id === a.id).length, 1);
    assert.deepEqual(r.chats.get(chat.id)?.pending, []);
  } finally {
    await r.close();
  }
});

test('a message id sent twice is written once, and answered as the first time', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${join(r.scratch, 'f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const id = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    const first = r.chats.sendMessage(chat.id, 'only once', [], id);
    const again = r.chats.sendMessage(chat.id, 'only once', [], id);
    assert.deepEqual(first, { id, taken: 'written' });
    assert.deepEqual(again, { id, taken: 'written', duplicate: true });
    await pause(200);
    assert.equal(r.ops().filter((o) => o.op === 'stdin' && o.text === 'only once').length, 1);
    assert.equal(r.chats.events(chat.id).filter((e) => e.kind === 'message' && e.entry?.uuid === id).length, 1);
  } finally {
    await r.close();
  }
});

test('the id a message is sent with is the one the CLI gets and the one the page streams', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${join(r.scratch, 'f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const { id } = r.chats.sendMessage(chat.id, 'with an id');
    await until(() => r.ops().some((o) => o.op === 'stdin' && o.text === 'with an id'), 'the write');
    assert.equal(r.ops().find((o) => o.op === 'stdin' && o.text === 'with an id')?.uuid, id);
    assert.ok(r.chats.events(chat.id).some((e) => e.kind === 'message' && e.entry?.uuid === id));
  } finally {
    await r.close();
  }
});

test('a message sent while the process leaves is held, and answered so', async () => {
  const r = rig({ FAKE_LINGER_MS: '1500' });
  try {
    const chat = r.chats.start({ prompt: 'first', keepAlive: false });
    await until(() => r.ops().some((o) => o.op === 'eof'), 'stdin to close');
    const held = r.chats.sendMessage(chat.id, 'for the next process');
    assert.equal(held.taken, 'held');
    assert.deepEqual(r.chats.get(chat.id)?.pending?.map((m) => [m.id, m.state]), [[held.id, 'held']]);
    // The replacement takes it, and reads it back
    await until(() => r.ops().filter((o) => o.op === 'turn').length === 2, 'the replacement', 6000);
    await until(() => r.deliveries(chat.id).some((d) => d.id === held.id && d.state === 'delivered'), 'its delivery');
  } finally {
    await r.close();
  }
});

test('"Send now" ends the turn while the message waits, and is refused once the agent has read it', async () => {
  const r = rig();
  try {
    const chat = r.chats.start({ prompt: `HOLD ${join(r.scratch, 'f1')}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const { id } = r.chats.sendMessage(chat.id, `HOLD ${join(r.scratch, 'f2')}`);
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    await r.chats.interrupt(chat.id, id);
    await until(() => r.deliveries(chat.id).some((d) => d.id === id && d.state === 'delivered'), 'its delivery');
    const controls = r.ops().filter((o) => o.op === 'control').length;
    await assert.rejects(r.chats.interrupt(chat.id, id), (err: unknown) => err instanceof ChatRefusal && err.statusCode === 409);
    await pause(100);
    assert.equal(r.ops().filter((o) => o.op === 'control').length, controls, 'the turn answering it was interrupted');
  } finally {
    await r.close();
  }
});

test('a chat restored with messages the agent had not taken says they were lost', () => {
  const config = tempConfig();
  try {
    const at = '2026-10-08T12:00:00.000Z';
    const chat = LiveChat.restore(
      {
        record: {
          id: 'c1',
          name: 'c1',
          cwd: config.workspaceDir,
          workingDir: null,
          origin: 'agentry',
          orchestrationId: null,
          orchestrationTaskId: null,
          derivedFrom: null,
          prompt: 'first',
          lastText: null,
          model: null,
          permissionMode: 'manual',
          permissionPrompts: 'none',
          pending: [{ id: 'm1', text: 'still queued', attachments: [], state: 'written', sentAt: at }],
          createdAt: at,
          updatedAt: at,
        },
        executions: [] as Execution[],
      },
      config,
      new ClaudeCodeDriver(FAKE_QUEUE),
    );
    const [lost] = chat.summary().pending ?? [];
    assert.equal(lost?.state, 'undelivered');
    assert.equal(lost?.text, 'still queued');
    assert.ok(lost?.reason);
  } finally {
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});

// ---------- the minor findings ----------

test('S-9: a limit replay sends the turn that died again, and what was written during it', async () => {
  const r = rig();
  try {
    const f1 = join(r.scratch, 'f1');
    const chat = r.chats.start({ prompt: `HOLD ${f1}` });
    await until(() => r.ops().some((o) => o.op === 'turn'), 'the first turn');
    const later = r.chats.sendMessage(chat.id, 'written during it');
    await until(() => r.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    assert.equal(await r.chats.replayLastTurn(chat.id), true);
    await until(() => r.ops().filter((o) => o.op === 'turn').length === 2, 'the replayed turn');
    r.release('f1');
    await until(() => r.ops().filter((o) => o.op === 'turn').length === 3, 'the message written during it');
    assert.deepEqual(r.ops().filter((o) => o.op === 'turn').map((o) => o.prompt), [`HOLD ${f1}`, `HOLD ${f1}`, 'written during it']);
    // It went on under the id the page knows it by, and was never called lost
    assert.ok(!r.deliveries(chat.id).some((d) => d.state === 'undelivered'));
    await until(() => r.deliveries(chat.id).some((d) => d.id === later.id && d.state === 'delivered'), 'its delivery');
  } finally {
    await r.close();
  }
});

test('S-10: two messages sent close together reach the agent in the order they were sent', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_QUEUE };
  const scratch = mkdtempSync(join(tmpdir(), 'agentry-delivery-'));
  const queueLog = join(scratch, 'queue.jsonl');
  const restore = withEnv({ FAKE_QUEUE_LOG: queueLog });
  const core = new Core(config);
  try {
    const chat = core.runtime.start({ prompt: `HOLD ${join(scratch, 'f1')}` });
    await until(() => existsSync(queueLog), 'the first turn');
    // The first send's look at the chat is the slow one: without an order of their own the second
    // write overtook it
    const service = core.chats as unknown as { summaryOf: (id: string) => Promise<unknown> };
    const read = service.summaryOf.bind(core.chats);
    let calls = 0;
    service.summaryOf = async (id: string) => {
      if (calls++ === 0) await pause(300);
      return read(id);
    };
    await Promise.all([core.chats.send(chat.id, { text: 'one' }), core.chats.send(chat.id, { text: 'two' })]);
    // A send settles once the line is on the CLI's stdin, before the CLI has read it: the order is
    // read off the CLI's own log once both lines reached it
    const enqueued = () => readFileSync(queueLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Op).filter((o) => o.op === 'enqueue').map((o) => o.text);
    const written = await until(() => (enqueued().length >= 2 ? enqueued() : null), 'both messages to reach the CLI');
    assert.deepEqual(written, ['one', 'two']);
  } finally {
    writeFileSync(join(scratch, 'f1'), '');
    core.shutdown();
    await pause(150);
    restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});

test('S-11: a message sent between a process exiting and closing waits for it, and the old execution ends first', async () => {
  const r = rig({ FAKE_CLOSE_GAP_MS: '1200' });
  try {
    const chat = r.chats.start({ prompt: 'first', keepAlive: false });
    // Exited, with a child still holding its stdout: no pid, and no close yet
    await until(() => r.chats.get(chat.id)?.pid === null, 'the process to exit');
    assert.equal(r.chats.get(chat.id)?.executions[0]?.endedAt, null, 'the process has not closed yet');
    const sent = r.chats.sendMessage(chat.id, 'between exit and close');
    assert.equal(sent.taken, 'held');
    await until(() => r.ops().filter((o) => o.op === 'turn').length === 2, 'the replacement', 6000);
    const executions = r.chats.get(chat.id)?.executions ?? [];
    assert.equal(executions.length, 2);
    assert.ok(executions[0]?.endedAt, 'the first execution was never ended');
  } finally {
    await r.close();
  }
});

test('S-12: an interrupt on a process whose input is closed answers at once', async () => {
  const r = rig({ FAKE_LINGER_MS: '3000' });
  try {
    const chat = r.chats.start({ prompt: 'first', keepAlive: false });
    await until(() => r.ops().some((o) => o.op === 'eof'), 'stdin to close');
    const at = Date.now();
    await r.chats.interrupt(chat.id);
    assert.ok(Date.now() - at < 1000, `the interrupt took ${Date.now() - at} ms`);
  } finally {
    await r.close();
  }
});

test('S-13: a message that would start a process waits its turn under the limit on concurrent runs', async () => {
  const r = rig({}, (config) => Object.assign(config, { maxConcurrentRuns: 1 }));
  try {
    const done = r.chats.start({ prompt: 'first', keepAlive: false });
    await r.chats.exited(done.id);
    r.chats.start({ prompt: `HOLD ${join(r.scratch, 'f1')}` });
    assert.throws(() => r.chats.sendMessage(done.id, 'starts a second process'), (err: unknown) => err instanceof ChatRefusal && /Concurrent run limit/.test(err.message));
  } finally {
    await r.close();
  }
});

// ---------- S-8: ACP ----------

const harness = acpHarness('gemini');
let savedPath: string | undefined;
before(() => {
  savedPath = process.env.PATH;
  process.env.PATH = harness.env?.PATH ?? savedPath ?? '';
});
after(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

test('S-8: an ACP interrupt that times out fails the turn and starts no prompt beside the one still running', async () => {
  const config = tempConfig();
  const scratch = mkdtempSync(join(tmpdir(), 'agentry-delivery-'));
  const log = join(scratch, 'acp.jsonl');
  const restore = withEnv({ AGENTRY_ACP_INTERRUPT_TIMEOUT_MS: '200', FAKE_ACP_LOG: log });
  const db = new Db(config);
  const chats = new ChatManager(config, db, [harness.driver(config) as AcpDriver]);
  const prompts = () =>
    (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; line?: unknown }) : []).flatMap((m) => {
      if (!m.line) return [];
      const msg = (typeof m.line === 'string' ? JSON.parse(m.line) : m.line) as { method?: string; id?: number };
      return [{ dir: m.dir, method: msg.method, id: msg.id }];
    });
  try {
    const chat = chats.start({ prompt: 'STUBBORN 1200', name: 'stubborn' });
    await until(() => prompts().some((p) => p.dir === 'in' && p.method === 'session/prompt'), 'the first prompt');
    chats.send(chat.id, 'TURN second');
    await chats.interrupt(chat.id);
    // Given up on: the turn is reported failed, and the second prompt waits for the first one's reply
    assert.equal(chats.events(chat.id).filter((e) => e.kind === 'result').length, 1);
    assert.equal(prompts().filter((p) => p.dir === 'in' && p.method === 'session/prompt').length, 1, 'a second prompt ran beside the first');
    await until(() => chats.events(chat.id).filter((e) => e.kind === 'result').length === 2, 'the second turn', 6000);
    const results = chats.events(chat.id).filter((e) => e.kind === 'result');
    assert.equal(results[1]?.text?.includes('TURN second'), true, `the second result is not the second turn's: ${results[1]?.text}`);
  } finally {
    chats.stopAll();
    await pause(150);
    db.close();
    restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});
