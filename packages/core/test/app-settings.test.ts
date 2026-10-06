import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent } from '@agentry/shared';
import { AppSettingsStore, RuntimeHosts } from '../src/app-settings.ts';
import { Core } from '../src/index.ts';
import { loadConfig, type CoreConfig } from '../src/paths.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

/** A wrapper's config in a scratch directory, with whatever the environment says on top. */
function config(env: NodeJS.ProcessEnv = {}, root = mkdtempSync(join(tmpdir(), 'agentry-app-settings-'))): CoreConfig {
  return loadConfig({
    CLAUDE_BIN: '/nonexistent/claude',
    CSWAP_BIN: '/nonexistent/cswap',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
    AGENTRY_DATA_DIR: join(root, 'data'),
    ...env,
  });
}

const fileOf = (c: CoreConfig) => join(c.dataDir, 'app-settings.json');

test('an install that sets nothing runs on the defaults it always had, and writes no file for them', () => {
  const c = config();
  const store = new AppSettingsStore(c);

  assert.deepEqual(store.get(), {
    allowedHosts: [],
    maxConcurrentRuns: 8,
    defaultPermissionMode: 'acceptEdits',
    providersStepSeen: false,
    sources: { allowedHosts: 'default', maxConcurrentRuns: 'default', defaultPermissionMode: 'default', providersStepSeen: 'default' },
    allowedHostLayers: { env: [], file: [], runtime: [] },
  });
  // The environment's view is what it was before the settings had layers
  assert.deepEqual([c.allowedHosts, c.maxConcurrentRuns, c.defaultPermissionMode], [[], 8, 'acceptEdits']);
  assert.equal(c.settingsFromEnv.size, 0);
  assert.equal(existsSync(fileOf(c)), false);
});

test('an empty variable is not a setting, so a compose file passing VAR= through does not lock the UI', () => {
  const c = config({ AGENTRY_ALLOWED_HOSTS: '', AGENTRY_MAX_CONCURRENT_RUNS: ' ', AGENTRY_DEFAULT_PERMISSION_MODE: '' });
  assert.equal(c.settingsFromEnv.size, 0);
  assert.deepEqual(new AppSettingsStore(c).get().sources, { allowedHosts: 'default', maxConcurrentRuns: 'default', defaultPermissionMode: 'default', providersStepSeen: 'default' });
  // An empty count used to become `Number('') === 0`, a wrapper that could start no run at all
  assert.equal(c.maxConcurrentRuns, 8);
  assert.equal(c.defaultPermissionMode, 'acceptEdits');
});

test('a value in the environment beats the file, and the file cannot be written for it', async () => {
  const c = config({ AGENTRY_MAX_CONCURRENT_RUNS: '3' });
  writeFileSync(fileOf(c), JSON.stringify({ maxConcurrentRuns: 20, defaultPermissionMode: 'plan' }));
  const store = new AppSettingsStore(c);

  assert.deepEqual(store.get(), {
    allowedHosts: [],
    maxConcurrentRuns: 3,
    defaultPermissionMode: 'plan',
    providersStepSeen: false,
    sources: { allowedHosts: 'default', maxConcurrentRuns: 'env', defaultPermissionMode: 'file', providersStepSeen: 'default' },
    allowedHostLayers: { env: [], file: [], runtime: [] },
  });

  const before = readFileSync(fileOf(c), 'utf8');
  await assert.rejects(store.update({ maxConcurrentRuns: 4 }), /set by the environment \(AGENTRY_MAX_CONCURRENT_RUNS\)/);
  // Refused whole: the key the environment does not hold is not written either
  await assert.rejects(store.update({ defaultPermissionMode: 'auto', maxConcurrentRuns: 4 }), /AGENTRY_MAX_CONCURRENT_RUNS/);
  assert.equal(readFileSync(fileOf(c), 'utf8'), before);
  assert.equal(store.defaultPermissionMode, 'plan');

  assert.equal((await store.update({ defaultPermissionMode: 'auto' })).defaultPermissionMode, 'auto');
});

test("hosts added in the UI add to the environment's, which stay fixed", async () => {
  const c = config({ AGENTRY_ALLOWED_HOSTS: '*.devtunnels.ms,192.168.1.184' });
  // A file from before the variable was set still counts, minus what the variable names already
  writeFileSync(fileOf(c), JSON.stringify({ allowedHosts: ['file.example.com', '192.168.1.184'] }));
  const store = new AppSettingsStore(c);
  const guardList = store.allowedHosts;

  assert.deepEqual(store.get().allowedHosts, ['*.devtunnels.ms', '192.168.1.184', 'file.example.com']);
  assert.deepEqual(store.get().allowedHostLayers, { env: ['*.devtunnels.ms', '192.168.1.184'], file: ['file.example.com'], runtime: [] });
  assert.equal(store.get().sources.allowedHosts, 'env');

  // Sending back the whole list read stores only the UI's part; an environment host cannot be dropped
  const changed = await store.update({ allowedHosts: ['192.168.1.184', 'agentry.example.com'] });
  assert.deepEqual(changed.allowedHosts, ['*.devtunnels.ms', '192.168.1.184', 'agentry.example.com']);
  assert.deepEqual(changed.allowedHostLayers.file, ['agentry.example.com']);
  assert.deepEqual(JSON.parse(readFileSync(fileOf(c), 'utf8')), { allowedHosts: ['agentry.example.com'] });
  // A new array, so the guard knows to rebuild its allowlist
  assert.notEqual(store.allowedHosts, guardList);

  assert.deepEqual((await store.update({ allowedHosts: [] })).allowedHosts, ['*.devtunnels.ms', '192.168.1.184']);
  await assert.rejects(store.update({ allowedHosts: ['*.com'] }), /allowedHosts/);
});

test("the tunnel's host is listed apart, and coming or going is announced", async () => {
  const events: AgentryEvent[] = [];
  const store = new AppSettingsStore(config(), { emit: (event) => events.push({ ...event, id: events.length + 1, at: '' } as AgentryEvent) });
  const guardList = store.allowedHosts;

  store.runtimeHosts.add('abc123.lhr.life');
  store.runtimeHosts.add('abc123.lhr.life');
  const settings = store.get();
  assert.deepEqual([settings.allowedHosts, settings.allowedHostLayers.runtime], [[], ['abc123.lhr.life']]);
  assert.equal(store.allowedHosts, guardList, 'the configured list is not rebuilt for a runtime host');
  assert.equal(events.length, 1, 'adding a host already there is not news');
  assert.deepEqual(events[0]?.type === 'settings.changed' && events[0].settings.allowedHostLayers.runtime, ['abc123.lhr.life']);

  store.runtimeHosts.remove('abc123.lhr.life');
  store.runtimeHosts.remove('abc123.lhr.life');
  assert.equal(events.length, 2);
  assert.deepEqual(store.get().allowedHostLayers.runtime, []);
});

test('a change is written to the file, survives a restart, and goes out on the event feed', async () => {
  const c = config();
  const events: AgentryEvent[] = [];
  const store = new AppSettingsStore(c, { emit: (event) => events.push({ ...event, id: events.length + 1, at: '' } as AgentryEvent) });

  const changed = await store.update({ maxConcurrentRuns: 2, allowedHosts: [' Agentry.Example.com ', '*.preview.example.com', 'agentry.example.com'] });
  assert.deepEqual(changed.allowedHosts, ['agentry.example.com', '*.preview.example.com'], 'trimmed, lowercased and without repeats');
  assert.deepEqual(changed.sources, { allowedHosts: 'file', maxConcurrentRuns: 'file', defaultPermissionMode: 'default', providersStepSeen: 'default' });
  // Only what was set is stored: a default the person never chose keeps following the default
  assert.deepEqual(JSON.parse(readFileSync(fileOf(c), 'utf8')), { maxConcurrentRuns: 2, allowedHosts: ['agentry.example.com', '*.preview.example.com'] });

  const [event] = events;
  assert.equal(event?.type, 'settings.changed');
  assert.deepEqual(event?.type === 'settings.changed' && event.settings, changed);

  assert.deepEqual(new AppSettingsStore(c).get(), changed);
});

test('what the environment refuses is refused from the file too, whichever way it gets there', async () => {
  const c = config();
  const store = new AppSettingsStore(c);
  for (const host of ['*.com', '*', 'a.*.example.com', 'ex*mple.com', 'agentry.example.com:8787', 'has space.example.com', 'http://x.example.com', '']) {
    await assert.rejects(store.update({ allowedHosts: [host] }), /allowedHosts/, JSON.stringify(host));
  }
  for (const value of [0, 1.5, 65, '4', null]) {
    await assert.rejects(store.update({ maxConcurrentRuns: value }), /maxConcurrentRuns/, String(value));
  }
  await assert.rejects(store.update({ defaultPermissionMode: 'yolo' }), /defaultPermissionMode must be one of/);
  await assert.rejects(store.update({ allowedHost: ['typo.example.com'] }), /unknown app settings: allowedHost/);
  await assert.rejects(store.update([]), /JSON object/);
  assert.equal(existsSync(fileOf(c)), false, 'nothing refused reached the disk');
  // An IPv6 literal is an address, not a name with a port
  assert.deepEqual((await store.update({ allowedHosts: ['[fd00::1]'] })).allowedHosts, ['fd00::1']);

  // A hand-edited file cannot widen the allowlist past what a PUT could: the bad key falls back
  writeFileSync(fileOf(c), JSON.stringify({ allowedHosts: ['*.com'], maxConcurrentRuns: 5 }));
  const reread = new AppSettingsStore(c).get();
  assert.deepEqual([reread.allowedHosts, reread.sources.allowedHosts, reread.maxConcurrentRuns], [[], 'default', 5]);
  assert.deepEqual(reread.allowedHostLayers.file, []);
});

test('a settings file that does not parse starts on the defaults, and is not overwritten', async () => {
  const c = config();
  writeFileSync(fileOf(c), '{ "maxConcurrentRuns": 2,');
  const store = new AppSettingsStore(c);
  assert.equal(store.maxConcurrentRuns, 8);
  await assert.rejects(store.update({ maxConcurrentRuns: 3 }), /not valid JSON; fix or remove it/);
  assert.equal(readFileSync(fileOf(c), 'utf8'), '{ "maxConcurrentRuns": 2,');
});

test('two changes in flight both land, in the order they were made', async () => {
  const c = config();
  const store = new AppSettingsStore(c);
  await Promise.all([store.update({ maxConcurrentRuns: 2 }), store.update({ defaultPermissionMode: 'plan' }), store.update({ maxConcurrentRuns: 5 })]);
  assert.deepEqual(JSON.parse(readFileSync(fileOf(c), 'utf8')), { maxConcurrentRuns: 5, defaultPermissionMode: 'plan' });
  assert.deepEqual([store.maxConcurrentRuns, store.defaultPermissionMode], [5, 'plan']);
});

test('a runtime host is an exact name, answered until its owner removes it', () => {
  const hosts = new RuntimeHosts();
  hosts.add('Abc123.LHR.life', { clientIpHeader: 'X-Forwarded-For' });
  assert.deepEqual(hosts.get('abc123.lhr.life'), { clientIpHeader: 'x-forwarded-for' });
  assert.deepEqual(hosts.list(), ['abc123.lhr.life']);

  // A pattern here would let in everybody else's tunnels on the same provider
  for (const host of ['*.lhr.life', 'lhr', '', 'a b.lhr.life', 'abc.lhr.life:443', '-x.lhr.life']) {
    assert.throws(() => hosts.add(host), /exact name/, host);
  }
  assert.throws(() => hosts.add('b.lhr.life', { clientIpHeader: 'x forwarded' }), /not a header name/);

  hosts.remove('ABC123.lhr.life');
  assert.equal(hosts.get('abc123.lhr.life'), undefined);
  assert.deepEqual(hosts.list(), []);
});

test('two wrappers in one process keep settings of their own', async () => {
  const a = new AppSettingsStore(config());
  const b = new AppSettingsStore(config());
  await a.update({ maxConcurrentRuns: 1 });
  a.runtimeHosts.add('a.lhr.life');
  assert.equal(b.maxConcurrentRuns, 8);
  assert.equal(b.runtimeHosts.get('a.lhr.life'), undefined);
});

test('the run limit and the default mode apply to the next run, without a restart', async (t) => {
  const core = new Core({ ...config(), claudeBin: FAKE_CLAUDE });
  t.after(() => core.shutdown());
  const seen: AgentryEvent[] = [];
  core.events.subscribe((event) => seen.push(event));

  await core.appSettings.update({ maxConcurrentRuns: 1, defaultPermissionMode: 'plan' });
  assert.ok(seen.some((event) => event.type === 'settings.changed'));
  assert.equal((await core.system()).defaultPermissionMode, 'plan');

  const first = core.runtime.start({ prompt: 'hello' });
  assert.equal(first.permissionMode, 'plan');
  assert.throws(() => core.runtime.start({ prompt: 'again' }), /Concurrent run limit reached \(1\)/);

  await core.appSettings.update({ maxConcurrentRuns: 2, defaultPermissionMode: 'acceptEdits' });
  const second = core.runtime.start({ prompt: 'again' });
  assert.equal(second.permissionMode, 'acceptEdits');
  // A chat that chose its mode keeps it, whatever the default says
  await core.appSettings.update({ maxConcurrentRuns: 3 });
  assert.equal(core.runtime.start({ prompt: 'chosen', permissionMode: 'auto' }).permissionMode, 'auto');
});

test('a new orchestration takes the default mode and the run limit as they stand now', async (t) => {
  const core = new Core(config());
  t.after(() => core.shutdown());
  await core.appSettings.update({ maxConcurrentRuns: 2, defaultPermissionMode: 'dontAsk' });
  // Not a repository and no worktrees: nothing but the settings decides what the graph is given
  const graph = core.orchestrator.create({ name: 'graph', cwd: mkdtempSync(join(tmpdir(), 'agentry-graph-')), worktree: false, concurrency: 5, tasks: [{ id: 'a', name: 'A', prompt: 'p' }] });
  assert.equal(graph.permissionMode, 'dontAsk');
  assert.equal(graph.concurrency, 2);
  core.orchestrator.stop(graph.id);
});

test('the first-run step is remembered in the file, refused for a non-boolean, and owned by the environment when it sets it', async () => {
  const c = config();
  const store = new AppSettingsStore(c);
  assert.equal(store.get().providersStepSeen, false);
  await assert.rejects(store.update({ providersStepSeen: 'yes' }), /providersStepSeen must be true or false/);
  const saved = await store.update({ providersStepSeen: true });
  assert.deepEqual([saved.providersStepSeen, saved.sources.providersStepSeen], [true, 'file']);
  assert.equal(new AppSettingsStore(c).get().providersStepSeen, true);

  const owned = config({ AGENTRY_PROVIDERS_STEP_SEEN: 'on' });
  const ownedStore = new AppSettingsStore(owned);
  assert.deepEqual([ownedStore.get().providersStepSeen, ownedStore.get().sources.providersStepSeen], [true, 'env']);
  await assert.rejects(ownedStore.update({ providersStepSeen: true }), /AGENTRY_PROVIDERS_STEP_SEEN/);
});
