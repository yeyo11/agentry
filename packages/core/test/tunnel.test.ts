import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AuthMode, TunnelStatus } from '@agentry/shared';
import { RuntimeHosts } from '../src/app-settings.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { LOCALHOST_RUN_KNOWN_HOSTS, parseTunnelUrl, TunnelManager, TunnelRefusedError, type TunnelDeps } from '../src/tunnel.ts';

const FAKE_SSH = fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url));

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Agentry's health, as far as the manager can tell: the only route it asks for through the tunnel */
async function healthServer(t: TestContext): Promise<number> {
  const server: Server = createServer((req, res) => {
    res.writeHead(req.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cli: true, loggedIn: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return (server.address() as AddressInfo).port;
}

/** "The public URL", reached through the fake ssh's loopback proxy with the tunnel's own `Host` */
function throughFake(routesFile: string, url: string, path = '/api/health'): Promise<number> {
  const host = new URL(url).hostname;
  const routes = existsSync(routesFile) ? (JSON.parse(readFileSync(routesFile, 'utf8')) as Record<string, number>) : {};
  const port = routes[host];
  if (!port) return Promise.resolve(0);
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

interface Rig {
  root: string;
  manager: TunnelManager;
  hosts: RuntimeHosts;
  events: TunnelStatus[];
  audit: string[];
  security: { mode: AuthMode };
  starts: () => { pid: number; argv: string[] }[];
  routes: string;
}

function rig(t: TestContext, options: { mode?: AuthMode; sshBin?: string; fakeMode?: string; verify?: TunnelDeps['verify']; root?: string; timing?: TunnelDeps['timing'] } = {}): Rig {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'agentry-tunnel-'));
  const log = join(root, 'ssh.log');
  const routes = join(root, 'routes.json');
  // The child inherits the environment: set per test, and put back once it is done
  const saved = { log: process.env.FAKE_SSH_LOG, routes: process.env.FAKE_SSH_ROUTES, mode: process.env.FAKE_SSH_MODE };
  process.env.FAKE_SSH_LOG = log;
  process.env.FAKE_SSH_ROUTES = routes;
  if (options.fakeMode) process.env.FAKE_SSH_MODE = options.fakeMode;
  else delete process.env.FAKE_SSH_MODE;
  const hosts = new RuntimeHosts();
  const events: TunnelStatus[] = [];
  const audit: string[] = [];
  const security = { mode: options.mode ?? 'token' };
  const manager = new TunnelManager({
    dataDir: join(root, 'data'),
    sshBin: options.sshBin ?? FAKE_SSH,
    security,
    hosts,
    emit: (event: AgentryEventInput) => {
      if (event.type === 'tunnel.changed') events.push(event.tunnel);
    },
    audit: (row) => audit.push(row.summary),
    verify: options.verify ?? (async (url) => (await throughFake(routes, url)) === 200),
    timing: { verifyIntervalMs: 20, verifyTimeoutMs: 2_000, backoffMs: [10], killGraceMs: 500, ...options.timing },
  });
  t.after(() => {
    manager.shutdown();
    for (const [key, value] of [['FAKE_SSH_LOG', saved.log], ['FAKE_SSH_ROUTES', saved.routes], ['FAKE_SSH_MODE', saved.mode]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const starts = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { pid: number; argv: string[] })
      : [];
  return { root, manager, hosts, events, audit, security, starts, routes };
}

const hostOf = (status: TunnelStatus): string => new URL(status.url ?? 'https://none.invalid').hostname;

test('the address comes from the banner line, and from no other link localhost.run prints', () => {
  assert.equal(parseTunnelUrl('cb5bcc0471f2ae.lhr.life tunneled with tls termination, https://cb5bcc0471f2ae.lhr.life\r'), 'https://cb5bcc0471f2ae.lhr.life');
  assert.equal(parseTunnelUrl('create an account and add your key for a longer lasting domain name. see https://localhost.run/docs/forever-free/ for more information.'), null);
  assert.equal(parseTunnelUrl('To explore using localhost.run visit the documentation site: https://localhost.run/docs/'), null);
  // The same name on both sides, or it is not the line we think it is
  assert.equal(parseTunnelUrl('a1.lhr.life tunneled with tls termination, https://evil.example.com'), null);
  assert.equal(parseTunnelUrl('a1.lhr.life tunneled with tls termination, https://a1.lhr.life/path'), null);
});

test('start is refused under mode none, and no ssh is run', async (t) => {
  const { manager, starts } = rig(t, { mode: 'none' });
  manager.attach(await healthServer(t));
  await assert.rejects(manager.start(), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.authRequired' && error.statusCode === 409);
  assert.equal(manager.status().state, 'stopped');
  assert.deepEqual(starts(), []);
});

test('the host joins the allowlist only once Agentry answers through it, and leaves on stop', async (t) => {
  let answer: (ok: boolean) => void = () => undefined;
  const asked: string[] = [];
  const { manager, hosts, events, audit } = rig(t, {
    verify: (url) => {
      asked.push(url);
      return new Promise((resolve) => (answer = resolve));
    },
  });
  manager.attach(await healthServer(t));
  const started = await manager.start();
  assert.equal(started.state, 'starting');
  await until(() => manager.status().state === 'verifying', 'verifying');
  // Handed out but not yet answering: not shown, not answered to
  assert.equal(manager.status().url, null);
  assert.deepEqual(hosts.list(), []);
  const host = new URL(asked[0] ?? '').hostname;
  assert.match(host, /^[0-9a-f]{14}\.lhr\.life$/);

  answer(true);
  await until(() => manager.status().state === 'active', 'active');
  const active = manager.status();
  assert.equal(active.url, `https://${host}`);
  assert.ok(active.since && Date.parse(active.since) > 0);
  assert.deepEqual(hosts.list(), [host]);
  // Registered without a client-address header: localhost.run sets none, and a client's own is forgeable
  assert.deepEqual(hosts.get(host), {});

  const pid = manager.pid;
  assert.ok(pid);
  const stopped = await manager.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.url, null);
  assert.deepEqual(hosts.list(), []);
  assert.equal(alive(pid), false);
  assert.deepEqual(
    events.map((e) => e.state),
    ['starting', 'verifying', 'active', 'stopping', 'stopped'],
  );
  // The address is on the feed only while it works
  assert.ok(events.filter((e) => e.state !== 'active').every((e) => e.url === null));
  assert.deepEqual(audit, [`Tunnel host ${host} joined the allowlist`, `Tunnel host ${host} left the allowlist`]);
});

test('an address that never answers is not shown, and the tunnel fails after its attempts', async (t) => {
  const { manager, hosts, starts } = rig(t, { verify: async () => false, timing: { verifyTimeoutMs: 60, maxAttempts: 2 } });
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'failed', 'failed');
  const status = manager.status();
  assert.equal(status.reason?.code, 'tunnel.unverified');
  assert.equal(status.url, null);
  assert.deepEqual(hosts.list(), []);
  assert.equal(starts().length, 2);
  assert.equal(manager.pid, null);
});

test('a domain change on the same connection swaps the host', async (t) => {
  const { manager, hosts, audit } = rig(t);
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  const first = hostOf(manager.status());
  const pid = manager.pid;
  assert.ok(pid);

  process.kill(pid, 'SIGUSR1');
  await until(() => manager.status().state === 'active' && hostOf(manager.status()) !== first, 'the new address');
  const second = hostOf(manager.status());
  assert.deepEqual(hosts.list(), [second]);
  assert.equal(manager.pid, pid);
  assert.deepEqual(audit, [
    `Tunnel host ${first} joined the allowlist`,
    `Tunnel host ${first} left the allowlist`,
    `Tunnel host ${second} joined the allowlist`,
  ]);
});

test('a dropped connection reconnects with backoff, and the old host is gone at once', async (t) => {
  const { manager, hosts, starts } = rig(t);
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  const first = hostOf(manager.status());
  const pid = manager.pid;
  assert.ok(pid);

  process.kill(pid, 'SIGUSR2');
  await until(() => !hosts.list().includes(first), 'the old host to leave');
  await until(() => manager.status().state === 'active', 'active again');
  assert.notEqual(hostOf(manager.status()), first);
  assert.deepEqual(hosts.list(), [hostOf(manager.status())]);
  assert.equal(starts().length, 2);
  assert.notEqual(manager.pid, pid);
});

test('a network that never lets ssh through ends in failed, with what ssh said', async (t) => {
  const { manager, starts } = rig(t, { fakeMode: 'fail', timing: { maxAttempts: 3 } });
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'failed', 'failed');
  const { reason } = manager.status();
  assert.equal(reason?.code, 'tunnel.exited');
  assert.match(reason?.text ?? '', /Network is unreachable/);
  // The banner's line with the caller's public address is never a reason shown on screen
  assert.doesNotMatch(reason?.text ?? '', /203\.0\.113\.7/);
  assert.equal(starts().length, 3);
});

test('the pinned key is the only one ssh may accept, and ~/.ssh is never named', async (t) => {
  const { root, manager, starts } = rig(t);
  const knownHosts = join(root, 'data', 'tunnel', 'known_hosts');
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  assert.equal(readFileSync(knownHosts, 'utf8'), LOCALHOST_RUN_KNOWN_HOSTS);
  assert.equal(statSync(knownHosts).mode & 0o777, 0o600);

  const [first] = starts();
  assert.ok(first);
  const { argv } = first;
  const options = argv.flatMap((arg, i) => (argv[i - 1] === '-o' ? [arg] : []));
  assert.deepEqual(argv.slice(0, 2), ['-F', 'none']);
  for (const option of [`UserKnownHostsFile=${knownHosts}`, 'GlobalKnownHostsFile=none', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'BatchMode=yes', 'PubkeyAuthentication=no', 'IdentityAgent=none', 'IdentityFile=none', 'ExitOnForwardFailure=yes']) {
    assert.ok(options.includes(option), `ssh is run with -o ${option}`);
  }
  assert.equal(argv.at(-1), 'nokey@localhost.run');
  assert.match(argv[argv.indexOf('-R') + 1] ?? '', /^80:127\.0\.0\.1:\d+$/);
  assert.ok(!argv.some((arg) => arg.includes(join(homedir(), '.ssh'))), 'no argument points into ~/.ssh');
});

test('a host key that is not the pinned one fails the tunnel without retrying', async (t) => {
  const { manager, starts, hosts } = rig(t, { fakeMode: 'hostkey' });
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'failed', 'failed');
  assert.equal(manager.status().reason?.code, 'tunnel.hostKey');
  // Retrying would only ask the same endpoint again; this needs a person, or a new Agentry
  assert.equal(starts().length, 1);
  assert.deepEqual(hosts.list(), []);
});

test('the pin is written again before every attempt, whatever the file was changed to', async (t) => {
  const { root, manager, starts } = rig(t);
  manager.attach(await healthServer(t));
  const knownHosts = join(root, 'data', 'tunnel', 'known_hosts');
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  await manager.stop();
  writeFileSync(knownHosts, 'localhost.run ssh-ed25519 AAAAsomethingelse\n');
  await manager.start();
  await until(() => manager.status().state === 'active', 'active after tampering');
  assert.equal(readFileSync(knownHosts, 'utf8'), LOCALHOST_RUN_KNOWN_HOSTS);
  assert.equal(starts().length, 2);
});

test('ssh missing is a state, not a crash', async (t) => {
  const { manager } = rig(t, { sshBin: '/nonexistent/ssh' });
  assert.equal(manager.status().sshAvailable, false);
  manager.attach(await healthServer(t));
  const status = await manager.start();
  assert.equal(status.state, 'failed');
  assert.equal(status.reason?.code, 'tunnel.sshMissing');
  assert.equal(status.sshAvailable, false);
  assert.equal((await manager.stop()).state, 'stopped');
});

test('the child dies with Agentry, and its pid file goes with it', async (t) => {
  const { root, manager, hosts } = rig(t);
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  const pid = manager.pid;
  assert.ok(pid);
  const pidFile = join(root, 'data', 'tunnel', 'ssh.pid');
  assert.equal(readFileSync(pidFile, 'utf8'), String(pid));

  manager.shutdown();
  await until(() => !alive(pid), 'ssh to exit');
  assert.equal(existsSync(pidFile), false);
  assert.deepEqual(hosts.list(), []);
});

test('an orphan a crash left behind is cleared on the next start, and a stranger with its pid is not', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-tunnel-orphan-'));
  const dir = join(root, 'data', 'tunnel');
  const knownHosts = join(dir, 'known_hosts');
  const { manager } = rig(t, { root });
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  const pidFile = join(dir, 'ssh.pid');

  // A crash: the process went away without its shutdown, so ssh and its pid file are still there.
  // Stood in for by a detached copy of the same command line, outliving any manager
  const orphan = spawn(FAKE_SSH, ['-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-R', '80:127.0.0.1:9', 'nokey@localhost.run'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  assert.ok(orphan.pid);
  t.after(() => {
    if (orphan.pid && alive(orphan.pid)) process.kill(orphan.pid, 'SIGKILL');
  });
  manager.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(pidFile, String(orphan.pid));
  const next = rig(t, { root });
  await until(() => !alive(orphan.pid ?? 0), 'the orphan to be killed');
  assert.equal(existsSync(pidFile), false);
  assert.equal(next.manager.status().state, 'stopped');

  // A pid the system handed to something else since is left alone
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  assert.ok(stranger.pid);
  t.after(() => stranger.kill('SIGKILL'));
  writeFileSync(pidFile, String(stranger.pid));
  rig(t, { root });
  assert.equal(alive(stranger.pid), true);
  assert.equal(existsSync(pidFile), false);
});

test('start with Agentry is off by default, is kept, and opens the tunnel on the next attach', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-tunnel-settings-'));
  const port = await healthServer(t);
  const first = rig(t, { root });
  assert.equal(first.manager.status().settings.startWithAgentry, false);
  first.manager.attach(port);
  assert.equal(first.manager.status().state, 'stopped');
  await assert.rejects(first.manager.updateSettings({ startWithAgentry: 'yes' }), /must be a boolean/);
  await assert.rejects(first.manager.updateSettings({ provider: 'ngrok' }), /unknown tunnel settings/);
  const updated = await first.manager.updateSettings({ startWithAgentry: true });
  assert.equal(updated.settings.startWithAgentry, true);
  assert.equal(first.events.at(-1)?.settings.startWithAgentry, true);
  first.manager.shutdown();

  const second = rig(t, { root });
  assert.equal(second.manager.status().settings.startWithAgentry, true);
  second.manager.attach(port);
  await until(() => second.manager.status().state === 'active', 'active');
  second.manager.shutdown();

  // Asked to start with Agentry on a wrapper without authentication: says why instead of opening
  const third = rig(t, { root, mode: 'none' });
  third.manager.attach(port);
  await until(() => third.manager.status().state === 'failed', 'failed');
  assert.equal(third.manager.status().reason?.code, 'tunnel.authRequired');
  assert.deepEqual(third.starts().length, 1);
});

test('a reconnect under mode none does not happen: the tunnel stops instead', async (t) => {
  const { manager, security, hosts, audit } = rig(t);
  manager.attach(await healthServer(t));
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  const pid = manager.pid;
  assert.ok(pid);
  // The guard went away by some path that did not stop the tunnel first; the next connect notices
  security.mode = 'none';
  process.kill(pid, 'SIGUSR2');
  await until(() => manager.status().state === 'stopped', 'stopped');
  assert.deepEqual(hosts.list(), []);
  assert.ok(audit.includes('Stop the tunnel: authentication was turned off'));
});
