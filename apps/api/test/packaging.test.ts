import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';
import { listenOn } from '../src/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const dockerfile = readFileSync(resolve(here, '../../../docker/Dockerfile'), 'utf8');

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

test('the Agentry release is read without asking GitHub, and the image says it is Docker', async () => {
  const { app, core } = await wrapper();
  const before = (await app.inject('/api/system/release')).json();
  assert.equal(before.current, core.version);
  assert.equal(before.latest, null);
  assert.equal(before.checkedAt, null);
  assert.equal(before.updateAvailable, false);
  assert.match(dockerfile, /^\s+AGENTRY_DISTRIBUTION=docker$/m);
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

// The image ships one JavaScript file. These two tests are the contract between the bundle script,
// the Dockerfile and the healthcheck: each is useless if one of the others moves.
test('the image starts the compiled API instead of transpiling the source on every boot', () => {
  assert.match(dockerfile, /^CMD \["node", "\/app\/api\.mjs"\]$/m);
  assert.match(dockerfile, /^COPY --from=build .*\/app\/apps\/api\/dist\/api\.mjs \/app\/api\.mjs$/m);

  // Whatever the last stage does not carry cannot be part of the running image
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.doesNotMatch(runtimeStage, /pnpm install/, 'node_modules belongs to the build stage');
  assert.doesNotMatch(runtimeStage, /^COPY (packages|apps)\b/m, 'the source tree belongs to the build stage');
});

test('the compiled API serves and stops on its own, with no source tree, node_modules or transpiler beside it', { timeout: 120_000 }, async () => {
  const bundler = spawn(process.execPath, [join(apiRoot, 'scripts/bundle.mjs')], { cwd: apiRoot, stdio: 'ignore' });
  assert.deepEqual(await once(bundler, 'exit'), [0, null], 'the bundle script must build both entrypoints');

  // A directory of its own, outside the monorepo: nothing can be resolved from a node_modules above it
  const dir = mkdtempSync(join(tmpdir(), 'agentry-bundle-'));
  const pidFile = join(dir, 'agentry.pid');
  copyFileSync(join(apiRoot, 'dist/api.mjs'), join(dir, 'api.mjs'));

  const server = spawn(process.execPath, ['api.mjs'], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PORT: '0',
      HOST: '127.0.0.1',
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(dir, 'workspace'),
      AGENTRY_DATA_DIR: join(dir, 'data'),
      AGENTRY_PID_FILE: pidFile,
      // No check means no call to the registry from a test
      AGENTRY_CLI_UPDATE_CHECK: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = server.stdout;
  const stderr = server.stderr;
  assert.ok(stdout && stderr);

  try {
    // The bound port is only known from the log line: this is the entrypoint the container starts,
    // and it announces nothing else
    const url = await new Promise<string>((done, fail) => {
      let log = '';
      const timer = setTimeout(() => fail(new Error(`the bundle never listened. Output:\n${log}`)), 60_000);
      const read = (chunk: Buffer) => {
        log += chunk.toString('utf8');
        const listening = /"msg":"Server listening at ([^"]+)"/.exec(log);
        if (!listening?.[1]) return;
        clearTimeout(timer);
        done(listening[1]);
      };
      stdout.on('data', read);
      stderr.on('data', read);
      server.once('exit', (code) => fail(new Error(`the bundle exited with ${code}. Output:\n${log}`)));
    });

    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(readFileSync(pidFile, 'utf8'), String(server.pid), 'the healthcheck signals the server through this file');

    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], 'SIGTERM reaches the server itself now that no package manager stands in between');
    assert.equal(existsSync(pidFile), false, 'a server that stopped must not leave a pid file for the healthcheck to signal');
  } finally {
    server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a port that is taken does not stop the server: it binds one the system picks', async (t) => {
  // The desktop shell remembers a port between launches, so the one it asks for may be gone
  const held = Fastify({ logger: false });
  await held.listen({ port: 0, host: '127.0.0.1' });
  const taken = (held.server.address() as AddressInfo).port;
  t.after(() => held.close());

  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await listenOn(app, taken, '127.0.0.1');
  const bound = (app.server.address() as AddressInfo).port;

  assert.notEqual(bound, taken);
  assert.ok(bound > 0);
});

test('a listen that failed for any other reason is not retried away', async (t) => {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  // An address this machine does not have: retrying on port 0 would hide a real misconfiguration
  await assert.rejects(listenOn(app, 8787, '203.0.113.1'), (err: NodeJS.ErrnoException) => err.code !== 'EADDRINUSE');
});
