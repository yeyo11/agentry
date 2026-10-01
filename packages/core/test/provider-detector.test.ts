import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ProvidersSettings } from '@agentry/shared';
import type { AgentryEventInput } from '../src/events.ts';
import { loadConfig } from '../src/paths.ts';
import { ProviderDetector, satisfiesRange } from '../src/providers/detector.ts';
import { confirmClaudeInit } from '../src/providers/claude-code/handshake.ts';
import type { SessionInit } from '../src/providers/driver.ts';

let root: string;
let bin: string;
let home: string;
let n = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentry-detector-'));
});
after(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  n += 1;
  bin = join(root, `bin${n}`);
  home = join(root, `home${n}`);
  await mkdir(bin);
  await mkdir(home);
});

async function fake(name: string, body: string): Promise<string> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

function detector(options: { settings?: ProvidersSettings | null; events?: AgentryEventInput[]; probeTimeoutMs?: number } = {}) {
  const env = { PATH: bin, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
  return new ProviderDetector({
    config: loadConfig(env),
    env,
    home,
    platform: 'linux',
    resolvePath: async () => bin,
    settings: () => options.settings ?? null,
    emit: (event) => options.events?.push(event),
    probeTimeoutMs: options.probeTimeoutMs ?? 5_000,
    debounceMs: 50,
    minWatchGapMs: 0,
  });
}

const CLAUDE = (version: string, loggedIn: boolean) =>
  `case "$1" in --version) echo "${version} (Claude Code)";; auth) echo '{"loggedIn": ${String(loggedIn)}, "email": "me@example.com"}';; esac`;
const CODEX = (loginExit: number) =>
  `case "$1" in --version) echo "codex-cli 0.5.0";; login) exit ${String(loginExit)};; esac`;

async function statusOf(d: ProviderDetector, id: string) {
  const status = (await d.refresh()).find((s) => s.id === id);
  assert.ok(status, id);
  return status;
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('satisfiesRange', () => {
  it('reads space-separated comparators', () => {
    assert.equal(satisfiesRange('2.1.285', '>=2.1 <3'), 'in');
    assert.equal(satisfiesRange('2.0.9', '>=2.1 <3'), 'below');
    assert.equal(satisfiesRange('3.0.0', '>=2.1 <3'), 'above');
    assert.equal(satisfiesRange('9.9.9', ''), 'in');
  });
});

describe('ProviderDetector', () => {
  it('lists every provider as not installed on an empty machine', async () => {
    const all = await detector().refresh();
    assert.deepEqual(all.map((s) => s.id), ['claude-code', 'codex', 'gemini', 'copilot', 'opencode']);
    for (const s of all) assert.deepEqual([s.state, s.reason, s.binaryPath], ['not-installed', 'binary-not-found', null]);
  });

  it('says used-before when only the config home is there', async () => {
    await mkdir(join(home, '.codex'));
    const codex = await statusOf(detector(), 'codex');
    assert.deepEqual([codex.state, codex.reason, codex.configHome], ['used-before', 'config-home-only', join(home, '.codex')]);
  });

  it('resolves the Gemini config home from its parent variable', async () => {
    await mkdir(join(home, 'g', '.gemini'), { recursive: true });
    const env = { PATH: bin, HOME: home, GEMINI_CLI_HOME: join(home, 'g') };
    const d = new ProviderDetector({ config: loadConfig(env), env, home, resolvePath: async () => bin });
    const gemini = (await d.refresh()).find((s) => s.id === 'gemini');
    assert.equal(gemini?.configHome, join(home, 'g', '.gemini'));
  });

  it('is ready when installed, compatible and signed in, with the account', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const claude = await statusOf(detector(), 'claude-code');
    assert.deepEqual([claude.state, claude.reason, claude.version, claude.account], ['ready', null, '2.1.285', 'me@example.com']);
    assert.equal(claude.binaryPath, join(bin, 'claude'));
    assert.equal(claude.capabilities.length, 16);
  });

  it('is signed-out when the login probe says so', async () => {
    await fake('claude', CLAUDE('2.1.285', false));
    await fake('codex', CODEX(1));
    const all = await detector().refresh();
    assert.equal(all.find((s) => s.id === 'claude-code')?.state, 'signed-out');
    const codex = all.find((s) => s.id === 'codex');
    assert.deepEqual([codex?.state, codex?.reason, codex?.version], ['signed-out', 'missing-credentials', '0.5.0']);
  });

  it('reads an exit-code login probe as ready', async () => {
    await fake('codex', CODEX(0));
    assert.equal((await statusOf(detector(), 'codex')).state, 'ready');
  });

  it('is incompatible outside the tested range, on either side', async () => {
    await fake('claude', CLAUDE('1.9.0', true));
    const d = detector();
    const low = await statusOf(d, 'claude-code');
    assert.deepEqual([low.state, low.reason], ['incompatible', 'version-below-range']);
    assert.equal(d.knownSignedIn('claude-code'), true, 'the state hides it, /health still needs it');
    await fake('claude', CLAUDE('3.1.0', true));
    assert.equal((await statusOf(detector(), 'claude-code')).reason, 'version-above-range');
  });

  it('says unknown with no-probe when the vendor documents no login check', async () => {
    await fake('gemini', 'echo "0.9.1"');
    const gemini = await statusOf(detector(), 'gemini');
    assert.deepEqual([gemini.state, gemini.reason, gemini.version], ['unknown', 'no-probe', '0.9.1']);
  });

  it('reads OpenCode sign-in from the credentials file its login writes', async () => {
    await fake('opencode', 'echo "1.4.2"');
    const signedOut = await statusOf(detector(), 'opencode');
    assert.deepEqual([signedOut.state, signedOut.reason, signedOut.version], ['signed-out', 'missing-credentials', '1.4.2']);
    const data = join(home, '.local', 'share', 'opencode');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'auth.json'), '{}');
    assert.equal((await statusOf(detector(), 'opencode')).state, 'signed-out', 'an empty object holds no login');
    await writeFile(join(data, 'auth.json'), '{"anthropic": {"type": "api"}}');
    assert.equal((await statusOf(detector(), 'opencode')).state, 'ready');
    await writeFile(join(data, 'auth.json'), 'not json');
    assert.equal((await statusOf(detector(), 'opencode')).state, 'unknown', 'a file it cannot read is not a missing login');
  });

  it('says OpenCode was used before from its config home alone', async () => {
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    assert.equal((await statusOf(detector(), 'opencode')).state, 'used-before');
  });

  it('keeps a probe that hangs from holding the rest', async () => {
    await fake('gemini', 'exec /bin/sleep 30');
    await fake('codex', CODEX(0));
    const started = Date.now();
    const all = await detector({ probeTimeoutMs: 1_500 }).refresh();
    assert.ok(Date.now() - started < 5_000);
    const gemini = all.find((s) => s.id === 'gemini');
    assert.deepEqual([gemini?.state, gemini?.reason], ['unknown', 'probe-timeout']);
    assert.equal(all.find((s) => s.id === 'codex')?.state, 'ready');
  });

  it('says unreadable for a version it cannot parse, and spawn-failed for a crash', async () => {
    await fake('gemini', 'echo "no numbers here"');
    await fake('codex', 'exit 3');
    const all = await detector().refresh();
    assert.equal(all.find((s) => s.id === 'gemini')?.reason, 'version-unreadable');
    assert.equal(all.find((s) => s.id === 'codex')?.reason, 'spawn-failed');
  });

  it('uses the binary the person points at before the PATH', async () => {
    await fake('codex', 'echo "codex-cli 0.1.0"');
    const elsewhere = join(root, `elsewhere${n}`);
    await writeFile(elsewhere, '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.9.0";; login) exit 0;; esac\n');
    await chmod(elsewhere, 0o755);
    const settings: ProvidersSettings = { providers: { codex: { enabled: true, binaryPath: elsewhere } }, order: [], defaultProvider: null };
    const codex = await statusOf(detector({ settings }), 'codex');
    assert.deepEqual([codex.binaryPath, codex.version], [elsewhere, '0.9.0']);
    const missing: ProvidersSettings = { providers: { codex: { enabled: true, binaryPath: join(root, 'nope') } }, order: [], defaultProvider: null };
    assert.equal((await statusOf(detector({ settings: missing }), 'codex')).reason, 'binary-not-found');
  });

  it('does not probe a disabled provider, and follows the order in settings', async () => {
    await fake('codex', 'echo probed >> "$0.log"; echo "codex-cli 0.5.0"');
    const settings: ProvidersSettings = {
      providers: { codex: { enabled: false, binaryPath: null } },
      order: ['copilot', 'codex'],
      defaultProvider: null,
    };
    const all = await detector({ settings }).refresh();
    assert.deepEqual(all.map((s) => s.id), ['copilot', 'codex', 'claude-code', 'gemini', 'opencode']);
    assert.deepEqual([all[1]?.state, all[1]?.reason], ['unknown', 'disabled']);
    assert.equal(existsSync(join(bin, 'codex.log')), false);
  });

  it('emits providers.changed only when a status changes', async () => {
    const events: AgentryEventInput[] = [];
    const d = detector({ events });
    await d.refresh();
    assert.equal(events.length, 0, 'the first reading is not a change');
    await d.refresh();
    assert.equal(events.length, 0, 'the same statuses again are not a change');
    await fake('claude', CLAUDE('2.1.285', true));
    await d.refresh();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'providers.changed');
    await d.settingsChanged();
    assert.equal(events.length, 1);
  });

  it('serves the cache inside the TTL and reads once for concurrent refreshes', async () => {
    const counter = join(root, `count${n}`);
    await fake('codex', `echo x >> "${counter}"; case "$1" in --version) echo "codex-cli 0.5.0";; login) exit 0;; esac`);
    const d = detector();
    await Promise.all([d.refresh(), d.refresh()]);
    const lines = () => readFileSync(counter, 'utf8').trim().split('\n').length;
    assert.equal(lines(), 2, 'one version and one login probe');
    await d.statuses();
    assert.equal(lines(), 2);
  });

  it('answers a refresh asked while another runs with a detection that starts after it', async () => {
    const state = join(root, `state${n}`);
    const release = join(root, `release${n}`);
    // Each login probe reads the state as it starts, then the first one waits for the test to let it
    // go, so the first detection is still running when the state changes
    await fake('codex', `case "$1" in --version) echo "codex-cli 0.5.0";; login) s=$(/bin/cat "${state}"); while [ ! -e "${release}" ]; do /bin/sleep 0.05; done; exit "$s";; esac`);
    await writeFile(state, '1');
    const d = detector();
    const first = d.refresh();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = d.refresh();
    const third = d.refresh();
    assert.equal(second, third, 'everyone asking meanwhile shares one follow-up');
    await writeFile(state, '0');
    await writeFile(release, '');
    assert.equal((await first).find((s) => s.id === 'codex')?.state, 'signed-out');
    assert.equal((await second).find((s) => s.id === 'codex')?.state, 'ready', 'the follow-up read the change');
  });

  it('re-detects on its own when a binary lands on the PATH', async () => {
    const events: AgentryEventInput[] = [];
    const d = detector({ events });
    await d.refresh();
    await d.startWatching();
    try {
      await fake('codex', CODEX(0));
      await until(() => events.length > 0);
      assert.equal(events.length, 1);
      assert.equal(d.knownOne('codex')?.state, 'ready');
    } finally {
      d.close();
    }
  });

  it('re-detects when a config home appears', async () => {
    const events: AgentryEventInput[] = [];
    const d = detector({ events });
    await d.refresh();
    await d.startWatching();
    try {
      await mkdir(join(home, '.codex'));
      await until(() => events.length > 0);
      assert.equal(d.knownOne('codex')?.state, 'used-before');
    } finally {
      d.close();
    }
  });

  it('lands a full detection that ends after a newer reading of Claude Code alone', async () => {
    const release = join(root, `release${n}`);
    await fake('claude', CLAUDE('2.1.285', false));
    await fake('codex', `case "$1" in --version) echo "codex-cli 0.5.0";; login) while [ ! -e "${release}" ]; do /bin/sleep 0.05; done; exit 0;; esac`);
    const d = detector();
    const full = d.refresh();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await d.refresh({
      only: ['claude-code'],
      claude: { cli: { installed: true, version: '2.1.285', path: join(bin, 'claude') }, auth: { loggedIn: true, tokenSource: 'none' } },
    });
    await writeFile(release, '');
    await full;
    assert.equal(d.knownOne('codex')?.state, 'ready', 'the older full detection still lands for the providers the newer one did not read');
    assert.equal(d.knownOne('claude-code')?.state, 'ready', 'and the newer reading of Claude Code stays');
  });

  it('takes Claude Code from a reading already made, without spawning it again', async () => {
    await fake('claude', 'echo spawned >> "$0.log"; exit 9');
    const d = detector();
    await d.refresh({
      only: ['claude-code'],
      claude: { cli: { installed: true, version: '2.1.285', path: join(bin, 'claude') }, auth: { loggedIn: true, tokenSource: 'none' } },
    });
    assert.equal(d.knownOne('claude-code')?.state, 'ready');
    assert.equal(d.known()?.length, 1);
    assert.equal(existsSync(join(bin, 'claude.log')), false);
  });
});

describe('capabilities confirmed by a session', () => {
  const init = (over: Partial<SessionInit> = {}): SessionInit => ({
    version: '2.1.285',
    tools: ['Read', 'Task', 'Workflow'],
    mcpServers: [{ name: 'pando', status: 'connected' }],
    structuredOutput: false,
    ...over,
  });

  it('confirms what the init shows and leaves the rest declared', () => {
    const c = confirmClaudeInit(init());
    assert.deepEqual(c.confirmed, ['subagents', 'workflowTool', 'mcp']);
    assert.deepEqual(c.missing, []);
    assert.deepEqual(confirmClaudeInit(init({ structuredOutput: true })).confirmed.slice(-1), ['structuredOutput']);
  });

  it('reads Agent as the subagent tool, and contradicts only from a tool list it could read', () => {
    assert.ok(confirmClaudeInit(init({ tools: ['Agent'] })).confirmed.includes('subagents'));
    assert.deepEqual(confirmClaudeInit(init({ tools: ['Read'] })).missing, ['subagents', 'workflowTool']);
    assert.deepEqual(confirmClaudeInit(init({ tools: [] })).missing, []);
  });

  it('confirms nothing for a version outside the range', () => {
    assert.deepEqual(confirmClaudeInit(init({ version: '1.0.0' })), { version: '1.0.0', confirmed: [], missing: [] });
  });

  it('records it on the status and emits providers.changed only when that changes', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const events: AgentryEventInput[] = [];
    const d = detector({ events });
    assert.equal((await statusOf(d, 'claude-code')).confirmed, null);

    d.confirm('claude-code', confirmClaudeInit(init()));
    const confirmed = d.knownOne('claude-code');
    assert.equal(confirmed?.state, 'ready');
    assert.deepEqual(confirmed?.confirmed?.capabilities, ['subagents', 'workflowTool', 'mcp']);
    assert.equal(confirmed?.confirmed?.version, '2.1.285');
    assert.equal(events.filter((e) => e.type === 'providers.changed').length, 1);

    d.confirm('claude-code', confirmClaudeInit(init()));
    assert.equal(events.filter((e) => e.type === 'providers.changed').length, 1, 'the same answer is not a change');
  });

  it('degrades a provider whose declared capability the init contradicts, and survives a re-detection', async () => {
    await fake('claude', CLAUDE('2.1.285', true));
    const d = detector();
    await statusOf(d, 'claude-code');
    d.confirm('claude-code', confirmClaudeInit(init({ tools: ['Read'] })));
    const degraded = d.knownOne('claude-code');
    assert.deepEqual([degraded?.state, degraded?.reason], ['degraded', 'capability-missing']);
    assert.ok(!degraded?.capabilities.includes('subagents'));
    assert.ok(!d.capabilities('claude-code').includes('workflowTool'));

    const again = await statusOf(d, 'claude-code');
    assert.deepEqual([again.state, again.reason], ['degraded', 'capability-missing']);
  });

  it('drops the confirmation when the installed version is no longer the one confirmed', async () => {
    await fake('claude', CLAUDE('2.1.300', true));
    const d = detector();
    d.confirm('claude-code', confirmClaudeInit(init({ version: '2.1.285', tools: ['Read'] })));
    const status = await statusOf(d, 'claude-code');
    assert.deepEqual([status.state, status.confirmed], ['ready', null]);
  });

  it('answers with the declared set before any session', () => {
    assert.equal(detector().capabilities('claude-code').length, 16);
  });
});
