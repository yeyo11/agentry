import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_EDITOR, EditorSettingsStore, parseEditorSettings, sanitizeEditor, templateProblem } from '../src/editor-settings.ts';
import { tempConfig } from './helpers.ts';

test('templateProblem refuses what could never be a safe editor link', () => {
  assert.equal(templateProblem('vscode://file/{path}:{line}'), null);
  assert.equal(templateProblem('  '), 'empty');
  assert.equal(templateProblem('/opt/{path}'), 'scheme');
  for (const scheme of ['javascript', 'JavaScript', 'data', 'vbscript', 'file', 'blob']) {
    assert.equal(templateProblem(`${scheme}:{path}`), 'unsafe', scheme);
  }
  assert.equal(templateProblem('vscode://file/'), 'path');
});

test('parseEditorSettings refuses a bad template and malformed rows instead of replacing them', () => {
  assert.throws(() => parseEditorSettings(null), /JSON object/);
  assert.throws(() => parseEditorSettings({}), /template must be a string/);
  assert.throws(() => parseEditorSettings({ template: 'javascript:alert({path})' }), /never allowed/);
  assert.throws(() => parseEditorSettings({ template: 'zed://' }), /\{path\}/);
  assert.throws(() => parseEditorSettings({ template: 'zed://{path}', diffCommand: 3 }), /diffCommand/);
  assert.throws(() => parseEditorSettings({ template: 'zed://{path}', pathMap: {} }), /array/);
  assert.throws(() => parseEditorSettings({ template: 'zed://{path}', pathMap: [{ from: '/w' }] }), /from and to/);
  assert.throws(() => parseEditorSettings({ template: 'zed://{path}', pathMap: [{ from: ' ', to: '/h' }] }), /non-empty from/);
  assert.deepEqual(parseEditorSettings({ template: ' zed://{path} ', diffCommand: '  ', pathMap: [{ from: ' /work ', to: '/home/me ' }], extra: 1 }), {
    template: 'zed://{path}',
    pathMap: [{ from: '/work', to: '/home/me' }],
  });
});

test('sanitizeEditor falls back to the default template for a stored value it cannot trust', () => {
  assert.deepEqual(sanitizeEditor('nope'), DEFAULT_EDITOR);
  assert.deepEqual(sanitizeEditor({ template: 'data:text/html,{path}', diffCommand: 'code --diff {left} {right}' }), {
    template: DEFAULT_EDITOR.template,
    diffCommand: 'code --diff {left} {right}',
  });
});

test('the store says nothing was saved until the first write, then keeps editor.json', async () => {
  const config = tempConfig();
  const store = new EditorSettingsStore(config);
  assert.deepEqual(store.get(), { stored: false, settings: DEFAULT_EDITOR });

  const saved = await store.set({ template: 'cursor://file/{path}:{line}:{column}', pathMap: [{ from: '/workspace', to: '/home/me/src' }] });
  assert.equal(saved.stored, true);
  assert.deepEqual(new EditorSettingsStore(config).get(), saved);
  const file = join(config.dataDir, 'editor.json');
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { template: string }).template, 'cursor://file/{path}:{line}:{column}');

  await assert.rejects(store.set({ template: 'vbscript:{path}' }), /never allowed/);
  assert.deepEqual(store.get(), saved, 'a refused write leaves the stored document alone');

  writeFileSync(file, '{ not json');
  assert.throws(() => store.get(), /not valid JSON/);
});
