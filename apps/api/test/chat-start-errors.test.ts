import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ChatRefusal, Core, loadConfig } from '@agentry/core';
import type { Project, WorkItem } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// What a chat that fails to start answers: a refusal keeps its 4xx, and anything else is the
// server's, a 500 that still says what went wrong. The runtime's start is replaced, so nothing here
// spawns Claude or reads the real ~/.claude.
let app: FastifyInstance;
let core: Core;
let project: Project;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-chat-start-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  const dir = mkdtempSync(join(tmpdir(), 'agentry-api-chat-start-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# Shop\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name: 'Shop', modules: ['board'] }) });
  assert.equal(res.statusCode, 201, res.body);
  project = res.json<Project>();
});

after(async () => {
  await app.close();
  core.shutdown();
});

async function workOn(title: string) {
  const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title }) });
  assert.equal(created.statusCode, 201, created.body);
  const item = created.json<WorkItem>();
  return { item, res: await app.inject({ method: 'POST', url: `/api/work-items/${item.id}/work`, ...json({}) }) };
}

test('a generic error while "Work on it" creates its chat answers 500 with its message', async () => {
  const start = core.runtime.start.bind(core.runtime);
  core.runtime.start = () => {
    throw new Error('the CLI binary is not executable');
  };
  try {
    const { item, res } = await workOn('Generic');
    assert.equal(res.statusCode, 500, res.body);
    assert.match(res.json<{ error: string }>().error, /the chat could not start: the CLI binary is not executable/);
    // Nothing is left half done: the item did not move
    assert.equal(core.workItems.find(item.id)?.status, 'backlog');

    // The same over the chats route
    const chat = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi' }) });
    assert.equal(chat.statusCode, 500, chat.body);
    assert.match(chat.json<{ error: string }>().error, /not executable/);
  } finally {
    core.runtime.start = start;
  }
});

test('a known refusal while "Work on it" creates its chat keeps its 4xx', async () => {
  const start = core.runtime.start.bind(core.runtime);
  core.runtime.start = () => {
    throw new ChatRefusal('Concurrent run limit reached (1)');
  };
  try {
    const { res } = await workOn('Refused');
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json<{ error: string }>().error, /Concurrent run limit reached/);
  } finally {
    core.runtime.start = start;
  }
  // A refusal of the request itself, before any chat: still a 4xx
  const bad = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: '' }) });
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500, `${bad.statusCode} ${bad.body}`);
  const agents = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', agentsFile: '/etc/passwd' }) });
  assert.equal(agents.statusCode, 400, agents.body);
});

test('a chat on a provider with no session driver is refused with a 400', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', provider: 'nope' }) });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json<{ error: string }>().error, /cannot run chats/);
  const bad = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', provider: 7 }) });
  assert.equal(bad.statusCode, 400, bad.body);
});

test('a request the provider cannot honour is refused by capability, and a listed chat has a provider', async () => {
  const manifest = core.runtime.providers.get('claude-code');
  assert.ok(manifest);
  const declared = manifest.capabilities;
  try {
    manifest.capabilities = declared.filter((c) => c !== 'budgetLimit');
    const refused = await app.inject({ method: 'POST', url: '/api/chats', ...json({ prompt: 'hi', maxBudgetUsd: 1 }) });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.json<{ error: string }>().error, /"budgetLimit" capability/);
  } finally {
    manifest.capabilities = declared;
  }
  const list = await app.inject({ method: 'GET', url: '/api/chats' });
  assert.equal(list.statusCode, 200, list.body);
  for (const chat of list.json<Array<{ provider?: string }>>()) assert.equal(chat.provider, 'claude-code');
});
