import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { monitorHeaders } from '../src/live-monitor.ts';
import { LogFile } from '../src/log.ts';
import { newDesktopSecret, ServerProcess, serverEnv } from '../src/server-process.ts';

const envFor = (desktopSecret: string, base: NodeJS.ProcessEnv = {}) =>
  serverEnv({ base, PATH: '/usr/bin', rememberedPort: 43123, webDist: '/web', dataDir: '/data', workspaceDir: '/ws', version: '1.2.3', distribution: 'deb', desktopSecret });

test('each launch has a secret of its own, long enough that nobody guesses it', () => {
  const a = newDesktopSecret();
  const b = newDesktopSecret();
  assert.notEqual(a, b);
  // 32 random bytes in base64url
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test("the server the app spawns is handed the launch's secret, beside what the person set", async () => {
  const secret = newDesktopSecret();
  const env = envFor(secret, { PORT: '9999', SOMETHING_OF_MINE: 'kept' });
  assert.equal(env.AGENTRY_DESKTOP_TOKEN, secret);
  assert.equal(env.SOMETHING_OF_MINE, 'kept');
  assert.equal(env.PORT, '9999', 'PORT from the environment still wins');
  assert.equal(envFor(secret).PORT, '43123');
  assert.equal(env.HOST, '127.0.0.1');

  // And it really reaches the child: a stand-in server writes down what it was given
  const dir = mkdtempSync(join(tmpdir(), 'agentry-desktop-server-'));
  const seen = join(dir, 'seen');
  const entry = join(dir, 'server.mjs');
  writeFileSync(
    entry,
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SEEN_FILE, process.env.AGENTRY_DESKTOP_TOKEN ?? '');
console.log('AGENTRY_READY ' + JSON.stringify({ url: 'http://127.0.0.1:1', port: 1 }));
setInterval(() => {}, 1000);
`,
  );
  const log = new LogFile(dir, 'server.log');
  const server = new ServerProcess({ entry, cwd: dir, env: { ...envFor(secret), SEEN_FILE: seen } }, log, () => undefined);
  try {
    assert.equal(await server.start(), 'http://127.0.0.1:1');
    assert.equal(readFileSync(seen, 'utf8'), secret);
  } finally {
    await server.stop();
    await log.close();
  }
  assert.equal(readFileSync(log.path, 'utf8').includes(secret), false, 'the secret is never logged');
});

test("the tray sends the launch's secret, and AGENTRY_AUTH_TOKEN only when there is none", () => {
  assert.deepEqual(monitorHeaders('launch-secret', { AGENTRY_AUTH_TOKEN: 'from-env' }), { Authorization: 'Bearer launch-secret' });
  assert.deepEqual(monitorHeaders(undefined, { AGENTRY_AUTH_TOKEN: ' from-env ' }), { Authorization: 'Bearer from-env' });
  assert.deepEqual(monitorHeaders(undefined, {}), {});
});
