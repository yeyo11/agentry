import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PermissionMode, ToolPolicy } from '@agentry/shared';
import { CodexDriver } from '../src/providers/codex/driver.ts';
import type { DriverEvent, SessionLaunch } from '../src/providers/driver.ts';

// The driver's session against the fake app-server, with the fake's log of what the driver sent.

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'agentry-codex-session-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
let logs = 0;
const launch = (over: Partial<SessionLaunch> = {}): SessionLaunch => ({
  id: 'chat-1',
  nativeId: null,
  created: false,
  forkFrom: null,
  name: 'test',
  cwd: dir,
  permissionMode: 'manual',
  permissionPrompts: 'host',
  account: null,
  policy: null,
  ...over,
});

async function run(spec: SessionLaunch, steps: (api: Api) => Promise<void>, state = join(dir, `state-${++counter}.json`)) {
  const log = join(dir, `log-${++logs}.jsonl`);
  const driver = new CodexDriver(FAKE);
  const plan = driver.launch(spec);
  const proc = spawn(plan.bin, plan.args, { cwd: dir, env: { ...plan.env, FAKE_CODEX_LOG: log, FAKE_CODEX_STATE: state }, stdio: 'pipe' });
  const events: DriverEvent[] = [];
  const session = driver.attach({ write: (t) => proc.stdin.write(t), end: () => proc.stdin.end(), up: () => !proc.killed }, (e) => events.push(e), driver.createBranches());
  createInterface({ input: proc.stdout }).on('line', (l) => session.readLine(l));
  proc.stdin.on('error', () => {});
  const api: Api = {
    session,
    events,
    until: async (what, ok) => {
      const end = Date.now() + 8000;
      while (!ok()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    sent: (method) =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { dir: string; line: { method?: string; params?: Record<string, unknown> } })
        .filter((m) => m.dir === 'in' && m.line.method === method)
        .map((m) => m.line.params ?? {}),
    results: () => events.filter((e): e is Extract<DriverEvent, { kind: 'result' }> => e.kind === 'result'),
  };
  try {
    await steps(api);
  } finally {
    session.dispose('test over');
    proc.stdin.end();
    proc.kill('SIGTERM');
  }
}

interface Api {
  session: ReturnType<CodexDriver['attach']>;
  events: DriverEvent[];
  until(what: string, ok: () => boolean): Promise<void>;
  sent(method: string): Array<Record<string, unknown>>;
  results(): Array<Extract<DriverEvent, { kind: 'result' }>>;
}

test('a new chat starts a thread with the mode, the policy sandbox and the instructions, and the init names the thread', async () => {
  const policy: ToolPolicy = { read: { allow: true }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'deny', gitPush: 'omit' };
  await run(launch({ policy, model: 'gpt-6-sol', appendSystemPrompt: 'be brief' }), async (api) => {
    api.session.send({ text: 'TURN hi', attachments: [] });
    await api.until('the result', () => api.results().length === 1);
    const [start] = api.sent('thread/start');
    assert.equal(start?.sandbox, 'read-only');
    assert.equal(start?.approvalPolicy, 'on-request');
    assert.equal(start?.model, 'gpt-6-sol');
    assert.equal(start?.developerInstructions, 'be brief');
    assert.deepEqual(start?.config, { web_search: 'disabled' });
    const init = api.events.find((e) => e.kind === 'init');
    assert.ok(init?.kind === 'init' && init.nativeSessionId && init.nativeSessionId === init.sessionId);
    assert.equal(api.results()[0]?.text, 'reply: TURN hi');
  });
});

test('a mode and a model chosen later travel with the next turn, once', async () => {
  await run(launch(), async (api) => {
    api.session.send({ text: 'TURN one', attachments: [] });
    await api.until('the first result', () => api.results().length === 1);
    await api.session.setOption({ permissionMode: 'plan' as PermissionMode });
    await api.session.setOption({ model: 'gpt-6-luna' });
    assert.ok(api.events.some((e) => e.kind === 'mode-changed' && e.mode === 'plan'));
    api.session.send({ text: 'TURN two', attachments: [] });
    await api.until('the second result', () => api.results().length === 2);
    api.session.send({ text: 'TURN three', attachments: [] });
    await api.until('the third result', () => api.results().length === 3);
    const [first, second, third] = api.sent('turn/start');
    assert.equal(first?.approvalPolicy, undefined);
    assert.equal(second?.approvalPolicy, 'on-request');
    assert.deepEqual(second?.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(second?.model, 'gpt-6-luna');
    assert.equal(third?.model, undefined);
    assert.equal(third?.sandboxPolicy, undefined);
  });
});

test('a later process resumes the thread by the id Codex gave it, and a fork copies it by that id', async () => {
  const state = join(dir, 'shared-state.json');
  let thread = '';
  await run(
    launch(),
    async (api) => {
      api.session.send({ text: 'TURN one', attachments: [] });
      await api.until('the result', () => api.results().length === 1);
      const init = api.events.find((e) => e.kind === 'init');
      thread = init?.kind === 'init' ? (init.nativeSessionId ?? '') : '';
    },
    state,
  );
  assert.ok(thread);
  await run(
    launch({ created: true, nativeId: thread }),
    async (api) => {
      api.session.send({ text: 'TURN two', attachments: [] });
      await api.until('the result', () => api.results().length === 1);
      assert.deepEqual(api.sent('thread/resume').map((p) => p.threadId), [thread]);
      assert.deepEqual(api.sent('thread/start'), []);
    },
    state,
  );
  await run(
    launch({ id: 'chat-2', forkFrom: thread }),
    async (api) => {
      api.session.send({ text: 'TURN copy', attachments: [] });
      await api.until('the result', () => api.results().length === 1);
      assert.deepEqual(api.sent('thread/fork').map((p) => p.threadId), [thread]);
      const init = api.events.find((e) => e.kind === 'init');
      assert.ok(init?.kind === 'init' && init.nativeSessionId && init.nativeSessionId !== thread);
    },
    state,
  );
});

test('dontAsk answers an approval from the policy and no request reaches a person', async () => {
  const policy: ToolPolicy = { read: { allow: true }, edit: { allow: 'any' }, commands: { allow: [{ command: 'npm test', args: 'none' }] }, network: 'omit', gitPush: 'omit' };
  await run(launch({ permissionMode: 'dontAsk', policy }), async (api) => {
    api.session.send({ text: 'ASK command npm test', attachments: [] });
    await api.until('the first result', () => api.results().length === 1);
    assert.equal(api.results()[0]?.text, 'done');
    api.session.send({ text: 'ASK command rm -rf build', attachments: [] });
    await api.until('the second result', () => api.results().length === 2);
    assert.equal(api.results()[1]?.text, 'declined');
    assert.ok(!api.events.some((e) => e.kind === 'permission-request'));
  });
});

test('acceptEdits takes a file change without asking, and a command still asks', async () => {
  await run(launch({ permissionMode: 'acceptEdits' }), async (api) => {
    api.session.send({ text: 'ASK file', attachments: [] });
    await api.until('the result', () => api.results().length === 1);
    assert.equal(api.results()[0]?.text, 'done');
    api.session.send({ text: 'ASK command npm test', attachments: [] });
    await api.until('the question', () => api.events.some((e) => e.kind === 'permission-request'));
    const asked = api.events.find((e) => e.kind === 'permission-request');
    assert.ok(asked?.kind === 'permission-request' && asked.question.request?.kind === 'command');
    api.session.answerPermission(asked.question.id, { behavior: 'allow' });
    await api.until('the second result', () => api.results().length === 2);
  });
});

test('a file change is judged by the paths item/started named, relative to the project', async () => {
  await run(launch(), async (api) => {
    api.session.send({ text: 'ASK file', attachments: [] });
    await api.until('the question', () => api.events.some((e) => e.kind === 'permission-request'));
    const asked = api.events.find((e) => e.kind === 'permission-request');
    assert.ok(asked?.kind === 'permission-request');
    assert.deepEqual(asked.question.request, { kind: 'edit', paths: ['notes.txt'] });
    api.session.answerPermission(asked.question.id, { behavior: 'deny' });
    await api.until('the result', () => api.results().length === 1);
    assert.equal(api.results()[0]?.text, 'declined');
  });
});

test('a request the driver has no shape for is refused, and the turn goes on', async () => {
  await run(launch(), async (api) => {
    api.session.send({ text: 'ASK input', attachments: [] });
    await api.until('the result', () => api.results().length === 1);
    assert.ok(!api.events.some((e) => e.kind === 'permission-request'));
    assert.ok(api.events.some((e) => e.kind === 'notice'));
  });
});

test('a failed turn is an error result with the failure, and a usage limit is a rate limit', async () => {
  await run(launch(), async (api) => {
    api.session.send({ text: 'RATE', attachments: [] });
    await api.until('the result', () => api.results().length === 1);
    const [result] = api.results();
    assert.equal(result?.isError, true);
    assert.equal(result?.rateLimited, true);
    assert.equal(result?.text, 'You have hit your usage limit.');
    assert.ok(api.events.some((e) => e.kind === 'rate-limit' && e.info.status === 'rejected'));
  });
});

test('a signed-out account fails the handshake with auth-required before any turn is sent', async () => {
  const driver = new CodexDriver(FAKE);
  const plan = driver.launch(launch());
  const proc = spawn(plan.bin, plan.args, { cwd: dir, env: { ...plan.env, FAKE_CODEX_SIGNED_OUT: '1' }, stdio: 'pipe' });
  const events: DriverEvent[] = [];
  const session = driver.attach({ write: (t) => proc.stdin.write(t), end: () => proc.stdin.end(), up: () => true }, (e) => events.push(e), driver.createBranches());
  createInterface({ input: proc.stdout }).on('line', (l) => session.readLine(l));
  proc.stdin.on('error', () => {});
  session.send({ text: 'TURN hi', attachments: [] });
  const end = Date.now() + 8000;
  while (!events.some((e) => e.kind === 'failed') && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  proc.kill('SIGTERM');
  const failed = events.find((e) => e.kind === 'failed');
  assert.ok(failed?.kind === 'failed' && failed.reason === 'auth-required');
  assert.ok(!events.some((e) => e.kind === 'init' || e.kind === 'result'));
});

test('the detection handshake reads the version, the account and the models without a thread', async () => {
  const driver = new CodexDriver(FAKE);
  const result = await driver.handshake({ ...process.env, FAKE_CODEX_PLAN: 'pro' }, new AbortController().signal);
  assert.match(result.version ?? '', /^\d+\.\d+\.\d+/);
  assert.equal(result.account, 'ChatGPT pro');
  assert.ok(result.models.length > 1 && result.models[0]?.value);
  assert.ok(result.confirmed.every((c) => driver.manifest.capabilities.includes(c)));
  const out = await driver.handshake({ ...process.env, FAKE_CODEX_SIGNED_OUT: '1' }, new AbortController().signal);
  assert.equal(out.account, null);
});
