import assert from 'node:assert/strict';
import { connect } from 'node:net';
import test from 'node:test';
import type { PermissionDecision, PermissionRequest } from '@agentry/shared';
import { PermissionBroker } from '../src/permissions.ts';
import { tempConfig } from './helpers.ts';

/** Speaks the wire the MCP server speaks: one JSON line out, one decision line back. */
function askOverSocket(path: string, payload: unknown): Promise<PermissionDecision> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      if (!buffer.includes('\n')) return;
      resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as PermissionDecision);
      socket.end();
    });
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

const waitForRequest = (broker: PermissionBroker): Promise<PermissionRequest> =>
  new Promise((resolve) => broker.once('requested', resolve));

test('a request waits on the socket until someone answers it', async () => {
  const broker = new PermissionBroker(tempConfig().dataDir);
  broker.listen();

  const decision = askOverSocket(broker.socketPath, {
    runId: 'run-1',
    toolName: 'Bash',
    toolUseId: 'toolu_1',
    input: { command: 'rm -rf /' },
  });
  const request = await waitForRequest(broker);

  assert.equal(request.toolName, 'Bash');
  assert.equal(request.input.command, 'rm -rf /');
  assert.deepEqual(
    broker.list('run-1').map((r) => r.id),
    [request.id],
  );
  assert.deepEqual(broker.list('other-run'), []);

  broker.answer(request.id, { behavior: 'deny', message: 'not on my machine' });
  assert.deepEqual(await decision, { behavior: 'deny', message: 'not on my machine' });
  // Answered means gone: a second answer would have nothing to resolve
  assert.deepEqual(broker.list(), []);
  assert.throws(() => broker.answer(request.id, { behavior: 'allow' }), /not found/);
  broker.close();
});

test('allowing carries the edited arguments back', async () => {
  const broker = new PermissionBroker(tempConfig().dataDir);
  broker.listen();
  const decision = askOverSocket(broker.socketPath, { runId: 'r', toolName: 'Bash', input: { command: 'ls /etc' } });
  const request = await waitForRequest(broker);
  broker.answer(request.id, { behavior: 'allow', updatedInput: { command: 'ls .' } });
  assert.deepEqual(await decision, { behavior: 'allow', updatedInput: { command: 'ls .' } });
  broker.close();
});

test('a run that ends takes its unanswered prompts with it', async () => {
  const broker = new PermissionBroker(tempConfig().dataDir);
  broker.listen();
  const decision = askOverSocket(broker.socketPath, { runId: 'doomed', toolName: 'Bash', input: {} });
  await waitForRequest(broker);
  // The process it belonged to is gone; nobody could act on an approval now
  broker.denyAllFor('doomed');
  const answer = await decision;
  assert.equal(answer.behavior, 'deny');
  assert.deepEqual(broker.list(), []);
  broker.close();
});

test('a malformed request is denied rather than left hanging', async () => {
  const broker = new PermissionBroker(tempConfig().dataDir);
  broker.listen();
  const answer = await new Promise<PermissionDecision>((resolve, reject) => {
    const socket = connect(broker.socketPath);
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('\n')) {
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as PermissionDecision);
        socket.end();
      }
    });
    socket.write('this is not json\n');
  });
  assert.equal(answer.behavior, 'deny');
  broker.close();
});
