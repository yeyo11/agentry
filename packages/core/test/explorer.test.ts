import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigExplorer } from '../src/config/explorer.ts';
import { parseMcpHealth } from '../src/config/mcp.ts';
import { projectScope, userScope } from '../src/config/scope.ts';
import { loadConfig } from '../src/paths.ts';
import { tempConfig } from './helpers.ts';

test('explorer writes, reads, lists and deletes inside the root', async () => {
  const config = tempConfig();
  const explorer = new ConfigExplorer(config.configDir);
  const user = userScope(config);

  const script = await explorer.write(user, 'user', 'hooks/guard.sh', '#!/bin/bash\nexit 0\n', true);
  assert.equal(script.path, 'hooks/guard.sh');
  assert.equal(script.executable, true);
  assert.equal(statSync(join(config.configDir, 'hooks', 'guard.sh')).mode & 0o777, 0o755);
  await explorer.write(user, 'user', 'keybindings.json', '{}');

  const tree = await explorer.tree(user);
  assert.deepEqual(tree.map((n) => [n.type, n.name]), [['dir', 'hooks'], ['file', 'keybindings.json']]); // dirs first
  assert.deepEqual(tree[0]?.children?.map((n) => n.path), ['hooks/guard.sh']);

  assert.equal((await explorer.read(user, 'user', 'hooks/guard.sh')).content, '#!/bin/bash\nexit 0\n');
  await explorer.remove(user, 'hooks');
  assert.deepEqual((await explorer.tree(user)).map((n) => n.name), ['keybindings.json']);
  await assert.rejects(explorer.read(user, 'user', 'hooks/guard.sh'), /not found/);
});

test('explorer refuses traversal, symlink escapes, secrets and binaries', async () => {
  const config = tempConfig();
  const explorer = new ConfigExplorer(config.configDir);
  const user = userScope(config);
  mkdirSync(config.configDir, { recursive: true });
  writeFileSync(join(config.configDir, '.credentials.json'), '{"token":"secret"}');
  mkdirSync(join(config.configDir, 'projects'), { recursive: true });
  writeFileSync(join(config.configDir, 'blob.bin'), Buffer.from([1, 0, 2]));
  symlinkSync(tmpdir(), join(config.configDir, 'escape'));

  await assert.rejects(explorer.read(user, 'user', '../outside.txt'), /outside the config root/);
  await assert.rejects(explorer.write(user, 'user', '/etc/passwd', 'x'), /outside the config root/);
  await assert.rejects(explorer.write(user, 'user', 'escape/pwned.txt', 'x'), /resolves outside/);
  await assert.rejects(explorer.read(user, 'user', '.credentials.json'), /not editable/);
  await assert.rejects(explorer.write(user, 'user', 'projects/x.jsonl', 'x'), /not editable/);
  await assert.rejects(explorer.read(user, 'user', 'blob.bin'), /binary/);
  await assert.rejects(explorer.remove(user, ''), /path is required/);

  const names = (await explorer.tree(user)).map((n) => n.name);
  assert.ok(!names.includes('.credentials.json') && !names.includes('projects'));

  // The user-only deny list does not hide a project's own files
  const project = projectScope(join(config.workspaceDir, 'app'));
  assert.equal((await explorer.write(project, 'app', 'plans/notes.md', 'ok')).path, 'plans/notes.md');
});

test('a project scope on the config dir hides the credentials as the user scope does', async () => {
  // A home-shaped layout, because the bypass is importing $HOME: there `<project>/.claude` *is* the config dir
  const home = mkdtempSync(join(tmpdir(), 'agentry-home-'));
  const config = loadConfig({
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    AGENTRY_WORKSPACE_DIR: join(home, 'workspace'),
    AGENTRY_DATA_DIR: join(home, 'data'),
  });
  const explorer = new ConfigExplorer(config.configDir);
  mkdirSync(join(config.configDir, 'projects'), { recursive: true });
  writeFileSync(join(config.configDir, '.credentials.json'), '{"token":"secret"}');
  writeFileSync(join(config.configDir, 'projects', 'chat.jsonl'), '{}\n');
  symlinkSync(home, join(home, 'alias'));

  // Importing $HOME as a project would point the project root at the real config dir
  for (const root of [home, join(home, 'alias')]) {
    const scope = projectScope(root);
    await assert.rejects(explorer.read(scope, 'home', '.credentials.json'), /not editable/);
    await assert.rejects(explorer.read(scope, 'home', 'projects/chat.jsonl'), /not editable/);
    const names = (await explorer.tree(scope)).map((n) => n.name);
    assert.ok(!names.includes('.credentials.json') && !names.includes('projects'));
  }
});

test('parses `claude mcp list` health lines', () => {
  const health = parseMcpHealth(
    [
      'Checking MCP server health…',
      '',
      'claude.ai Claude Docs: https://api.example.com/v1/mcp - ✔ Connected',
      'openseo: https://seo.example.net/mcp (HTTP) - ! Needs authentication',
      'local-db: npx -y db-mcp --flag - ✘ Failed to connect',
    ].join('\n'),
  );
  assert.deepEqual(health, [
    { name: 'claude.ai Claude Docs', status: 'connected', detail: 'Connected' },
    { name: 'openseo', status: 'needs-auth', detail: 'Needs authentication' },
    { name: 'local-db', status: 'failed', detail: 'Failed to connect' },
  ]);
});
