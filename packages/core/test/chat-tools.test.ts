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

test('a default preset is taken by a new chat that picks no tools, and can be refused', async () => {
  const { core, spawns } = setup();
  try {
    assert.equal(core.toolPresets.overview().defaultPresetId, null, 'a fresh install has no default');
    await assert.rejects(core.toolPresets.setDefault({ defaultPresetId: 'ghost' }), /tool preset 'ghost' not found/);
    await assert.rejects(core.toolPresets.setDefault({ defaultPresetId: 3 }), /preset id or null/);
    assert.deepEqual(await core.toolPresets.setDefault({ defaultPresetId: 'no-network' }), { defaultPresetId: 'no-network' });
    assert.equal(core.toolPresets.overview().defaultPresetId, 'no-network');
    // Its rules hold no spaces, which keeps them whole in the spawn log
    const noNetwork = core.toolPresets.get('no-network');

    // Nothing picked: the default
    const plain = await core.chats.create({ prompt: 'x' });
    await until(() => spawns().length === 1, 'the first process');
    assert.equal(flagged(spawns()[0], '--allowedTools='), `--allowedTools=${noNetwork?.allowedTools.join(',')}`);
    assert.equal((await core.chats.get(plain.id))?.tools?.preset?.id, 'no-network');

    // Only disallowed tools said: still the default, with that list winning over the preset's
    await core.chats.create({ prompt: 'x', disallowedTools: ['WebFetch'] });
    await until(() => spawns().length === 2, 'the second process');
    assert.equal(flagged(spawns()[1], '--allowedTools='), `--allowedTools=${noNetwork?.allowedTools.join(',')}`);
    assert.equal(flagged(spawns()[1], '--disallowedTools='), '--disallowedTools=WebFetch');

    // An explicit list, another preset or `null` each keep the default out
    await core.chats.create({ prompt: 'x', allowedTools: ['Read'] });
    await until(() => spawns().length === 3, 'the third process');
    assert.equal(flagged(spawns()[2], '--allowedTools='), '--allowedTools=Read');
    assert.equal(flagged(spawns()[2], '--disallowedTools'), undefined);

    await core.chats.create({ prompt: 'x', toolPreset: 'everything' });
    await until(() => spawns().length === 4, 'the fourth process');
    assert.match(flagged(spawns()[3], '--allowedTools=') ?? '', /WebSearch/);

    const optedOut = await core.chats.create({ prompt: 'x', toolPreset: null });
    await until(() => spawns().length === 5, 'the fifth process');
    assert.equal(flagged(spawns()[4], '--allowedTools'), undefined);
    assert.equal(flagged(spawns()[4], '--disallowedTools'), undefined);
    assert.equal((await core.chats.get(optedOut.id))?.tools?.preset ?? null, null);

    // The default lives in the same document, and goes with its preset
    await core.toolPresets.remove('no-network');
    assert.equal(core.toolPresets.overview().defaultPresetId, null);
    assert.equal(core.toolPresets.defaultPreset(), null);
    // `default` names the route that sets it, so no preset may take it
    await assert.rejects(core.toolPresets.upsert('default', { name: 'x' }), /reserved/);
  } finally {
    core.shutdown();
  }
});

test('restoring the shipped presets rewrites those three and leaves the rest alone', async () => {
  const { core } = setup();
  try {
    await core.toolPresets.upsert('read-only', { name: 'Just reading', allowedTools: ['Read'] });
    await core.toolPresets.remove('everything');
    await core.toolPresets.upsert('review', { name: 'Review', allowedTools: ['Read', 'Grep'] });
    await core.toolPresets.setDefault({ defaultPresetId: 'review' });

    const restored = await core.toolPresets.restore();
    assert.equal(restored.defaultPresetId, 'review', 'the default is not touched');
    for (const shipped of DEFAULT_TOOL_PRESETS) {
      assert.deepEqual(core.toolPresets.get(shipped.id), { ...shipped, disallowedTools: shipped.disallowedTools ?? [] }, `${shipped.id} is as it ships`);
    }
    assert.deepEqual(core.toolPresets.get('review'), { id: 'review', name: 'Review', allowedTools: ['Read', 'Grep'], disallowedTools: [] });
    // An edited one keeps its place; a deleted one comes back at the end
    assert.deepEqual(core.toolPresets.list().map((p) => p.id), ['read-only', 'no-network', 'review', 'everything']);
    assert.deepEqual(restored.presets, core.toolPresets.list());
  } finally {
    core.shutdown();
  }
});

test('a fork runs with the tools and servers of its source unless it picks others', async () => {
  const { core, spawns } = setup();
  try {
    const source = await core.chats.create({ prompt: 'x', toolPreset: 'read-only', allowedTools: ['Read'], mcp: { servers: ['files'] } });
    await until(() => spawns().length === 1, 'the source process');
    await stopped(core, source.id);

    const copy = await core.chats.fork(source.id, { prompt: 'go on elsewhere' });
    await until(() => spawns().length === 2, 'the fork process');
    const argv = spawns()[1];
    assert.ok(argv?.includes('--fork-session'), 'it is a fork');
    assert.equal(flagged(argv, '--allowedTools='), '--allowedTools=Read');
    assert.equal(flagged(argv, '--disallowedTools='), flagged(spawns()[0], '--disallowedTools='));
    assert.equal(flagged(argv, '--mcp-config='), flagged(spawns()[0], '--mcp-config='));
    assert.ok(argv?.includes('--strict-mcp-config'));
    const tools = (await core.chats.get(copy.id))?.tools;
    assert.equal(tools?.preset?.id, 'read-only');
    assert.deepEqual(tools?.allowedTools, ['Read']);
    assert.deepEqual(tools?.mcp?.servers, ['files']);

    // Picking a preset replaces the tools and still carries the servers
    const wider = await core.chats.fork(source.id, { prompt: 'wider', toolPreset: 'everything' });
    await until(() => spawns().length === 3, 'the second fork');
    assert.match(flagged(spawns()[2], '--allowedTools=') ?? '', /WebSearch/);
    assert.equal(flagged(spawns()[2], '--mcp-config='), flagged(spawns()[0], '--mcp-config='));
    assert.equal((await core.chats.get(wider.id))?.tools?.preset?.id, 'everything');

    // `toolPreset: null` with `mcp: null` is a fork with the CLI's own of both
    await core.chats.fork(source.id, { prompt: 'bare', toolPreset: null, mcp: null });
    await until(() => spawns().length === 4, 'the third fork');
    assert.equal(flagged(spawns()[3], '--allowedTools'), undefined);
    assert.equal(flagged(spawns()[3], '--mcp-config'), undefined);
  } finally {
    core.shutdown();
  }
});

test('a resume that picks no servers starts them as they are defined now', async () => {
  const { core, spawns, config } = setup();
  try {
    const chat = await core.chats.create({ prompt: 'x', mcp: { servers: ['docs', 'files'] } });
    await until(() => spawns().length === 1, 'the first process');
    await stopped(core, chat.id);

    // A person edits one server and removes the other
    writeFileSync(config.globalConfigFile, JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/v2/mcp' } } }));

    await core.chats.resume(chat.id, { prompt: 'again' });
    await until(() => spawns().length === 2, 'the resumed process');
    const file = flagged(spawns()[1], '--mcp-config=')?.slice('--mcp-config='.length) ?? '';
    assert.ok(spawns()[1]?.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mcpServers: { docs: { type: 'http', url: 'https://docs.example/v2/mcp' } } });
    assert.deepEqual((await core.chats.get(chat.id))?.tools?.mcp, { servers: ['docs'], config: file });
  } finally {
    core.shutdown();
  }
});
