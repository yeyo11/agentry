import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { AssistantRunDetail, Chat, Project, WorkItem, WorkItemHistoryEntry } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// What a write made with a chat's token is recorded as: the audit actor under the open mode, and the
// actor and cause in the item's history. The person's own requests stay as they were.

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let root: string;
let app: FastifyInstance;
let core: Core;
let project: Project;
let assistantChat: string;
let plainChat: string;
let assistantToken: string;
let plainToken: string;

const post = (url: string, body: unknown, token?: string) => ({
  method: 'POST' as const,
  url,
  payload: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-api-assistant-writes-'));
  process.env.FAKE_CLAUDE_LOGGED_IN = '1';
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
  const dir = join(root, 'shop');
  mkdirSync(dir, { recursive: true });
  const imported = await app.inject(post('/api/projects/import', { path: dir, name: 'Shop', modules: ['board'] }));
  assert.equal(imported.statusCode, 201, imported.body);
  project = imported.json<Project>();
  assistantChat = (await app.inject(post('/api/assistant/chats', { prompt: 'hi' }))).json<Chat>().id;
  plainChat = (await app.inject(post('/api/chats', { prompt: 'hi' }))).json<Chat>().id;
  assistantToken = core.security.chatTokens.mint(assistantChat);
  plainToken = core.security.chatTokens.mint(plainChat);
});

after(async () => {
  delete process.env.FAKE_CLAUDE_LOGGED_IN;
  core.shutdown();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const history = async (itemId: string) => (await app.inject({ url: `/api/work-items/${itemId}/history` })).json<WorkItemHistoryEntry[]>();
const audit = async () => (await app.inject({ url: '/api/audit' })).json<{ entries: Array<{ actor: string; method: string; path: string }> }>().entries;

async function newItem(token?: string): Promise<WorkItem> {
  const res = await app.inject(post(`/api/projects/${project.id}/work-items`, { title: 'Cart', status: 'todo' }, token));
  assert.equal(res.statusCode, 201, res.body);
  return res.json<WorkItem>();
}

test('the open mode labels a request by its chat token, and an invalid token is still local and accepted', async () => {
  await newItem(assistantToken);
  assert.equal((await audit())[0]?.actor, `chat:${assistantChat}`);
  const wrong = await app.inject(post(`/api/projects/${project.id}/work-items`, { title: 'Wrong' }, 'agentry_chat_nope'));
  assert.equal(wrong.statusCode, 201);
  assert.equal((await audit())[0]?.actor, 'local');
  await newItem();
  assert.equal((await audit())[0]?.actor, 'local');
});

test("a chat's PATCH, move and comment record the agent and the chat, and the comment its source", async () => {
  const item = await newItem();
  const patched = await app.inject({ method: 'PATCH', url: `/api/work-items/${item.id}`, payload: JSON.stringify({ priority: 'high' }), headers: { 'content-type': 'application/json', authorization: `Bearer ${assistantToken}` } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((await app.inject(post(`/api/work-items/${item.id}/move`, { status: 'in_progress' }, assistantToken))).statusCode, 200);
  const commented = await app.inject(post(`/api/work-items/${item.id}/comments`, { body: 'looked at it' }, assistantToken));
  assert.equal(commented.statusCode, 201, commented.body);
  const written = (await history(item.id)).filter((e) => e.change !== 'created');
  assert.ok(written.length >= 2);
  for (const entry of written) {
    assert.deepEqual(entry.actor, { kind: 'agent', role: 'assistant' }, entry.change);
    assert.deepEqual(entry.cause, { kind: 'chat', chatId: assistantChat, orchestrationId: null, taskId: null, event: 'chat.api-write' }, entry.change);
  }
  const detail = (await app.inject({ url: `/api/work-items/${item.id}` })).json<{ comments: Array<{ author: unknown; source: unknown }> }>();
  assert.deepEqual(detail.comments[0]?.author, { kind: 'agent', role: 'assistant' });
  assert.deepEqual(detail.comments[0]?.source, { kind: 'chat', chatId: assistantChat, orchestrationId: null, taskId: null });
});

test('a chat that is not the assistant is an agent with no role, and creating through the assistant records its creation', async () => {
  const item = await newItem(assistantToken);
  const [created] = await history(item.id);
  assert.equal(created?.change, 'created');
  assert.deepEqual(created?.actor, { kind: 'agent', role: 'assistant' });
  assert.equal(created?.cause?.event, 'chat.api-write');

  const other = await newItem(plainToken);
  const [first] = await history(other.id);
  assert.deepEqual(first?.actor, { kind: 'agent', role: null });
  assert.equal(first?.cause?.chatId, plainChat);
});

test("the person's own requests are recorded as the person, with no cause", async () => {
  const item = await newItem();
  await app.inject(post(`/api/work-items/${item.id}/comments`, { body: 'mine' }));
  await app.inject(post(`/api/work-items/${item.id}/move`, { status: 'in_review' }));
  for (const entry of await history(item.id)) {
    assert.deepEqual(entry.actor, { kind: 'person', role: null }, entry.change);
    assert.equal(entry.cause, null, entry.change);
  }
});

test("a proposal decided with a chat's token is decided by an agent", async () => {
  const dir = join(root, 'notes');
  mkdirSync(dir, { recursive: true });
  const p = (await app.inject(post('/api/projects/import', { path: dir, name: 'Notas', template: 'software', modules: ['board', 'team'] }))).json<Project>();
  const run = (await app.inject(post(`/api/projects/${p.id}/assistant/runs`, { kind: 'project' }))).json<AssistantRunDetail>();
  const [first, second] = run.proposals;
  assert.ok(first && second);
  const accepted = await app.inject(post(`/api/assistant/proposals/${first.id}/accept`, {}, assistantToken));
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.deepEqual(accepted.json<{ decidedBy: unknown }>().decidedBy, { kind: 'agent', role: 'assistant' });
  const discarded = await app.inject(post(`/api/assistant/proposals/${second.id}/discard`, {}, assistantToken));
  assert.deepEqual(discarded.json<{ decidedBy: unknown }>().decidedBy, { kind: 'agent', role: 'assistant' });
});
