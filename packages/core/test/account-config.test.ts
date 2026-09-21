import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { AccountSummary } from '@agentry/shared';
import { AccountConfigs, pickAccount } from '../src/account-config.ts';
import { AccountManager } from '../src/accounts.ts';
import { Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

function account(number: number, pct: number | null, extra: Partial<AccountSummary> = {}): AccountSummary {
  return {
    number,
    email: `a${String(number)}@example.com`,
    organizationName: null,
    alias: null,
    active: false,
    disabled: false,
    usageStatus: 'ok',
    usage: pct === null ? null : { fiveHour: { pct, resetsAt: null, countdown: null }, sevenDay: null, scoped: [] },
    usageFetchedAt: null,
    headroomPct: pct === null ? null : 100 - pct,
    ...extra,
  };
}

const policy = { id: 'p', threshold: 90, projects: ['proj'] };

// ---------- which account a policy picks ----------

test('a chat stays on its account until the threshold, and only then does the order decide', () => {
  const accounts = [account(1, 10), account(2, 50), account(3, 20)];
  const order = { ...policy, order: [3, 2, 1] };
  // Under the threshold: staying put beats going back to the head of the order
  assert.equal(pickAccount(order, accounts, { current: 2 })?.number, 2);
  // Past it: the first account in the order that has room
  assert.equal(pickAccount(order, [account(1, 10), account(2, 95), account(3, 20)], { current: 2 })?.number, 3);
  // No account in use yet: the order starts at its head
  assert.equal(pickAccount(order, accounts, { current: null })?.number, 3);
});

test('a policy only ever offers the accounts it lists, never a disabled or exhausted one', () => {
  const accounts = [account(1, 10, { disabled: true }), account(2, 10), account(3, 10)];
  assert.equal(pickAccount({ ...policy, order: [1, 3] }, accounts, { current: null })?.number, 3, 'account 2 is not in the order, 1 is disabled');
  assert.equal(pickAccount({ ...policy, order: [2, 3] }, accounts, { current: 2, exhausted: new Set([2]) })?.number, 3);
  assert.equal(pickAccount({ ...policy, order: [2] }, accounts, { current: 2, exhausted: new Set([2]) }), null, 'nothing left is an answer, not a guess');
  assert.equal(pickAccount({ ...policy, order: [3] }, accounts, { current: 1 })?.number, 3, 'the account in use is not on the list');
});

test('an account whose usage is unknown is trusted only when claude-swap calls it healthy', () => {
  assert.equal(pickAccount(policy, [account(1, null, { usageStatus: 'token_expired' }), account(2, null)], { current: null })?.number, 2);
});

// ---------- the config directory ----------

function shared(): { config: ReturnType<typeof tempConfig>; dir: string } {
  const config = tempConfig();
  mkdirSync(config.projectsDir, { recursive: true });
  writeFileSync(join(config.configDir, 'settings.json'), '{"theme":"dark"}');
  writeFileSync(join(config.configDir, 'CLAUDE.md'), '# mine');
  return { config, dir: join(mkdtempSync(join(tmpdir(), 'agentry-acct-')), 'account-1') };
}

test('giving an account a config dir creates it empty and links only the history, and clearing it undoes exactly that', async () => {
  const { config, dir } = shared();
  const store = new AccountConfigs(config);

  const set = await store.setConfigDir(1, { configDir: dir });
  assert.deepEqual(set, { number: 1, configDir: dir, links: ['projects'] });
  assert.equal(readlinkSync(join(dir, 'projects')), config.projectsDir, 'transcripts still land where the session store reads them');
  assert.equal(existsSync(join(dir, 'settings.json')), false, 'settings are only borrowed when asked');
  assert.equal(store.configDirOf(1), dir);

  // A file the account made itself in there is not Agentry's to remove
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  assert.equal(await store.setConfigDir(1, { configDir: null }), null);
  assert.equal(store.configDirOf(1), null);
  assert.equal(existsSync(join(dir, 'projects')), false, 'the link it made is gone');
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(readFileSync(join(config.configDir, 'settings.json'), 'utf8'), '{"theme":"dark"}', 'the shared dir was never touched');
  assert.equal(existsSync(config.projectsDir), true);
});

test('shared settings are borrowed as symlinks, never over what the account already has', async () => {
  const { config, dir } = shared();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# the account\'s own');
  const store = new AccountConfigs(config);

  const set = await store.setConfigDir(1, { configDir: dir, shareSettings: true });
  assert.deepEqual(set?.links.sort(), ['projects', 'settings.json']);
  assert.equal(lstatSync(join(dir, 'settings.json')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), "# the account's own");

  await store.setConfigDir(1, { configDir: null });
  assert.equal(existsSync(join(dir, 'settings.json')), false);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), "# the account's own");
});

test('a link the account replaced by something of its own survives being cleared', async () => {
  const { config, dir } = shared();
  const store = new AccountConfigs(config);
  await store.setConfigDir(1, { configDir: dir });
  const elsewhere = join(dirname(dir), 'elsewhere');
  mkdirSync(elsewhere);
  // Re-pointed by hand: it is no longer the link Agentry made
  const link = join(dir, 'projects');
  unlinkSync(link);
  symlinkSync(elsewhere, link);
  await store.setConfigDir(1, { configDir: null });
  assert.equal(readlinkSync(link), elsewhere);
});

test('a config dir is refused when it is relative, is a file, or already belongs to another account', async () => {
  const { config, dir } = shared();
  const store = new AccountConfigs(config);
  await assert.rejects(store.setConfigDir(1, { configDir: 'relative/dir' }), /absolute/);
  writeFileSync(join(config.dataDir, 'a-file'), '');
  await assert.rejects(store.setConfigDir(1, { configDir: join(config.dataDir, 'a-file') }), /not a directory/);
  await store.setConfigDir(1, { configDir: dir });
  await assert.rejects(store.setConfigDir(2, { configDir: dir }), /already account 1/);
  // The wrapper's own directory is what null already means
  assert.equal(await store.setConfigDir(2, { configDir: config.configDir }), null);
});

test('config dirs and policies survive a restart', async () => {
  const { config, dir } = shared();
  const store = new AccountConfigs(config);
  await store.setConfigDir(1, { configDir: dir });
  const created = await store.createPolicy({ threshold: 80, order: [2, 1], projects: ['proj'] });

  const reloaded = new AccountConfigs(config);
  assert.equal(reloaded.configDirOf(1), dir);
  assert.deepEqual(reloaded.policyFor('proj'), created);
  assert.equal(reloaded.policyFor('other'), null, 'a project with no policy keeps the global auto-switch');
});

// ---------- policies ----------

test('a project is governed by at most one policy, and bad ones are refused', async () => {
  const store = new AccountConfigs(tempConfig());
  const first = await store.createPolicy({ threshold: 85, projects: ['a', 'b'] });
  await assert.rejects(store.createPolicy({ threshold: 85, projects: ['b', 'c'] }), /already governed/);
  await assert.rejects(store.createPolicy({ threshold: 10, projects: ['c'] }), /threshold must be/);
  await assert.rejects(store.createPolicy({ threshold: 85, projects: [] }), /at least one project/);
  await assert.rejects(store.createPolicy({ threshold: 85, projects: ['c'], order: [0] }), /order must/);

  // Editing a policy does not collide with itself
  const updated = await store.updatePolicy(first.id, { threshold: 70, projects: ['a', 'b', 'c'], order: [2, 1, 2] });
  assert.deepEqual(updated, { id: first.id, threshold: 70, projects: ['a', 'b', 'c'], order: [2, 1] });
  await store.deletePolicy(first.id);
  assert.deepEqual(store.policies(), []);
  await assert.rejects(store.deletePolicy(first.id), /not found/);
});

// ---------- launching through claude-swap ----------

/** Readings are fetched a little before now, as they are in life: an old one would look stale to the sampler. */
const FETCHED = Date.now() - 120_000;
const ACCOUNTS = (usage: Record<number, number>, fetchedAt = FETCHED) => ({
  schemaVersion: 1,
  accounts: [1, 2, 3].map((number) => ({
    number,
    email: `a${String(number)}@example.com`,
    active: number === 2,
    usageStatus: 'ok',
    usage: { fiveHour: { pct: usage[number] ?? 0, resetsAt: null, countdown: null }, sevenDay: null },
    usageFetchedAt: new Date(fetchedAt).toISOString(),
  })),
});

/** A `cswap` that lists whatever `list.json` holds and records how it was asked to run a chat. */
function fakeCswap(usage: Record<number, number>) {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-cswap-'));
  const listFile = join(dir, 'list.json');
  const log = join(dir, 'launches.log');
  writeFileSync(listFile, JSON.stringify(ACCOUNTS(usage)));
  const bin = join(dir, 'cswap');
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  --version) echo "cswap 0.26.0" ;;
  list) cat "${listFile}" ;;
  run) echo "cswap $*" >> "${log}" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  const claude = join(dir, 'claude');
  writeFileSync(
    claude,
    `#!/bin/sh
echo "claude CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" >> "${log}"
`,
  );
  chmodSync(claude, 0o755);
  return {
    bin,
    claude,
    setUsage: (next: Record<number, number>, fetchedAt = FETCHED) => writeFileSync(listFile, JSON.stringify(ACCOUNTS(next, fetchedAt))),
    launches: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function managed(usage: Record<number, number>) {
  const cswap = fakeCswap(usage);
  const config = { ...tempConfig(), cswapBin: cswap.bin, claudeBin: cswap.claude };
  const manager = new AccountManager(config, new Db(config));
  await manager.list(true);
  return { cswap, config, manager };
}

test('by default no account has a config dir, and a chat is launched exactly as before', async () => {
  const { manager } = await managed({});
  assert.deepEqual(manager.launchFor({ account: null, cwd: '/w/a' }), { account: null, configDir: null });
  assert.deepEqual(manager.launchFor({ account: '3', cwd: '/w/a' }), { account: '3', configDir: null });
  assert.deepEqual((await manager.overview()).configs, []);
  assert.deepEqual((await manager.overview()).policies, []);
});

test('an account with a config dir hands it to the chats started for it, pinned or on the active credential', async () => {
  const { manager, config } = await managed({});
  const dir3 = join(config.dataDir, 'acct-3');
  const dir2 = join(config.dataDir, 'acct-2');
  await manager.setConfig(3, { configDir: dir3 });
  await manager.setConfig('a2@example.com', { configDir: dir2 });
  assert.deepEqual(manager.launchFor({ account: '3', cwd: '/w/a' }), { account: '3', configDir: dir3 });
  // Account 2 is the active one: a chat pinned to nothing runs on it
  assert.deepEqual(manager.launchFor({ account: null, cwd: '/w/a' }), { account: null, configDir: dir2 });
  await assert.rejects(manager.setConfig(9, { configDir: dir3 }), /account not found/);
});

test('a project under a policy runs on the account the policy picks, and a chat pinned by hand is left alone', async () => {
  const { manager, cswap } = await managed({ 1: 20, 2: 95, 3: 10 });
  manager.projectOf = (cwd) => (cwd.startsWith('/w/governed') ? 'proj' : null);
  await manager.configs.createPolicy({ threshold: 90, order: [3, 1], projects: ['proj'] });

  // Account 2 (the active one) is not on the policy's list, so the order picks 3
  assert.deepEqual(manager.launchFor({ account: null, cwd: '/w/governed/x' }), { account: '3', configDir: null });
  // A project without a policy keeps the global behaviour: the active credential
  assert.deepEqual(manager.launchFor({ account: null, cwd: '/w/other' }), { account: null, configDir: null });
  assert.deepEqual(manager.launchFor({ account: '2', cwd: '/w/governed/x' }), { account: '2', configDir: null });

  // The account climbs past the threshold: the next in the order takes over
  cswap.setUsage({ 1: 20, 2: 95, 3: 92 });
  await manager.list(true);
  assert.equal(manager.launchFor({ account: null, cwd: '/w/governed/x' }).account, '1');
});

test('a rate-limited chat under a policy moves within it and leaves the shared credential where it is', async () => {
  const { manager, cswap } = await managed({ 1: 10, 2: 10, 3: 10 });
  manager.projectOf = () => 'proj';
  await manager.configs.createPolicy({ threshold: 90, order: [3, 1], projects: ['proj'] });
  const chat = { account: null, cwd: '/w/governed' };
  assert.equal(manager.launchFor(chat).account, '3');

  // The usage read is still low: only the limit the chat hit says the account is out
  const moved = await manager.rotateWithinPolicy(chat, 'chat hit its rate limit');
  assert.deepEqual(moved, { switched: true, from: 'a3@example.com', to: 'a1@example.com', reason: 'project rotation policy' });
  assert.equal(manager.launchFor(chat).account, '1');
  assert.equal(manager.isActive('2'), true, 'no cswap switch was made');
  assert.equal((await manager.overview()).events.at(-1)?.event, 'rotate');

  const stuck = await manager.rotateWithinPolicy(chat, 'chat hit its rate limit');
  assert.equal(stuck?.switched, false);
  assert.equal((await manager.overview()).events.at(-1)?.event, 'no-switch');

  // No policy, or a chat pinned by hand: the global rotation is the caller's to run
  manager.projectOf = () => null;
  assert.equal(await manager.rotateWithinPolicy(chat, 'x'), null);
  assert.equal(cswap.launches().length, 0);
});

// ---------- the process a chat starts ----------

test('a chat pinned to another account runs through `cswap run`, and one whose account has a config dir runs claude against it', async () => {
  const cswap = fakeCswap({});
  const config = { ...tempConfig(), cswapBin: cswap.bin, claudeBin: cswap.claude };
  const core = new Core(config);
  try {
    await until(() => core.accounts.managed, 'claude-swap to be read');
    core.runtime.start({ prompt: 'hi', keepAlive: false, account: '3' });
    const first = await until(() => cswap.launches()[0], 'the first launch');
    // cswap has `run`, not `chat`: a chat pinned to an account that is not active used to fail to start
    assert.match(first, /^cswap run 3 --share-history -- /);

    const dir = join(config.dataDir, 'acct-3');
    await core.accounts.setConfig(3, { configDir: dir });
    core.runtime.start({ prompt: 'hi', keepAlive: false, account: '3' });
    const second = await until(() => cswap.launches()[1], 'the second launch');
    assert.equal(second, `claude CLAUDE_CONFIG_DIR=${dir}`, 'cswap run would have replaced the directory with its own session profile');
  } finally {
    core.shutdown();
  }
});

// ---------- usage history ----------

test('every fresh reading of the usage is kept as a row per account and window, without duplicates', async () => {
  const { manager, cswap } = await managed({ 1: 20, 2: 5, 3: 10 });
  await manager.list(true); // the same fetch again: same rows
  assert.equal(manager.usageHistory({ account: 1, window: '5h' }).length, 1);
  assert.equal(manager.usageHistory({ window: '7d' }).length, 0, 'a window the account did not report has no row');

  const later = FETCHED + 60_000;
  cswap.setUsage({ 1: 45, 2: 5, 3: 10 }, later);
  await manager.list(true);

  const series = manager.usageHistory({ account: 1, window: '5h' });
  assert.deepEqual(series.map((p) => p.pct), [20, 45], 'oldest first, for a chart');
  assert.deepEqual(manager.usageHistory({ account: 1, since: new Date(later).toISOString() }).map((p) => p.pct), [45]);
  assert.equal(manager.usageHistory({ account: 2 }).length, 1, 'a reading that did not move is not written again');
  assert.equal(manager.usageHistory({ limit: 2 }).length, 2);
});
