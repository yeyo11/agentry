import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENTRY_MCP_READ_TOOLS, AGENTRY_MCP_WRITE_TOOLS, AGENTRY_MCP_WRITE_TOOL_NAMES, isAgentryMcpWriteTool } from '../src/names.ts';
import { createClient, type FetchLike } from '../src/client.ts';
import { createServer } from '../src/server.ts';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** A stand-in for the API: it records each request and answers from a table by `METHOD /path` */
function stub(routes: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/api/, '');
    seen.push({ method: init.method, url: path, authorization: init.headers.authorization, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const route = routes[`${init.method} ${path}`] ?? { status: 404, body: { error: 'not found' } };
    return { status: route.status ?? 200, text: async () => JSON.stringify(route.body) };
  };
  const server = createServer({ api: createClient({ baseUrl: 'http://x/api', token: 'tok', chatId: 'c1', fetch }), version: 't' });
  let n = 0;
  const call = async (name: string, args: unknown) => {
    const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }));
    const result = (JSON.parse(line ?? 'null') as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    return { isError: result.isError, text: result.content[0]?.text ?? '' };
  };
  return { seen, call };
}

const item = { id: 'item_one', key: 'AGN-7', title: 'Cart', status: 'todo', description: 'long text that is not echoed', history: [1, 2, 3] };

test('the write tools are named and never pre-allowed', () => {
  assert.equal(AGENTRY_MCP_WRITE_TOOL_NAMES.length, 9);
  for (const tool of AGENTRY_MCP_WRITE_TOOLS) {
    assert.ok(isAgentryMcpWriteTool(tool));
    assert.ok(!AGENTRY_MCP_READ_TOOLS.includes(tool));
  }
});

test('each tool sends its one route, its body and the token', async () => {
  const s = stub({
    'POST /projects/p1/work-items': { status: 201, body: item },
    'GET /work-items/by-key/AGN-7': { body: item },
    'PATCH /work-items/item_one': { body: item },
    'POST /work-items/item_one/move': { body: { item, column: { status: 'in_progress', count: 2 } } },
    'POST /work-items/item_one/comments': { status: 201, body: { id: 'cm-1', body: 'hello' } },
    'POST /flow-runs/run-1/retry': { status: 201, body: { id: 'run-2', state: 'queued', error: null } },
    'POST /orchestrations/o1/tasks/t1/retry': { body: { id: 'o1', state: 'running', tasks: [1, 2, 3] } },
    'GET /projects/p1': { body: { id: 'p1', path: '/work/shop' } },
    'POST /chats': { status: 201, body: { id: 'chat-9', state: 'working' } },
    'POST /assistant/proposals/pr1/accept': { body: { id: 'pr1', status: 'accepted' } },
    'POST /assistant/proposals/pr1/discard': { body: { id: 'pr1', status: 'discarded' } },
  });
  const calls: Array<[string, Record<string, unknown>, string, string, unknown]> = [
    ['create_work_item', { projectId: 'p1', title: 'Cart', labels: ['a'], acceptanceCriteria: [{ text: 'works' }] }, 'POST', '/projects/p1/work-items', { title: 'Cart', labels: ['a'], acceptanceCriteria: [{ text: 'works' }] }],
    ['update_work_item', { item: 'agn-7', priority: 'high' }, 'PATCH', '/work-items/item_one', { priority: 'high' }],
    ['move_work_item', { item: 'item_one', status: 'in_progress', afterId: 'x' }, 'POST', '/work-items/item_one/move', { status: 'in_progress', afterId: 'x' }],
    ['comment_work_item', { item: 'AGN-7', body: 'hello' }, 'POST', '/work-items/item_one/comments', { body: 'hello' }],
    ['retry_flow_run', { runId: 'run-1' }, 'POST', '/flow-runs/run-1/retry', {}],
    ['retry_orchestration_task', { orchestrationId: 'o1', taskId: 't1' }, 'POST', '/orchestrations/o1/tasks/t1/retry', {}],
    ['start_chat', { prompt: 'go', projectId: 'p1', model: 'sonnet' }, 'POST', '/chats', { prompt: 'go', cwd: '/work/shop', model: 'sonnet' }],
    ['accept_assistant_proposal', { proposalId: 'pr1' }, 'POST', '/assistant/proposals/pr1/accept', {}],
    ['discard_assistant_proposal', { proposalId: 'pr1' }, 'POST', '/assistant/proposals/pr1/discard', {}],
  ];
  const covered: string[] = [];
  for (const [name, args, method, path, body] of calls) {
    s.seen.length = 0;
    const out = await s.call(name, args);
    assert.equal(out.isError, false, `${name}: ${out.text}`);
    const sent = s.seen.at(-1);
    assert.deepEqual([sent?.method, sent?.url, sent?.body], [method, path, body], name);
    assert.ok(s.seen.every((r) => r.authorization === 'Bearer tok'), name);
    covered.push(name);
  }
  assert.deepEqual(covered, [...AGENTRY_MCP_WRITE_TOOL_NAMES]);
});

test('a key is resolved through the by-key route, an id is not', async () => {
  const s = stub({ 'GET /work-items/by-key/AGN-7': { body: item }, 'POST /work-items/item_one/comments': { status: 201, body: { id: 'cm' } } });
  await s.call('comment_work_item', { item: 'agn-7', body: 'x' });
  assert.deepEqual(s.seen.map((r) => `${r.method} ${r.url}`), ['GET /work-items/by-key/AGN-7', 'POST /work-items/item_one/comments']);
  s.seen.length = 0;
  await s.call('comment_work_item', { item: 'item_one', body: 'x' });
  assert.deepEqual(s.seen.map((r) => `${r.method} ${r.url}`), ['POST /work-items/item_one/comments']);
});

test('the result carries what identifies it and nothing of the rest', async () => {
  const s = stub({ 'PATCH /work-items/item_one': { body: item } });
  const out = await s.call('update_work_item', { item: 'item_one', title: 'Cart' });
  assert.deepEqual(JSON.parse(out.text), { id: 'item_one', key: 'AGN-7', title: 'Cart', status: 'todo' });
});

test('move_work_item refuses done without calling the API', async () => {
  const s = stub({});
  const out = await s.call('move_work_item', { item: 'item_one', status: 'done' });
  assert.equal(out.isError, true);
  assert.match(out.text, /Done themselves/);
  assert.equal(s.seen.length, 0);
});

test('start_chat has no field that widens a chat, and sends none', async () => {
  const s = stub({ 'POST /chats': { status: 201, body: { id: 'c' } } });
  for (const field of ['permissionMode', 'allowedTools', 'disallowedTools', 'toolPreset', 'mcp', 'account', 'confine', 'permissionPrompts']) {
    const out = await s.call('start_chat', { prompt: 'go', [field]: field === 'mcp' ? null : 'bypassPermissions' });
    assert.equal(out.isError, true, field);
    assert.match(out.text, /unknown argument/);
  }
  assert.equal(s.seen.length, 0);
});

test('an input the schema rejects makes no request', async () => {
  const s = stub({});
  const bad: Array<[string, unknown]> = [
    ['create_work_item', { projectId: 'p1' }],
    ['create_work_item', { projectId: 'p1', title: 'x', type: 'saga' }],
    ['create_work_item', { projectId: 'p1', title: 'x', acceptanceCriteria: [{ text: 'a', extra: 1 }] }],
    ['create_work_item', { projectId: 'p1', title: 'x', labels: 'a' }],
    ['update_work_item', { item: 'item_one', status: 'done' }],
    ['move_work_item', { item: 'item_one', status: 'later' }],
    ['comment_work_item', { item: 'item_one', body: '' }],
    ['retry_flow_run', {}],
    ['retry_orchestration_task', { orchestrationId: 'o1' }],
    ['accept_assistant_proposal', { proposalId: 'p', extra: true }],
    ['discard_assistant_proposal', { proposalId: 5 }],
  ];
  for (const [name, args] of bad) assert.equal((await s.call(name, args)).isError, true, `${name} ${JSON.stringify(args)}`);
  assert.equal(s.seen.length, 0);
});

test('a 4xx from the route is an error result with its status and text, and nothing is retried', async () => {
  const s = stub({ 'POST /flow-runs/run-1/retry': { status: 409, body: { error: 'the run is not failed' } } });
  const out = await s.call('retry_flow_run', { runId: 'run-1' });
  assert.equal(out.isError, true);
  assert.match(out.text, /409: the run is not failed/);
  assert.equal(s.seen.length, 1);
});
