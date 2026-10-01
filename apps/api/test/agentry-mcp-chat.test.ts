import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Core, loadConfig } from '@agentry/core';
import type { Project, WorkItem } from '@agentry/shared';
import { buildApp } from '../src/app.ts';

// A chat confined to Agentry's read tools answers from the wrapper that runs it: the fake CLI starts
// the server from the config file the core wrote (through tsx, as from source) and calls it over stdio.

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

let root: string;
let app: FastifyInstance;
let core: Core;
let project: Project;
let item: WorkItem;

const json = (body: unknown) => ({ payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentry-mcp-chat-'));
  core = new Core(
    loadConfig({
      CLAUDE_BIN: FAKE_CLAUDE,
      CSWAP_BIN: '/nonexistent/cswap',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
      AGENTRY_DATA_DIR: join(root, 'data'),
    }),
  );
  app = await buildApp(core, { logLevel: 'silent', webDist: join(root, 'no-ui') });
  // A real socket, so the server the fake CLI starts can reach the API
  await app.listen({ port: 0, host: '127.0.0.1' });
  core.runtime.apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  const dir = join(root, 'shop');
  mkdirSync(dir, { recursive: true });
  project = (await app.inject({ method: 'POST', url: '/api/projects/import', ...json({ path: dir, name: 'Shop', modules: ['board'] }) })).json<Project>();
  item = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/work-items`, ...json({ title: 'Cart loses items', type: 'bug', status: 'todo' }) })).json<WorkItem>();
});

after(async () => {
  core.shutdown();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

async function ask(prompt: string) {
  const launch = await core.agentryMcp();
  const chat = core.runtime.start({ prompt, cwd: join(root, 'shop'), ...launch });
  const result = await core.runtime.waitForResult(chat.id);
  const blocks = (core.runtime.messages(chat.id) ?? []).flatMap((entry) => entry.blocks ?? []);
  return { result, blocks };
}

test('a confined chat answers how an item is going from the wrapper that runs it', async () => {
  const { result, blocks } = await ask(`FAKE-MCP-CALL agentry get_work_item {"item":"${item.key}"}\nhow is ${item.key} going?`);
  assert.equal(result.isError, false, result.result);
  const call = blocks.find((b) => b.type === 'tool_use');
  assert.equal(call?.type === 'tool_use' ? call.name : null, 'mcp__agentry__get_work_item');
  const answer = blocks.find((b) => b.type === 'tool_result');
  assert.ok(answer?.type === 'tool_result' && !answer.isError, 'the tool answered');
  assert.match(answer.content, /Cart loses items/);
  assert.match(answer.content, /"status":"todo"/);
  assert.match(result.result, /Cart loses items/);
});

test('a tool outside the allow list is denied', async () => {
  const { result, blocks } = await ask('FAKE-MCP-CALL - Bash {"command":"ls"}\nlist the files');
  const answer = blocks.find((b) => b.type === 'tool_result');
  assert.ok(answer?.type === 'tool_result' && answer.isError);
  assert.match(answer.content, /denied/);
  assert.match(result.result, /Bash failed/);
});
