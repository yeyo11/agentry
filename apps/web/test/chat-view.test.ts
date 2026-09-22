import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { ChatDetail, TranscriptEntry } from '@agentry/shared';
import { keys } from '../src/api';
import { patchActivity } from '../src/lib/events';
import { callHint, rowOf, stepDuration, stepTools, subagentFor, transcriptRows } from '../src/lib/chat-steps.ts';
import { chatPill, checklistCounts, checklistStepState, tickerActivity } from '../src/lib/chat-live.ts';

// The chat page folds a turn's tool calls into one step and says who wrote a row only when that
// changes. These rules decide what a person sees of a conversation, so they are pinned here.

let n = 0;
const entry = (role: 'user' | 'assistant', blocks: TranscriptEntry['blocks'], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: `u${++n}`,
  role,
  timestamp: `2026-09-21T10:00:${String(n % 60).padStart(2, '0')}.000Z`,
  model: role === 'assistant' ? 'opus' : null,
  isSidechain: false,
  parentToolUseId: null,
  blocks,
  ...extra,
});
const say = (text: string) => entry('user', [{ type: 'text', text }]);
const answer = (text: string) => entry('assistant', [{ type: 'text', text }]);
const call = (id: string, name: string, input: unknown = {}) => entry('assistant', [{ type: 'tool_use', id, name, input }]);
const result = (id: string, content = 'ok', isError = false) => entry('user', [{ type: 'tool_result', toolUseId: id, content, isError }]);
const think = (text: string) => entry('assistant', [{ type: 'thinking', text }]);

test('a run of tool calls and their results becomes one step, with each result on its call', () => {
  const rows = transcriptRows([say('fix it'), call('a', 'Read'), result('a'), call('b', 'Edit'), result('b', 'boom', true), answer('done')]);
  assert.deepEqual(rows.map((r) => r.kind), ['entry', 'step', 'entry']);
  const step = rows[1];
  assert.ok(step?.kind === 'step');
  assert.equal(step.entries.length, 4);
  assert.deepEqual(
    step.parts.map((p) => (p.kind === 'call' ? [p.name, p.result?.isError] : p.kind)),
    [['Read', false], ['Edit', true]],
  );
  assert.equal(step.pending, false);
});

test('a call still waiting for its result keeps its step pending', () => {
  const rows = transcriptRows([say('go'), call('a', 'Bash', { command: 'npm test' })]);
  const step = rows[1];
  assert.ok(step?.kind === 'step');
  assert.equal(step.pending, true);
});

test('thinking between calls stays inside the step, and thinking alone is not folded', () => {
  const rows = transcriptRows([say('go'), think('hmm'), call('a', 'Grep'), result('a'), think('so'), answer('x')]);
  assert.deepEqual(rows.map((r) => r.kind), ['entry', 'step', 'entry']);
  const step = rows[1];
  assert.ok(step?.kind === 'step');
  assert.deepEqual(step.parts.map((p) => p.kind), ['thinking', 'call', 'thinking']);
  const alone = transcriptRows([say('go'), think('hmm'), answer('x')]);
  assert.deepEqual(alone.map((r) => r.kind), ['entry', 'entry', 'entry']);
});

test('the author line shows only when the author changes, and a step is Claude speaking', () => {
  const rows = transcriptRows([say('a'), say('b'), answer('c'), call('x', 'Read'), result('x'), answer('d'), say('e')]);
  const continued = rows.map((r) => (r.kind === 'entry' ? r.continued : 'step'));
  assert.deepEqual(continued, [false, true, false, 'step', true, false]);
});

test("a subagent's calls never share a step with the chat's own", () => {
  const side = { isSidechain: true };
  const rows = transcriptRows([call('a', 'Task'), entry('assistant', [{ type: 'tool_use', id: 's', name: 'Read', input: {} }], side), entry('user', [{ type: 'tool_result', toolUseId: 's', content: '', isError: false }], side), result('a')]);
  assert.deepEqual(rows.map((r) => (r.kind === 'step' ? `step:${r.isSidechain}` : 'entry')), ['step:false', 'step:true', 'step:false']);
});

test('a result whose call is on a page not read yet is still shown, as a call with no name', () => {
  const rows = transcriptRows([result('gone', 'late'), call('b', 'Read'), result('b')]);
  const step = rows[0];
  assert.ok(step?.kind === 'step');
  assert.deepEqual(step.parts.map((p) => (p.kind === 'call' ? p.name : null)), [null, 'Read']);
  assert.equal(step.pending, false, 'an orphan result is an answer, not a call in flight');
});

test('a search hit on an entry folded into a step lands on that step', () => {
  const hit = result('a', 'the platypus burrow');
  const entries = [say('go'), call('a', 'Bash'), hit, answer('ok')];
  const rows = transcriptRows(entries);
  assert.equal(rowOf(rows, hit), rows[1]);
  assert.equal(rowOf(rows, entries[0] as TranscriptEntry), rows[0]);
});

test('a step names its tools once each, in the order they were first used, and how long it took', () => {
  const rows = transcriptRows([
    entry('assistant', [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }], { timestamp: '2026-09-21T10:00:00.000Z' }),
    call('b', 'Edit'),
    call('c', 'Read'),
    entry('user', [{ type: 'tool_result', toolUseId: 'c', content: '', isError: false }], { timestamp: '2026-09-21T10:00:42.000Z' }),
  ]);
  const step = rows[0];
  assert.ok(step?.kind === 'step');
  assert.deepEqual(stepTools(step.parts), [{ name: 'Read', count: 2 }, { name: 'Edit', count: 1 }]);
  assert.equal(stepDuration(step), 42_000);
  assert.equal(stepDuration({ startedAt: null, endedAt: null }), null);
});

test("a call's hint is what it was pointed at, on one line", () => {
  assert.equal(callHint({ command: 'npm\n  test' }), 'npm test');
  assert.equal(callHint({ description: 'Run the tests', command: 'npm test' }), 'Run the tests');
  assert.equal(callHint({ file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(callHint({ unknown: 'x' }), '');
  assert.equal(callHint(null), '');
});

test('a delegation finds its subagent by what it asked for, and never guesses between two', () => {
  const subs = [
    { id: 's1', description: 'Survey the build', kind: 'Explore' },
    { id: 's2', description: 'Fix the tests', kind: 'general-purpose' },
    { id: 's3', description: 'Fix the tests', kind: 'Plan' },
  ];
  assert.equal(subagentFor({ description: 'Survey the build' }, subs)?.id, 's1');
  assert.equal(subagentFor({ description: 'Fix the tests', subagent_type: 'Plan' }, subs)?.id, 's3');
  assert.equal(subagentFor({ description: 'Fix the tests' }, subs), null);
  assert.equal(subagentFor({ prompt: 'no description' }, subs), null);
});

const chat = (over: Partial<Parameters<typeof chatPill>[0]> = {}) => ({
  state: 'idle' as const,
  control: { mode: 'resumable' as const },
  execution: null,
  ...over,
});

test('the pill says the stream is live, and only says reconnecting once it has been down a while', () => {
  const live = chat({ state: 'working', control: { mode: 'interactive' }, execution: {} as never });
  assert.deepEqual(chatPill(live, { connected: true, downLong: false }), { tone: 'working', link: 'live' });
  assert.deepEqual(chatPill(live, { connected: false, downLong: false }), { tone: 'working', link: 'live' });
  assert.deepEqual(chatPill(live, { connected: false, downLong: true }), { tone: 'working', link: 'reconnecting' });
});

test('without a process of ours the pill says who holds the chat', () => {
  assert.equal(chatPill(chat(), { connected: false, downLong: true }).link, 'resumable');
  assert.equal(chatPill(chat({ control: { mode: 'readOnly', reason: 'x', action: 'fork' } }), { connected: false, downLong: true }).link, 'readOnly');
});

const ticking = { state: 'working' as const, activity: null, updatedAt: '2026-09-21T10:00:00.000Z', startedAt: '2026-09-21T09:00:00.000Z' };

test("the ticker prefers the chat's own stream, then what core derived, then a plain working", () => {
  const partial = { block: 'thinking' as const, since: '2026-09-21T10:00:05.000Z' };
  assert.deepEqual(tickerActivity(ticking, partial), { kind: 'thinking', since: partial.since });
  const activity = { kind: 'tool' as const, tool: 'Edit', target: 'src/a.ts', since: '2026-09-21T10:00:01.000Z' };
  assert.deepEqual(tickerActivity({ ...ticking, activity }, null), activity);
  assert.deepEqual(tickerActivity(ticking, null), { kind: 'tool', since: ticking.updatedAt });
  assert.deepEqual(tickerActivity({ ...ticking, state: 'waiting' }, null), { kind: 'waiting', since: ticking.updatedAt });
});

test('an idle chat has no ticker, even with an activity left over from its last turn', () => {
  const activity = { kind: 'tool' as const, tool: 'Edit', since: '2026-09-21T10:00:01.000Z' };
  assert.equal(tickerActivity({ ...ticking, state: 'idle', activity }, null), null);
});

test('a checklist reads as steps and as counts for its progress blocks', () => {
  const items = [
    { text: 'a', status: 'completed' as const },
    { text: 'b', status: 'in_progress' as const },
    { text: 'c', status: 'pending' as const },
    { text: 'd', status: 'pending' as const },
  ];
  assert.deepEqual(items.map(checklistStepState), ['done', 'current', 'pending', 'pending']);
  assert.deepEqual(checklistCounts(items), { done: 1, running: 1, pending: 2 });
});

test("a chat's own page gets the activity the feed carries, so its ticker never lags the list", () => {
  const client = new QueryClient();
  const detail = { chat: { id: 'chat-1', activity: null }, entries: [], from: 0, total: 0 } as unknown as ChatDetail;
  client.setQueryData(keys.chat('chat-1', false), detail);
  const activity = { kind: 'tool' as const, tool: 'Bash', target: 'npm test', since: '2026-09-21T10:00:00.000Z' };
  patchActivity(client, {
    id: 1,
    at: activity.since,
    title: '',
    type: 'chat.activity',
    runId: 'chat-1',
    runName: 'demo',
    sessionId: 'chat-1',
    orchestrationId: null,
    internal: false,
    taskId: null,
    activity,
  });
  assert.deepEqual(client.getQueryData<ChatDetail>(keys.chat('chat-1', false))?.chat.activity, activity);
  assert.equal(client.getQueryData(keys.chat('chat-1', true)), undefined, 'a page nobody opened is not invented');
});
