import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentryEvent, ChatActivity } from '@agentry/shared';
import { activityKey, activityTarget, ChatActivityTracker } from '../src/chat-activity.ts';
import { ChatManager, type ChatRuntime } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { RunEventPublisher } from '../src/event-sources.ts';
import { EventBus } from '../src/events.ts';
import { PermissionBroker } from '../src/permissions.ts';
import { tempConfig } from './helpers.ts';

// What a chat is doing right now, read from the stream-json events the CLI already writes: the
// label a call gets, the order the three kinds are read in, the throttle the feed goes out under,
// and the whole path from a line on stdout to `ChatSummary.activity` and a `chat.activity` event.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

test('a tool call is labelled with the part of its input a person recognises', () => {
  const cwd = '/work/project';
  assert.equal(activityTarget('Edit', { file_path: '/work/project/packages/core/src/chats.ts' }, cwd), 'packages/core/src/chats.ts');
  assert.equal(activityTarget('Read', { file_path: '/etc/hosts' }, cwd), '/etc/hosts', 'a file outside the chat stays where it is');
  assert.equal(activityTarget('NotebookEdit', { notebook_path: '/work/project/a.ipynb' }, cwd), 'a.ipynb');
  assert.equal(activityTarget('Bash', { command: 'pnpm test', description: 'Run the unit tests' }, cwd), 'Run the unit tests');
  assert.equal(activityTarget('Bash', { command: 'pnpm test' }, cwd), 'pnpm test');
  assert.equal(activityTarget('Grep', { pattern: 'ChatActivity', path: 'packages' }, cwd), 'ChatActivity');
  assert.equal(activityTarget('Task', { subagent_type: 'Explore', description: 'Find the feed' }, cwd), 'Find the feed');
  assert.equal(activityTarget('Task', { subagent_type: 'Explore' }, cwd), 'Explore');
  assert.equal(activityTarget('WebFetch', { url: 'https://docs.anthropic.com/en/api/overview' }, cwd), 'docs.anthropic.com');
  assert.equal(activityTarget('WebSearch', { query: 'stream-json events' }, cwd), 'stream-json events');
  assert.equal(activityTarget('TodoWrite', { todos: [] }, cwd), undefined, 'a plan has no one target');
  assert.equal(activityTarget('mcp__github__create_issue', { title: 'x', description: 'Open an issue' }, cwd), 'Open an issue', 'a tool nobody knows still gets a label');
  assert.equal(activityTarget('Unknown', { flag: true }, cwd), undefined);
});

test('a label is one line and short enough for a list row', () => {
  const command = `echo ${'a'.repeat(200)}`;
  const target = activityTarget('Bash', { command }, '/work') ?? '';
  assert.equal(target.length, 80);
  assert.ok(target.endsWith('…'));
  assert.equal(activityTarget('Bash', { command: 'git commit -m "one\n\ntwo"' }, '/work'), 'git commit -m "one two"');
});

test('a tool call is what the chat is doing until its result arrives', () => {
  const tracker = new ChatActivityTracker('/work');
  assert.equal(tracker.current(), null, 'a chat that has said nothing is doing nothing');

  tracker.called('t1', 'Edit', { file_path: '/work/src/app.ts' }, '2026-09-21T10:00:00.000Z');
  assert.deepEqual(tracker.current(), { kind: 'tool', tool: 'Edit', target: 'src/app.ts', since: '2026-09-21T10:00:00.000Z' } satisfies ChatActivity);

  // Two calls in one message run in parallel; the newest is the one worth showing
  tracker.called('t2', 'Bash', { command: 'pnpm test' }, '2026-09-21T10:00:01.000Z');
  assert.equal(tracker.current()?.tool, 'Bash');
  tracker.answered('t2');
  assert.equal(tracker.current()?.tool, 'Edit', 'the call still open comes back');
  tracker.answered('t1');
  assert.equal(tracker.current(), null);
});

test('a streaming block says whether it is prose or thinking, and a tool call outranks it', () => {
  const tracker = new ChatActivityTracker('/work');
  tracker.blockStarted({ type: 'thinking' }, '2026-09-21T10:00:00.000Z');
  assert.deepEqual(tracker.current(), { kind: 'thinking', since: '2026-09-21T10:00:00.000Z' });
  tracker.blockStopped();
  assert.equal(tracker.current(), null);

  tracker.blockStarted({ type: 'text' }, '2026-09-21T10:00:01.000Z');
  assert.equal(tracker.current()?.kind, 'writing');
  // The CLI announces a call as a block before the message that carries its input: the ticker must
  // not wait for a large edit to finish serialising to say what is happening
  tracker.blockStarted({ type: 'tool_use', id: 't1', name: 'Write' }, '2026-09-21T10:00:02.000Z');
  assert.deepEqual(tracker.current(), { kind: 'tool', tool: 'Write', since: '2026-09-21T10:00:02.000Z' });
  tracker.called('t1', 'Write', { file_path: '/work/src/new.ts' }, '2026-09-21T10:00:03.000Z');
  assert.deepEqual(tracker.current(), { kind: 'tool', tool: 'Write', target: 'src/new.ts', since: '2026-09-21T10:00:02.000Z' }, 'the input fills the label in without restarting the clock');
});

test('a prompt waiting for a person outranks whatever the chat was doing, and the turn ending clears it all', () => {
  const tracker = new ChatActivityTracker('/work');
  tracker.called('t1', 'Bash', { command: 'rm -rf build' }, '2026-09-21T10:00:00.000Z');
  tracker.setPendingPrompts(1, '2026-09-21T10:00:01.000Z');
  assert.deepEqual(tracker.current(), { kind: 'waiting', since: '2026-09-21T10:00:01.000Z' });

  // A second prompt does not restart the clock: the chat has been blocked since the first one
  tracker.setPendingPrompts(2, '2026-09-21T10:00:05.000Z');
  assert.equal(tracker.current()?.since, '2026-09-21T10:00:01.000Z');
  tracker.setPendingPrompts(0, '2026-09-21T10:00:06.000Z');
  assert.equal(tracker.current()?.kind, 'tool', 'the call it was asking about is what it goes back to');

  // An interrupt leaves calls without results; the turn is over, so nothing is still running
  tracker.turnEnded();
  assert.equal(tracker.current(), null);
});

// ---------- the throttle ----------

/** A runtime summary with only the fields the activity event reads set to anything. */
function runtime(activity: ChatActivity | null): ChatRuntime {
  return {
    id: 'sess-1',
    name: 'demo',
    cwd: '/work',
    workingDir: '/work',
    origin: 'agentry',
    derivedFrom: null,
    model: null,
    permissionMode: 'manual',
    status: 'busy',
    pid: 1,
    createdAt: '',
    updatedAt: '',
    endedAt: null,
    turns: 0,
    costUsd: 0,
    prompt: 'p',
    lastText: null,
    error: null,
    orchestrationId: 'graph-1',
    orchestrationTaskId: 'task-a',
    account: null,
    permissionPrompts: 'none',
    pendingPrompts: 0,
    activity,
    executions: [],
    backgroundTasks: [],
    subagents: [],
    workflows: [],
  };
}

test('what a chat is doing goes out at most once per window, and the window ends with the newest of them', async () => {
  const seen: AgentryEvent[] = [];
  const bus = new EventBus();
  bus.observe((e) => seen.push(e));
  const publisher = new RunEventPublisher((e) => bus.emit(e), 250, 60);

  const at = (tool: string, since: string): ChatActivity => ({ kind: 'tool', tool, since });
  publisher.activity(runtime(at('Read', '1')));
  assert.equal(seen.length, 1, 'the first one is news and goes out at once');

  for (const n of ['2', '3', '4', '5']) publisher.activity(runtime(at('Edit', n)));
  assert.equal(seen.length, 1, 'nothing more inside the window');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(seen.length, 2);
  const last = seen[1];
  assert.equal(last?.type, 'chat.activity');
  if (last?.type !== 'chat.activity') throw new Error('unreachable');
  assert.deepEqual(last.activity, at('Edit', '5'), 'the newest, not the three it skipped');
  assert.equal(last.taskId, 'task-a', 'a worker of a graph names its task, so a board patches it too');

  // Saying the same thing twice is not news
  publisher.activity(runtime(at('Edit', '5')));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(seen.length, 2);
  publisher.dispose();
});

test('two activities are the same news only when every field of them matches', () => {
  assert.equal(activityKey(null), '');
  assert.notEqual(activityKey({ kind: 'tool', tool: 'Edit', target: 'a.ts', since: '1' }), activityKey({ kind: 'tool', tool: 'Edit', target: 'b.ts', since: '1' }));
  assert.equal(activityKey({ kind: 'writing', since: '1' }), activityKey({ kind: 'writing', since: '1' }));
});

// ---------- end to end, over a real process ----------

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a command the CLI has not answered is what the chat reports doing, on its summary and on the feed', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const bus = new EventBus();
  runs.bus = bus;
  const seen: AgentryEvent[] = [];
  bus.observe((e) => seen.push(e));

  const chat = runs.start({ prompt: 'BASH pnpm build' });
  const activity = await until(() => runs.get(chat.id)?.activity, 'the chat to report what it is doing');
  assert.deepEqual(activity, { kind: 'tool', tool: 'Bash', target: 'pnpm build', since: activity.since });

  const announced = await until(() => seen.find((e) => e.type === 'chat.activity'), 'the feed to carry it');
  assert.equal(announced.type === 'chat.activity' ? announced.runId : '', chat.id);
  assert.deepEqual(announced.type === 'chat.activity' ? announced.activity : null, activity);
  assert.match(announced.title, /is using Bash on pnpm build/);

  runs.stop(chat.id);
  await runs.exited(chat.id);
  assert.equal(runs.get(chat.id)?.activity, null, 'a chat with no process of ours is doing nothing');
  runs.stopAll();
  db.close();
});

test('a text block being streamed is reported as writing, from the partial events alone', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const bus = new EventBus();
  runs.bus = bus;
  const seen: AgentryEvent[] = [];
  bus.observe((e) => seen.push(e));

  const turn = join(config.dataDir, 'writing.jsonl');
  writeFileSync(
    turn,
    [
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look.' } } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  );

  const chat = runs.start({ prompt: `REPLAY ${turn}` });
  const announced = await until(() => seen.find((e) => e.type === 'chat.activity'), 'the feed to carry the streaming block');
  assert.equal(announced.type === 'chat.activity' ? announced.activity?.kind : null, 'writing');

  runs.stopAll();
  await runs.exited(chat.id);
  db.close();
});

test('a chat blocked on a permission prompt reports that it is waiting for a person', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const db = new Db(config);
  const runs = new ChatManager(config, db);
  const broker = new PermissionBroker();
  runs.permissions = broker;

  const chat = runs.start({ prompt: 'ASK Bash', permissionPrompts: 'host' });
  const asked = await until(() => broker.list(chat.id)[0], 'the prompt');
  assert.deepEqual(runs.get(chat.id)?.activity?.kind, 'waiting');

  broker.answer(asked.id, { behavior: 'deny', message: 'not on this machine' });
  await until(() => runs.get(chat.id)?.status === 'idle', 'the turn to end');
  assert.equal(runs.get(chat.id)?.activity, null, 'the turn is over: nothing is being done');
  runs.stopAll();
  db.close();
});
