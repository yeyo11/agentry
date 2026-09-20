import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { PermissionRequest } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { PermissionBroker } from '../src/permissions.ts';
import { ChatManager, type ChatRuntime } from '../src/chats.ts';
import { tempConfig } from './helpers.ts';

const request = (id: string, runId = 'run-1'): PermissionRequest => ({
  id,
  runId,
  toolName: 'Bash',
  toolUseId: `toolu_${id}`,
  input: { command: 'rm -rf /' },
  requestedAt: new Date().toISOString(),
});

// ---------- the broker ----------

test('a request waits until someone answers it', async () => {
  const broker = new PermissionBroker();
  const decision = broker.ask(request('a'));

  assert.deepEqual(
    broker.list('run-1').map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(broker.list('other-run'), []);

  broker.answer('a', { behavior: 'deny', message: 'not on my machine' });
  assert.deepEqual(await decision, { behavior: 'deny', message: 'not on my machine' });
  // Answered means gone: a second answer would have nothing to resolve
  assert.deepEqual(broker.list(), []);
  assert.throws(() => broker.answer('a', { behavior: 'allow' }), /not found/);
});

test('a run that ends takes its unanswered prompts with it', async () => {
  const broker = new PermissionBroker();
  const doomed = broker.ask(request('a', 'doomed'));
  const other = broker.ask(request('b', 'other'));
  // The process it belonged to is gone; nobody could act on an approval now
  broker.denyAllFor('doomed');
  assert.equal((await doomed)?.behavior, 'deny');
  assert.deepEqual(
    broker.list().map((r) => r.id),
    ['b'],
  );
  broker.close();
  assert.equal((await other)?.behavior, 'deny');
});

test('a withdrawn request disappears without an answer, and an ignored one is denied', async () => {
  const broker = new PermissionBroker(30);
  const withdrawn = broker.ask(request('a'));
  broker.withdraw('a');
  assert.equal(await withdrawn, null);

  // The broker's timer never holds the process open, so something else has to while it runs out
  const hold = setInterval(() => {}, 1000);
  const ignored = await broker.ask(request('b'));
  clearInterval(hold);
  assert.equal(ignored?.behavior, 'deny');
  assert.match(ignored?.message ?? '', /in time/);
  assert.deepEqual(broker.list(), []);
});

// ---------- the runner speaking the control protocol ----------

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const broker = new PermissionBroker();
  runs.permissions = broker;
  return { runs, broker, db };
}

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const idle = (runs: ChatManager, id: string) => until(() => runs.get(id)?.status === 'idle' && runs.get(id), 'the turn to end');
const resultText = (runs: ChatManager, id: string) => runs.events(id).filter((e) => e.kind === 'result').at(-1)?.text ?? '';

test('a question reaches the panel and its answers reach the CLI', async () => {
  const { runs, broker, db } = setup();
  const run = runs.start({ prompt: 'ASK AskUserQuestion', permissionPrompts: 'host' });

  const asked = await until(() => broker.list(run.id)[0], 'the question');
  assert.equal(asked.toolName, 'AskUserQuestion');
  assert.equal(asked.requiresUserInteraction, true);
  assert.equal(asked.description, 'wants AskUserQuestion');
  assert.deepEqual(asked.suggestions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.equal(runs.get(run.id)?.pendingPrompts, 1);

  broker.answer(asked.id, { behavior: 'allow', updatedInput: { ...asked.input, answers: { 'Color?': 'Blue' } } });
  await idle(runs, run.id);
  const decision = JSON.parse(resultText(runs, run.id).replace('decision=', '')) as Record<string, unknown>;
  assert.equal(decision.behavior, 'allow');
  assert.deepEqual((decision.updatedInput as Record<string, unknown>).answers, { 'Color?': 'Blue' });
  assert.equal(runs.get(run.id)?.pendingPrompts, 0);
  runs.stopAll();
  db.close();
});

test('allowing always sends the accepted suggestions back, and denying sends the reason', async () => {
  const { runs, broker, db } = setup();
  const run = runs.start({ prompt: 'ASK Bash', permissionPrompts: 'host' });
  let asked = await until(() => broker.list(run.id)[0], 'the prompt');
  broker.answer(asked.id, { behavior: 'allow', updatedPermissions: asked.suggestions });
  await idle(runs, run.id);
  let decision = JSON.parse(resultText(runs, run.id).replace('decision=', '')) as Record<string, unknown>;
  // Allowing without edits still has to carry the input: the CLI requires it
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: asked.suggestions });

  runs.send(run.id, 'ASK Bash');
  asked = await until(() => broker.list(run.id)[0], 'the second prompt');
  broker.answer(asked.id, { behavior: 'deny', message: 'use git instead' });
  await until(() => resultText(runs, run.id).includes('deny') && runs.get(run.id)?.status === 'idle', 'the denial');
  decision = JSON.parse(resultText(runs, run.id).replace('decision=', '')) as Record<string, unknown>;
  assert.deepEqual(decision, { behavior: 'deny', message: 'use git instead' });
  runs.stopAll();
  db.close();
});

test('an interrupt ends the turn, withdraws the prompt and keeps the process', async () => {
  const { runs, broker, db } = setup();
  const run = runs.start({ prompt: 'ASK Bash', permissionPrompts: 'host' });
  await until(() => broker.list(run.id)[0], 'the prompt');
  const pid = runs.get(run.id)?.pid;

  await runs.interrupt(run.id);
  const after: ChatRuntime = await idle(runs, run.id);
  assert.deepEqual(broker.list(run.id), []);
  assert.equal(after.pendingPrompts, 0);
  // Stopping on purpose is not a failure
  assert.equal(after.error, null);
  assert.equal(after.pid, pid);

  runs.send(run.id, 'hello again');
  await until(() => resultText(runs, run.id).startsWith('args='), 'the next turn');
  assert.equal(runs.get(run.id)?.pid, pid);
  runs.stopAll();
  db.close();
});

test('the mode and the model change on a live run, and wait for the next resume otherwise', async () => {
  const { runs, db } = setup();
  const run = runs.start({ prompt: 'hi', permissionPrompts: 'host', permissionMode: 'plan' });
  await idle(runs, run.id);

  const changed = await runs.updateSettings(run.id, { permissionMode: 'acceptEdits', model: 'claude-sonnet-5' });
  assert.equal(changed.permissionMode, 'acceptEdits');
  assert.equal(changed.model, 'claude-sonnet-5');
  await assert.rejects(runs.updateSettings(run.id, { model: ' ' }), /empty/);

  runs.stop(run.id);
  await until(() => runs.get(run.id)?.status === 'stopped', 'the stop');
  await runs.updateSettings(run.id, { permissionMode: 'manual' });
  runs.send(run.id, 'again');
  // The CLI answers with `default`; the panel only knows the name it was given
  await until(() => runs.get(run.id)?.status === 'idle', 'the resumed turn');
  assert.equal(runs.get(run.id)?.permissionMode, 'manual');
  await until(() => runs.get(run.id)?.status === 'idle' && resultText(runs, run.id).includes('--resume'), 'the resume');
  const argv = resultText(runs, run.id);
  assert.match(argv, /--permission-mode manual/);
  assert.match(argv, /--model claude-sonnet-5/);
  assert.match(argv, /--permission-prompt-tool stdio/);
  runs.stopAll();
  db.close();
});

test('a run nobody answers for never asks', async () => {
  const { runs, broker, db } = setup();
  const run = runs.start({ prompt: 'ASK Bash' });
  await idle(runs, run.id);
  assert.equal(resultText(runs, run.id), 'denied: nobody to ask');
  assert.deepEqual(broker.list(), []);
  assert.equal(runs.get(run.id)?.permissionPrompts, 'none');
  runs.stopAll();
  db.close();
});

test('continuing in a copy forks once, under the id Agentry chose, then resumes the copy', async () => {
  const { runs, db } = setup();
  const source = { cwd: tempConfig().workspaceDir, name: 'terminal chat', model: null };
  assert.throws(() => runs.fork('terminal-session', { prompt: ' ' }, source), /prompt is required/);

  const copy = runs.fork('terminal-session', { prompt: 'hi' }, source);
  // The copy has its id and records where it came from before the CLI has said anything, so no
  // second row can ever stand for it
  assert.notEqual(copy.id, 'terminal-session');
  assert.equal(copy.derivedFrom?.chatId, 'terminal-session');
  await idle(runs, copy.id);
  assert.match(resultText(runs, copy.id), new RegExp(`--resume terminal-session --fork-session --session-id ${copy.id}`));
  assert.equal(runs.list().filter((c) => c.id === copy.id).length, 1);

  runs.stop(copy.id);
  await until(() => runs.get(copy.id)?.status === 'stopped', 'the stop');
  runs.send(copy.id, 'again');
  await until(() => runs.get(copy.id)?.status === 'idle' && resultText(runs, copy.id).includes(`--resume ${copy.id}`), 'the resume of the copy');
  assert.doesNotMatch(resultText(runs, copy.id), /--fork-session/);
  assert.equal(runs.get(copy.id)?.executions.length, 2, 'the copy is one chat with an execution per process');
  runs.stopAll();
  db.close();
});

test('a message sent while the process is on its way out goes to the one that replaces it', async () => {
  const { runs, db } = setup();
  const run = runs.start({ prompt: 'first', keepAlive: false });
  // The instant its turn ends, the process has closed its stdin but not exited yet
  await runs.nextResult(run.id);
  const next = runs.nextResult(run.id);
  runs.send(run.id, 'second');
  const result = await next;
  assert.equal(result.isError, false);
  assert.match(result.result, /--resume/);
  runs.stopAll();
  db.close();
});

test('a run resumed right after a stop keeps its new process', async () => {
  const { runs, db } = setup();
  const run = runs.start({ prompt: 'first' });
  await idle(runs, run.id);
  runs.stop(run.id);
  await runs.exited(run.id);
  runs.send(run.id, 'second');
  await idle(runs, run.id);
  const pid = runs.get(run.id)?.pid;
  // Past the moment the stop would have forced its way out
  await new Promise((r) => setTimeout(r, 5500));
  assert.equal(runs.get(run.id)?.pid, pid);
  assert.equal(runs.get(run.id)?.status, 'idle');
  runs.stopAll();
  db.close();
});
