import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SettingsFiles } from '../src/config/files.ts';
import { parseVariant, projectScope, userScope } from '../src/config/scope.ts';
import { MarkdownResources } from '../src/config/resources.ts';
import { CredentialStore } from '../src/credentials.ts';
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
  const resources = new MarkdownResources();
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
