import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_TOOL_PRESETS } from '../src/chat-tools.ts';
import { Core } from '../src/index.ts';
import { tempConfig } from './helpers.ts';

// A chat that picks nothing is started exactly as before. A preset becomes the tool flags, and a
// choice of MCP servers becomes a config file the CLI is given with --strict-mcp-config.

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

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const log = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = log;
  // Two servers a person configured for their user
  mkdirSync(dirname(config.globalConfigFile), { recursive: true });
  writeFileSync(
    config.globalConfigFile,
    JSON.stringify({
      mcpServers: {
        docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer secret' } },
        files: { command: 'npx', args: ['-y', 'files-mcp'], env: { TOKEN: 'secret' } },
      },
    }),
  );
  const core = new Core(config);
  /** The argv of every chat process started so far, oldest first */
  const spawns = (): string[][] =>
    (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [])
      .filter((line) => line.includes('--session-id') || line.includes('--resume'))
      .map((line) => line.split(' ').slice(1));
  return { config, core, spawns };
}

const flagged = (argv: string[] | undefined, prefix: string) => argv?.find((a) => a.startsWith(prefix));

/** Ends the process and waits until it is gone, so the chat can be resumed. */
async function stopped(core: Core, id: string): Promise<void> {
  core.runtime.stop(id);
  await until(() => core.runtime.get(id)?.pid === null, 'the process to exit');
}

test('the shipped presets are listed until the first edit, and edits are kept', async () => {
  const { core } = setup();
  try {
    assert.deepEqual(core.toolPresets.list().map((p) => p.id), DEFAULT_TOOL_PRESETS.map((p) => p.id));
    assert.ok(core.toolPresets.list().every((p) => p.builtIn));

    await core.toolPresets.upsert('review', { name: 'Review', allowedTools: ['Read', 'Grep', 'Read'], disallowedTools: ['Bash'] });
    const edited = await core.toolPresets.upsert('read-only', { name: 'Just reading', allowedTools: ['Read'] });
    assert.equal(edited.builtIn, true, 'an edited shipped preset is still the shipped one');

    const listed = core.toolPresets.list();
    assert.deepEqual(listed.find((p) => p.id === 'review'), { id: 'review', name: 'Review', allowedTools: ['Read', 'Grep'], disallowedTools: ['Bash'] });
    assert.equal(listed.find((p) => p.id === 'read-only')?.name, 'Just reading');
    // Once the file exists it is the whole truth: deleting a shipped one does not bring it back
    await core.toolPresets.remove('everything');
    assert.equal(core.toolPresets.get('everything'), undefined);
    await assert.rejects(core.toolPresets.remove('everything'), /not found/);
  } finally {
    core.shutdown();
  }
});

test('a preset is checked before it is stored', async () => {
  const { core } = setup();
  try {
    await assert.rejects(core.toolPresets.upsert('Bad Id', { name: 'x' }), /invalid preset id/);
    await assert.rejects(core.toolPresets.upsert('ok', { name: ' ' }), /name is required/);
    await assert.rejects(core.toolPresets.upsert('ok', { name: 'x', allowedTools: 'Read' }), /list of strings/);
    // The lists travel on one comma-separated flag
    await assert.rejects(core.toolPresets.upsert('ok', { name: 'x', allowedTools: ['Bash(a,b)'] }), /comma/);
    assert.equal(core.toolPresets.get('ok'), undefined);
  } finally {
    core.shutdown();
  }
});

test('a chat that picks nothing is started without any of the new flags', async () => {
  const { core, spawns } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'hello' });
    await until(() => spawns().length === 1, 'the process');
    const argv = spawns()[0];
    assert.equal(flagged(argv, '--allowedTools'), undefined);
    assert.equal(flagged(argv, '--disallowedTools'), undefined);
    assert.equal(flagged(argv, '--mcp-config'), undefined);
    assert.ok(!argv?.includes('--strict-mcp-config'));
    assert.equal((await core.chats.get(chat.id))?.tools, null);
  } finally {
    core.shutdown();
  }
});

test('a preset becomes the tool flags and is shown on the chat', async () => {
  const { core, spawns } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'look around', toolPreset: 'no-network' });
    await until(() => spawns().length === 1, 'the process');
    const argv = spawns()[0];
    const preset = core.toolPresets.get('no-network');
    assert.equal(flagged(argv, '--allowedTools='), `--allowedTools=${preset?.allowedTools.join(',')}`);
    assert.equal(flagged(argv, '--disallowedTools='), `--disallowedTools=${preset?.disallowedTools?.join(',')}`);

    const tools = (await core.chats.get(chat.id))?.tools;
    assert.equal(tools?.preset?.id, 'no-network');
    assert.deepEqual(tools?.disallowedTools, preset?.disallowedTools);
    assert.equal(tools?.mcp, null);
  } finally {
    core.shutdown();
  }
});

test('lists said outright win over the preset they came with, and an unknown preset is refused', async () => {
  const { core, spawns } = setup();
  try {
    await assert.rejects(core.chats.create({ prompt: 'x', toolPreset: 'nope' }), /tool preset 'nope' not found/);
    assert.equal(spawns().length, 0, 'nothing was started');

    await core.chats.create({ prompt: 'x', toolPreset: 'read-only', allowedTools: ['Read', 'Bash(ls:*)'] });
    await until(() => spawns().length === 1, 'the process');
    assert.equal(flagged(spawns()[0], '--allowedTools='), '--allowedTools=Read,Bash(ls:*)');
    // What it did not say still comes from the preset
    assert.match(flagged(spawns()[0], '--disallowedTools=') ?? '', /Edit,Write/);
  } finally {
    core.shutdown();
  }
});

test('choosing MCP servers writes a private config with only those and makes it strict', async () => {
  const { core, spawns } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'x', mcp: { servers: ['files'] } });
    await until(() => spawns().length === 1, 'the process');
    const argv = spawns()[0];
    const file = flagged(argv, '--mcp-config=')?.slice('--mcp-config='.length);
    assert.ok(file, 'the config is passed');
    assert.ok(argv?.includes('--strict-mcp-config'));

    // The secrets a server carries are copied into it, so nobody else may read it
    const written = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(written.mcpServers), ['files']);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const tools = (await core.chats.get(chat.id))?.tools;
    assert.deepEqual(tools?.mcp, { servers: ['files'], config: file });
    // Only what was picked is reported: the flags of the tool half stay off
    assert.equal(flagged(argv, '--allowedTools'), undefined);
  } finally {
    core.shutdown();
  }
});

test('an empty selection starts the chat with no MCP server at all, and an unknown one is refused', async () => {
  const { core, spawns, config } = setup();
  try {
    await assert.rejects(core.chats.create({ prompt: 'x', mcp: { servers: ['ghost'] } }), /MCP server 'ghost' is not configured/);
    await core.chats.create({ prompt: 'x', mcp: { servers: [] } });
    await until(() => spawns().length === 1, 'the process');
    const file = flagged(spawns()[0], '--mcp-config=')?.slice('--mcp-config='.length) ?? '';
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mcpServers: {} });
    assert.ok(spawns()[0]?.includes('--strict-mcp-config'));
    assert.ok(file.startsWith(config.dataDir));
  } finally {
    core.shutdown();
  }
});

test('a project server is offered to a chat that starts in that project', async () => {
  const { core, spawns, config } = setup();
  try {
    const cwd = join(config.workspaceDir, 'app');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['srv.js'] } } }));
    await core.chats.create({ prompt: 'x', cwd, mcp: { servers: ['local', 'docs'] } });
    await until(() => spawns().length === 1, 'the process');
    const file = flagged(spawns()[0], '--mcp-config=')?.slice('--mcp-config='.length) ?? '';
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: object }).mcpServers), ['local', 'docs']);
  } finally {
    core.shutdown();
  }
});

test('a resumed chat keeps what it had unless it picks again, and can go back to the default servers', async () => {
  const { core, spawns } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'x', toolPreset: 'read-only', mcp: { servers: ['docs'] } });
    await until(() => spawns().length === 1, 'the first process');
    await stopped(core, chat.id);

    // Nothing picked: the same tools and servers again
    await core.chats.resume(chat.id, { prompt: 'again' });
    await until(() => spawns().length === 2, 'the second process');
    assert.equal(flagged(spawns()[1], '--allowedTools='), flagged(spawns()[0], '--allowedTools='));
    assert.equal(flagged(spawns()[1], '--mcp-config='), flagged(spawns()[0], '--mcp-config='));
    await stopped(core, chat.id);

    // A different preset replaces the tools and leaves the servers alone
    await core.chats.resume(chat.id, { prompt: 'wider', toolPreset: 'everything' });
    await until(() => spawns().length === 3, 'the third process');
    assert.notEqual(flagged(spawns()[2], '--allowedTools='), flagged(spawns()[0], '--allowedTools='));
    assert.equal(flagged(spawns()[2], '--mcp-config='), flagged(spawns()[0], '--mcp-config='));
    assert.equal((await core.chats.get(chat.id))?.tools?.preset?.id, 'everything');
    await stopped(core, chat.id);

    // `null` is the CLI's own choice of servers again
    await core.chats.resume(chat.id, { prompt: 'default', mcp: null });
    await until(() => spawns().length === 4, 'the fourth process');
    assert.equal(flagged(spawns()[3], '--mcp-config'), undefined);
    assert.ok(!spawns()[3]?.includes('--strict-mcp-config'));
    assert.equal((await core.chats.get(chat.id))?.tools?.mcp, null);
    assert.equal(flagged(spawns()[3], '--allowedTools='), flagged(spawns()[2], '--allowedTools='));
  } finally {
    core.shutdown();
  }
});

test('the tools a chat runs with survive a restart of the wrapper', async () => {
  const { core, spawns, config } = setup();
  let chatId = '';
  try {
    const chat = await core.chats.create({ prompt: 'x', toolPreset: 'read-only', mcp: { servers: ['files'] } });
    chatId = chat.id;
    await until(() => spawns().length === 1, 'the process');
    await stopped(core, chat.id);
  } finally {
    core.shutdown();
  }

  const again = new Core(config);
  try {
    await until(() => again.runtime.get(chatId), 'the chat to be restored');
    const tools = again.runtime.get(chatId)?.tools;
    assert.equal(tools?.preset?.id, 'read-only');
    assert.deepEqual(tools?.mcp?.servers, ['files']);

    await again.chats.resume(chatId, { prompt: 'after the restart' });
    await until(() => spawns().length === 2, 'the resumed process');
    assert.equal(flagged(spawns()[1], '--allowedTools='), flagged(spawns()[0], '--allowedTools='));
    assert.ok(flagged(spawns()[1], '--mcp-config='));
  } finally {
    again.shutdown();
  }
});
