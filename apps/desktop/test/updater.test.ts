import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EMPTY_SNAPSHOT, trayMenu, type LiveSnapshot } from '../src/live.ts';
import {
  appImageRelaunch,
  debCanElevate,
  DesktopUpdater,
  distributionOf,
  installDecision,
  parseInstallRequest,
  updateSupport,
  type Support,
  type UpdaterEngine,
  type UpdateState,
} from '../src/updater.ts';

/** electron-updater's events, driven by hand: each call says what the real engine would emit */
class FakeEngine extends EventEmitter implements UpdaterEngine {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  logger: UpdaterEngine['logger'] = null;
  latest: string | null = '0.18.0';
  failCheck: Error | null = null;
  failDownload: Error | null = null;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  installResult = true;

  async checkForUpdates() {
    this.emit('checking-for-update');
    if (this.failCheck) {
      this.emit('error', this.failCheck);
      throw this.failCheck;
    }
    if (!this.latest) {
      this.emit('update-not-available', { version: '0.17.1' });
      return { isUpdateAvailable: false, updateInfo: { version: '0.17.1' } };
    }
    this.emit('update-available', { version: this.latest });
    return { isUpdateAvailable: true, updateInfo: { version: this.latest } };
  }

  async downloadUpdate() {
    if (this.failDownload) {
      this.emit('error', this.failDownload);
      throw this.failDownload;
    }
    this.emit('download-progress', { percent: 12.4 });
    this.emit('download-progress', { percent: 99.6 });
    this.emit('update-downloaded', { version: this.latest, downloadedFile: '/tmp/x' });
    return ['/tmp/x'];
  }

  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean {
    this.installs.push([isSilent, isForceRunAfter]);
    return this.installResult;
  }
}

const SUPPORTED: Support = { supported: true, distribution: 'appimage' };

function setup(support: Support = SUPPORTED) {
  const engine = new FakeEngine();
  let made = 0;
  const updater = new DesktopUpdater({
    support,
    engine: () => {
      made++;
      return engine;
    },
    log: () => undefined,
  });
  const seen: UpdateState[] = [];
  updater.onState((s) => seen.push(s));
  return { engine, updater, seen, made: () => made };
}

test('the package is told apart the way electron-updater does: APPIMAGE first, then package-type', () => {
  assert.equal(distributionOf({ appImage: '/home/me/Agentry.AppImage', packageType: undefined }), 'appimage');
  assert.equal(distributionOf({ appImage: undefined, packageType: 'deb\n' }), 'deb');
  assert.equal(distributionOf({ appImage: undefined, packageType: 'rpm' }), undefined);
  assert.equal(distributionOf({ appImage: undefined, packageType: undefined }), undefined);
});

test('a dev build, an unknown package and a read-only AppImage cannot update', () => {
  const writable = () => true;
  const dev = updateSupport({ dev: true, appImage: '/a/Agentry.AppImage', packageType: undefined, appImageWritable: writable, debCanElevate: () => true });
  assert.equal('reason' in dev && dev.reason, 'development');
  const unknown = updateSupport({ dev: false, appImage: undefined, packageType: undefined, appImageWritable: writable, debCanElevate: () => true });
  assert.equal('reason' in unknown && unknown.reason, 'unknown-package');
  const readOnly = updateSupport({ dev: false, appImage: '/opt/Agentry.AppImage', packageType: undefined, appImageWritable: () => false, debCanElevate: () => true });
  assert.equal('reason' in readOnly && readOnly.reason, 'read-only');
  assert.deepEqual(updateSupport({ dev: false, appImage: undefined, packageType: 'deb', appImageWritable: () => false, debCanElevate: () => true }), {
    supported: true,
    distribution: 'deb',
  });
});

test('a .deb with no graphical password prompt cannot update', () => {
  const facts = { dev: false, appImage: undefined, packageType: 'deb', appImageWritable: () => true };
  const blocked = updateSupport({ ...facts, debCanElevate: () => false });
  assert.equal('reason' in blocked && blocked.reason, 'no-elevation');
  assert.match('message' in blocked ? blocked.message : '', /pkexec/);
  // Only a .deb goes through sudo: an AppImage never asks
  assert.deepEqual(updateSupport({ ...facts, appImage: '/a/Agentry.AppImage', packageType: undefined, debCanElevate: () => false }), {
    supported: true,
    distribution: 'appimage',
  });
});

test('debCanElevate looks for pkexec and its peers on PATH, and needs none as root', () => {
  const empty = mkdtempSync(join(tmpdir(), 'agentry-path-'));
  const withTool = mkdtempSync(join(tmpdir(), 'agentry-path-'));
  writeFileSync(join(withTool, 'pkexec'), '#!/bin/sh\n');
  chmodSync(join(withTool, 'pkexec'), 0o755);
  assert.equal(debCanElevate({ PATH: empty }, 1000), false);
  assert.equal(debCanElevate({ PATH: `${empty}:${withTool}` }, 1000), true);
  assert.equal(debCanElevate({}, 1000), false);
  assert.equal(debCanElevate({ PATH: empty }, 0), true);
});

test('an unsupported copy never loads the engine and stays unsupported', async () => {
  const unsupported = updateSupport({ dev: true, appImage: undefined, packageType: undefined, appImageWritable: () => true, debCanElevate: () => true });
  const { updater, made } = setup(unsupported);
  assert.equal(updater.state.status, 'unsupported');
  assert.equal((await updater.check()).status, 'unsupported');
  assert.equal((await updater.download()).status, 'unsupported');
  assert.equal(updater.install(), false);
  assert.equal(made(), 0);
});

test('the engine never downloads or installs on its own', async () => {
  const { engine, updater } = setup();
  await updater.check();
  assert.equal(engine.autoDownload, false);
  assert.equal(engine.autoInstallOnAppQuit, false);
});

test('check: checking, then available with the version, or back to idle', async () => {
  const { engine, updater, seen } = setup();
  assert.deepEqual(updater.state, { status: 'idle' });
  assert.deepEqual(await updater.check(), { status: 'available', version: '0.18.0' });
  assert.equal(seen[0]?.status, 'checking');

  engine.latest = null;
  assert.deepEqual(await updater.check(), { status: 'idle' });
});

test('a failed check is an error with its message, and a later check recovers', async () => {
  const { engine, updater } = setup();
  engine.failCheck = new Error('net::ERR_INTERNET_DISCONNECTED');
  assert.deepEqual(await updater.check(), { status: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
  engine.failCheck = null;
  assert.equal((await updater.check()).status, 'available');
});

test('download checks first when nothing is known, reports whole percents, and ends ready', async () => {
  const { updater, seen } = setup();
  assert.deepEqual(await updater.download(), { status: 'ready', version: '0.18.0' });
  assert.deepEqual(
    seen.map((s) => (s.status === 'downloading' ? `downloading ${s.percent}` : s.status)),
    ['checking', 'available', 'downloading 0', 'downloading 12', 'downloading 100', 'ready'],
  );
  assert.equal(updater.readyVersion, '0.18.0');
  // Nothing more to do once it is ready: a second download does not start another
  assert.deepEqual(await updater.download(), { status: 'ready', version: '0.18.0' });
});

test('download with nothing newer stays idle and downloads nothing', async () => {
  const { engine, updater } = setup();
  engine.latest = null;
  engine.downloadUpdate = async () => assert.fail('downloaded with nothing to download');
  assert.deepEqual(await updater.download(), { status: 'idle' });
});

test('a failed download is an error', async () => {
  const { engine, updater } = setup();
  engine.failDownload = new Error('sha512 checksum mismatch');
  assert.deepEqual(await updater.download(), { status: 'error', message: 'sha512 checksum mismatch' });
  assert.equal(updater.readyVersion, undefined);
});

test('install runs silently and without a run-after, and only once ready', async () => {
  const { engine, updater } = setup();
  assert.equal(updater.install(), false);
  await updater.download();
  assert.equal(updater.install(), true);
  assert.deepEqual(engine.installs, [[true, false]]);
});

test('install on quit is only armed with a download ready', async () => {
  const { updater } = setup();
  assert.equal(updater.requestInstallOnQuit(), false);
  assert.equal(updater.installOnQuit, false);
  await updater.download();
  assert.equal(updater.requestInstallOnQuit(), true);
  assert.equal(updater.installOnQuit, true);
});

test('a renamed AppImage is remembered for the relaunch', async () => {
  const { engine, updater } = setup();
  await updater.check();
  engine.emit('appimage-filename-updated', '/home/me/Agentry-0.18.0-x86_64.AppImage');
  assert.equal(updater.installedAppImage, '/home/me/Agentry-0.18.0-x86_64.AppImage');
});

const busy: LiveSnapshot = { ...EMPTY_SNAPSHOT, working: 2, running: 1 };
const ready: UpdateState = { status: 'ready', version: '0.18.0' };

test('the restart refuses while work is live, and says what is', () => {
  assert.deepEqual(installDecision(ready, busy, {}), {
    status: 'busy',
    version: '0.18.0',
    live: { working: 2, waiting: 0, running: 1 },
  });
  // A chat waiting for a permission answer has a CLI running as well
  assert.equal(installDecision(ready, { ...EMPTY_SNAPSHOT, waiting: 1 }, {}).status, 'busy');
  assert.deepEqual(installDecision(ready, EMPTY_SNAPSHOT, {}), { status: 'restarting', version: '0.18.0' });
});

test('once asked, the person can restart anyway or leave it for the next quit', () => {
  assert.equal(installDecision(ready, busy, { force: true }).status, 'restarting');
  assert.deepEqual(installDecision(ready, busy, { whenIdle: true }), { status: 'scheduled', version: '0.18.0' });
  assert.equal(installDecision({ status: 'idle' }, EMPTY_SNAPSHOT, {}).status, 'not-ready');
});

test('the page only passes the two flags, and only as true booleans', () => {
  assert.deepEqual(parseInstallRequest({ whenIdle: true, force: 'yes', extra: 1 }), { whenIdle: true, force: false });
  assert.deepEqual(parseInstallRequest(null), {});
  assert.deepEqual(parseInstallRequest('force'), {});
});

test('the tray offers the restart above Quit once a download is ready', () => {
  const labels = (update?: string) =>
    trayMenu(EMPTY_SNAPSHOT, update).flatMap((e) => (e.type === 'item' ? [e.label] : []));
  assert.ok(!labels().some((l) => l.startsWith('Restart')));
  const withUpdate = trayMenu(EMPTY_SNAPSHOT, '0.18.0');
  const items = withUpdate.flatMap((e) => (e.type === 'item' ? [e] : []));
  assert.deepEqual(items.slice(-2), [
    { type: 'item', label: 'Restart to update to 0.18.0', action: { kind: 'update' } },
    { type: 'item', label: 'Quit Agentry', action: { kind: 'quit' } },
  ]);
});

test('the AppImage relaunch waits for the old process to exit, then runs the new file with its arguments and no inherited descriptors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-relaunch-'));
  const appImage = join(dir, 'Agentry.AppImage');
  const ran = join(dir, 'ran');
  const fds = join(dir, 'fds');
  writeFileSync(appImage, `#!/bin/sh\nls /proc/$$/fd > ${JSON.stringify(fds)}\necho "$@" > ${JSON.stringify(ran)}\n`);
  chmodSync(appImage, 0o755);

  // The "old process" is a sleep that is still alive when the relaunch starts
  const old = spawn('sleep', ['0.6']);
  const oldExited = new Promise((resolve) => old.once('exit', resolve));
  const relaunch = appImageRelaunch(old.pid!, appImage, ['--no-sandbox', '--flag']);
  assert.equal(relaunch.command, '/bin/bash');
  // Descriptors 3 and 4 stand for what Chromium leaves inheritable
  const child = spawn(relaunch.command, relaunch.args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const done = new Promise((resolve) => child.once('exit', resolve));

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(existsSync(ran), false, 'nothing starts while the old process lives');
  await oldExited;
  await done;
  assert.equal(readFileSync(ran, 'utf8').trim(), '--no-sandbox --flag');
  const open = readFileSync(fds, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.ok(!open.includes(3) && !open.includes(4), `inherited descriptors were closed: ${open.join(' ')}`);
});
