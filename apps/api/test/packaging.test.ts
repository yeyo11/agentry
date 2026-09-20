import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

const here = dirname(fileURLToPath(import.meta.url));

async function wrapper() {
  const root = mkdtempSync(join(tmpdir(), 'agentry-pkg-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  return { core, app, root };
}

test('the CLI version is read without asking the registry, and the check route is a separate call', async () => {
  const { app } = await wrapper();
  const before = (await app.inject('/api/system/cli-version')).json();
  assert.equal(before.latest, null);
  assert.equal(before.checkedAt, null);
  assert.equal(before.updateAvailable, false);
  await app.close();
});

test('closing the server does not wait for a browser tab that is still listening to the event stream', async () => {
  const { app } = await wrapper();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      res.once('data', () => resolve());
      res.on('error', () => {});
    });
    req.on('error', () => {});
  });

  const closed = await Promise.race([app.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 5000))]);
  assert.equal(closed, 'closed');
});

// The script is what turns "unhealthy" into a restart, so it is tested with a real process: the one
// this test started, found through the pid file, never by matching a command line.
test('the healthcheck ends the server only after the configured run of failed probes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-hc-'));
  const pidfile = join(dir, 'agentry.pid');
  const victim = spawn('sleep', ['300'], { stdio: 'ignore' });
  const exited = new Promise<string | null>((resolve) => victim.once('exit', (_code, signal) => resolve(signal)));
  writeFileSync(pidfile, String(victim.pid));

  const probe = () =>
    new Promise<number | null>((resolve) => {
      // A port nothing listens on: every probe fails
      const child = spawn(join(here, '../../../docker/healthcheck.sh'), [], {
        env: { ...process.env, PORT: '1', AGENTRY_PID_FILE: pidfile, AGENTRY_HEALTH_RESTART_AFTER: '2' },
        stdio: 'ignore',
      });
      child.once('exit', (code) => resolve(code));
    });

  try {
    assert.equal(await probe(), 1);
    assert.equal(victim.exitCode, null, 'one failed probe is not enough to restart');
    assert.equal(await probe(), 1);
    assert.equal(await exited, 'SIGTERM');
  } finally {
    victim.kill('SIGKILL');
  }
});
