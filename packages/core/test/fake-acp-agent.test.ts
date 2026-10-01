import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// The fake ACP agent answers what the recordings show, per profile: the recorded `initialize`, a
// `session/new` of the recorded shape, the methods the real agent refuses, and the scripted turns.
const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const RECORDINGS = fileURLToPath(new URL('./fixtures/recordings/', import.meta.url));

type Msg = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
};

const tmp = mkdtempSync(join(tmpdir(), 'agentry-fake-acp-'));
const clients: Client[] = [];
// A failed assertion leaves its child with an open stdin, which would keep the test process alive.
after(() => {
  for (const c of clients) c.child.kill();
  rmSync(tmp, { recursive: true, force: true });
});

/** Waits for a condition the child's other pipe will make true; a few seconds is a failure, not a slow runner */
async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly seen: Msg[] = [];
  readonly stderr: string[] = [];
  /** Lines on stdout that are not the protocol */
  readonly banner: string[] = [];
  private waiting: Array<() => void> = [];
  private nextId = 0;
  readonly exited: Promise<number | null>;

  constructor(profile: string, env: Record<string, string> = {}, extra: string[] = []) {
    this.child = spawn(process.execPath, [FAKE, '--profile', profile, '--acp', ...extra], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        this.seen.push(JSON.parse(line) as Msg);
      } catch {
        this.banner.push(line);
      }
      for (const w of this.waiting.splice(0)) w();
    });
    this.child.stderr.on('data', (d: Buffer) => this.stderr.push(String(d)));
    clients.push(this);
    this.exited = new Promise((resolve) => this.child.on('close', (code) => resolve(code)));
  }

  async until<T>(find: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const hit = find();
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`timed out; saw ${JSON.stringify(this.seen)}`);
      await new Promise<void>((r) => {
        this.waiting.push(r);
        setTimeout(r, 50);
      });
    }
  }

  write(msg: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Msg> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return this.until(() => this.seen.find((m) => m.id === id && m.method === undefined));
  }

  request(method: string): Promise<Msg> {
    return this.until(() => this.seen.find((m) => m.method === method && m.id !== undefined));
  }

  updates(sessionUpdate: string): Msg[] {
    return this.seen.filter((m) => m.method === 'session/update' && m.params?.update.sessionUpdate === sessionUpdate);
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

const lines = (rel: string): Array<{ dir: string; line: Msg }> =>
  readFileSync(join(RECORDINGS, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const recordedReply = (rel: string, method: string): Msg => {
  const all = lines(rel);
  const req = all.find((l) => l.dir === 'in' && l.line.method === method);
  const out = all.find((l) => l.dir === 'out' && l.line.id === req?.line.id);
  assert.ok(out, `${method} is in ${rel}`);
  return out.line;
};

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };

async function started(client: Client): Promise<string> {
  await client.call('initialize', INIT);
  const created = await client.call('session/new', { cwd: tmp, mcpServers: [] });
  const sessionId = created.result?.sessionId as string | undefined;
  assert.ok(sessionId, 'session/new gave an id');
  return sessionId;
}

const prompt = (c: Client, sessionId: string, text: string) =>
  c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

const PROFILES = [
  { profile: 'copilot', rel: 'copilot/1.0.90/acp-prompt-with-owner-account-by-accident.jsonl', id: /^[0-9a-f-]{36}$/, list: true, fork: false },
  { profile: 'gemini', rel: 'gemini/0.62.0/acp-initialize.jsonl', id: /^[0-9a-f-]{36}$/, list: false, fork: false },
  { profile: 'opencode', rel: 'opencode/1.18.34/acp-initialize.jsonl', id: /^ses_[0-9a-f]{26}$/, list: true, fork: true },
] as const;

for (const p of PROFILES) {
  describe(`fake-acp-agent --profile ${p.profile}`, () => {
    test('answers initialize with the recorded reply', async () => {
      const c = new Client(p.profile);
      const reply = await c.call('initialize', INIT);
      assert.deepEqual(reply.result, recordedReply(p.rel, 'initialize').result);
      assert.equal(await c.close(), 0);
    });

    test('session/new has the recorded shape and the id format of the agent', async () => {
      const c = new Client(p.profile);
      await c.call('initialize', INIT);
      const created = await c.call('session/new', { cwd: tmp, mcpServers: [] });
      const sessionId = created.result?.sessionId as string;
      assert.match(sessionId, p.id);
      const recorded = recordedReply(p.rel, 'session/new');
      if (recorded.result) {
        assert.deepEqual(Object.keys(created.result ?? {}).sort(), Object.keys(recorded.result).sort());
        assert.deepEqual(created.result?.configOptions, recorded.result.configOptions);
      } else {
        assert.equal(recorded.error?.code, -32000); // Gemini's recording is the refusal
        assert.ok(created.result?.modes && created.result?.models);
      }
      if (p.profile !== 'gemini') await c.until(() => (c.updates('available_commands_update').length > 0 ? true : undefined));
      assert.equal(c.updates('available_commands_update').length, p.profile === 'gemini' ? 0 : 1);
      await c.close();
    });

    test('refuses what the real agent refuses with -32601 and data.method', async () => {
      const c = new Client(p.profile);
      await started(c);
      const unknown = await c.call('no/such/method');
      assert.deepEqual(unknown.error, recordedReply('copilot/1.0.65/acp-initialize.jsonl', 'no/such/method').error);
      const list = await c.call('session/list');
      if (p.list) assert.ok(Array.isArray(list.result?.sessions));
      else assert.deepEqual(list.error, { code: -32601, message: '"Method not found": session/list', data: { method: 'session/list' } });
      const fork = await c.call('session/fork', { sessionId: 'x' });
      assert.equal(p.fork ? fork.error?.code !== -32601 : fork.error?.code === -32601, true);
      await c.close();
    });

    test('FAKE_ACP_SIGNED_OUT: -32000 on session/new, except where the real agent starts anyway', async () => {
      const c = new Client(p.profile, { FAKE_ACP_SIGNED_OUT: '1' });
      await c.call('initialize', INIT);
      const created = await c.call('session/new', { cwd: tmp, mcpServers: [] });
      if (p.profile === 'opencode') assert.ok(created.result?.sessionId);
      else assert.equal(created.error?.code, -32000);
      await c.close();
    });

    test('a turn streams the recorded update shapes and ends end_turn', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      const done = await prompt(c, sid, 'TURN please');
      assert.equal(done.result?.stopReason, 'end_turn');
      const kinds = new Set(c.seen.filter((m) => m.method === 'session/update').map((m) => m.params?.update.sessionUpdate));
      for (const k of ['agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'usage_update', 'agent_message_chunk']) {
        assert.ok(kinds.has(k), k);
      }
      assert.equal(kinds.has('session_info_update'), p.profile === 'copilot');
      assert.equal(done.result?.usage !== undefined, p.profile === 'copilot');
      const diff = c.updates('tool_call').find((m) => m.params?.update.kind === 'edit');
      assert.equal(diff?.params?.update.content[0].type, 'diff');
      await c.close();
    });

    test('ASK waits for the answer and goes on by the option chosen', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      const turn = prompt(c, sid, 'ASK execute');
      const req = await c.request('session/request_permission');
      assert.equal(req.params?.toolCall.kind, 'execute');
      assert.deepEqual(req.params?.options.map((o: { kind: string }) => o.kind), ['allow_always', 'allow_once', 'reject_once']);
      c.write({ id: req.id, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } });
      assert.equal((await turn).result?.stopReason, 'end_turn');
      assert.equal(c.updates('tool_call_update').at(-1)?.params?.update.status, 'failed');
      await c.close();
    });

    test('GITPUSH asks to run git push', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      const turn = prompt(c, sid, 'GITPUSH');
      const req = await c.request('session/request_permission');
      assert.equal(req.params?.toolCall.rawInput.command, 'git push origin main');
      c.write({ id: req.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
      await turn;
      assert.equal(c.updates('tool_call_update').at(-1)?.params?.update.status, 'completed');
      await c.close();
    });

    test('CANCEL-WAIT holds the request until session/cancel, then ends cancelled', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      const turn = prompt(c, sid, 'CANCEL-WAIT');
      const req = await c.request('session/request_permission');
      c.write({ method: 'session/cancel', params: { sessionId: sid } });
      c.write({ id: req.id, result: { outcome: { outcome: 'cancelled' } } });
      assert.equal((await turn).result?.stopReason, 'cancelled');
      await c.close();
    });

    test('HOLD ends cancelled on session/cancel', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      const turn = prompt(c, sid, 'HOLD');
      await c.until(() => (c.updates('agent_message_chunk').length > 0 ? true : undefined));
      c.write({ method: 'session/cancel', params: { sessionId: sid } });
      assert.equal((await turn).result?.stopReason, 'cancelled');
      await c.close();
    });

    test('ODD sends a request the driver does not know, and goes on once answered', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      const turn = prompt(c, sid, 'ODD');
      const odd = await c.request('fake/unknown');
      c.write({ id: odd.id, error: { code: -32601, message: 'Method not found' } });
      assert.equal((await turn).result?.stopReason, 'end_turn');
      await c.close();
    });

    test('AUTH fails the prompt with -32000', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      assert.equal((await prompt(c, sid, 'AUTH')).error?.code, -32000);
      await c.close();
    });

    test('NOISY streams fifty chunks and logs on stderr', async () => {
      const c = new Client(p.profile);
      const sid = await started(c);
      await prompt(c, sid, 'NOISY');
      assert.equal(c.updates('agent_message_chunk').length, 50);
      // stdout and stderr are two pipes: the answer can arrive before the log line does
      await until(() => /agent log line 0/.test(c.stderr.join('')));
      assert.match(c.stderr.join(''), /agent log line 0/);
      assert.deepEqual(c.banner, ['agent banner, not json']);
      await c.close();
    });

    test('session/load replays the history as updates, then answers; stdin EOF exits 0', async () => {
      const c = new Client(p.profile);
      await c.call('initialize', INIT);
      const loaded = await c.call('session/load', { sessionId: 'earlier', cwd: tmp, mcpServers: [] });
      assert.ok(loaded.result);
      assert.equal(c.updates('user_message_chunk').length, 1);
      assert.equal(await c.close(), 0);
    });
  });
}

describe('fake-acp-agent specifics', () => {
  test('Copilot answers the handshake of the version asked, and 1.0.90 has session/close', async () => {
    for (const [v, rel] of [
      ['1.0.65', 'copilot/1.0.65/acp-initialize.jsonl'],
      ['1.0.90', 'copilot/1.0.90/acp-prompt-with-owner-account-by-accident.jsonl'],
    ] as const) {
      const c = new Client('copilot', { FAKE_ACP_VERSION: v });
      const init = await c.call('initialize', INIT);
      assert.deepEqual(init.result, recordedReply(rel, 'initialize').result);
      const sid = await started(c);
      const closed = await c.call('session/close', { sessionId: sid });
      assert.equal(closed.error?.code === -32601, v === '1.0.65');
      await c.close();
    }
  });

  test('set_mode and set_config_option answer as recorded', async () => {
    const c = new Client('copilot');
    const sid = await started(c);
    const mode = 'https://agentclientprotocol.com/protocol/session-modes#plan';
    assert.deepEqual((await c.call('session/set_mode', { sessionId: sid, modeId: mode })).result, {});
    assert.equal(c.updates('current_mode_update')[0]?.params?.update.currentModeId, mode);
    const set = await c.call('session/set_config_option', { sessionId: sid, configId: 'allow_all', value: 'on' });
    assert.equal(set.result?.configOptions.find((o: { id: string }) => o.id === 'allow_all').currentValue, 'on');
    await c.close();
  });

  test('Gemini has no set_config_option, OpenCode forks and resumes', async () => {
    const g = new Client('gemini');
    const gid = await started(g);
    assert.equal((await g.call('session/set_config_option', { sessionId: gid, configId: 'x', value: 'y' })).error?.code, -32601);
    assert.deepEqual((await g.call('session/set_model', { sessionId: gid, modelId: 'fake-model' })).result, {});
    await g.close();

    const o = new Client('opencode');
    const oid = await started(o);
    const forked = await o.call('session/fork', { sessionId: oid, cwd: tmp, mcpServers: [] });
    assert.match(forked.result?.sessionId, /^ses_/);
    assert.notEqual(forked.result?.sessionId, oid);
    assert.ok((await o.call('session/resume', { sessionId: oid, cwd: tmp })).result);
    assert.equal(o.updates('user_message_chunk').length, 0); // a resume replays nothing
    await o.close();
  });

  test('FAKE_ACP_LOG records the start (argv, Copilot update env) and every message', async () => {
    const log = join(tmp, 'acp.log');
    const c = new Client('copilot', { FAKE_ACP_LOG: log, COPILOT_AUTO_UPDATE: 'false' }, ['--no-auto-update']);
    await c.call('initialize', INIT);
    await c.close();
    const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(rows[0].argv.includes('--no-auto-update'), true);
    assert.equal(rows[0].env.COPILOT_AUTO_UPDATE, 'false');
    assert.deepEqual(rows.slice(1).map((r) => r.dir), ['in', 'out']);
  });

  test('--version prints the recorded version', async () => {
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [FAKE, '--profile', 'opencode', '--version']);
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += String(d)));
      child.on('close', () => resolve(text));
    });
    assert.equal(out.trim(), '1.18.34');
  });
});
