import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { CodexTranscripts, itemEntries } from '../src/providers/codex/transcripts.ts';
import type { ThreadItem } from '../src/providers/codex/protocol/types.ts';

// Codex's history through the store, on the fake app-server: a first process runs a turn and ends,
// the store reads what it left from a reader process of its own.
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

let dir = '';
let state = '';
let threadId = '';
let store: CodexTranscripts;

function seed(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [FAKE, 'app-server'], { env: { PATH: process.env.PATH ?? '', FAKE_CODEX_STATE: state }, stdio: 'pipe' });
    const send = (m: Record<string, unknown>) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    let id = '';
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const m = JSON.parse(line) as { id?: number; method?: string; result?: { thread?: { id: string } } };
      if (m.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'thread/start', params: { cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write' } });
      } else if (m.id === 2) {
        id = m.result?.thread?.id ?? '';
        send({ id: 3, method: 'turn/start', params: { threadId: id, input: [{ type: 'text', text: 'find the needle', text_elements: [] }] } });
      } else if (m.method === 'turn/completed') {
        proc.stdin.end();
      }
    });
    proc.on('exit', () => (id ? resolve(id) : reject(new Error('no thread'))));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentry', title: 'Agentry', version: '0.0.0' }, capabilities: { experimentalApi: false, requestAttestation: false } } });
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentry-codex-transcripts-'));
  state = join(dir, 'threads.json');
  threadId = await seed();
  store = new CodexTranscripts({ bin: process.execPath, args: [FAKE, 'app-server'], env: { FAKE_CODEX_STATE: state } });
});

after(() => {
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('it lists the threads of a directory and answers the thread by its native id', async () => {
  const listed = await store.list('/work');
  assert.deepEqual(listed.map((s) => s.id), [threadId]);
  assert.equal(listed[0]?.projectPath, '/work');
  assert.equal(listed[0]?.firstPrompt, 'find the needle');
  assert.deepEqual(await store.list('/elsewhere'), []);
  const summary = await store.summary(threadId);
  assert.equal(summary?.id, threadId);
  assert.ok((summary?.messageCount ?? 0) >= 2);
  assert.equal(await store.summary('no-such-thread'), null);
});

test('it pages the entries oldest first and finds text in them', async () => {
  const all = await store.page(threadId);
  assert.ok(all && all.total >= 2);
  assert.equal(all.from, 0);
  assert.equal(all.entries[0]?.role, 'user');
  assert.deepEqual(all.entries[0]?.blocks, [{ type: 'text', text: 'find the needle' }]);
  assert.ok(all.entries.some((e) => e.role === 'assistant' && e.blocks.some((b) => b.type === 'text')));
  const last = await store.page(threadId, { limit: 1 });
  assert.equal(last?.entries.length, 1);
  assert.equal(last?.from, all.total - 1);
  const before = await store.page(threadId, { before: last?.from ?? 0, limit: 1 });
  assert.equal(before?.from, all.total - 2);
  assert.ok(((await store.search(threadId, 'needle'))?.hits.length ?? 0) >= 1);
  assert.equal(await store.page('no-such-thread'), null);
});

test('it reads nothing and fails nothing when Codex is not installed', async () => {
  const none = new CodexTranscripts({ bin: join(dir, 'no-such-codex'), args: [] });
  assert.deepEqual(await none.list(), []);
  assert.equal(await none.summary('x'), null);
  none.dispose();
});

test('items map to the entries the live path shows, and an unknown one shows its type', () => {
  const command = { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: 'a\n', exitCode: 0, durationMs: 1 } as ThreadItem;
  const [use, result] = itemEntries(command, null, 'm');
  assert.deepEqual(use?.blocks, [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }]);
  assert.deepEqual(result?.blocks, [{ type: 'tool_result', toolUseId: 'c1', content: 'a\n', isError: false }]);
  const edit = { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '+x' }] } as ThreadItem;
  assert.equal(itemEntries(edit, null, null).length, 2);
  const odd = itemEntries({ type: 'contextCompaction', id: 'x' }, null, null);
  assert.deepEqual(odd[0]?.blocks, [{ type: 'text', text: '[codex item: contextCompaction]' }]);
});
