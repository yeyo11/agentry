import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentBlock, Health, HealthSignal, TranscriptEntry } from '@agentry/shared';
import { cancellable, checklistProgress, currentActivity, describeCall, healthWord, hunksOf, totalsOf } from '../src/lib/observe.ts';

const entry = (uuid: string, blocks: ContentBlock[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid,
  role: 'assistant',
  timestamp: '2026-05-01T10:00:00.000Z',
  model: null,
  isSidechain: false,
  parentToolUseId: null,
  blocks,
  ...extra,
});
const call = (id: string, name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id, name, input });
const result = (toolUseId: string): ContentBlock => ({ type: 'tool_result', toolUseId, content: 'ok', isError: false });

test('a hunk points at the first line it changed, not at the context above it', () => {
  const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -10,6 +10,7 @@ function f() {', ' one', ' two', ' three', '+added', ' four', '-gone', ''].join('\n');
  assert.deepEqual(hunksOf(diff), [{ header: '@@ -10,6 +10,7 @@ function f() {', line: 13 }]);
});

test('a hunk that only deletes points at the line the deletion left behind', () => {
  const diff = ['@@ -5,3 +5,2 @@', ' keep', '-removed', ' keep too', ''].join('\n');
  assert.equal(hunksOf(diff)[0]?.line, 6);
});

test('every hunk of a file is listed, in order', () => {
  const diff = ['@@ -1,2 +1,3 @@', ' a', '+b', ' c', '@@ -40,2 +41,2 @@', '-x', '+y', ' z'].join('\n');
  assert.deepEqual(
    hunksOf(diff).map((h) => h.line),
    [2, 41],
  );
});

test('a file emptied has no line zero to open: the link goes to the first line', () => {
  assert.equal(hunksOf('@@ -1,2 +0,0 @@\n-a\n-b')[0]?.line, 1);
});

test('a new file opens at its first line, and the +++ header is not a line of it', () => {
  assert.equal(hunksOf('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b')[0]?.line, 1);
});

test('text that is not a diff has no hunks', () => {
  assert.deepEqual(hunksOf(''), []);
  assert.deepEqual(hunksOf('Binary files differ'), []);
});

test('totals add the lines of every file', () => {
  const file = (additions: number, deletions: number) => ({ path: 'p', status: 'modified' as const, additions, deletions });
  assert.deepEqual(totalsOf([file(3, 1), file(10, 0)]), { additions: 13, deletions: 1 });
  assert.deepEqual(totalsOf([]), { additions: 0, deletions: 0 });
});

test('a call is described by what it acts on', () => {
  assert.equal(describeCall('Bash', { command: 'pnpm  test\n--filter x' }), 'pnpm test --filter x');
  assert.equal(describeCall('Edit', { file_path: '/a/b.ts', old_string: 'x' }), '/a/b.ts');
  assert.equal(describeCall('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(describeCall('Mystery', { size: 3 }), 'Mystery');
  assert.equal(describeCall('Mystery', null), 'Mystery');
  assert.ok(describeCall('Bash', { command: 'x'.repeat(500) }).length <= 120);
});

test('the call with no result yet is what the chat is running', () => {
  const entries = [
    entry('1', [call('a', 'Read', { file_path: '/x.ts' })]),
    entry('2', [result('a')], { role: 'user', timestamp: '2026-05-01T10:00:05.000Z' }),
    entry('3', [call('b', 'Bash', { command: 'pnpm e2e' })], { timestamp: '2026-05-01T10:00:10.000Z' }),
  ];
  const now = currentActivity(entries);
  assert.equal(now.running?.id, 'b');
  assert.equal(now.running?.summary, 'pnpm e2e');
  assert.equal(now.lastEventAt, '2026-05-01T10:00:10.000Z');
});

test('when every call has come back, nothing is running', () => {
  const entries = [entry('1', [call('a', 'Bash', { command: 'ls' })]), entry('2', [result('a')], { role: 'user', timestamp: '2026-05-01T10:00:02.000Z' })];
  const now = currentActivity(entries);
  assert.equal(now.running, null);
  assert.equal(now.lastEventAt, '2026-05-01T10:00:02.000Z');
});

test('a subagent is a branch of the chat: its calls are not what the chat runs', () => {
  const entries = [entry('1', [call('a', 'Task', { description: 'review' })]), entry('2', [call('s', 'Bash', { command: 'inner' })], { isSidechain: true })];
  assert.equal(currentActivity(entries).running?.id, 'a');
});

test('a transcript with nothing in it says nothing', () => {
  assert.deepEqual(currentActivity([]), { running: null, lastEventAt: null });
});

const health = (level: Health['level'], kinds: HealthSignal['kind'][]): Pick<Health, 'level' | 'signals'> => ({
  level,
  signals: kinds.map((kind) => ({ kind, level: level === 'ok' ? 'warn' : level, reason: kind })),
});

test('a health verdict is named: ok, slow, stuck, or looping when it repeats itself', () => {
  assert.equal(healthWord(health('ok', [])), 'ok');
  assert.equal(healthWord(health('warn', ['silence'])), 'slow');
  assert.equal(healthWord(health('bad', ['hung-command'])), 'stuck');
  assert.equal(healthWord(health('bad', ['hung-command', 'repeat-stall'])), 'looping');
  assert.equal(healthWord(health('bad', ['loop'])), 'looping');
  // A warning that repeats is still only slow: looping asks for something a warning does not
  assert.equal(healthWord(health('warn', ['loop'])), 'slow');
});

test('only a command that is still running can be cancelled', () => {
  const signal = (kind: HealthSignal['kind'], toolUseId?: string): HealthSignal => ({ kind, level: 'bad', reason: 'r', ...(toolUseId ? { toolUseId } : {}) });
  assert.equal(cancellable(signal('hung-command', 'toolu_1')), true);
  assert.equal(cancellable(signal('repeat-stall', 'toolu_2')), true);
  assert.equal(cancellable(signal('hung-command')), false);
  // A weakened test names the edit that did it, and that call is long finished
  assert.equal(cancellable(signal('weakened-test', 'toolu_3')), false);
});

test('a checklist reports what is done and what is being worked on', () => {
  const progress = checklistProgress([
    { text: 'a', status: 'completed' },
    { text: 'b', status: 'in_progress' },
    { text: 'c', status: 'pending' },
  ]);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.current?.text, 'b');
  assert.equal(checklistProgress([]).current, null);
});
