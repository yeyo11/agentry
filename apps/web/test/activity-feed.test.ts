import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { ChatActivityEvent, ChatSummary, Orchestration, OrchestrationTaskState, Overview } from '@agentry/shared';
import { keys } from '../src/api';
import { patchActivity, targetsFor } from '../src/lib/events';

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
