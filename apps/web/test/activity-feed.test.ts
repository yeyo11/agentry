import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { ChatActivityEvent, ChatSummary, Orchestration, OrchestrationTaskState, Overview, RunUpdatedEvent } from '@agentry/shared';
import { keys } from '../src/api';
import { patchActivity, patchRun, runState, targetsFor } from '../src/lib/events';

// `chat.activity` is the one event on the feed that refetches nothing: it carries the whole line a
// row shows, so it is written straight into the caches that show it.

const event = (over: Partial<ChatActivityEvent> = {}): ChatActivityEvent => ({
  id: 1,
  at: '2026-09-21T10:00:00.000Z',
  title: 'demo is using Edit on src/app.ts',
  type: 'chat.activity',
  runId: 'chat-1',
  runName: 'demo',
  sessionId: 'chat-1',
  orchestrationId: null,
  internal: false,
  taskId: null,
  activity: { kind: 'tool', tool: 'Edit', target: 'src/app.ts', since: '2026-09-21T10:00:00.000Z' },
  ...over,
});

const chat = (id: string): ChatSummary => ({ id, title: id, activity: null }) as ChatSummary;
const task = (id: string): OrchestrationTaskState => ({ id, name: id, prompt: '', status: 'running' }) as OrchestrationTaskState;

test('what a chat is doing refetches nothing: the event is the whole news', () => {
  assert.deepEqual(targetsFor(event()), []);
});

test('the activity is written into every cache that shows the chat, and nowhere else', () => {
  const client = new QueryClient();
  client.setQueryData(keys.chatList({}), [chat('chat-1'), chat('chat-2')]);
  client.setQueryData(keys.overview, { recentChats: [chat('chat-1')] } as Overview);

  patchActivity(client, event());

  const list = client.getQueryData<ChatSummary[]>(keys.chatList({})) ?? [];
  assert.equal(list[0]?.activity?.target, 'src/app.ts');
  assert.equal(list[1]?.activity, null, 'the other chat is untouched');
  assert.equal(client.getQueryData<Overview>(keys.overview)?.recentChats[0]?.activity?.tool, 'Edit');

  // Cleared the moment the chat stops doing anything nameable
  patchActivity(client, event({ activity: null }));
  assert.equal((client.getQueryData<ChatSummary[]>(keys.chatList({})) ?? [])[0]?.activity, null);
});

test("a worker's activity also reaches the task on its orchestration, in the list and on its page", () => {
  const client = new QueryClient();
  const graph = { id: 'graph-1', name: 'redesign', tasks: [task('a'), task('b')] } as Orchestration;
  client.setQueryData(keys.orchestration('graph-1'), graph);
  client.setQueryData(keys.orchestrations, [graph]);

  patchActivity(client, event({ orchestrationId: 'graph-1', taskId: 'b' }));

  const page = client.getQueryData<Orchestration>(keys.orchestration('graph-1'));
  assert.equal(page?.tasks[0]?.activity, undefined, 'the task that is not the worker keeps what it had');
  assert.equal(page?.tasks[1]?.activity?.tool, 'Edit');
  assert.equal(client.getQueryData<Orchestration[]>(keys.orchestrations)?.[0]?.tasks[1]?.activity?.tool, 'Edit');
});

// `run.updated` comes every quarter second per working run. Without a status change it is the run's
// own numbers, which go straight into the rows; a list is read again only when a row's state moved.

const updated = (over: Partial<RunUpdatedEvent> = {}): RunUpdatedEvent => ({
  id: 2,
  at: '2026-09-21T10:00:05.000Z',
  title: 'demo is busy',
  type: 'run.updated',
  runId: 'chat-1',
  runName: 'demo',
  sessionId: 'chat-1',
  orchestrationId: null,
  internal: false,
  status: 'busy',
  previousStatus: null,
  turns: 3,
  costUsd: 0.25,
  pendingPrompts: 0,
  ...over,
});

const row = (id: string, over: Partial<ChatSummary> = {}): ChatSummary =>
  ({ id, title: id, state: 'working', updatedAt: '2026-09-21T10:00:00.000Z', cost: { usd: 0.1, tokens: [], total: {} }, ...over }) as ChatSummary;

test('a run moving without a status change reads only its transcript, never a list or its side panels', () => {
  const keysOf = targetsFor(updated()).map(([key]) => JSON.stringify(key));
  assert.ok(!keysOf.includes(JSON.stringify(keys.chats)), 'no list');
  assert.ok(!keysOf.includes(JSON.stringify(keys.chatScope('chat-1'))), 'not everything under the chat');
  assert.ok(keysOf.includes(JSON.stringify(keys.chat('chat-1', false))));
  // A status change is rare, and moves counts everywhere
  const changed = targetsFor(updated({ previousStatus: 'idle' })).map(([key]) => JSON.stringify(key));
  assert.ok(changed.includes(JSON.stringify(keys.chats)));
});

test('the state a run gives its chat is the one the server lists it with', () => {
  assert.equal(runState('busy', 0), 'working');
  assert.equal(runState('starting', 0), 'working');
  assert.equal(runState('busy', 1), 'waiting');
  assert.equal(runState('idle', 0), 'idle');
  assert.equal(runState('failed', 2), 'idle');
});

test("a run's numbers are written into its rows, and only a change of state asks for the lists again", () => {
  const client = new QueryClient();
  client.setQueryData(keys.chatList({}), [row('chat-1'), row('chat-2')]);
  client.setQueryData(keys.overview, { recentChats: [row('chat-1')] } as unknown as Overview);

  assert.equal(patchRun(client, updated()), false, 'still working: nothing to read again');
  const list = client.getQueryData<ChatSummary[]>(keys.chatList({})) ?? [];
  assert.equal(list[0]?.cost.usd, 0.25);
  assert.equal(list[0]?.updatedAt, '2026-09-21T10:00:05.000Z', 'a new figure means the transcript was just written');
  assert.equal(list[1]?.cost.usd, 0.1, 'the other chat is untouched');
  assert.equal(client.getQueryData<Overview>(keys.overview)?.recentChats[0]?.cost.usd, 0.25);

  assert.equal(patchRun(client, updated({ pendingPrompts: 1 })), true, 'a prompt makes it wait: state-filtered lists are wrong now');
  assert.equal((client.getQueryData<ChatSummary[]>(keys.chatList({})) ?? [])[0]?.state, 'waiting');
});

test('a run that has answered nothing keeps its cost unknown, not zero', () => {
  const client = new QueryClient();
  client.setQueryData(keys.chatList({}), [row('chat-1', { cost: { usd: null, tokens: [], total: {} } as unknown as ChatSummary['cost'] })]);
  patchRun(client, updated({ costUsd: 0, turns: 0 }));
  assert.equal((client.getQueryData<ChatSummary[]>(keys.chatList({})) ?? [])[0]?.cost.usd, null);
});
