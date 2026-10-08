import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentryEvent, LoginSession, SetupTool } from '@agentry/shared';
import type { AgentryEventInput } from '../src/events.ts';
import { SecretVault } from '../src/secret-vault.ts';
import { DEVICE_PATTERNS, readDeviceLine } from '../src/setup/device-patterns.ts';
import { LoginInputError, LoginService, type LoginServiceDeps } from '../src/setup/logins.ts';
import { setupMethods } from '../src/setup/methods.ts';
import { YoutrackCredentialStore } from '../src/trackers/youtrack/credentials.ts';
import { tempConfig } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, 'fixtures', 'logins', name);

/** A binary that runs the fake CLI: a shell shim, so the test never changes a tracked file's mode */
function fakeBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-login-'));
  const bin = join(dir, 'fake-login');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(here, 'fixtures', 'fake-login-cli.mjs')}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

interface Rig {
  logins: LoginService;
  events: AgentryEvent[];
  record: string;
  vault: SecretVault;
  readinessCalls: Array<{ tool: SetupTool; host: string | null }>;
}

function rig(options: { fake?: Record<string, string>; ready?: boolean | null; binary?: string | null; lifetimeMs?: number } = {}): Rig {
  const config = tempConfig();
  const vault = new SecretVault(config);
  const record = join(config.dataDir, 'record.json');
  const events: AgentryEvent[] = [];
  const readinessCalls: Rig['readinessCalls'] = [];
  const bin = options.binary === undefined ? fakeBinary() : options.binary;
  const deps: LoginServiceDeps = {
    vault,
    youtrack: new YoutrackCredentialStore(config, vault),
    emit: (event: AgentryEventInput) => events.push({ ...event, id: events.length + 1, at: new Date().toISOString() } as AgentryEvent),
    binary: async () => bin,
    readiness: async (tool, host) => {
      readinessCalls.push({ tool, host });
      return options.ready === undefined ? true : options.ready;
    },
    baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_LOGIN_RECORD: record, ...options.fake },
    lifetimeMs: options.lifetimeMs ?? 10_000,
    commandTimeoutMs: 10_000,
    killGraceMs: 200,
  };
  return { logins: new LoginService(deps), events, record, vault, readinessCalls };
}

async function until<T>(read: () => T | null | undefined, what: string, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ended = (r: Rig, id: string): LoginSession | null => {
  const session = r.logins.get(id);
  return session?.endedAt ? session : null;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readRecord = (r: Rig): { pid: number; argv: string[]; stdin: string; env: Record<string, string | null> } =>
  JSON.parse(readFileSync(r.record, 'utf8')) as { pid: number; argv: string[]; stdin: string; env: Record<string, string | null> };

// ---------- device-code output ----------

test('the URL and the code are read from each tool\'s device-code output', () => {
  const expected = {
    gh: ['https://github.com/login/device', 'AB12-CD34'],
    copilot: ['https://github.com/login/device', '1234-5678'],
    codex: ['https://auth.openai.com/codex/device', 'QW7E-RT9YU'],
    glab: ['https://gitlab.com/oauth/device', 'K3M9-PL2Q'],
  } as const;
  for (const [tool, [url, code]] of Object.entries(expected) as Array<[keyof typeof DEVICE_PATTERNS, readonly [string, string]]>) {
    let found: { url: string | null; code: string | null } = { url: null, code: null };
    for (const line of readFileSync(fixture(`${tool}-fake.txt`), 'utf8').split('\n')) {
      const read = readDeviceLine(DEVICE_PATTERNS[tool], line);
      found = { url: found.url ?? read.url, code: found.code ?? read.code };
    }
    assert.deepEqual(found, { url, code }, tool);
  }
});

test('colour codes and a sentence\'s closing punctuation never end up in the URL or the code', () => {
  const read = readDeviceLine(DEVICE_PATTERNS.codex, '\u001b[1mOpen https://auth.openai.com/codex/device.\u001b[0m then type \u001b[32mAAAA-BBBB\u001b[0m');
  assert.deepEqual(read, { url: 'https://auth.openai.com/codex/device', code: 'AAAA-BBBB' });
  // Only an https address is a link worth showing
  assert.equal(readDeviceLine(DEVICE_PATTERNS.glab, 'see http://gitlab.com/oauth/device').url, null);
});

test('the methods table offers a device sign-in where the vendor documents one, and gh waits for its recording', () => {
  const methods = Object.fromEntries(setupMethods().map((m) => [m.tool, m]));
  assert.deepEqual(
    Object.entries(methods).filter(([, m]) => m.device).map(([tool]) => tool).sort(),
    ['codex', 'copilot', 'gh', 'glab'],
  );
  assert.equal(methods.gh?.deviceNeedsRecording, true);
  assert.equal(methods.copilot?.signOut, false);
  assert.deepEqual(methods['claude-code']?.variables, ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
});

// ---------- device sign-in ----------

test('a device sign-in shows the URL and the code, and succeeds when the readiness probe says signed in', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-fake.txt'), FAKE_LOGIN_DELAY_MS: '300' } });
  const started = await r.logins.start({ tool: 'codex', method: 'device' });
  assert.equal(started.state, 'starting');
  const done = await until(() => ended(r, started.id), 'the sign-in to end');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.ready, true);
  assert.deepEqual(r.readinessCalls, [{ tool: 'codex', host: null }]);
  const waiting = r.events.find((e) => e.type === 'login.updated' && e.login.state === 'waiting-for-person');
  assert.ok(waiting && waiting.type === 'login.updated');
  assert.deepEqual([waiting.login.url, waiting.login.code], ['https://auth.openai.com/codex/device', 'QW7E-RT9YU']);
  // Nothing else the CLI printed leaves the service
  assert.ok(!JSON.stringify(r.events).includes('phishing'));
  assert.deepEqual(readRecord(r).argv, ['login', '--device-auth']);
});

test('a code printed on stderr counts too (copilot), and gh and glab name their host', async () => {
  const copilot = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('copilot-fake.txt'), FAKE_LOGIN_STDERR: '1' } });
  const one = await copilot.logins.start({ tool: 'copilot', method: 'device' });
  assert.equal((await until(() => ended(copilot, one.id), 'copilot')).code, '1234-5678');

  const glab = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('glab-fake.txt') } });
  const two = await glab.logins.start({ tool: 'glab', method: 'device', host: 'GitLab.example.com' });
  const done = await until(() => ended(glab, two.id), 'glab');
  assert.deepEqual([done.state, done.host, done.code], ['succeeded', 'gitlab.example.com', 'K3M9-PL2Q']);
  assert.deepEqual(readRecord(glab).argv, ['auth', 'login', '--device', '--hostname', 'gitlab.example.com']);
  assert.deepEqual(glab.readinessCalls, [{ tool: 'glab', host: 'gitlab.example.com' }]);
});

test('a device sign-in fails with a code, never the CLI\'s text: refused, no code shown, or still signed out', async () => {
  const refused = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('gh-fake.txt'), FAKE_LOGIN_EXIT: '1' } });
  const a = await refused.logins.start({ tool: 'gh', method: 'device' });
  assert.deepEqual(await until(() => ended(refused, a.id), 'refused').then((s) => [s.state, s.error]), ['failed', 'cli-refused']);

  const silent = rig({ fake: { FAKE_LOGIN_EXIT: '2' } });
  const b = await silent.logins.start({ tool: 'codex', method: 'device' });
  assert.deepEqual(await until(() => ended(silent, b.id), 'no code').then((s) => [s.state, s.error]), ['failed', 'no-code']);

  const out = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-fake.txt') }, ready: false });
  const c = await out.logins.start({ tool: 'codex', method: 'device' });
  assert.deepEqual(await until(() => ended(out, c.id), 'not signed in').then((s) => [s.state, s.error, s.ready]), ['failed', 'not-signed-in', false]);

  const missing = rig({ binary: null });
  const d = await missing.logins.start({ tool: 'codex', method: 'device' });
  assert.deepEqual([d.state, d.error], ['failed', 'cli-missing']);
});

test('a device sign-in nobody approves expires, and its process is killed', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-fake.txt'), FAKE_LOGIN_EXIT: 'hang' }, lifetimeMs: 600 });
  const started = await r.logins.start({ tool: 'codex', method: 'device' });
  await until(() => (existsSync(r.record) ? true : null), 'the fake to start');
  const { pid } = readRecord(r);
  const done = await until(() => ended(r, started.id), 'expiry');
  assert.equal(done.state, 'expired');
  await until(() => (alive(pid) ? null : true), 'the process to die');
  assert.equal(r.readinessCalls.length, 0);
});

test('cancelling a device sign-in kills its process group and ends it cancelled', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('glab-fake.txt'), FAKE_LOGIN_EXIT: 'hang' } });
  const started = await r.logins.start({ tool: 'glab', method: 'device' });
  await until(() => (r.logins.get(started.id)?.state === 'waiting-for-person' ? true : null), 'the code');
  const { pid } = readRecord(r);
  assert.equal(r.logins.cancel(started.id)?.state, 'cancelled');
  await until(() => (alive(pid) ? null : true), 'the process to die');
  // A late exit does not turn it into a failure
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(r.logins.get(started.id)?.state, 'cancelled');
});

test('starting again for the same tool and host cancels the sign-in still waiting', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-fake.txt'), FAKE_LOGIN_EXIT: 'hang' } });
  const first = await r.logins.start({ tool: 'codex', method: 'device' });
  const second = await r.logins.start({ tool: 'codex', method: 'device' });
  assert.equal(r.logins.get(first.id)?.state, 'cancelled');
  r.logins.cancel(second.id);
});

// ---------- keys ----------

test('a key for a CLI with a login command goes on stdin, never in argv, and the CLI is what stores it', async () => {
  const secret = 'sk-proj-never-in-argv-123';
  const r = rig();
  const codex = await r.logins.start({ tool: 'codex', method: 'key', secret: ` ${secret} ` });
  assert.deepEqual([codex.state, codex.ready], ['succeeded', true]);
  const seen = readRecord(r);
  assert.deepEqual(seen.argv, ['login', '--with-api-key']);
  assert.ok(!seen.argv.join(' ').includes(secret));
  assert.equal(seen.stdin, `${secret}\n`);
  assert.equal(r.vault.has('codex'), false);
  assert.ok(!JSON.stringify(r.events).includes(secret));
  assert.ok(!JSON.stringify(codex).includes(secret));

  // gh through the execution layer, with its host
  const gh = await r.logins.start({ tool: 'gh', method: 'key', secret, host: 'github.example.com' });
  assert.equal(gh.state, 'succeeded');
  const ghSeen = readRecord(r);
  assert.deepEqual(ghSeen.argv, ['auth', 'login', '--with-token', '--hostname', 'github.example.com']);
  assert.equal(ghSeen.stdin, `${secret}\n`);
});

test('a key the CLI takes but the readiness probe does not is a failure; one the CLI refuses is too', async () => {
  const out = rig({ ready: false });
  assert.deepEqual(await out.logins.start({ tool: 'copilot', method: 'key', secret: 'ghp_x' }).then((s) => [s.state, s.error]), ['failed', 'not-signed-in']);
  const refused = rig({ fake: { FAKE_LOGIN_EXIT: '1' } });
  assert.deepEqual(await refused.logins.start({ tool: 'glab', method: 'key', secret: 'glpat-x' }).then((s) => [s.state, s.error]), ['failed', 'cli-refused']);
});

test('a key for a tool that reads its environment is sealed in the vault and handed to no process', async () => {
  const r = rig();
  const gemini = await r.logins.start({ tool: 'gemini', method: 'key', secret: 'AIza-gemini' });
  assert.equal(gemini.state, 'succeeded');
  assert.deepEqual(r.vault.get('gemini'), { GEMINI_API_KEY: 'AIza-gemini' });
  assert.equal(existsSync(r.record), false);

  await r.logins.start({ tool: 'claude-code', method: 'key', secret: 'sk-ant-api', variable: 'ANTHROPIC_API_KEY' });
  await r.logins.start({ tool: 'claude-code', method: 'key', secret: 'sk-ant-oat' });
  // One credential at a time: the token replaced the key
  assert.deepEqual(r.vault.get('claude-code'), { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' });

  await r.logins.start({ tool: 'opencode', method: 'key', secret: 'sk-oa', variable: 'OPENAI_API_KEY' });
  await r.logins.start({ tool: 'opencode', method: 'key', secret: 'sk-or', variable: 'OPENROUTER_API_KEY' });
  assert.deepEqual(r.vault.get('opencode'), { OPENAI_API_KEY: 'sk-oa', OPENROUTER_API_KEY: 'sk-or' });

  const yt = await r.logins.start({ tool: 'youtrack', method: 'key', secret: 'perm-yt', host: 'https://x.youtrack.cloud/' });
  assert.equal(yt.state, 'succeeded');
  assert.deepEqual(r.vault.get('youtrack'), { YOUTRACK_HOST: 'https://x.youtrack.cloud', YOUTRACK_TOKEN: 'perm-yt' });
});

test('a bad request is refused before anything runs, and the message never echoes the key', async () => {
  const r = rig();
  const refusals: unknown[] = [
    { tool: 'nope', method: 'key' },
    { tool: 'codex', method: 'magic' },
    { tool: 'gemini', method: 'device' },
    { tool: 'codex', method: 'key', secret: 'two words' },
    { tool: 'codex', method: 'key' },
    { tool: 'opencode', method: 'key', secret: 'k', variable: 'PATH' },
    { tool: 'gh', method: 'key', secret: 'k', host: '--hostname=evil' },
    { tool: 'youtrack', method: 'key', secret: 'k' },
  ];
  for (const body of refusals) {
    await assert.rejects(r.logins.start(body), (err: Error) => err instanceof LoginInputError && !err.message.includes('two words'), JSON.stringify(body));
  }
  assert.equal(existsSync(r.record), false);
});

// ---------- sign-out ----------

test('signing out runs the documented command, forgets what the vault keeps, and says so where there is none', async () => {
  const r = rig();
  assert.deepEqual(await r.logins.signOut('copilot'), { tool: 'copilot', host: null, signedOut: false, reason: 'unsupported' });
  assert.equal(existsSync(r.record), false);

  assert.deepEqual(await r.logins.signOut('codex'), { tool: 'codex', host: null, signedOut: true, reason: null });
  assert.deepEqual(readRecord(r).argv, ['logout']);

  assert.equal((await r.logins.signOut('gh', 'github.com')).signedOut, true);
  assert.deepEqual(readRecord(r).argv, ['auth', 'logout', '--hostname', 'github.com']);

  await r.vault.set('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 't' });
  assert.equal((await r.logins.signOut('claude-code')).signedOut, true);
  assert.deepEqual(readRecord(r).argv, ['auth', 'logout']);
  assert.equal(r.vault.has('claude-code'), false);

  await r.vault.set('gemini', { GEMINI_API_KEY: 'g' });
  assert.equal((await r.logins.signOut('gemini')).signedOut, true);
  assert.equal(r.vault.has('gemini'), false);
});
