import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SettingsFiles } from '../src/config/files.ts';
import { McpConfig } from '../src/config/mcp.ts';
import { parseVariant, projectScope, userScope } from '../src/config/scope.ts';
import { ConfigResources } from '../src/config/resources.ts';
import { CredentialStore } from '../src/credentials.ts';
import { loadConfig } from '../src/paths.ts';
import { encodeProjectId, Workspace } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

test('settings and instructions round-trip per scope', async () => {
  const config = tempConfig();
  const files = new SettingsFiles();
  const user = userScope(config);
  const project = projectScope(join(config.workspaceDir, 'app'));

  assert.deepEqual(await files.getSettings(user), { path: join(config.configDir, 'settings.json'), exists: false, settings: {} });
  assert.deepEqual((await files.setSettings(user, 'shared', { model: 'sonnet' })).settings, { model: 'sonnet' });
  await assert.rejects(files.setSettings(user, 'shared', [1]), /JSON object/);
  await assert.rejects(files.getSettings(user, 'local'), /only exists in project scope/);

  const local = await files.setSettings(project, 'local', { env: { A: '1' } });
  assert.equal(local.path, join(config.workspaceDir, 'app', '.claude', 'settings.local.json'));
  assert.equal((await files.getSettings(project, 'shared')).exists, false); // variants are independent files

  assert.equal((await files.setInstructions(user, 'shared', '# Rules\n')).path, join(config.configDir, 'CLAUDE.md'));
  assert.equal((await files.setInstructions(project, 'shared', 'p')).path, join(config.workspaceDir, 'app', 'CLAUDE.md'));
  assert.equal((await files.setInstructions(project, 'local', 'l')).path, join(config.workspaceDir, 'app', 'CLAUDE.local.md'));
  await assert.rejects(files.setInstructions(user, 'shared', 42), /string/);
  assert.throws(() => parseVariant('nope'), /variant must be/);
});

test('markdown resources CRUD with per-kind layout and scope', async () => {
  const config = tempConfig();
  const resources = new ConfigResources();
  const user = userScope(config);
  const project = projectScope(join(config.workspaceDir, 'app'));
  const body = '---\nname: x\ndescription: "Reviews code"\n---\nBody\n';

  const agent = await resources.save(user, 'agents', 'reviewer', body);
  assert.equal(agent.path, join(config.configDir, 'agents', 'reviewer.md'));
  assert.equal(agent.description, 'Reviews code');

  const skill = await resources.save(project, 'skills', 'deploy', body);
  assert.equal(skill.path, join(config.workspaceDir, 'app', '.claude', 'skills', 'deploy', 'SKILL.md'));
  assert.deepEqual((await resources.list(project, 'skills')).map((r) => r.name), ['deploy']);
  assert.deepEqual(await resources.list(user, 'skills'), []); // scopes do not leak into each other

  const style = await resources.save(user, 'output-styles', 'terse', body);
  assert.equal(style.path, join(config.configDir, 'output-styles', 'terse.md'));

  await resources.remove(project, 'skills', 'deploy');
  assert.equal(existsSync(join(config.workspaceDir, 'app', '.claude', 'skills', 'deploy')), false);
  await assert.rejects(resources.remove(user, 'agents', 'ghost'), /not found/);
  await assert.rejects(resources.save(user, 'agents', '../evil', 'x'), /invalid resource name/);
});

test('a saved workflow is a script resource: found by its meta name, kept in its own file, and never mistaken for markdown', async () => {
  const config = tempConfig();
  const resources = new ConfigResources();
  const user = userScope(config);
  const project = projectScope(join(config.workspaceDir, 'app'));
  const dir = join(config.workspaceDir, 'app', '.claude', 'workflows');
  mkdirSync(dir, { recursive: true });
  // The file is not called what the script says: the Workflow tool goes by `meta.name`
  writeFileSync(join(dir, 'audit-v2.mjs'), "export const meta = { name: 'audit', description: 'Audit the API' }\nreturn 1\n");
  writeFileSync(join(dir, 'notes.md'), '# not a workflow');

  const listed = await resources.list(project, 'workflows');
  assert.deepEqual(listed.map((r) => [r.name, r.format, r.description]), [['audit', 'javascript', 'Audit the API']]);
  assert.deepEqual(await resources.list(user, 'workflows'), []); // scopes do not leak into each other
  assert.equal((await resources.list(project, 'agents')).every((r) => r.format === 'markdown'), true);

  // Saving by name edits the file that holds it instead of creating a second `audit.js`
  const edited = await resources.save(project, 'workflows', 'audit', "export const meta = { name: 'audit', description: 'Changed' }\n");
  assert.equal(edited.path, join(dir, 'audit-v2.mjs'));
  assert.equal(edited.description, 'Changed');
  assert.equal(existsSync(join(dir, 'audit.js')), false);

  const created = await resources.save(project, 'workflows', 'fresh', "export const meta = { name: 'fresh' }\n");
  assert.equal(created.path, join(dir, 'fresh.js'));
  assert.equal(readFileSync(created.path, 'utf8'), "export const meta = { name: 'fresh' }\n");

  // A script that renames itself is the workflow of its new name
  const renamed = await resources.save(project, 'workflows', 'fresh', "export const meta = { name: 'fresher' }\n");
  assert.equal(renamed.name, 'fresher');
  assert.equal(renamed.path, created.path);

  await resources.remove(project, 'workflows', 'audit');
  assert.equal(existsSync(join(dir, 'audit-v2.mjs')), false);
  await assert.rejects(resources.remove(project, 'workflows', 'audit'), /not found/);
});

test('credential store injects, swaps and restores env', async () => {
  const config = tempConfig();
  const before = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'boot-token';
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const store = new CredentialStore(config);
    assert.equal(store.active, false);

    await store.set({ apiKey: ' sk-test ' });
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined); // only one credential type at a time
    assert.equal(statSync(join(config.dataDir, 'credentials.json')).mode & 0o777, 0o600);

    // A fresh instance (wrapper restart) picks the stored credential up again
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(new CredentialStore(config).active, true);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-test');

    await assert.rejects(store.set({}), /provide oauthToken or apiKey/);
    await assert.rejects(store.set({ oauthToken: 'a', apiKey: 'b' }), /only one/);

    store.clear();
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, 'boot-token');
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const [k, v] of [['CLAUDE_CODE_OAUTH_TOKEN', before.token], ['ANTHROPIC_API_KEY', before.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('an allowed-hosts pattern that guards nothing stops the wrapper instead of opening it', () => {
  const base = { CLAUDE_CONFIG_DIR: join(tmpdir(), 'agentry-hosts', 'claude'), AGENTRY_DATA_DIR: join(tmpdir(), 'agentry-hosts', 'data'), AGENTRY_WORKSPACE_DIR: join(tmpdir(), 'agentry-hosts', 'workspace') };

  assert.deepEqual(loadConfig({ ...base, AGENTRY_ALLOWED_HOSTS: ' *.Example.com , agentry.internal ' }).allowedHosts, ['*.example.com', 'agentry.internal']);
  assert.deepEqual(loadConfig({ ...base }).allowedHosts, []);

  // A wildcard over a public suffix, or anywhere but the front, is a typo worth failing on
  for (const value of ['*.com', '*', '*.', 'a.*.example.com', 'ex*mple.com']) {
    assert.throws(() => loadConfig({ ...base, AGENTRY_ALLOWED_HOSTS: value }), /AGENTRY_ALLOWED_HOSTS/, value);
  }
});

test('two panels asking for MCP health at once share one connection check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-mcp-'));
  const log = join(root, 'invocations');
  const bin = join(root, 'claude');
  // Slow enough that the second caller arrives while the first check is still dialling
  const script = ['#!/bin/sh', `echo "$@" >> '${log}'`, 'sleep 0.3', "echo 'docs: https://example.com - ✔ Connected'", ''];
  writeFileSync(bin, script.join('\n'), { mode: 0o755 });
  const config = loadConfig({
    CLAUDE_BIN: bin,
    CSWAP_BIN: '/nonexistent/cswap',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
    AGENTRY_DATA_DIR: join(root, 'data'),
  });
  const mcp = new McpConfig(config);
  const scope = userScope(config);
  const runs = () => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('mcp list')).length;

  const [first, second] = await Promise.all([mcp.health(scope), mcp.health(scope)]);
  assert.deepEqual(first, [{ name: 'docs', status: 'connected', detail: 'Connected' }]);
  assert.deepEqual(second, first);
  assert.equal(runs(), 1);

  // Sharing lasts only while one is running: the panel that reopens later checks again
  await mcp.health(scope);
  assert.equal(runs(), 2);
});

test('workspace projects', async () => {
  const config = tempConfig();
  const workspace = new Workspace(config);
  const path = await workspace.create('my-app');
  assert.equal(path, join(config.workspaceDir, 'my-app'));
  assert.equal(statSync(path).isDirectory(), true);
  await assert.rejects(workspace.create('my-app'), /already exists/);
  await assert.rejects(workspace.create('../escape'), /invalid project name/);
  await assert.rejects(workspace.create('repo', 'file:///etc'), /invalid git url/);
  assert.equal(encodeProjectId('/home/me/My App (1)'), '-home-me-My-App--1-');
});
