import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopback, parseInstallAnswer, parseUpdateState, updateRoute } from '../src/lib/updates.ts';

// The Updates card offers one way to take a release, chosen from the kind of install the server is
// and from where the page runs; the desktop shell's answers arrive as `unknown` and are checked.

test('the desktop window updates itself, whatever the server reports as its distribution', () => {
  for (const distribution of ['appimage', 'deb', 'source'] as const) {
    assert.deepEqual(updateRoute({ distribution, desktopUpdates: true, hostname: '127.0.0.1' }), { kind: 'desktop' });
  }
});

test('a browser on the same machine gets the steps addressed to its reader', () => {
  assert.deepEqual(updateRoute({ distribution: 'docker', desktopUpdates: false, hostname: 'localhost' }), { kind: 'steps', how: 'docker', remote: false });
  assert.deepEqual(updateRoute({ distribution: 'source', desktopUpdates: false, hostname: '127.0.0.1' }), { kind: 'steps', how: 'source', remote: false });
  assert.deepEqual(updateRoute({ distribution: 'appimage', desktopUpdates: false, hostname: '[::1]' }), { kind: 'steps', how: 'desktop-app', remote: false });
});

test('a phone or another computer gets the same steps, addressed to whoever runs the server', () => {
  assert.deepEqual(updateRoute({ distribution: 'docker', desktopUpdates: false, hostname: '192.168.1.20' }), { kind: 'steps', how: 'docker', remote: true });
  assert.deepEqual(updateRoute({ distribution: 'deb', desktopUpdates: false, hostname: 'agentry.example.com' }), { kind: 'steps', how: 'desktop-app', remote: true });
});

test('loopback names and addresses count as this machine, and nothing else does', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.equal(isLoopback(host), true, host);
  for (const host of ['192.168.1.2', '10.0.0.1', 'agentry.lan', 'localhost.example.com', '1127.0.0.1']) assert.equal(isLoopback(host), false, host);
});

test('the shell state is read as the desktop updater sends it', () => {
  assert.deepEqual(parseUpdateState({ status: 'idle' }), { status: 'idle' });
  assert.deepEqual(parseUpdateState({ status: 'available', version: '0.19.0' }), { status: 'available', version: '0.19.0' });
  assert.deepEqual(parseUpdateState({ status: 'downloading', version: '0.19.0', percent: 42.6 }), { status: 'downloading', version: '0.19.0', percent: 43 });
  assert.deepEqual(parseUpdateState({ status: 'ready', version: '0.19.0' }), { status: 'ready', version: '0.19.0' });
  assert.deepEqual(parseUpdateState({ status: 'unsupported', reason: 'development', message: 'Updates are off.' }), {
    status: 'unsupported',
    reason: 'development',
    message: 'Updates are off.',
  });
  assert.deepEqual(parseUpdateState({ status: 'error', message: 'offline' }), { status: 'error', message: 'offline' });
});

test('a progress out of range is clamped, and a state this build does not know is dropped', () => {
  assert.deepEqual(parseUpdateState({ status: 'downloading', version: '1.0.0', percent: 140 }), { status: 'downloading', version: '1.0.0', percent: 100 });
  assert.equal(parseUpdateState({ status: 'ready' }), null, 'ready without a version');
  assert.equal(parseUpdateState({ status: 'paused' }), null);
  assert.equal(parseUpdateState('ready'), null);
  assert.equal(parseUpdateState(null), null);
});

test('a busy answer carries what a restart would stop, so the page can ask first', () => {
  assert.deepEqual(parseInstallAnswer({ status: 'busy', version: '0.19.0', live: { working: 2, waiting: 1, running: 0 } }), {
    status: 'busy',
    version: '0.19.0',
    live: { working: 2, waiting: 1, running: 0 },
  });
  assert.deepEqual(parseInstallAnswer({ status: 'busy', version: '0.19.0', live: { working: -1, waiting: 'x' } }), {
    status: 'busy',
    version: '0.19.0',
    live: { working: 0, waiting: 0, running: 0 },
  });
  assert.deepEqual(parseInstallAnswer({ status: 'scheduled', version: '0.19.0' }), { status: 'scheduled', version: '0.19.0' });
  assert.deepEqual(parseInstallAnswer({ status: 'restarting', version: '0.19.0' }), { status: 'restarting', version: '0.19.0' });
  assert.deepEqual(parseInstallAnswer({ status: 'not-ready', state: { status: 'idle' } }), { status: 'not-ready', state: { status: 'idle' } });
  assert.equal(parseInstallAnswer({ status: 'busy', version: '0.19.0' }), null);
  assert.equal(parseInstallAnswer(undefined), null);
});
