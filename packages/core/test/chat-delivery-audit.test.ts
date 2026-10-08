import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { entryText, type TranscriptEntry } from '@agentry/shared';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import type { AcpDriver } from '../src/providers/acp/driver.ts';
import { ChatEntriesTranscripts } from '../src/providers/chat-entries.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { acpHarness } from './acp-harness.ts';
import { tempConfig } from './helpers.ts';

// Reproductions of the server findings of the chat message audit (docs/reports/chat-audit/server.md).
// Each test states the behaviour a fix should give and is marked `todo` with the finding's id, so the
// suite stays green while the bug stands; a fix removes the mark.

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

/** A chat manager over the queueing fake, with the log the fake keeps of what it read. */
function claudeRig() {
  const config = tempConfig();
  const root = join(config.dataDir, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'agentry-delivery-'));
  const queueLog = join(scratch, 'queue.jsonl');
  const db = new Db(config);
  const chats = new ChatManager(config, db, [new ClaudeCodeDriver(FAKE_QUEUE)]);
  const savedLog = process.env.FAKE_QUEUE_LOG;
  process.env.FAKE_QUEUE_LOG = queueLog;
  const ops = (): Array<{ op: string; prompt?: string; text?: string; subtype?: string }> =>
    existsSync(queueLog) ? readFileSync(queueLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { op: string }) : [];
  const close = async () => {
    // Every hold is let go, so nothing the fake runs outlives the test
    for (const name of ['f1', 'f2', 'f3']) writeFileSync(join(scratch, name), '');
    chats.stopAll();
    await pause(100);
    db.close();
    if (savedLog === undefined) delete process.env.FAKE_QUEUE_LOG;
    else process.env.FAKE_QUEUE_LOG = savedLog;
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  };
  return { config, db, chats, scratch, ops, close };
}

/** A turn that runs until a second message the CLI queued is read as a turn of its own, and that turn is thinking. */
async function secondTurnThinking(rig: ReturnType<typeof claudeRig>): Promise<string> {
  const f1 = join(rig.scratch, 'f1');
  const f2 = join(rig.scratch, 'f2');
  const chat = rig.chats.start({ prompt: `HOLD ${f1}` });
  await until(() => rig.ops().some((o) => o.op === 'turn'), 'the first turn');
  // Sent while the first turn runs: the CLI queues it
  rig.chats.send(chat.id, `SILENT ${f2}`);
  await until(() => rig.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue the second message');
  writeFileSync(f1, '');
  // The first turn ends and the CLI starts on the queued message at once, streaming only partials
  await until(() => rig.ops().filter((o) => o.op === 'turn').length === 2, 'the second turn');
  await until(() => rig.chats.get(chat.id)?.turns === 1, 'the first result to be folded');
  await pause(100);
  return chat.id;
}

// ---------- S-1: the chat reads idle while the CLI works on a queued message ----------

test('S-1: a chat whose CLI is working on a message it queued is busy, not idle', { todo: 'S-1' }, async () => {
  const rig = claudeRig();
  try {
    const id = await secondTurnThinking(rig);
    assert.equal(rig.chats.get(id)?.status, 'busy', 'the CLI is on the second message, the chat says it is idle');
  } finally {
    await rig.close();
  }
});

test('S-1: "send now" (an interrupt) reaches the CLI while it works on a queued message', { todo: 'S-1' }, async () => {
  const rig = claudeRig();
  try {
    const id = await secondTurnThinking(rig);
    // What the page's "Send now" calls: answered 200, with the chat as it is
    await rig.chats.interrupt(id);
    await pause(200);
    assert.ok(
      rig.ops().some((o) => o.op === 'control' && o.subtype === 'interrupt'),
      'the interrupt was answered without being sent: the status said idle',
    );
  } finally {
    await rig.close();
  }
});

// ---------- S-2: a message the CLI queued dies with its process, and nothing says so ----------

test('S-2: a message the CLI still held when its process went away is reported as not delivered', { todo: 'S-2' }, async () => {
  const rig = claudeRig();
  try {
    const chat = rig.chats.start({ prompt: `HOLD ${join(rig.scratch, 'f1')}` });
    await until(() => rig.ops().some((o) => o.op === 'turn'), 'the first turn');
    rig.chats.send(chat.id, 'second, queued by the CLI');
    await until(() => rig.ops().some((o) => o.op === 'enqueue'), 'the CLI to queue it');
    // The page showed it as sent: the stream carried it as a user message the moment it was written
    assert.ok(rig.chats.events(chat.id).some((e) => e.kind === 'message' && e.entry?.role === 'user' && entryText(e.entry) === 'second, queued by the CLI'));
    // Stop (or a crash, a move to another provider, a wrapper restart) takes the CLI's queue with it
    rig.chats.stop(chat.id);
    await until(() => !rig.chats.get(chat.id)?.pid, 'the process to exit');
    await pause(100);
    assert.equal(rig.ops().filter((o) => o.op === 'turn').length, 1, 'the CLI never read it');
    const told = rig.chats.events(chat.id).some((e) => e.kind === 'notice' && JSON.stringify(e).includes('second, queued'));
    assert.ok(told, 'nothing tells the page that the message it shows as sent was never read');
  } finally {
    await rig.close();
  }
});

// ---------- S-3: a message held for the replacement process has no trace and stop drops it ----------

test('S-3: a message held for the next process shows in the stream at once', { todo: 'S-3' }, async () => {
  const rig = claudeRig();
  const saved = process.env.FAKE_LINGER_MS;
  process.env.FAKE_LINGER_MS = '3000';
  try {
    const chat = rig.chats.start({ prompt: 'first', keepAlive: false });
    // keepAlive false: the result closes stdin, and the CLI lingers on its way out
    await until(() => rig.ops().some((o) => o.op === 'eof'), 'stdin to close');
    assert.ok(rig.chats.get(chat.id)?.pid, 'the process is still up');
    const before = rig.chats.events(chat.id).length;
    rig.chats.send(chat.id, 'second, sent while the process leaves');
    const after = rig.chats.events(chat.id).slice(before);
    assert.ok(
      after.some((e) => e.kind === 'message' && e.entry && entryText(e.entry).includes('second')),
      'POST /messages answered 200 and the stream says nothing of the message until a new process starts',
    );
  } finally {
    if (saved === undefined) delete process.env.FAKE_LINGER_MS;
    else process.env.FAKE_LINGER_MS = saved;
    await rig.close();
  }
});

test('S-3: stopping a chat that holds a message says the message was not delivered', { todo: 'S-3' }, async () => {
  const rig = claudeRig();
  const saved = process.env.FAKE_LINGER_MS;
  process.env.FAKE_LINGER_MS = '3000';
  try {
    const chat = rig.chats.start({ prompt: 'first', keepAlive: false });
    await until(() => rig.ops().some((o) => o.op === 'eof'), 'stdin to close');
    rig.chats.send(chat.id, 'second, sent while the process leaves');
    rig.chats.stop(chat.id);
    await until(() => !rig.chats.get(chat.id)?.pid, 'the process to exit');
    await pause(100);
    assert.equal(rig.ops().filter((o) => o.op === 'turn').length, 1, 'stop means no new process');
    const said = rig.chats.events(chat.id).some((e) => (e.kind === 'notice' || e.kind === 'message') && JSON.stringify(e).includes('second, sent'));
    assert.ok(said, 'the message was dropped from memory with no event, no notice and no row anywhere');
  } finally {
    if (saved === undefined) delete process.env.FAKE_LINGER_MS;
    else process.env.FAKE_LINGER_MS = saved;
    await rig.close();
  }
});

// ---------- S-4: a message the CLI absorbed mid-turn is not in the transcript ----------

test('S-4: a message the CLI absorbed into the running turn is in the transcript Agentry serves', { todo: 'S-4' }, async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_QUEUE };
  const core = new Core(config);
  try {
    const sessionId = '0b5f4a3e-6d1c-4a52-9a37-3f1c8e2b7d10';
    const cwd = join(config.workspaceDir, 'project');
    mkdirSync(cwd, { recursive: true });
    const dir = join(config.projectsDir, encodeProjectId(cwd));
    mkdirSync(dir, { recursive: true });
    const at = '2026-10-01T12:26:56.793Z';
    // The lines CLI 2.1 writes when a stream-json message arrives during a tool call: the queue
    // operations and an `attachment` of type `queued_command`, and no `user` entry with the text
    // (shape copied from a real transcript, ids and text replaced)
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: at, cwd, sessionId, message: { role: 'user', content: 'run the tests' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at, cwd, sessionId, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }] } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId, content: 'also check the lint' },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: at, cwd, sessionId, message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok', is_error: false }] } },
      {
        parentUuid: 'u2',
        isSidechain: false,
        attachment: { type: 'queued_command', prompt: 'also check the lint', source_uuid: 's1', delivery_id: 'd1', commandMode: 'prompt', timestamp: at },
        type: 'attachment',
        uuid: 'q1',
        timestamp: at,
        sessionId,
        cwd,
      },
      { type: 'queue-operation', operation: 'remove', timestamp: at, sessionId, content: 'also check the lint', reason: 'absorbed_mid_turn' },
      { type: 'assistant', uuid: 'a2', parentUuid: 'q1', timestamp: at, cwd, sessionId, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Tests pass; running the lint as asked.' }] } },
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
    const detail = await core.chats.detail(sessionId);
    const said = detail.entries.filter((e: TranscriptEntry) => e.role === 'user').map((e) => entryText(e));
    assert.ok(said.includes('also check the lint'), `the person's second message is not on the page: ${JSON.stringify(said)}`);
  } finally {
    core.shutdown();
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  }
});

// ---------- ACP: S-6 and S-7 ----------

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

function acpRig() {
  const config = tempConfig();
  const driver = harness.driver(config) as AcpDriver;
  const db = new Db(config);
  const chats = new ChatManager(config, db, [driver]);
  const close = () => {
    chats.stopAll();
    db.close();
    rmSync(join(config.dataDir, '..'), { recursive: true, force: true });
  };
  return { db, chats, close };
}

test("S-6: a Gemini or Copilot chat's transcript holds the person's own messages", { todo: 'S-6' }, async () => {
  const { db, chats, close } = acpRig();
  try {
    const chat = chats.start({ prompt: 'TURN for the person', name: 'person', keepAlive: false });
    await chats.exited(chat.id);
    const recorded = db.chatEntries(chat.id).map((row) => row.entry as TranscriptEntry);
    assert.ok(recorded.some((e) => e.role === 'assistant'), 'the agent side was recorded');
    // What the page reads for a provider that keeps no transcript Agentry can read
    const page = await new ChatEntriesTranscripts(db).page(chat.id);
    const said = (page?.entries ?? []).filter((e) => e.role === 'user').map((e) => entryText(e));
    assert.ok(said.includes('TURN for the person'), `only tool results were recorded as user entries: ${JSON.stringify(said)}`);
  } finally {
    close();
  }
});

test('S-7: an ACP chat that ends its input after a turn still runs the turn queued behind it', { todo: 'S-7' }, async () => {
  const { chats, close } = acpRig();
  const saved = process.env.FAKE_ACP_STEP_MS;
  process.env.FAKE_ACP_STEP_MS = '150';
  try {
    // keepAlive false, as every flow run, orchestration worker and decision chat has
    const chat = chats.start({ prompt: 'TURN first', name: 'queued', keepAlive: false });
    await until(() => chats.get(chat.id)?.status === 'busy', 'the first turn');
    // A hint, or the person, while the first turn runs: the driver queues it
    chats.send(chat.id, 'TURN second');
    await chats.exited(chat.id);
    const results = chats.events(chat.id).filter((e) => e.kind === 'result');
    assert.equal(results.length, 2, 'the second turn was written after stdin closed and never ran');
  } finally {
    if (saved === undefined) delete process.env.FAKE_ACP_STEP_MS;
    else process.env.FAKE_ACP_STEP_MS = saved;
    close();
  }
});
