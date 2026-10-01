import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { seed, type Seeded } from './fixture.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const NO_URL = 'agentry-mcp: AGENTRY_API_URL is not set; this server only talks to the Agentry that started the chat\n';

let s: Seeded;
let url: string;
before(async () => {
  s = await seed();
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}/api`;
});
after(() => s.close());

function start(env: Record<string, string>): ChildProcessWithoutNullStreams {
  // Only what the test names: nothing of the real environment reaches the child
  return spawn(process.execPath, ['--import', 'tsx', MAIN], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' });
}

/** The next `count` lines the child writes to stdout */
function lines(child: ChildProcessWithoutNullStreams, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`only got: ${buffer}`)), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const got = buffer.split('\n').filter(Boolean);
      if (got.length >= count) {
        clearTimeout(timer);
        resolve(got);
      }
    });
  });
}

test('over stdio: initialize, tools/list and a call, a bad line, and an exit when stdin closes', async () => {
  const child = start({ AGENTRY_API_URL: url, AGENTRY_CHAT_ID: 'chat-1' });
  const got = lines(child, 4);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  child.stdin.write('this is not json\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_work_item', arguments: { item: s.item.key } } })}\n`);
  const [init, list, bad, call] = (await got).map((l) => JSON.parse(l) as Record<string, any>);
  assert.equal(init?.result.serverInfo.name, 'agentry');
  assert.equal(list?.result.tools.length, 15);
  assert.equal(bad?.error.code, -32700);
  assert.equal(call?.result.isError, false, JSON.stringify(call));
  assert.match(call?.result.content[0].text, /Cart loses items/);
  assert.equal(child.exitCode, null, 'a malformed line must not end the process');
  child.stdin.end();
  assert.deepEqual(await once(child, 'exit'), [0, null]);
});

test('without a usable AGENTRY_API_URL it exits with 1, says why on stderr and writes nothing to stdout', async () => {
  const envs: Array<Record<string, string>> = [{}, { AGENTRY_API_URL: '' }, { AGENTRY_API_URL: 'not-a-url' }, { AGENTRY_API_URL: 'ftp://x/api' }];
  for (const env of envs) {
    const child = start(env);
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, JSON.stringify(env));
    assert.equal(err, NO_URL);
    assert.equal(out, '');
  }
});
