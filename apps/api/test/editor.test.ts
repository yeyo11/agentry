import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { EditorSettingsDoc } from '@agentry/shared';
import { Core, loadConfig } from '@agentry/core';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-editor-'));
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

test('editor settings start as the default and are replaced whole', async () => {
  const first = await app.inject('/api/settings/editor');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json<EditorSettingsDoc>(), { stored: false, settings: { template: 'vscode://file/{path}:{line}' } });

  const settings = { template: 'zed://file/{path}:{line}', diffCommand: 'code --diff {left} {right}', pathMap: [{ from: '/workspace', to: '/home/me' }] };
  const put = await app.inject({ method: 'PUT', url: '/api/settings/editor', ...json(settings) });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json<EditorSettingsDoc>(), { stored: true, settings });

  const replaced = await app.inject({ method: 'PUT', url: '/api/settings/editor', ...json({ template: 'idea://open?file={path}&line={line}' }) });
  assert.deepEqual(replaced.json<EditorSettingsDoc>().settings, { template: 'idea://open?file={path}&line={line}' });
  assert.deepEqual((await app.inject('/api/settings/editor')).json<EditorSettingsDoc>(), replaced.json<EditorSettingsDoc>());
});

test('an unsafe template is refused with a 400 and nothing changes', async () => {
  const kept = (await app.inject('/api/settings/editor')).json<EditorSettingsDoc>();
  for (const template of ['javascript:alert({path})', 'data:text/html,{path}', 'file:///{path}', 'no-scheme/{path}', 'vscode://file/']) {
    const res = await app.inject({ method: 'PUT', url: '/api/settings/editor', ...json({ template }) });
    assert.equal(res.statusCode, 400, template);
    assert.equal(typeof res.json<{ error: string }>().error, 'string');
  }
  assert.deepEqual((await app.inject('/api/settings/editor')).json<EditorSettingsDoc>(), kept);
});
