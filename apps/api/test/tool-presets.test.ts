import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ToolPresetsOverview } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-presets-'));
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
});

after(() => app.close());

test('tool presets ship with defaults and can be created, edited and deleted', async () => {
  const shipped = (await app.inject('/api/config/tool-presets')).json<ToolPresetsOverview>();
  assert.deepEqual(shipped.presets.map((p) => p.id), ['read-only', 'no-network', 'everything']);
  assert.equal(shipped.defaultPresetId, null);

  const created = await app.inject({ method: 'PUT', url: '/api/config/tool-presets/docs-only', ...json({ name: 'Docs only', allowedTools: ['Read', 'Edit(docs/**)'] }) });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json(), { id: 'docs-only', name: 'Docs only', allowedTools: ['Read', 'Edit(docs/**)'], disallowedTools: [] });

  assert.equal((await app.inject('/api/config/tool-presets')).json<ToolPresetsOverview>().presets.length, 4);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/config/tool-presets/docs-only' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/config/tool-presets/docs-only' })).statusCode, 404);
});

test('a bad preset is a 400, and an unknown one on a chat request is a 404 that starts nothing', async () => {
  const bad = await app.inject({ method: 'PUT', url: '/api/config/tool-presets/Nope!', ...json({ name: 'x' }) });
  assert.equal(bad.statusCode, 400);

  const chat = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', toolPreset: 'ghost' }) });
  assert.equal(chat.statusCode, 404);
  assert.match(chat.json<{ error: string }>().error, /tool preset 'ghost' not found/);

  const server = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', mcp: { servers: ['ghost'] } }) });
  assert.equal(server.statusCode, 400);
  assert.match(server.json<{ error: string }>().error, /'ghost' is not configured/);
});

test('the default preset is set and cleared, and restoring brings the shipped ones back alone', async () => {
  const unknown = await app.inject({ method: 'PUT', url: '/api/config/tool-presets/default', ...json({ defaultPresetId: 'ghost' }) });
  assert.equal(unknown.statusCode, 404);
  const malformed = await app.inject({ method: 'PUT', url: '/api/config/tool-presets/default', ...json({ defaultPresetId: 7 }) });
  assert.equal(malformed.statusCode, 400);

  await app.inject({ method: 'PUT', url: '/api/config/tool-presets/mine', ...json({ name: 'Mine', allowedTools: ['Read'] }) });
  const set = await app.inject({ method: 'PUT', url: '/api/config/tool-presets/default', ...json({ defaultPresetId: 'mine' }) });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json(), { defaultPresetId: 'mine' });
  assert.equal((await app.inject('/api/config/tool-presets')).json<ToolPresetsOverview>().defaultPresetId, 'mine');

  await app.inject({ method: 'DELETE', url: '/api/config/tool-presets/no-network' });
  const restored = await app.inject({ method: 'POST', url: '/api/config/tool-presets/restore' });
  assert.equal(restored.statusCode, 200);
  const overview = restored.json<ToolPresetsOverview>();
  assert.deepEqual(overview.presets.map((p) => p.id).sort(), ['everything', 'mine', 'no-network', 'read-only']);
  assert.equal(overview.defaultPresetId, 'mine');

  const cleared = await app.inject({ method: 'PUT', url: '/api/config/tool-presets/default', ...json({ defaultPresetId: null }) });
  assert.deepEqual(cleared.json(), { defaultPresetId: null });
  await app.inject({ method: 'DELETE', url: '/api/config/tool-presets/mine' });
});
