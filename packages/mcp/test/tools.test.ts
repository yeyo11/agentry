import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { AGENTRY_MCP_READ_TOOLS, AGENTRY_MCP_READ_TOOL_NAMES } from '../src/names.ts';
import { ApiError, createClient } from '../src/client.ts';
import { RESULT_MAX_CHARS, createServer, render } from '../src/server.ts';
import { TOOLS } from '../src/tools.ts';
import { injectFetch, seed, type Seeded } from './fixture.ts';

let s: Seeded;
before(async () => {
  s = await seed();
});
after(() => s.close());

const rpc = (server: ReturnType<typeof createServer>, method: string, params?: unknown) =>
  server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })).then((line) => JSON.parse(line ?? 'null') as Record<string, any>);

test('the catalogue is the list of names, and every tool has a description and a strict schema', async () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    [...AGENTRY_MCP_READ_TOOL_NAMES],
  );
  assert.deepEqual(AGENTRY_MCP_READ_TOOLS, AGENTRY_MCP_READ_TOOL_NAMES.map((n) => `mcp__agentry__${n}`));
  const server = createServer({ api: createClient({ baseUrl: 'http://x/api', fetch: injectFetch(s.app) }), version: '1.2.3' });
  const listed = (await rpc(server, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { additionalProperties: unknown } }>;
  assert.deepEqual(listed.map((t) => t.name), [...AGENTRY_MCP_READ_TOOL_NAMES]);
  for (const tool of listed) {
    assert.ok(tool.description.length > 10, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  const init = (await rpc(server, 'initialize', { protocolVersion: '2024-11-05' })).result;
  assert.deepEqual([init.protocolVersion, init.serverInfo, init.capabilities], ['2024-11-05', { name: 'agentry', version: '1.2.3' }, { tools: {} }]);
  assert.equal((await rpc(server, 'initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.equal((await rpc(server, 'nope')).error.code, -32601);
  assert.equal(JSON.parse((await server.handleLine('{not json')) ?? '').error.code, -32700);
});

test('every tool is called once and answers with the seeded data', async () => {
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ['list_projects', {}, 'Shop'],
    ['get_overview', {}, '{'],
    ['get_board', { projectId: s.project.id }, 'Cart loses items'],
    ['get_work_item', { item: s.item.key.toLowerCase() }, 'Cart loses items'],
    ['list_orchestrations', { limit: 5 }, s.orchestration.id],
    ['get_orchestration', { orchestrationId: s.orchestration.id }, s.orchestration.id],
    ['get_team', { projectId: s.project.id }, '{'],
    ['list_flow_runs', { projectId: s.project.id }, 'run-1'],
    ['get_journal', { projectId: s.project.id }, '{'],
    ['list_documents', { projectId: s.project.id }, 'plan.md'],
    ['read_document', { projectId: s.project.id, path: 'docs/plan.md' }, '# Shop plan'],
    ['list_chats', {}, '['],
    ['get_usage', { from: '2026-09-01', to: '2026-09-30' }, 'breakdown'],
    ['list_accounts', {}, '{'],
  ];
  for (const [name, args, expected] of calls) {
    const result = await s.call(name, args);
    assert.equal(result.isError, false, `${name}: ${result.text}`);
    assert.ok(result.text.includes(expected), `${name} should mention ${expected}: ${result.text.slice(0, 200)}`);
  }
  // get_chat needs a chat: an unknown one is a 404, which is the call being made and answered
  const chat = await s.call('get_chat', { chatId: 'nope' });
  assert.equal(chat.isError, true);
  assert.match(chat.text, /404/);
  const covered = new Set([...calls.map(([n]) => n), 'get_chat']);
  assert.deepEqual([...covered].sort(), [...AGENTRY_MCP_READ_TOOL_NAMES].sort());
});

test('get_work_item merges the item, its history, links and flow runs, by key in any case or by id', async () => {
  for (const item of [s.item.key.toLowerCase(), s.item.key, s.item.id]) {
    const { json, isError } = await s.call('get_work_item', { item });
    assert.equal(isError, false, item);
    const detail = json as { title: string; status: string; history: unknown[]; links: unknown[]; runs: Array<{ id: string }> };
    assert.equal(detail.title, 'Cart loses items');
    assert.equal(detail.status, 'todo');
    assert.ok(detail.history.length >= 1);
    assert.ok(Array.isArray(detail.links));
    assert.deepEqual(detail.runs.map((r) => r.id), ['run-1']);
  }
});

test('an unknown id or key is an error result with the 404 text', async () => {
  for (const [name, args] of [['get_work_item', { item: `${s.item.key.split('-')[0]}-999` }], ['get_orchestration', { orchestrationId: 'nope' }], ['get_team', { projectId: 'nope' }]] as const) {
    const result = await s.call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.text, /404/, name);
  }
});

test('an input that fails the schema is an error result and no request is made', async () => {
  const seen: Array<{ url: string }> = [];
  const server = createServer({ api: createClient({ baseUrl: 'http://x/api', fetch: injectFetch(s.app, seen as never) }), version: 't' });
  for (const args of [{}, { item: 5 }, { item: s.item.key, extra: true }]) {
    const out = (await rpc(server, 'tools/call', { name: 'get_work_item', arguments: args })).result;
    assert.equal(out.isError, true);
  }
  assert.equal((await rpc(server, 'tools/call', { name: 'get_chat', arguments: { chatId: '' } })).result.isError, true);
  assert.equal((await rpc(server, 'tools/call', { name: 'list_chats', arguments: { limit: 500 } })).result.isError, true);
  assert.equal((await rpc(server, 'tools/call', { name: 'no_such_tool', arguments: {} })).result.isError, true);
  assert.equal(seen.length, 0);
});

test('a result over the cap is cut and says so', () => {
  const out = render({ text: 'x'.repeat(RESULT_MAX_CHARS * 2) });
  assert.ok(out.length < RESULT_MAX_CHARS + 500);
  assert.match(out, /"truncated":true/);
  assert.equal(render({ a: 1 }), '{"a":1}');
});

test('the token and the chat id are sent when set, and not otherwise', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
  const fetch = injectFetch(s.app, seen);
  await createClient({ baseUrl: 'http://x/api', fetch }).get('/projects');
  assert.equal(seen[0]?.headers.authorization, undefined);
  assert.equal(seen[0]?.headers['x-agentry-chat'], undefined);
  await createClient({ baseUrl: 'http://x/api', token: 'tok', chatId: 'chat-1', fetch }).get('/projects', { a: 'b' });
  assert.equal(seen[1]?.headers.authorization, 'Bearer tok');
  assert.equal(seen[1]?.headers['x-agentry-chat'], 'chat-1');
  assert.equal(seen[1]?.url, 'http://x/api/projects?a=b');
});

test('the client refuses every method but GET, before a request is made', async () => {
  const seen: unknown[] = [];
  const client = createClient({ baseUrl: 'http://x/api', fetch: injectFetch(s.app, seen as never) });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(client.request(method, '/projects'), ApiError);
  assert.equal(seen.length, 0);
});

test('a guarded API says what is missing, and a wrong wrapper is named', async () => {
  const guarded = createClient({ baseUrl: 'http://x/api', fetch: async () => ({ status: 401, text: async () => '{"error":"unauthorized"}' }) });
  await assert.rejects(guarded.get('/projects'), /guarded and this chat has no token/);
  const down = createClient({
    baseUrl: 'http://wrong.test:1/api',
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(down.get('/projects'), /could not reach http:\/\/wrong\.test:1\/api: ECONNREFUSED/);
});

test('packages/mcp/src holds no default URL or port', () => {
  const dir = fileURLToPath(new URL('../src', import.meta.url));
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(source, /localhost:|127\.0\.0\.1:|0\.0\.0\.0:/, file);
  }
});
