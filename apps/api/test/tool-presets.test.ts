import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ToolPreset } from '@agentry/shared';
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
  const shipped = (await app.inject('/api/config/tool-presets')).json<ToolPreset[]>();
  assert.deepEqual(shipped.map((p) => p.id), ['read-only', 'no-network', 'everything']);

  const created = await app.inject({ method: 'PUT', url: '/api/config/tool-presets/docs-only', ...json({ name: 'Docs only', allowedTools: ['Read', 'Edit(docs/**)'] }) });
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.json(), { id: 'docs-only', name: 'Docs only', allowedTools: ['Read', 'Edit(docs/**)'], disallowedTools: [] });

  assert.equal((await app.inject('/api/config/tool-presets')).json<ToolPreset[]>().length, 4);
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
