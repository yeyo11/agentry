import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AGENTRY_MCP_READ_TOOLS } from '@agentry/mcp';
import { agentryMcp, MCP_ENTRY_ENV, mcpCommand } from '../src/agentry-mcp.ts';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// The helper writes a config holding only the `agentry` server and returns the confinement; a chat
// started with it is given exactly those flags.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const entry = (dir: string) => {
  const file = join(dir, 'mcp.mjs');
  writeFileSync(file, '');
  return file;
};

test('the config holds only the agentry server, with its URL and the chat variables by reference, at mode 0600', async () => {
  const { dataDir } = tempConfig();
  const mcpEntry = entry(dataDir);
  const launch = await agentryMcp({ dataDir, apiUrl: 'http://127.0.0.1:4321/api', version: '9.9.9', env: { [MCP_ENTRY_ENV]: mcpEntry }, execPath: '/usr/bin/node' });
  const file = JSON.parse(readFileSync(launch.mcp.config, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  assert.deepEqual(Object.keys(file.mcpServers), ['agentry']);
  const server = file.mcpServers.agentry;
  assert.equal(server?.command, '/usr/bin/node');
  assert.deepEqual(server?.args, [mcpEntry]);
  assert.equal(server?.env.AGENTRY_API_URL, 'http://127.0.0.1:4321/api');
  assert.equal(server?.env.AGENTRY_VERSION, '9.9.9');
  // The token is minted per process: the file never holds it, it points at the one the CLI has
  assert.equal(server?.env.AGENTRY_CHAT_ID, '${AGENTRY_CHAT_ID}');
  assert.equal(server?.env.AGENTRY_API_TOKEN, '${AGENTRY_API_TOKEN}');
  assert.equal(statSync(launch.mcp.config).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, 'mcp')).mode & 0o777, 0o700);
  assert.deepEqual(launch.allowedTools, [...AGENTRY_MCP_READ_TOOLS]);
  assert.deepEqual(launch.confine, { tools: [], settingSources: [] });
  assert.equal(launch.permissionMode, 'dontAsk');
});

test('from source the server starts through tsx on packages/mcp/src/main.ts', () => {
  const { command, args } = mcpCommand({}, '/usr/bin/node');
  assert.equal(command, '/usr/bin/node');
  assert.equal(args[0], '--import');
  assert.match(args[1] ?? '', /^file:.*tsx/);
  assert.ok(existsSync(args[2] ?? ''));
  assert.match(args[2] ?? '', /packages\/mcp\/src\/main\.ts$/);
});

test('it throws without the API address, and without a server that can start', async () => {
  const { dataDir } = tempConfig();
  await assert.rejects(agentryMcp({ dataDir, apiUrl: null, version: '1', env: {} }), /not listening/);
  await assert.rejects(agentryMcp({ dataDir, apiUrl: 'http://127.0.0.1:1/api', version: '1', env: { [MCP_ENTRY_ENV]: join(dataDir, 'missing.mjs') } }), /not at/);
  assert.equal(existsSync(join(dataDir, 'mcp')), false, 'no config is written for a server that cannot start');
});

test('a chat started with the helper gets the strict config, no built-in tool, no settings, the read tools and dontAsk', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const log = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  const core = new Core(config);
  try {
    core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
    const launch = await core.agentryMcp();
    const chat = core.runtime.start({ prompt: 'hello', cwd: config.workspaceDir, ...launch });
    const argv = await until(
      () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.includes(chat.id)) : []).map((l) => l.split(' ').slice(1))[0],
      'the process to start',
    );
    const flagged = (prefix: string) => argv.find((a) => a.startsWith(prefix));
    assert.equal(flagged('--mcp-config='), `--mcp-config=${launch.mcp.config}`);
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.ok(argv.includes('--tools='), 'an empty --tools');
    assert.ok(argv.includes('--setting-sources='));
    assert.equal(flagged('--allowedTools='), `--allowedTools=${AGENTRY_MCP_READ_TOOLS.join(',')}`);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv.includes('--add-dir'), false);
  } finally {
    core.shutdown();
  }
});
