// Drift net for the web packages split: the keys the chat set reads and writes, pinned from
// today's `keys`. `lib/events.ts` invalidates by prefix, so a key that changes shape (or a prefix
// that stays behind) stops an event from refreshing the chat.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keys } from '../src/api';
import { chatKeys } from '@agentry/chat-ui/lib/context';

test('the chat keys keep their shape', () => {
  assert.deepEqual(keys.chats, ['chats']);
  assert.deepEqual(keys.chatScope('c1'), ['chat', 'c1']);
  assert.deepEqual(keys.chat('c1', true), ['chat', 'c1', true]);
  assert.deepEqual(keys.chat('c1', false), ['chat', 'c1', false]);
  assert.deepEqual(keys.chatEarlier('c1', true), ['chat', 'c1', true, 'earlier']);
  assert.deepEqual(keys.chatPermissions('c1'), ['chat', 'c1', 'permissions']);
  assert.deepEqual(keys.chatTasks('c1'), ['tasks', 'chat', 'c1']);
  assert.deepEqual(keys.agentDetail, ['agent-detail']);
  assert.deepEqual(keys.agent('c1', 'w1', 'a1'), ['agent-detail', 'c1', 'w1', 'a1']);
  assert.deepEqual(keys.taskOutput, ['task-output']);
  assert.deepEqual(keys.output('c1', 't1'), ['task-output', 'c1', 't1']);
});

test('the prefixes the event feed invalidates still cover the keys under them', () => {
  const startsWith = (key: readonly unknown[], prefix: readonly unknown[]): boolean => prefix.every((part, i) => key[i] === part);
  assert.ok(startsWith(keys.chat('c1', true), keys.chatScope('c1')));
  assert.ok(startsWith(keys.chatEarlier('c1', false), keys.chatScope('c1')));
  assert.ok(startsWith(keys.chatPermissions('c1'), keys.chatScope('c1')));
  assert.ok(startsWith(keys.agent('c1', 'w1', 'a1'), keys.agentDetail));
  assert.ok(startsWith(keys.output('c1', 't1'), keys.taskOutput));
  assert.ok(startsWith(keys.chatTasks('c1'), keys.tasks));
});

test('the app spreads the chat package keys, the same function objects', () => {
  for (const name of Object.keys(chatKeys) as Array<keyof typeof chatKeys>) assert.equal(keys[name], chatKeys[name], name);
});
