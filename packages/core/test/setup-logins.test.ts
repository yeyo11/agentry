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
import { LoginInputError, LoginRefusedError, LoginService, type LoginServiceDeps } from '../src/setup/logins.ts';
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

const ended = (r: Pick<Rig, 'logins'>, id: string): LoginSession | null => {
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

test('the URL and the code are read from each tool\'s recorded device-code output', () => {
  // Recorded on the pinned versions with no terminal (fixtures/logins/README.md)
  const expected = {
    gh: ['gh-web.stderr', 'https://github.com/login/device', '250D-975E'],
    codex: ['codex-device-auth.stdout', 'https://auth.openai.com/codex/device', 'LK0N-5V0Q5'],
    glab: ['glab-device.stderr', 'https://gitlab.com/oauth/device', 'WZS9BFLC'],
  } as const;
  for (const [tool, [file, url, code]] of Object.entries(expected) as Array<[keyof typeof DEVICE_PATTERNS, readonly [string, string, string]]>) {
    let found: { url: string | null; code: string | null } = { url: null, code: null };
    for (const line of readFileSync(fixture(file), 'utf8').split('\n')) {
      const read = readDeviceLine(DEVICE_PATTERNS[tool], line);
      found = { url: found.url ?? read.url, code: found.code ?? read.code };
    }
    assert.deepEqual(found, { url, code }, tool);
  }
});

test('colour codes and a sentence\'s closing punctuation never end up in the URL or the code', () => {
  const url = readDeviceLine(DEVICE_PATTERNS.gh, '\u001b[1mOpen this URL to continue in your web browser: https://github.com/login/device.\u001b[0m');
  assert.equal(url.url, 'https://github.com/login/device');
  assert.equal(readDeviceLine(DEVICE_PATTERNS.gh, '! First copy your one-time code: \u001b[32mAAAA-BBBB\u001b[0m').code, 'AAAA-BBBB');
  // Only an https address is a link worth showing
  assert.equal(readDeviceLine(DEVICE_PATTERNS.glab, 'Then open this URL on any device to authorize: http://gitlab.com/oauth/device').url, null);
});

test('the methods table offers a device sign-in where the vendor documents one', () => {
  const methods = Object.fromEntries(setupMethods().map((m) => [m.tool, m]));
  assert.deepEqual(
    Object.entries(methods).filter(([, m]) => m.device).map(([tool]) => tool).sort(),
    ['codex', 'copilot', 'gh', 'glab', 'tailscale'],
  );
  assert.deepEqual(methods['claude-code']?.variables, ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
});

test('Copilot\'s key is kept for its environment and its Code is gh\'s sign-in to github.com, since its own login cannot store a token without a keychain', () => {
  const copilot = setupMethods({}).find((m) => m.tool === 'copilot');
  assert.ok(copilot);
  assert.deepEqual([copilot.key, copilot.variables, copilot.device, copilot.deviceVia], ['env', ['COPILOT_GITHUB_TOKEN'], true, { tool: 'gh', host: 'github.com' }]);
  // Sign out forgets the kept key only: Copilot's own state and gh's are not Agentry's to undo
  assert.deepEqual([copilot.signOut, copilot.signOutKeyOnly], [true, true]);
  assert.equal(setupMethods({}).filter((m) => m.deviceVia !== null).length, 1, 'no other tool lends its sign-in');
});

test('Copilot\'s Code targets the GitHub Enterprise Cloud host COPILOT_GH_HOST or GH_HOST names, the one Copilot asks gh about', () => {
  const via = (env: NodeJS.ProcessEnv) => setupMethods(env).find((m) => m.tool === 'copilot')?.deviceVia;
  assert.deepEqual(via({ GH_HOST: 'acme.ghe.com' }), { tool: 'gh', host: 'acme.ghe.com' });
  assert.deepEqual(via({ GH_HOST: 'ghes.example.com', COPILOT_GH_HOST: 'https://Acme.ghe.com/' }), { tool: 'gh', host: 'acme.ghe.com' }, 'COPILOT_GH_HOST wins, given as a URL like `copilot login --host`');
  assert.deepEqual(via({ GH_HOST: '  ' }), { tool: 'gh', host: 'github.com' }, 'a blank variable names nothing');
  assert.deepEqual(via({ COPILOT_GH_HOST: '--not a host' }), { tool: 'gh', host: null });
  assert.equal(setupMethods({ GH_HOST: 'acme.ghe.com' }).find((m) => m.tool === 'gh')?.defaultHost, 'github.com', 'gh\'s own row keeps its default');
});

// ---------- device sign-in ----------

test('a device sign-in shows the URL and the code, and succeeds when the readiness probe says signed in', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-device-auth.stdout'), FAKE_LOGIN_DELAY_MS: '300' } });
  const started = await r.logins.start({ tool: 'codex', method: 'device' });
  assert.equal(started.state, 'starting');
  const done = await until(() => ended(r, started.id), 'the sign-in to end');
  assert.equal(done.state, 'succeeded');
  assert.equal(done.ready, true);
  assert.deepEqual(r.readinessCalls, [{ tool: 'codex', host: null }]);
  const waiting = r.events.find((e) => e.type === 'login.updated' && e.login.state === 'waiting-for-person');
  assert.ok(waiting && waiting.type === 'login.updated');
  assert.deepEqual([waiting.login.url, waiting.login.code], ['https://auth.openai.com/codex/device', 'LK0N-5V0Q5']);
  // Nothing else the CLI printed leaves the service
  assert.ok(!JSON.stringify(r.events).includes('phishing'));
  assert.deepEqual(readRecord(r).argv, ['login', '--device-auth']);
});

test('Copilot\'s Code starts gh\'s device sign-in to github.com, the session gh\'s row shows', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('gh-web.stderr'), FAKE_LOGIN_STDERR: '1' } });
  const started = await r.logins.start({ tool: 'copilot', method: 'device' });
  assert.deepEqual([started.tool, started.host], ['gh', 'github.com']);
  const done = await until(() => ended(r, started.id), 'gh');
  assert.deepEqual([done.state, done.code], ['succeeded', '250D-975E']);
  assert.deepEqual(readRecord(r).argv, ['auth', 'login', '--web', '--hostname', 'github.com']);
  assert.deepEqual(r.readinessCalls, [{ tool: 'gh', host: 'github.com' }]);
  // One live gh sign-in to github.com at a time, whichever row asked for it
  const hang = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('gh-web.stderr'), FAKE_LOGIN_STDERR: '1', FAKE_LOGIN_EXIT: 'hang' } });
  const fromGh = await hang.logins.start({ tool: 'gh', method: 'device' });
  const fromCopilot = await hang.logins.start({ tool: 'copilot', method: 'device' });
  assert.equal(hang.logins.get(fromGh.id)?.state, 'cancelled');
  hang.logins.cancel(fromCopilot.id);
});

test('Copilot\'s Code signs gh in to the host GH_HOST names, and is refused when it names no host', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('gh-web.stderr'), FAKE_LOGIN_STDERR: '1', GH_HOST: 'acme.ghe.com' } });
  const started = await r.logins.start({ tool: 'copilot', method: 'device' });
  assert.deepEqual([started.tool, started.host], ['gh', 'acme.ghe.com']);
  await until(() => ended(r, started.id), 'gh');
  assert.deepEqual(readRecord(r).argv, ['auth', 'login', '--web', '--hostname', 'acme.ghe.com']);
  const bad = rig({ fake: { COPILOT_GH_HOST: '-x' } });
  await assert.rejects(bad.logins.start({ tool: 'copilot', method: 'device' }), LoginInputError);
  assert.equal(existsSync(bad.record), false, 'nothing ran');
});

test('a code printed on stderr counts too (glab), and gh and glab name their host', async () => {
  const glab = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('glab-device.stderr'), FAKE_LOGIN_STDERR: '1' } });
  const two = await glab.logins.start({ tool: 'glab', method: 'device', host: 'GitLab.example.com' });
  const done = await until(() => ended(glab, two.id), 'glab');
  assert.deepEqual([done.state, done.host, done.code], ['succeeded', 'gitlab.example.com', 'WZS9BFLC']);
  assert.deepEqual(readRecord(glab).argv, ['auth', 'login', '--device', '--hostname', 'gitlab.example.com']);
  assert.deepEqual(glab.readinessCalls, [{ tool: 'glab', host: 'gitlab.example.com' }]);
});

test('a device sign-in fails with a code, never the CLI\'s text: refused, no code shown, or still signed out', async () => {
  const refused = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('gh-web.stderr'), FAKE_LOGIN_STDERR: '1', FAKE_LOGIN_EXIT: '1' } });
  const a = await refused.logins.start({ tool: 'gh', method: 'device' });
  assert.deepEqual(await until(() => ended(refused, a.id), 'refused').then((s) => [s.state, s.error]), ['failed', 'cli-refused']);

  const silent = rig({ fake: { FAKE_LOGIN_EXIT: '2' } });
  const b = await silent.logins.start({ tool: 'codex', method: 'device' });
  assert.deepEqual(await until(() => ended(silent, b.id), 'no code').then((s) => [s.state, s.error]), ['failed', 'no-code']);

  const out = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-device-auth.stdout') }, ready: false });
  const c = await out.logins.start({ tool: 'codex', method: 'device' });
  assert.deepEqual(await until(() => ended(out, c.id), 'not signed in').then((s) => [s.state, s.error, s.ready]), ['failed', 'not-signed-in', false]);

  const missing = rig({ binary: null });
  const d = await missing.logins.start({ tool: 'codex', method: 'device' });
  assert.deepEqual([d.state, d.error], ['failed', 'cli-missing']);
});

test('a device sign-in nobody approves expires, and its process is killed', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-device-auth.stdout'), FAKE_LOGIN_EXIT: 'hang' }, lifetimeMs: 600 });
  const started = await r.logins.start({ tool: 'codex', method: 'device' });
  await until(() => (existsSync(r.record) ? true : null), 'the fake to start');
  const { pid } = readRecord(r);
  const done = await until(() => ended(r, started.id), 'expiry');
  assert.equal(done.state, 'expired');
  await until(() => (alive(pid) ? null : true), 'the process to die');
  assert.equal(r.readinessCalls.length, 0);
});

test('cancelling a device sign-in kills its process group and ends it cancelled', async () => {
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('glab-device.stderr'), FAKE_LOGIN_STDERR: '1', FAKE_LOGIN_EXIT: 'hang' } });
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
  const r = rig({ fake: { FAKE_LOGIN_FIXTURE: fixture('codex-device-auth.stdout'), FAKE_LOGIN_EXIT: 'hang' } });
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
  assert.deepEqual(await out.logins.start({ tool: 'codex', method: 'key', secret: 'sk-x' }).then((s) => [s.state, s.error]), ['failed', 'not-signed-in']);
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

  const pat = 'github_pat_11AAAA_copilot_never_in_argv';
  const copilot = await r.logins.start({ tool: 'copilot', method: 'key', secret: pat });
  assert.equal(copilot.state, 'succeeded');
  assert.deepEqual(r.vault.get('copilot'), { COPILOT_GITHUB_TOKEN: pat });
  assert.equal(existsSync(r.record), false, 'no `copilot login` runs: it could not store the token without a keychain');
  assert.ok(!JSON.stringify(r.events).includes(pat));

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
    { tool: 'copilot', method: 'key', secret: 'ghp_classicTokenCopilotRefuses' },
  ];
  for (const body of refusals) {
    await assert.rejects(r.logins.start(body), (err: Error) => err instanceof LoginInputError && !err.message.includes('two words') && !err.message.includes('classicToken'), JSON.stringify(body));
  }
  assert.equal(existsSync(r.record), false);
  assert.equal(r.vault.has('copilot'), false, 'a classic token is never kept');
});

// ---------- sign-out ----------

test('signing out runs the documented command, forgets what the vault keeps, and says so where there is none', async () => {
  const r = rig();
  await r.vault.set('copilot', { COPILOT_GITHUB_TOKEN: 'github_pat_x' });
  assert.deepEqual(await r.logins.signOut('copilot'), { tool: 'copilot', host: null, signedOut: true, reason: null });
  assert.equal(r.vault.has('copilot'), false, 'Copilot\'s sign-out forgets the key Agentry kept');
  assert.equal(existsSync(r.record), false, 'and runs nothing: not copilot, not gh');

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

// ---------- Tailscale (the daemon the Docker image runs for Agentry) ----------

const FAKE_TAILSCALE = join(here, 'fixtures', 'fake-tailscale.mjs');

interface TailscaleRig {
  logins: LoginService;
  events: AgentryEvent[];
  /** The fake node's state file: `approved`, `authKey`, `backendState`, `keyFiles` */
  node: () => { backendState: string; hostname?: string; keyFiles?: Array<{ mode: number; key: string }> };
  approve: () => void;
  /** Every argv the CLI was started with */
  calls: () => string[][];
  signOuts: string[];
}

function tailscaleRig(options: { authKey?: string; refusal?: string | null } = {}): TailscaleRig {
  const config = tempConfig();
  const vault = new SecretVault(config);
  const stateFile = join(config.dataDir, 'node.json');
  const log = join(config.dataDir, 'tailscale.log');
  writeFileSync(stateFile, JSON.stringify({ backendState: 'NeedsLogin', ...(options.authKey ? { authKey: options.authKey } : {}) }));
  const events: AgentryEvent[] = [];
  const signOuts: string[] = [];
  const node = () => JSON.parse(readFileSync(stateFile, 'utf8')) as ReturnType<TailscaleRig['node']>;
  const logins = new LoginService({
    vault,
    youtrack: new YoutrackCredentialStore(config, vault),
    emit: (event: AgentryEventInput) => events.push({ ...event, id: events.length + 1, at: new Date().toISOString() } as AgentryEvent),
    binary: async () => FAKE_TAILSCALE,
    // What Core reads: the node's state through the CLI; here, the fake's own file
    readiness: async () => node().backendState === 'Running',
    refusal: () => options.refusal ?? null,
    beforeSignOut: async (tool) => {
      signOuts.push(tool);
    },
    tailscaleName: 'agentry-lab',
    baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_TAILSCALE_STATE: stateFile, FAKE_TAILSCALE_LOG: log },
    lifetimeMs: 10_000,
    commandTimeoutMs: 10_000,
    killGraceMs: 200,
  });
  return {
    logins,
    events,
    node,
    approve: () => writeFileSync(stateFile, JSON.stringify({ ...node(), approved: true })),
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { argv: string[] }).argv) : []),
    signOuts,
  };
}

test('Tailscale\'s recorded login output gives the URL alone: there is no code to type', () => {
  let found: { url: string | null; code: string | null } = { url: null, code: null };
  for (const line of readFileSync(fixture('tailscale-up.stderr'), 'utf8').split('\n')) {
    const read = readDeviceLine(DEVICE_PATTERNS.tailscale, line);
    found = { url: found.url ?? read.url, code: found.code ?? read.code };
  }
  assert.deepEqual(found, { url: 'https://login.tailscale.com/a/12c7b6a0132b3', code: null });
  // The sentence before it is not a link
  assert.equal(readDeviceLine(DEVICE_PATTERNS.tailscale, 'To authenticate, visit:').url, null);
});

test('a Tailscale sign-in waits on its login URL with no code, and succeeds once the node runs', async () => {
  const r = tailscaleRig();
  const started = await r.logins.start({ tool: 'tailscale', method: 'device' });
  assert.equal(started.state, 'starting');
  const waiting = await until(() => {
    const session = r.logins.get(started.id);
    return session?.state === 'waiting-for-person' ? session : null;
  }, 'the login URL');
  assert.deepEqual([waiting.url, waiting.code, waiting.host], ['https://login.tailscale.com/a/12c7b6a0132b3', null, null]);
  // The deploy's node name, and nothing that changes networking beyond what Serve needs
  assert.deepEqual(r.calls()[0], ['up', '--reset', '--hostname=agentry-lab']);
  r.approve();
  const done = await until(() => ended(r, started.id), 'the sign-in to end');
  assert.deepEqual([done.state, done.ready], ['succeeded', true]);
  assert.equal(r.node().hostname, 'agentry-lab');
});

test('a Tailscale auth key reaches the CLI only through a 0600 file that is gone once the command ended', async () => {
  const key = 'fake-ts-auth-key-never-in-argv';
  const r = tailscaleRig({ authKey: key });
  const session = await r.logins.start({ tool: 'tailscale', method: 'key', secret: key });
  assert.deepEqual([session.state, session.ready], ['succeeded', true]);
  const argv = r.calls()[0] ?? [];
  assert.deepEqual(argv.slice(0, 3), ['up', '--reset', '--hostname=agentry-lab']);
  const fileArg = argv[3] ?? '';
  assert.match(fileArg, /^--auth-key=file:\//);
  assert.ok(!argv.join(' ').includes(key), 'the key is never in argv');
  assert.deepEqual(r.node().keyFiles, [{ mode: 0o600, key }]);
  assert.equal(existsSync(fileArg.slice('--auth-key=file:'.length)), false, 'the key file is removed');
  assert.ok(!JSON.stringify(r.events).includes(key));
  assert.ok(!JSON.stringify(session).includes(key));

  // A key the control server refuses is a failure, and its file goes too
  const bad = tailscaleRig({ authKey: 'fake-ts-auth-key-the-right-one' });
  const refused = await bad.logins.start({ tool: 'tailscale', method: 'key', secret: 'fake-ts-auth-key-bad' });
  assert.deepEqual([refused.state, refused.error], ['failed', 'cli-refused']);
  const badArg = bad.calls()[0]?.[3] ?? '';
  assert.equal(existsSync(badArg.slice('--auth-key=file:'.length)), false);
});

test('Tailscale signs out with logout, after the tunnel had its chance to close', async () => {
  const r = tailscaleRig({ authKey: 'fake-ts-auth-key-ok' });
  await r.logins.start({ tool: 'tailscale', method: 'key', secret: 'fake-ts-auth-key-ok' });
  assert.deepEqual(await r.logins.signOut('tailscale'), { tool: 'tailscale', host: null, signedOut: true, reason: null });
  assert.deepEqual(r.calls().at(-1), ['logout']);
  assert.deepEqual(r.signOuts, ['tailscale']);
  assert.equal(r.node().backendState, 'NeedsLogin');
});

test('a Tailscale that belongs to the machine is neither signed in nor out from Agentry', async () => {
  const r = tailscaleRig({ refusal: 'not managed' });
  await assert.rejects(r.logins.start({ tool: 'tailscale', method: 'device' }), (err: Error) => err instanceof LoginRefusedError && (err as LoginRefusedError).statusCode === 409);
  await assert.rejects(r.logins.start({ tool: 'tailscale', method: 'key', secret: 'fake-ts-auth-key-x' }), LoginRefusedError);
  await assert.rejects(r.logins.signOut('tailscale'), LoginRefusedError);
  assert.deepEqual(r.calls(), [], 'the CLI never ran');
  assert.deepEqual(r.signOuts, []);
});
