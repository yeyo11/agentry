import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ChatManager, type AccountResolver, type NewChat } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import type { PermissionBroker } from '../src/permissions.ts';
import type { UploadStore } from '../src/uploads.ts';
import { tempConfig } from './helpers.ts';

// The argv a chat hands the CLI, and the command wrapping it, pinned over the option matrix. The
// expectations live in fixtures/golden/claude-args.json; moving the code that builds them must not
// change a byte. UPDATE_GOLDEN=1 rewrites the file, which a change of behaviour has to justify.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/golden/claude-args.json', import.meta.url));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

interface Case {
  name: string;
  chat?: Partial<NewChat>;
  /** What to do after the first turn: continue the chat in place, or in a copy */
  then?: 'resume' | 'fork';
  account?: { managed: boolean; active?: string; configDir?: string | null };
  host?: boolean;
}

const CASES: Case[] = [
  { name: 'new' },
  { name: 'new, model and effort', chat: { model: 'opus', effort: 'high' } },
  { name: 'resume', then: 'resume' },
  { name: 'fork', then: 'fork' },
  { name: 'confined', chat: { confine: { tools: ['Read', 'Grep'], settingSources: [] } } },
  { name: 'confined with settings', chat: { confine: { tools: [], settingSources: ['user', 'project'] } } },
  { name: 'worktree', chat: { worktree: 'wt-one' } },
  { name: 'budget', chat: { maxBudgetUsd: 2.5 } },
  { name: 'no budget when zero', chat: { maxBudgetUsd: 0 } },
  { name: 'schema', chat: { jsonSchema: { type: 'object', properties: { verdict: { type: 'string' } } } } },
  { name: 'host prompts', host: true, chat: { permissionPrompts: 'host' } },
  { name: 'host prompts with nobody listening', chat: { permissionPrompts: 'host' } },
  {
    name: 'mcp and tool lists',
    chat: { allowedTools: ['Read', 'Bash(git status:*)'], disallowedTools: ['Write'], mcp: { config: '/tmp/mcp.json', servers: [] } as unknown as NewChat['mcp'] },
  },
  { name: 'agent', chat: { agent: 'reviewer', agentsFile: '/tmp/agents.json', appendSystemPrompt: 'be brief', systemPromptSnapshot: 'off' } },
  { name: 'no uploads', chat: { uploads: false } },
  { name: 'internal', chat: { internal: true } },
  { name: 'bypass mode', chat: { permissionMode: 'bypassPermissions' } },
  { name: 'account, not the active one', account: { managed: true, active: 'other' }, chat: { account: 'work' } },
  { name: 'account, the active one', account: { managed: true, active: 'work' }, chat: { account: 'work' } },
  { name: 'account with its own config dir', account: { managed: true, active: 'other', configDir: '/tmp/acct-config' }, chat: { account: 'work' } },
  { name: 'claude-swap not managing', account: { managed: false } },
];

async function argvOf(c: Case, dir: string): Promise<string[][]> {
  const spawns = join(dir, `${c.name.replace(/\W+/g, '-')}.spawns`);
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const chats = new ChatManager(config, db);
  chats.uploads = { dir: '/uploads' } as unknown as UploadStore;
  if (c.host) chats.permissions = { denyAllFor: () => undefined } as unknown as PermissionBroker;
  if (c.account) {
    const { managed, active, configDir = null } = c.account;
    const resolver: AccountResolver = {
      managed,
      bin: FAKE_CLAUDE,
      isActive: (id) => id === active,
      launchFor: ({ account }) => ({ account, configDir }),
    };
    chats.accounts = resolver;
  }
  try {
    const first = chats.start({ prompt: 'hello', name: 'golden', keepAlive: false, ...c.chat });
    await chats.exited(first.id);
    if (c.then === 'resume') {
      chats.resume(first.id, { prompt: 'again', keepAlive: false, ...(c.chat?.model ? { model: c.chat.model } : {}) });
      await chats.exited(first.id);
    } else if (c.then === 'fork') {
      // keepAlive is not a fork option in the types, and the manager honours it all the same
      const request = { prompt: 'again', keepAlive: false };
      const copy = chats.fork(first.id, request, { cwd: first.cwd, name: 'golden', model: null });
      await chats.exited(copy.id);
    }
  } finally {
    chats.stopAll();
    db.close();
  }
  const ids = new Map<string, string>();
  return readFileSync(spawns, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^\d+ /, '')
        .replace(UUID, (id) => {
          if (!ids.has(id)) ids.set(id, `<chat-${String(ids.size + 1)}>`);
          return ids.get(id) ?? id;
        })
        .split(' '),
    );
}

test('the argv and command of a chat are what they were before chats.ts was split', async () => {
  const dir = join(tempConfig().dataDir, 'args');
  mkdirSync(dir, { recursive: true });
  const actual: Record<string, string[][]> = {};
  for (const c of CASES) actual[c.name] = await argvOf(c, dir);
  if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
