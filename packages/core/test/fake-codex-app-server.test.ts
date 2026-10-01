import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// The fake Codex app-server is what the driver's tests run against, so it has to answer the way the
// recorded 0.159.3 did: every request of the recorded scripts gets a reply of the recorded shape.
const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const RECORDED = fileURLToPath(new URL('./fixtures/recordings/codex/0.159.3/', import.meta.url));

type Json = Record<string, unknown>;
type Message = { id?: number; method?: string; params?: Json; result?: Json; error?: { code: number; message: string }; jsonrpc?: string; emittedAtMs?: number };

const dirs: string[] = [];
const procs: ChildProcessWithoutNullStreams[] = [];
after(() => {
  for (const p of procs) p.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NO_REPLY = Symbol('no reply');

class Client {
  readonly seen: Message[] = [];
  readonly raw: string[] = [];
  readonly stderr: string[] = [];
  private waiters: Array<() => void> = [];
  private nextId = 1;
  readonly exited: Promise<number | null>;
  constructor(
    readonly proc: ChildProcessWithoutNullStreams,
    private readonly onServerRequest: (m: Message) => unknown = () => ({ decision: 'accept' }),
  ) {
    createInterface({ input: proc.stdout }).on('line', (line) => {
      this.raw.push(line);
      let m: Message;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        return;
      }
      this.seen.push(m);
      if (m.method && m.id !== undefined) {
        const result = this.onServerRequest(m);
        if (result === NO_REPLY) return;
        this.write({ jsonrpc: '2.0', id: m.id, ...(result instanceof Error ? { error: { code: -32601, message: result.message } } : { result }) });
      }
      for (const w of this.waiters.splice(0)) w();
    });
    proc.stderr.on('data', (d: Buffer) => this.stderr.push(String(d)));
    this.exited = new Promise((resolve) => proc.on('exit', resolve));
  }
  write(m: Json) {
    this.proc.stdin.write(`${JSON.stringify(m)}\n`);
  }
  async until(test: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw ${this.seen.map((m) => m.method ?? `#${m.id}`).join(', ')}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  async request(method: string, params?: Json): Promise<Message> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    await this.until(() => this.seen.some((m) => m.id === id && !m.method), `reply to ${method}`);
    return this.seen.find((m) => m.id === id && !m.method) as Message;
  }
  methods(): string[] {
    return this.seen.filter((m) => m.method).map((m) => m.method as string);
  }
  notifications(method: string): Message[] {
    return this.seen.filter((m) => m.method === method && m.id === undefined);
  }
}

function start(env: Record<string, string> = {}, onServerRequest?: (m: Message) => unknown): Client {
  const proc = spawn(process.execPath, [FAKE, 'app-server'], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' });
  procs.push(proc);
  return new Client(proc, onServerRequest);
}

async function thread(c: Client, params: Json = {}): Promise<string> {
  await c.request('initialize', { clientInfo: { name: 'agentry', title: 'Agentry', version: '0.0.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
  c.write({ jsonrpc: '2.0', method: 'initialized' });
  const started = await c.request('thread/start', { cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write', ...params });
  return ((started.result?.thread as Json).id) as string;
}

async function turn(c: Client, threadId: string, text: string, extra: Json = {}): Promise<Message> {
  const before = c.notifications('turn/completed').length;
  await c.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...extra });
  await c.until(() => c.notifications('turn/completed').length > before, `turn/completed for ${text}`);
  return c.notifications('turn/completed').at(-1) as Message;
}

// A reply's shape: its keys, recursively; an array is the shape of its first element.
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v)]));
  return value === null ? null : typeof value;
}

function recordedReplies(file: string): Map<string, Message> {
  const sent = new Map<number, string>();
  const replies = new Map<string, Message>();
  for (const line of readFileSync(join(RECORDED, file), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { dir: string; line: Message };
    if (row.dir === 'in' && row.line.id !== undefined) sent.set(row.line.id, row.line.method as string);
    else if (row.dir === 'out' && row.line.id !== undefined && sent.has(row.line.id) && !row.line.method) replies.set(sent.get(row.line.id) as string, row.line);
  }
  return replies;
}

test('it answers each request of the recorded handshake with the recorded reply shape', async () => {
  const script = JSON.parse(readFileSync(join(RECORDED, 'handshake.script.json'), 'utf8')) as Array<{ send?: Message }>;
  const recorded = recordedReplies('app-server-handshake.jsonl');
  const c = start({ FAKE_CODEX_SIGNED_OUT: '1' });
  for (const step of script) {
    const m = step.send;
    if (!m) continue;
    if (m.id === undefined) {
      c.write({ ...m });
      continue;
    }
    const got = await c.request(m.method as string, m.params);
    const want = recorded.get(m.method as string) as Message;
    assert.ok(want, `${m.method} is recorded`);
    // thread/start's reply carries the whole thread; the others are small enough to compare whole
    assert.deepEqual(shape(got.error ? { error: got.error } : got.result), shape(want.error ? { error: want.error } : want.result), String(m.method));
    if (want.error) assert.equal(got.error?.code, want.error.code, String(m.method));
  }
  // what the real one does and the driver must tolerate
  assert.ok(c.seen.length > 0);
  assert.ok(c.seen.every((m) => m.jsonrpc === undefined), 'nothing it sends carries jsonrpc');
  assert.ok(c.notifications('remoteControl/status/changed').every((m) => typeof m.emittedAtMs === 'number'));
  c.proc.stdin.end();
  assert.equal(await c.exited, 0);
});

test('signed in, account/read names the account and the rate limits answer', async () => {
  const c = start({ FAKE_CODEX_PLAN: 'pro' });
  await c.request('initialize', { clientInfo: { name: 'agentry', title: 'Agentry', version: '1' } });
  const account = await c.request('account/read', {});
  assert.deepEqual(account.result, { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true, workspaceRouting: null });
  const limits = (await c.request('account/rateLimits/read')).result as { rateLimits: { primary: { usedPercent: number } } };
  assert.equal(typeof limits.rateLimits.primary.usedPercent, 'number');
  const models = (await c.request('model/list', {})).result as { data: Array<{ id: string }> };
  assert.equal(models.data[0]?.id, 'gpt-6.1-sol');
  const unknown = await c.request('no/such/method', {});
  assert.equal(unknown.error?.code, -32600);
  c.proc.stdin.end();
});

test('a turn follows the recorded sequence and streams the answer', async () => {
  const c = start();
  const id = await thread(c);
  const done = await turn(c, id, 'Say hi');
  assert.equal((done.params?.turn as Json).status, 'completed');
  const order = c.methods().filter((m) => m !== 'item/reasoning/summaryTextDelta');
  assert.deepEqual(order.slice(order.indexOf('thread/status/changed'), order.indexOf('thread/status/changed') + 5), [
    'thread/status/changed', 'turn/started', 'item/started', 'item/completed', 'item/started',
  ]);
  const deltas = c.notifications('item/agentMessage/delta').map((m) => m.params?.delta).join('');
  assert.equal(deltas, 'reply: Say hi');
  const finished = c.notifications('item/completed').map((m) => (m.params?.item as Json).type);
  assert.deepEqual(finished, ['userMessage', 'reasoning', 'agentMessage']);
  assert.equal(c.notifications('thread/tokenUsage/updated').length, 1);
  assert.equal(c.notifications('account/rateLimits/updated').length, 1);
  c.proc.stdin.end();
  assert.equal(await c.exited, 0);
});

test('interrupt answers {} and completes the turn as interrupted, like the recording', async () => {
  const recorded = recordedReplies('app-server-interrupt-and-failed-turn.jsonl');
  const c = start();
  const id = await thread(c);
  const started = await c.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'HANG', text_elements: [] }] });
  const turnId = (started.result?.turn as Json).id as string;
  await c.until(() => c.notifications('error').length > 0, 'the reconnect error');
  const interrupted = await c.request('turn/interrupt', { threadId: id, turnId });
  assert.deepEqual(interrupted.result, recorded.get('turn/interrupt')?.result);
  await c.until(() => c.notifications('turn/completed').length > 0, 'turn/completed');
  assert.equal(((c.notifications('turn/completed')[0] as Message).params?.turn as Json).status, 'interrupted');
  // the thread takes another turn afterwards
  assert.equal(((await turn(c, id, 'again')).params?.turn as Json).status, 'completed');
  c.proc.stdin.end();
});

test('stdin closing ends it with 0 even with a turn running', async () => {
  const c = start();
  const id = await thread(c);
  await c.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'HANG', text_elements: [] }] });
  c.proc.stdin.end();
  assert.equal(await c.exited, 0);
});

test('a model switch runs a compaction first, as recorded', async () => {
  const c = start();
  const id = await thread(c);
  await turn(c, id, 'one');
  await turn(c, id, 'two', { model: 'gpt-5.5', effort: 'low' });
  const types = c.notifications('item/started').map((m) => (m.params?.item as Json).type);
  assert.ok(types.indexOf('contextCompaction') < types.lastIndexOf('userMessage'), 'the compaction comes before the user message');
  assert.equal(types.filter((t) => t === 'contextCompaction').length, 1);
  c.proc.stdin.end();
});

test('ASK command waits for the decision and runs the command when accepted', async () => {
  const requests: Message[] = [];
  const c = start({}, (m) => {
    requests.push(m);
    return { decision: 'acceptForSession' };
  });
  const id = await thread(c);
  const done = await turn(c, id, 'ASK command npm test');
  assert.equal(requests[0]?.method, 'item/commandExecution/requestApproval');
  assert.equal(requests[0]?.params?.command, 'npm test');
  assert.equal((done.params?.turn as Json).status, 'completed');
  const ended = c.notifications('item/completed').map((m) => m.params?.item as Json).find((i) => i.type === 'commandExecution');
  assert.equal(ended?.status, 'completed');
  assert.equal(ended?.exitCode, 0);
  assert.equal(ended?.aggregatedOutput, 'ok\n');
  c.proc.stdin.end();
});

test('a declined approval declines the item and the turn goes on', async () => {
  const c = start({}, () => ({ decision: 'decline' }));
  const id = await thread(c);
  const done = await turn(c, id, 'GITPUSH');
  const item = c.notifications('item/completed').map((m) => m.params?.item as Json).find((i) => i.type === 'commandExecution');
  assert.equal(item?.command, 'git push origin HEAD');
  assert.equal(item?.status, 'declined');
  assert.equal((done.params?.turn as Json).status, 'completed');
  c.proc.stdin.end();
});

test('ASK file asks about the file change', async () => {
  const methods: string[] = [];
  const c = start({}, (m) => {
    methods.push(m.method as string);
    return { decision: 'accept' };
  });
  const id = await thread(c);
  await turn(c, id, 'ASK file');
  assert.deepEqual(methods, ['item/fileChange/requestApproval']);
  const change = c.notifications('item/completed').map((m) => m.params?.item as Json).find((i) => i.type === 'fileChange');
  assert.equal(change?.status, 'completed');
  c.proc.stdin.end();
});

test('answering an approval with cancel ends the turn interrupted', async () => {
  const c = start({}, () => ({ decision: 'cancel' }));
  const id = await thread(c);
  const done = await turn(c, id, 'ASK command');
  assert.equal((done.params?.turn as Json).status, 'interrupted');
  c.proc.stdin.end();
});

test('an interrupt with an approval pending completes the turn interrupted', async () => {
  const c = start({}, () => NO_REPLY);
  const id = await thread(c);
  const started = await c.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'ASK command', text_elements: [] }] });
  await c.until(() => c.methods().includes('item/commandExecution/requestApproval'), 'the approval');
  await c.request('turn/interrupt', { threadId: id, turnId: (started.result?.turn as Json).id });
  await c.until(() => c.notifications('turn/completed').length > 0, 'turn/completed');
  assert.equal(((c.notifications('turn/completed')[0] as Message).params?.turn as Json).status, 'interrupted');
  c.proc.stdin.end();
});

test('ODD sends a server request the driver does not know and goes on once it is answered', async () => {
  const c = start({}, (m) => (m.method === 'item/odd/request' ? new Error('unsupported') : { decision: 'accept' }));
  const id = await thread(c);
  const done = await turn(c, id, 'ODD');
  assert.ok(c.methods().includes('item/odd/request'));
  assert.equal((done.params?.turn as Json).status, 'completed');
  c.proc.stdin.end();
});

test('STRUCTURED answers the given JSON in two deltas', async () => {
  const c = start();
  const id = await thread(c);
  await turn(c, id, 'STRUCTURED {"verdict":"pass"}', { outputSchema: { type: 'object' } });
  const deltas = c.notifications('item/agentMessage/delta').map((m) => m.params?.delta as string);
  assert.equal(deltas.length, 2);
  assert.deepEqual(JSON.parse(deltas.join('')), { verdict: 'pass' });
  c.proc.stdin.end();
});

test('RATE fails the turn with usageLimitExceeded and a full window', async () => {
  const c = start();
  const id = await thread(c);
  const done = await turn(c, id, 'RATE');
  const t = done.params?.turn as { status: string; error: { codexErrorInfo: string } };
  assert.equal(t.status, 'failed');
  assert.equal(t.error.codexErrorInfo, 'usageLimitExceeded');
  const limits = c.notifications('account/rateLimits/updated')[0]?.params as { rateLimits: { primary: { usedPercent: number } } };
  assert.equal(limits.rateLimits.primary.usedPercent, 100);
  c.proc.stdin.end();
});

test('NOISY adds a stray line, stderr logs, an unknown notification and a retried error', async () => {
  const c = start();
  const id = await thread(c);
  const done = await turn(c, id, 'NOISY');
  assert.equal((done.params?.turn as Json).status, 'completed');
  assert.ok(c.raw.includes('this is not json'));
  assert.ok(c.stderr.join('').includes('ERROR codex_core'));
  assert.ok(c.methods().includes('fake/unknownNotification'));
  assert.equal((c.notifications('error')[0]?.params as Json).willRetry, true);
  c.proc.stdin.end();
});

test('DELEGATE spawns an agent through a collabAgentToolCall', async () => {
  const c = start();
  const id = await thread(c);
  await turn(c, id, 'DELEGATE look around');
  const call = c.notifications('item/completed').map((m) => m.params?.item as Json).find((i) => i.type === 'collabAgentToolCall');
  assert.equal(call?.tool, 'spawnAgent');
  assert.equal(call?.prompt, 'look around');
  c.proc.stdin.end();
});

test('AUTH replays the recorded signed-out turn: 401 retries, then failed', async () => {
  const c = start({ FAKE_CODEX_SIGNED_OUT: '1' });
  const id = await thread(c);
  const done = await turn(c, id, 'AUTH');
  const t = done.params?.turn as { status: string; error: { codexErrorInfo: Json } };
  assert.equal(t.status, 'failed');
  assert.deepEqual(t.error.codexErrorInfo, { httpConnectionFailed: { httpStatusCode: 401 } });
  const retries = c.notifications('error').filter((m) => (m.params as Json).willRetry === true);
  assert.equal(retries.length, 4);
  c.proc.stdin.end();
});

test('threads survive the process: resume and fork across two runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-fake-codex-'));
  dirs.push(dir);
  const state = join(dir, 'threads.json');
  const first = start({ FAKE_CODEX_STATE: state });
  const id = await thread(first);
  await turn(first, id, 'remember this');
  first.proc.stdin.end();
  await first.exited;

  const second = start({ FAKE_CODEX_STATE: state });
  await second.request('initialize', { clientInfo: { name: 'agentry', title: 'Agentry', version: '1' } });
  const resumed = await second.request('thread/resume', { threadId: id });
  const t = resumed.result?.thread as { id: string; turns: Array<{ items: Array<{ type: string }> }> };
  assert.equal(t.id, id);
  assert.equal(t.turns.length, 1);
  assert.ok(t.turns[0]?.items.some((i) => i.type === 'agentMessage'));
  assert.equal((await turn(second, id, 'and this')).params?.turn !== undefined, true);

  const forked = await second.request('thread/fork', { threadId: id });
  const f = forked.result?.thread as { id: string; forkedFromId: string; turns: unknown[] };
  assert.notEqual(f.id, id);
  assert.equal(f.forkedFromId, id);
  assert.equal(f.turns.length, 2);

  const listed = (await second.request('thread/list', {})).result as { data: Array<{ id: string }> };
  assert.deepEqual(listed.data.map((x) => x.id).sort(), [id, f.id].sort());
  const items = (await second.request('thread/items/list', { threadId: id })).result as { data: unknown[] };
  assert.ok(items.data.length >= 6);
  second.proc.stdin.end();
  assert.equal(await second.exited, 0);
});

test('thread/settings/update changes the settings and says so', async () => {
  const c = start();
  const id = await thread(c);
  await c.request('thread/settings/update', { threadId: id, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  await c.until(() => c.notifications('thread/settings/updated').length > 0, 'thread/settings/updated');
  const updated = c.notifications('thread/settings/updated')[0]?.params as { threadSettings: { approvalPolicy: string; sandboxPolicy: { type: string } } };
  assert.equal(updated.threadSettings.approvalPolicy, 'never');
  assert.equal(updated.threadSettings.sandboxPolicy.type, 'dangerFullAccess');
  c.proc.stdin.end();
});
