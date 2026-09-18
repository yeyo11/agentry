import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpConfig } from '../src/config/mcp.ts';
import { userScope } from '../src/config/scope.ts';
import { Plugins } from '../src/plugins.ts';
import { tempConfig } from './helpers.ts';

// Identifiers become CLI arguments; anything flag-like must be rejected before the CLI is spawned.
test('rejects identifiers that would be parsed as CLI flags', async () => {
  const config = { ...tempConfig(), claudeBin: '/nonexistent/claude' }; // proves validation happens first
  const plugins = new Plugins(config);
  for (const bad of ['--help', '-x', 'name@--flag', 'a b', '', 42, undefined]) {
    assert.throws(() => plugins.install(bad), /invalid plugin id/, String(bad));
    assert.throws(() => plugins.details(bad), /invalid plugin id/);
  }
  assert.throws(() => plugins.install('ok@market', 'global' as never), /scope must be/);
  for (const bad of ['--help', '-p', 'a;b', 'x y', '']) assert.throws(() => plugins.addMarketplace(bad), /invalid marketplace source/, bad);
  assert.throws(() => plugins.removeMarketplace('--all'), /invalid marketplace name/);
  assert.throws(() => plugins.updateMarketplace('-x'), /invalid marketplace name/);

  const mcp = new McpConfig(config);
  await assert.rejects(mcp.upsert(userScope(config), 'user', '--scope', { command: 'x' }), /invalid server name/);
  await assert.rejects(mcp.remove(userScope(config), 'user', '-s'), /invalid server name/);
});
