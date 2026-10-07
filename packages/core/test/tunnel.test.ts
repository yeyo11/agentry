import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AuthMode, TunnelStatus } from '@agentry/shared';
import { RuntimeHosts } from '../src/app-settings.ts';
import type { AgentryEventInput } from '../src/events.ts';
import { parseTailscaleVersion, readinessFromStatus, servePortUse, TunnelManager, TunnelRefusedError, type TunnelDeps } from '../src/tunnel.ts';

const FAKE_TAILSCALE = fileURLToPath(new URL('./fixtures/fake-tailscale.mjs', import.meta.url));
const NODE = 'agentry-test.tail0000.ts.net';
const TARGET = 'http://127.0.0.1:8787';

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The node's state as the fake CLI keeps it; any key left out is the fake's default. */
interface FakeNode {
  version?: string;
  daemon?: boolean;
  backendState?: string;
  dnsName?: string;
  magicDNS?: boolean;
  certDomains?: string[];
  operator?: boolean;
  serve?: Record<string, unknown>;
}

interface Rig {
  root: string;
  manager: TunnelManager;
  hosts: RuntimeHosts;
  events: TunnelStatus[];
  audit: string[];
  security: { mode: AuthMode };
  /** Every call the CLI received, as one string per call */
  calls: () => string[];
  node: () => Required<Pick<FakeNode, 'serve'>> & FakeNode;
  setNode: (next: FakeNode) => void;
  record: string;
}

function rig(t: TestContext, options: { mode?: AuthMode; enabled?: boolean; tailscaleBin?: string; node?: FakeNode; root?: string; timing?: TunnelDeps['timing']; attach?: boolean } = {}): Rig {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'agentry-tunnel-'));
  const log = join(root, 'tailscale.log');
  const stateFile = join(root, 'node.json');
  if (options.node || !existsSync(stateFile)) writeFileSync(stateFile, JSON.stringify({ serve: {}, ...options.node }));
  // The CLI inherits the environment: set per test, and put back once it is done
  const saved = { state: process.env.FAKE_TAILSCALE_STATE, log: process.env.FAKE_TAILSCALE_LOG };
  process.env.FAKE_TAILSCALE_STATE = stateFile;
  process.env.FAKE_TAILSCALE_LOG = log;
  const hosts = new RuntimeHosts();
  const events: TunnelStatus[] = [];
  const audit: string[] = [];
  const security = { mode: options.mode ?? 'token' };
  const manager = new TunnelManager({
    dataDir: join(root, 'data'),
    tailscaleBin: options.tailscaleBin ?? FAKE_TAILSCALE,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    security,
    hosts,
    emit: (event: AgentryEventInput) => {
      if (event.type === 'tunnel.changed') events.push(event.tunnel);
    },
    audit: (row) => audit.push(row.summary),
    timing: { monitorMs: 60_000, probeTtlMs: 0, ...options.timing },
  });
  t.after(() => {
    manager.shutdown();
    for (const [key, value] of [['FAKE_TAILSCALE_STATE', saved.state], ['FAKE_TAILSCALE_LOG', saved.log]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  if (options.attach !== false) manager.attach(8787);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(' ')) : []);
  const node = () => JSON.parse(readFileSync(stateFile, 'utf8')) as Required<Pick<FakeNode, 'serve'>> & FakeNode;
  const setNode = (next: FakeNode) => writeFileSync(stateFile, JSON.stringify({ ...node(), ...next }));
  return { root, manager, hosts, events, audit, security, calls, node, setNode, record: join(root, 'data', 'tunnel', 'serve-rule.json') };
}

const ours = (port = 8443, target = TARGET) => ({ TCP: { [String(port)]: { HTTPS: true } }, Web: { [`${NODE}:${port}`]: { Handlers: { '/': { Proxy: target } } } } });

async function openTunnel(r: Rig): Promise<TunnelStatus> {
  await r.manager.start();
  await until(() => ['active', 'failed'].includes(r.manager.status().state), 'active or failed');
  return r.manager.status();
}

test('the version and the readiness come from the CLI output as measured on 1.102.4', () => {
  assert.deepEqual(parseTailscaleVersion('1.102.4\n  tailscale commit: 3caf7d9'), [1, 102, 4]);
  assert.equal(parseTailscaleVersion('not a version'), null);
  const running = { BackendState: 'Running', Self: { DNSName: `${NODE}.` }, CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: [NODE] };
  assert.deepEqual(readinessFromStatus(running, '1.102.4'), { state: 'ready', version: '1.102.4', host: NODE, reason: null });
  assert.equal(readinessFromStatus({ ...running, BackendState: 'NeedsLogin' }, '1.102.4').state, 'loggedOut');
  assert.equal(readinessFromStatus({ ...running, BackendState: 'NeedsMachineAuth' }, '1.102.4').state, 'loggedOut');
  const stopped = readinessFromStatus({ ...running, BackendState: 'Stopped' }, '1.102.4');
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.reason?.params, { state: 'Stopped' });
  assert.equal(readinessFromStatus({ ...running, CurrentTailnet: { MagicDNSEnabled: false } }, '1.102.4').reason?.code, 'tunnel.magicDnsOff');
  assert.equal(readinessFromStatus({ ...running, CertDomains: null }, '1.102.4').reason?.code, 'tunnel.httpsOff');
});

test("only an HTTPS listener with one `/` proxy to this server is Agentry's; anything else on the port is the person's", () => {
  assert.equal(servePortUse({}, 8443, NODE, TARGET), 'free');
  assert.equal(servePortUse({ TCP: { '443': { HTTPS: true } }, Web: { [`${NODE}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }, 8443, NODE, TARGET), 'free');
  assert.equal(servePortUse(ours(), 8443, NODE, TARGET), 'match');
  assert.equal(servePortUse(ours(8443, `${TARGET}/`), 8443, NODE, TARGET), 'match');
  assert.equal(servePortUse(ours(8443, 'http://127.0.0.1:3000'), 8443, NODE, TARGET), 'other');
  const withPath = { TCP: ours().TCP, Web: { [`${NODE}:8443`]: { Handlers: { '/': { Proxy: TARGET }, '/grafana': { Proxy: 'http://127.0.0.1:3000' } } } } };
  assert.equal(servePortUse(withPath, 8443, NODE, TARGET), 'other');
  assert.equal(servePortUse({ TCP: { '8443': { TCPForward: '127.0.0.1:22' } } }, 8443, NODE, TARGET), 'other');
  assert.equal(servePortUse({ Foreground: { session: ours() } }, 8443, NODE, TARGET), 'other');
});

test('start is refused under mode none, and the Serve config is never touched', async (t) => {
  const r = rig(t, { mode: 'none' });
  await assert.rejects(r.manager.start(), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.authRequired' && error.statusCode === 409);
  assert.equal(r.manager.status().state, 'stopped');
  assert.ok(!r.calls().some((call) => call.startsWith('serve')));
});

test('where the deploy does not offer the tunnel, start is refused and the CLI is never run', async (t) => {
  const r = rig(t, { enabled: false });
  assert.equal((await r.manager.refresh()).enabled, false);
  await assert.rejects(r.manager.start(), (error: unknown) => error instanceof TunnelRefusedError && error.reason.code === 'tunnel.disabled' && error.statusCode === 409);
  assert.equal(r.manager.status().state, 'stopped');
  assert.deepEqual(r.hosts.list(), []);
  assert.deepEqual(r.calls(), []);
});

test('start with Agentry, saved before the operator turned the tunnel off, does not open it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-tunnel-'));
  const first = rig(t, { root, attach: false });
  await first.manager.updateSettings({ startWithAgentry: true });
  first.manager.shutdown();

  const second = rig(t, { root, enabled: false });
  assert.equal(second.manager.status().settings.startWithAgentry, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Stopped, not failed: nothing went wrong, the deploy simply does not offer it
  assert.equal(second.manager.status().state, 'stopped');
  assert.equal(second.manager.status().reason, null);
  assert.ok(!second.calls().some((call) => call.startsWith('serve')));
});

test('each way Tailscale is not ready is a state of its own, and start fails with its reason', async (t) => {
  const cases: { node?: FakeNode; bin?: string; state: string; code: string }[] = [
    { bin: '/nonexistent/tailscale', state: 'missing', code: 'tunnel.tailscaleMissing' },
    { node: { version: '1.50.1' }, state: 'unsupported', code: 'tunnel.tailscaleUnsupported' },
    { node: { daemon: false }, state: 'daemonDown', code: 'tunnel.tailscaleDaemonDown' },
    { node: { backendState: 'NeedsLogin' }, state: 'loggedOut', code: 'tunnel.tailscaleLoggedOut' },
    { node: { backendState: 'Stopped' }, state: 'stopped', code: 'tunnel.tailscaleNotConnected' },
    { node: { magicDNS: false }, state: 'httpsDisabled', code: 'tunnel.magicDnsOff' },
    { node: { certDomains: [] }, state: 'httpsDisabled', code: 'tunnel.httpsOff' },
  ];
  for (const c of cases) {
    const r = rig(t, { ...(c.node ? { node: c.node } : {}), ...(c.bin ? { tailscaleBin: c.bin } : {}) });
    const status = await r.manager.refresh();
    assert.equal(status.tailscale.state, c.state, c.code);
    assert.equal(status.tailscale.reason?.code, c.code);
    const started = await r.manager.start();
    assert.equal(started.state, 'failed', c.code);
    assert.equal(started.reason?.code, c.code);
    assert.ok(!r.calls().some((call) => call.startsWith('serve')), `${c.code}: no Serve call`);
    assert.deepEqual(r.hosts.list(), []);
  }
});

test("the node's name joins the allowlist once the rule reads back, and stop leaves the Serve config as it was found", async (t) => {
  // The person's own rule on 443 is there before, and still there after
  const theirs = { TCP: { '443': { HTTPS: true } }, Web: { [`${NODE}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  const r = rig(t, { node: { serve: theirs } });
  const ready = await r.manager.refresh();
  assert.deepEqual(ready.tailscale, { state: 'ready', version: '1.102.4', host: NODE, reason: null });
  // The readiness read is news of its own: the page learns that Tailscale is ready
  assert.deepEqual(r.events.splice(0).map((s) => [s.state, s.tailscale.state]), [['stopped', 'ready']]);

  const active = await openTunnel(r);
  assert.equal(active.state, 'active');
  assert.equal(active.url, `https://${NODE}:8443`);
  assert.ok(active.since);
  assert.deepEqual(r.hosts.list(), [NODE]);
  assert.deepEqual(r.node().serve, { TCP: { ...theirs.TCP, ...ours().TCP }, Web: { ...theirs.Web, ...ours().Web } });
  assert.ok(existsSync(r.record), 'the rule is recorded, so a crash cannot leave it behind unnoticed');
  assert.ok(r.calls().includes(`serve --bg --yes --https=8443 ${TARGET}`));
  assert.deepEqual(r.events.map((s) => s.state), ['starting', 'verifying', 'active']);
  assert.ok(r.events.every((s) => (s.state === 'active') === (s.url !== null)));

  const stopped = await r.manager.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.url, null);
  assert.deepEqual(r.hosts.list(), []);
  assert.deepEqual(r.node().serve, theirs);
  assert.ok(!existsSync(r.record));
  assert.deepEqual(r.audit, [`Tunnel host ${NODE} joined the allowlist`, `Tunnel host ${NODE} left the allowlist`]);
});

test('a port that already serves something else is left alone, and the tunnel says so', async (t) => {
  const theirs = ours(8443, 'http://127.0.0.1:3000');
  const r = rig(t, { node: { serve: theirs } });
  const status = await openTunnel(r);
  assert.equal(status.state, 'failed');
  assert.equal(status.reason?.code, 'tunnel.portTaken');
  assert.deepEqual(status.reason?.params, { port: '8443' });
  assert.deepEqual(r.node().serve, theirs);
  assert.ok(!r.calls().some((call) => call.includes('--bg') || call.endsWith('off')));
  assert.deepEqual(r.hosts.list(), []);
});

test('the same rule with no record of Agentry adding it is not adopted', async (t) => {
  const r = rig(t, { node: { serve: ours() } });
  const status = await openTunnel(r);
  assert.equal(status.reason?.code, 'tunnel.portTaken');
  await r.manager.stop();
  assert.deepEqual(r.node().serve, ours(), 'a rule Agentry did not add is never removed');
});

test('a user who is not the node operator gets the command that fixes it, and nothing is left behind', async (t) => {
  const r = rig(t, { node: { operator: false } });
  const status = await openTunnel(r);
  assert.equal(status.state, 'failed');
  assert.equal(status.reason?.code, 'tunnel.servePermission');
  assert.match(status.reason?.text ?? '', /tailscale set --operator/);
  await until(() => !existsSync(r.record), 'the record removed');
  assert.deepEqual(r.node().serve, {});
});

test('a rule a crash left behind is taken away on the next start, and one someone else replaced is not', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-tunnel-crash-'));
  const crashed = rig(t, { root, attach: false });
  crashed.manager.attach(8787);
  await openTunnel(crashed);
  assert.deepEqual(crashed.node().serve, ours());
  // A crash: the process is gone without shutdown, so the rule and its record stay
  const record = readFileSync(crashed.record, 'utf8');

  const next = rig(t, { root, attach: false });
  assert.ok(existsSync(next.record));
  next.manager.attach(8787);
  await until(() => !existsSync(next.record), 'the leftover reconciled');
  assert.deepEqual(next.node().serve, {});

  // The same record, but the port now holds the person's rule: the record goes, their rule stays
  writeFileSync(next.record, record);
  next.setNode({ serve: ours(8443, 'http://127.0.0.1:3000') });
  const third = rig(t, { root, attach: false });
  third.manager.attach(8787);
  await until(() => !existsSync(third.record), 'the stale record dropped');
  assert.deepEqual(third.node().serve, ours(8443, 'http://127.0.0.1:3000'));
});

test('shutdown takes the rule away before the process goes', async (t) => {
  const r = rig(t);
  await openTunnel(r);
  r.manager.shutdown();
  assert.deepEqual(r.node().serve, {});
  assert.deepEqual(r.hosts.list(), []);
  assert.ok(!existsSync(r.record));
});

test('a rule removed in a terminal closes the tunnel, and Tailscale going down does too', async (t) => {
  const removed = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(removed);
  removed.setNode({ serve: {} });
  await until(() => removed.manager.status().state === 'failed', 'failed');
  assert.equal(removed.manager.status().reason?.code, 'tunnel.ruleRemoved');
  assert.deepEqual(removed.hosts.list(), []);

  const down = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(down);
  down.setNode({ backendState: 'Stopped' });
  await until(() => down.manager.status().state === 'failed', 'failed');
  assert.equal(down.manager.status().reason?.code, 'tunnel.tailscaleNotConnected');
  assert.deepEqual(down.hosts.list(), []);
});

test('a node renamed while the tunnel is open moves the allowed host with it', async (t) => {
  const r = rig(t, { timing: { monitorMs: 30 } });
  await openTunnel(r);
  const renamed = 'renamed.tail0000.ts.net';
  const serve = r.node().serve as { TCP: unknown; Web: Record<string, unknown> };
  r.setNode({ dnsName: `${renamed}.`, certDomains: [renamed], serve: { TCP: serve.TCP, Web: { [`${renamed}:8443`]: serve.Web[`${NODE}:8443`] } } });
  await until(() => r.manager.status().url === `https://${renamed}:8443`, 'the new name');
  assert.deepEqual(r.hosts.list(), [renamed]);
  await r.manager.stop();
  assert.deepEqual(r.node().serve, {});
});

test('start with Agentry is off by default, is kept, and opens the tunnel on the next attach', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-tunnel-settings-'));
  const first = rig(t, { root });
  assert.equal(first.manager.status().settings.startWithAgentry, false);
  assert.equal(first.manager.status().state, 'stopped');
  await assert.rejects(first.manager.updateSettings({ startWithAgentry: 'yes' }), /must be a boolean/);
  await assert.rejects(first.manager.updateSettings({ provider: 'ngrok' }), /unknown tunnel settings/);
  const updated = await first.manager.updateSettings({ startWithAgentry: true });
  assert.equal(updated.settings.startWithAgentry, true);
  assert.equal(first.events.at(-1)?.settings.startWithAgentry, true);
  assert.equal(first.events.at(-1)?.tailscale.state, 'ready', 'the event carries a readiness that was read');
  first.manager.shutdown();

  const second = rig(t, { root });
  assert.equal(second.manager.status().settings.startWithAgentry, true);
  await until(() => second.manager.status().state === 'active', 'active');
  second.manager.shutdown();
  assert.deepEqual(second.node().serve, {});

  // Asked to start with Agentry on a wrapper without authentication: says why instead of opening
  const third = rig(t, { root, mode: 'none' });
  await until(() => third.manager.status().state === 'failed', 'failed');
  assert.equal(third.manager.status().reason?.code, 'tunnel.authRequired');
  assert.deepEqual(third.node().serve, {});
});

test('another port can be chosen, and the address carries it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-tunnel-port-'));
  writeFileSync(join(root, 'node.json'), JSON.stringify({ serve: {} }));
  process.env.FAKE_TAILSCALE_STATE = join(root, 'node.json');
  const hosts = new RuntimeHosts();
  const manager = new TunnelManager({ dataDir: join(root, 'data'), tailscaleBin: FAKE_TAILSCALE, port: 10443, security: { mode: 'token' }, hosts, timing: { monitorMs: 60_000 } });
  t.after(() => {
    manager.shutdown();
    delete process.env.FAKE_TAILSCALE_STATE;
  });
  manager.attach(8787);
  await manager.start();
  await until(() => manager.status().state === 'active', 'active');
  assert.equal(manager.status().url, `https://${NODE}:10443`);
  assert.equal(manager.status().port, 10443);
  await manager.stop();
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'node.json'), 'utf8')).serve, {});
});
