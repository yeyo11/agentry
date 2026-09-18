import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

// Isolated dirs and a missing CLI binary: these tests cover routing, scoping, validation and
// error mapping without ever spawning Claude or touching the real ~/.claude.
let app: FastifyInstance;
let projectId: string;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-'));
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const res = await app.inject({ method: 'POST', url: '/api/projects', ...json({ name: 'demo' }) });
  assert.equal(res.statusCode, 201);
  projectId = res.json().id;
});

after(() => app.close());

test('every API route is documented in the OpenAPI document', async () => {
  const spec = (await app.inject('/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  const undocumented: string[] = [];
  let operations = 0;
  for (const [path, methods] of Object.entries(spec.paths as Record<string, Record<string, { summary?: string; tags?: string[] }>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      operations++;
      if (!operation.summary || !operation.tags?.length) undocumented.push(`${method.toUpperCase()} ${path}`);
    }
  }
  assert.deepEqual(undocumented, []);
  assert.ok(operations >= 55, `only ${operations} operations documented`);
  // $refs used by routes must exist as components
  const refs = [...JSON.stringify(spec.paths).matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1] as string);
  const missing = [...new Set(refs)].filter((name) => !(name in spec.components.schemas));
  assert.deepEqual(missing, []);
  assert.equal(spec.paths['/api/runs'].post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/RunOptions');

  let docs = await app.inject('/docs');
  if (docs.statusCode === 301 || docs.statusCode === 302) docs = await app.inject(docs.headers.location as string);
  assert.equal(docs.statusCode, 200);
  assert.match(docs.headers['content-type'] as string, /text\/html/);
});

test('reports a missing CLI instead of failing', async () => {
  const health = (await app.inject('/api/health')).json();
  assert.deepEqual(health, { ok: false, cli: false, loggedIn: false });
  const system = (await app.inject('/api/system')).json();
  assert.equal(system.cli.installed, false);
  assert.equal(system.auth.tokenSource, 'none');
});

test('settings are scoped per user / project / variant', async () => {
  let res = await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: { model: 'sonnet' } }) });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'PUT', url: `/api/config/settings?project=${projectId}&variant=local`, ...json({ settings: { env: { A: '1' } } }) });
  assert.match(res.json().path, /demo\/\.claude\/settings\.local\.json$/);

  assert.deepEqual((await app.inject('/api/config/settings')).json().settings, { model: 'sonnet' });
  assert.deepEqual((await app.inject(`/api/config/settings?project=${projectId}`)).json(), {
    path: (await app.inject(`/api/config/settings?project=${projectId}`)).json().path,
    exists: false,
    settings: {},
  });
  assert.equal((await app.inject('/api/config/settings?variant=local')).statusCode, 400);
  assert.equal((await app.inject('/api/config/settings?project=ghost')).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/config/settings', ...json({ settings: [] }) })).statusCode, 400);
});

test('resources, memory and the file explorer validate their input', async () => {
  let res = await app.inject({ method: 'PUT', url: `/api/config/resources/rules/style?project=${projectId}`, ...json({ content: 'Use tabs.' }) });
  assert.equal(res.statusCode, 200);
  assert.equal((await app.inject(`/api/config/resources/rules?project=${projectId}`)).json().length, 1);
  assert.equal((await app.inject('/api/config/resources/rules')).json().length, 0); // user scope untouched
  assert.equal((await app.inject('/api/config/resources/widgets')).statusCode, 400);

  res = await app.inject({ method: 'PUT', url: `/api/memory/${projectId}/fact.md`, ...json({ content: '---\ndescription: d\n---\nx' }) });
  assert.equal(res.json().description, 'd');
  assert.equal((await app.inject(`/api/memory/${projectId}`)).json().length, 1);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/memory/${projectId}/nope.txt`, ...json({ content: 'x' }) })).statusCode, 400);
  assert.equal((await app.inject('/api/memory/ghost')).statusCode, 404);

  res = await app.inject({ method: 'PUT', url: '/api/config/files/content', ...json({ root: 'user', path: 'hooks/a.sh', content: 'exit 0', executable: true }) });
  assert.equal(res.json().executable, true);
  assert.deepEqual((await app.inject('/api/config/files/tree?root=user')).json().map((n: { name: string }) => n.name).sort(), ['hooks', 'settings.json']);
  for (const path of ['../x', '/etc/passwd', '.credentials.json', '.claude.json']) {
    assert.equal((await app.inject(`/api/config/files/content?root=user&path=${encodeURIComponent(path)}`)).statusCode, 400, path);
  }
  assert.equal((await app.inject('/api/config/files/content?root=user&path=missing.md')).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/config/files/content?root=user&path=hooks' })).statusCode, 200);
});

test('accounts degrade and validate without claude-swap', async () => {
  const overview = (await app.inject('/api/accounts')).json();
  assert.equal(overview.cswap.installed, false);
  assert.deepEqual(overview.accounts, []);
  assert.equal(overview.activeNumber, null);
  assert.equal(overview.autoSwitchRunning, false);

  // Identifiers and settings are rejected before anything is spawned
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/switch', ...json({ target: '--help' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/accounts/-x' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/1/alias', ...json({ alias: '--unset' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/token', ...json({ token: '' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/accounts/autoswitch', ...json({ threshold: 1 }) })).statusCode, 400);

  const saved = (await app.inject({ method: 'PUT', url: '/api/accounts/autoswitch', ...json({ threshold: 80, intervalSec: 30 }) })).json();
  assert.equal(saved.threshold, 80);
  assert.equal((await app.inject('/api/accounts/autoswitch')).json().intervalSec, 30);
});

test('planner drafts are listed and fetched by run', async () => {
  assert.deepEqual((await app.inject('/api/orchestrations/plans')).json(), []);
  // No such planner run: a clear 4xx rather than a hang
  assert.equal((await app.inject('/api/orchestrations/plans/nope')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/orchestrations/plan/start', ...json({}) })).statusCode, 400);
});

test('runs, orchestrations and plugins reject bad requests', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', ...json({ prompt: '  ' }) })).statusCode, 400);
  assert.equal((await app.inject('/api/runs/ghost')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs/ghost/messages', ...json({ text: 'hi' }) })).statusCode, 404);
  const cycle = { name: 'x', tasks: [{ id: 'a', name: 'a', prompt: 'p', dependsOn: ['b'] }, { id: 'b', name: 'b', prompt: 'p', dependsOn: ['a'] }] };
  assert.match((await app.inject({ method: 'POST', url: '/api/orchestrations', ...json(cycle) })).json().error, /cycle/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plugins/install', ...json({ plugin: '--help' }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/config/mcp/--scope', ...json({ config: { command: 'x' } }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/auth/credentials', ...json({}) })).statusCode, 400);
  assert.equal((await app.inject('/api/nope')).statusCode, 404);
});
