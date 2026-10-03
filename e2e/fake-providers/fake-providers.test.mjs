// The fake providers' own test: `node --test e2e/fake-providers/fake-providers.test.mjs`. It speaks to
// each fake as the drivers do (the version flag, the login probe, and the first request of the
// protocol), so a providers spec that fails can be told apart from a fake that stopped answering.
// Needs no build, no browser and no server.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let data;
before(() => {
  data = mkdtempSync(join(tmpdir(), 'agentry-fake-providers-'));
  mkdirSync(join(data, 'fake-providers'));
});
after(() => rmSync(data, { recursive: true, force: true }));

const env = () => ({ ...process.env, AGENTRY_DATA_DIR: data });
const stateFile = (name) => join(data, 'fake-providers', `${name}.json`);
const state = (name, value) => writeFileSync(stateFile(name), JSON.stringify(value));
const run = (name, args) => spawnSync(join(here, name), args, { env: env(), encoding: 'utf8' });

/** The reply to the first request of a protocol, as a driver's handshake reads it */
function ask(name, args, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(here, name), args, { env: env(), stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name} did not answer ${request.method}`));
    }, 8000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id !== request.id) return;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      resolve(message);
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`);
  });
}

const RECORDED = { codex: '0.159.3', copilot: '1.0.91', gemini: '0.62.0', opencode: '1.18.34' };

for (const [name, version] of Object.entries(RECORDED)) {
  test(`${name} answers --version with the recorded version unless a spec says another`, () => {
    rmSync(stateFile(name), { force: true });
    assert.match(run(name, ['--version']).stdout, new RegExp(version.replaceAll('.', '\\.')));
    state(name, { version: '9.9.9' });
    assert.match(run(name, ['--version']).stdout, /9\.9\.9/);
    state(name, { version: '0.0.1', versionExit: 3 });
    assert.equal(run(name, ['--version']).status, 3);
    rmSync(stateFile(name), { force: true });
  });
}

test('codex login status follows signedIn', () => {
  state('codex', { signedIn: true });
  assert.equal(run('codex', ['login', 'status']).status, 0);
  state('codex', { signedIn: false });
  assert.equal(run('codex', ['login', 'status']).status, 1);
  rmSync(stateFile('codex'), { force: true });
});

test('an unknown command is refused', () => {
  assert.equal(run('gemini', ['frobnicate']).status, 1);
});

test('codex app-server answers initialize and reads the account from signedIn', async () => {
  rmSync(stateFile('codex'), { force: true });
  const hello = await ask('codex', ['app-server'], { id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '0' }, capabilities: null } });
  assert.match(hello.result.userAgent, /0\.159\.3/);
  const account = await ask('codex', ['app-server'], { id: 1, method: 'account/read', params: {} });
  assert.ok(account.result.account);
  state('codex', { signedIn: false });
  const out = await ask('codex', ['app-server'], { id: 1, method: 'account/read', params: {} });
  assert.equal(out.result.account, null);
  rmSync(stateFile('codex'), { force: true });
});

for (const [name, args] of [
  ['gemini', ['--acp']],
  ['copilot', ['--acp', '--no-auto-update', '--no-remote']],
  ['opencode', ['acp']],
]) {
  test(`${name} speaks the Agent Client Protocol`, async () => {
    rmSync(stateFile(name), { force: true });
    const reply = await ask(name, args, { id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test' } } });
    assert.equal(reply.result.protocolVersion, 1);
    assert.ok(reply.result.agentCapabilities);
  });
}

test('codex RATE is the usage limit: the rate limits at 100 %, then a usageLimitExceeded error', async () => {
  rmSync(stateFile('codex'), { force: true });
  const child = spawn(join(here, 'codex'), ['app-server'], { env: env(), stdio: ['pipe', 'pipe', 'ignore'] });
  const seen = [];
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  try {
    const found = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no limit; saw ${JSON.stringify(seen)}`)), 8000);
      createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line);
        seen.push(message.method ?? message.id);
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'thread/start', params: {} });
        }
        if (message.id === 2) send({ id: 3, method: 'turn/start', params: { threadId: message.result.thread.id, input: [{ type: 'text', text: 'RATE', text_elements: [] }] } });
        if (message.method === 'error') {
          clearTimeout(timer);
          resolve({ rateLimits: seen.includes('account/rateLimits/updated'), error: message.params.error });
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '0' }, capabilities: null } });
    });
    assert.equal(found.rateLimits, true);
    assert.equal(found.error.codexErrorInfo, 'usageLimitExceeded');
  } finally {
    child.kill('SIGTERM');
  }
});
