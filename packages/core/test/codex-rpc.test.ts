import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonRpc, RpcError, type RpcHandlers } from '../src/providers/codex/rpc.ts';

function rig() {
  const sent: Array<Record<string, unknown>> = [];
  const seen = { requests: [] as Array<[unknown, string]>, notifications: [] as string[], unreadable: [] as string[] };
  const handlers: RpcHandlers = {
    request: (id, method) => seen.requests.push([id, method]),
    notification: (method) => seen.notifications.push(method),
    unreadable: (line) => seen.unreadable.push(line),
  };
  const rpc = new JsonRpc((text) => sent.push(JSON.parse(text) as Record<string, unknown>), handlers);
  return { rpc, sent, seen };
}

test('what it sends carries jsonrpc and an id, and what answers it needs no jsonrpc', async () => {
  const { rpc, sent } = rig();
  const reply = rpc.request<{ ok: boolean }>('model/list', { a: 1 });
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 1, method: 'model/list', params: { a: 1 } });
  rpc.line(JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await reply, { ok: true });
});

test('an error reply rejects with its code, and an unknown id is ignored', async () => {
  const { rpc } = rig();
  const reply = rpc.request('no/such/method');
  rpc.line(JSON.stringify({ id: 99, result: {} }));
  rpc.line(JSON.stringify({ id: 1, error: { code: -32600, message: 'Invalid request' } }));
  await assert.rejects(reply, (error: unknown) => error instanceof RpcError && error.code === -32600 && error.message === 'Invalid request');
});

test('a message is told by its shape: request, notification, or reply', () => {
  const { rpc, seen } = rig();
  rpc.line(JSON.stringify({ id: 7, method: 'item/commandExecution/requestApproval', params: {} }));
  rpc.line(JSON.stringify({ method: 'turn/started', params: {}, emittedAtMs: 1 }));
  assert.deepEqual(seen.requests, [[7, 'item/commandExecution/requestApproval']]);
  assert.deepEqual(seen.notifications, ['turn/started']);
});

test('a line that is not a message is unreadable', () => {
  const { rpc, seen } = rig();
  rpc.line('this is not json');
  rpc.line('[1,2]');
  rpc.line('{"neither":"id nor method"}');
  rpc.line('   ');
  assert.deepEqual(seen.unreadable, ['this is not json', '[1,2]', '{"neither":"id nor method"}']);
});

test('answers to the server are requests-in-reverse: result or error by the same id', () => {
  const { rpc, sent } = rig();
  rpc.respond(3, { decision: 'accept' });
  rpc.fail('x', -32601, 'nope');
  assert.deepEqual(sent, [
    { jsonrpc: '2.0', id: 3, result: { decision: 'accept' } },
    { jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'nope' } },
  ]);
});

test('a call that is not answered in time rejects, and dispose rejects what is pending', async () => {
  const { rpc } = rig();
  const slow = rpc.request('thread/start', {}, 20);
  // The request's own timer does not hold the process up; this one keeps the test alive until it fires
  const keep = setTimeout(() => {}, 2000);
  await assert.rejects(slow, /did not answer thread\/start/);
  clearTimeout(keep);
  const pending = rpc.request('turn/start', {});
  rpc.dispose('the chat ended');
  await assert.rejects(pending, /the chat ended/);
});
