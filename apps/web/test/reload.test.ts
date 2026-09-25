// A page left open across a deploy: when it should offer a reload, and how the reload gets past a
// service worker that would otherwise hand back the old build's shell.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BUILD_VERSION, isChunkLoadError, ReloadOffers, reloadApp, serverVersionChange, type WorkerContainer } from '../src/lib/reload.ts';

test('a server running another version is an update, whichever way the numbers moved', () => {
  assert.equal(serverVersionChange('0.17.1', '0.18.0'), '0.18.0');
  // A rollback is just as much a different build: the page's chunks are gone either way
  assert.equal(serverVersionChange('0.18.0', '0.17.1'), '0.17.1');
});

test('the same version, a server too old to say, or a build that does not know itself offer nothing', () => {
  assert.equal(serverVersionChange('0.17.1', '0.17.1'), null);
  assert.equal(serverVersionChange('0.17.1', undefined), null);
  assert.equal(serverVersionChange('0.17.1', ''), null);
  assert.equal(serverVersionChange('0.17.1', 18), null);
  assert.equal(serverVersionChange('', '0.18.0'), null);
});

test('the unit tests run unbuilt, so the build version is empty rather than a throw', () => {
  assert.equal(BUILD_VERSION, '');
});

test('the build reads its version from the root package.json', () => {
  const config = readFileSync(path.join(import.meta.dirname, '..', 'vite.config.ts'), 'utf8');
  assert.match(config, /new URL\('\.\.\/\.\.\/package\.json', import\.meta\.url\)/);
  assert.match(config, /__AGENTRY_VERSION__: JSON\.stringify\(VERSION\)/);
});

test('a missing lazy chunk is recognised in the words of every engine', () => {
  // Chrome
  assert.ok(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://a.test/assets/Chats-Aa11.js')));
  // Safari
  assert.ok(isChunkLoadError(new TypeError('Importing a module script failed.')));
  // Firefox
  assert.ok(isChunkLoadError(new TypeError('error loading dynamically imported module: https://a.test/assets/Chats-Aa11.js')));
  // Vite's preload of a lazy module's stylesheet
  assert.ok(isChunkLoadError(new Error('Unable to preload CSS for /assets/Chats-Aa11.css')));
  const named = new Error('Loading chunk 12 failed.');
  named.name = 'ChunkLoadError';
  assert.ok(isChunkLoadError(named));
  assert.ok(isChunkLoadError('Failed to fetch dynamically imported module'));
});

test('any other failure is not taken for a deploy', () => {
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')")), false);
  assert.equal(isChunkLoadError(new Error('Failed to fetch')), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError(undefined), false);
  assert.equal(isChunkLoadError({ message: 42 }), false);
});

test('every hello is compared, so a reconnection after a restart is when the page notices', () => {
  const offers = new ReloadOffers('0.17.1');
  let changes = 0;
  offers.subscribe(() => void changes++);
  offers.serverVersion('0.17.1');
  assert.equal(offers.current(), null);
  offers.serverVersion('0.18.0');
  assert.deepEqual(offers.current(), { reason: 'updated', version: '0.18.0' });
  // The same answer on the next reconnection is not news
  offers.serverVersion('0.18.0');
  assert.equal(changes, 1);
  offers.serverVersion('0.18.1');
  assert.deepEqual(offers.current(), { reason: 'updated', version: '0.18.1' });
});

test('a dismissal holds for that version, and a newer one brings the banner back', () => {
  const offers = new ReloadOffers('0.17.1');
  offers.serverVersion('0.18.0');
  offers.dismiss();
  assert.equal(offers.current(), null);
  offers.serverVersion('0.18.0');
  assert.equal(offers.current(), null);
  offers.serverVersion('0.19.0');
  assert.deepEqual(offers.current(), { reason: 'updated', version: '0.19.0' });
});

test('a server rolled back to this build takes the offer away', () => {
  const offers = new ReloadOffers('0.17.1');
  offers.serverVersion('0.18.0');
  offers.serverVersion(undefined);
  assert.notEqual(offers.current(), null, 'a hello without a version says nothing either way');
  offers.serverVersion('0.17.1');
  assert.equal(offers.current(), null);
});

test('a missing chunk offers the same reload, even after a dismissal, without hiding a known version', () => {
  const offers = new ReloadOffers('0.17.1');
  offers.staleChunk();
  assert.deepEqual(offers.current(), { reason: 'stale' });
  offers.dismiss();
  offers.staleChunk();
  assert.deepEqual(offers.current(), { reason: 'stale' });
  // A hello names the version, which is the better sentence
  offers.serverVersion('0.18.0');
  assert.deepEqual(offers.current(), { reason: 'updated', version: '0.18.0' });
  offers.staleChunk();
  assert.deepEqual(offers.current(), { reason: 'updated', version: '0.18.0' });
});

// ---------- the reload ----------

class FakeWorkers implements WorkerContainer {
  controller: unknown = {};
  listeners = new Set<() => void>();
  updates = 0;
  installing: unknown = null;
  waiting: unknown = null;
  registered = true;
  /** What `update()` does: find a new worker, and maybe have it take over at once */
  onUpdate: () => void = () => {};

  async getRegistration() {
    if (!this.registered) return undefined;
    const self = this;
    return {
      async update() {
        self.updates++;
        self.onUpdate();
      },
      get installing() {
        return self.installing;
      },
      get waiting() {
        return self.waiting;
      },
    };
  }
  addEventListener(_type: 'controllerchange', listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'controllerchange', listener: () => void) {
    this.listeners.delete(listener);
  }
  takeOver() {
    for (const listener of [...this.listeners]) listener();
  }
}

test('without a service worker in control, the reload is immediate', async () => {
  let reloads = 0;
  await reloadApp({ container: undefined, reload: () => void reloads++ });
  assert.equal(reloads, 1);
  const workers = new FakeWorkers();
  workers.controller = null;
  await reloadApp({ container: workers, reload: () => void reloads++ });
  assert.equal(reloads, 2);
  assert.equal(workers.updates, 0, 'a page no worker controls has nothing to update');
});

test('with a worker in control, the reload waits for the new one to take over', async () => {
  const workers = new FakeWorkers();
  workers.onUpdate = () => {
    workers.installing = {};
  };
  const order: string[] = [];
  const done = reloadApp({ container: workers, reload: () => void order.push('reload'), timeoutMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.updates, 1);
  assert.equal(order.length, 0, 'the old worker would answer a reload from its own shell');
  order.push('controllerchange');
  workers.takeOver();
  await done;
  assert.deepEqual(order, ['controllerchange', 'reload']);
  assert.equal(workers.listeners.size, 0, 'the listener is removed once it has done its job');
});

test('a worker that claims the page while update() is still running is not missed', async () => {
  const workers = new FakeWorkers();
  workers.onUpdate = () => {
    workers.installing = {};
    workers.takeOver();
  };
  let reloads = 0;
  await reloadApp({ container: workers, reload: () => void reloads++, timeoutMs: 60_000 });
  assert.equal(reloads, 1);
});

test('when update() finds nothing newer, the worker in control is current and the reload is at once', async () => {
  const workers = new FakeWorkers();
  let reloads = 0;
  await reloadApp({ container: workers, reload: () => void reloads++, timeoutMs: 60_000 });
  assert.equal(workers.updates, 1);
  assert.equal(reloads, 1);
});

test('a new worker that never takes over does not leave the button doing nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = new FakeWorkers();
  workers.onUpdate = () => {
    workers.waiting = {};
  };
  let reloads = 0;
  const done = reloadApp({ container: workers, reload: () => void reloads++, timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 0);
  t.mock.timers.tick(1);
  await done;
  assert.equal(reloads, 1);
});

test('a failed update or registration lookup still reloads', async () => {
  let reloads = 0;
  const offline = new FakeWorkers();
  offline.onUpdate = () => {
    throw new TypeError('Failed to update a ServiceWorker: network error');
  };
  await reloadApp({ container: offline, reload: () => void reloads++ });
  assert.equal(reloads, 1);
  const unregistered = new FakeWorkers();
  unregistered.registered = false;
  await reloadApp({ container: unregistered, reload: () => void reloads++ });
  assert.equal(reloads, 2);
});
