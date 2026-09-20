import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../src/sessions.ts';
import { checklistOf, CHECKLIST_TOOLS, touchedFilesOf, WRITING_TOOLS, type ToolCall } from '../src/tool-calls.ts';
import { tempConfig } from './helpers.ts';

let n = 0;
const call = (name: string, input: Record<string, unknown>, result = '', isError: boolean | null = false): ToolCall => ({
  id: `c${++n}`, name, input, at: `2026-01-01T10:00:${String(n).padStart(2, '0')}Z`, isError, result,
});

test('TodoWrite rewrites the whole list every time, so the last call is the checklist', () => {
  const list = checklistOf([
    call('TodoWrite', { todos: [{ content: 'read', status: 'in_progress' }, { content: 'write', status: 'pending' }] }),
    call('TodoWrite', { todos: [{ content: 'read', status: 'completed' }, { content: 'write', status: 'in_progress' }, { content: 'test', status: 'pending' }] }),
  ]);
  assert.deepEqual(list.items, [
    { text: 'read', status: 'completed' },
    { text: 'write', status: 'in_progress' },
    { text: 'test', status: 'pending' },
  ]);
  assert.match(list.updatedAt ?? '', /^2026-01-01T10:00:/);
});

test('TaskUpdate finds its item by the id the result of TaskCreate gave, whatever order they were made in', () => {
  const list = checklistOf([
    call('TaskCreate', { subject: 'first', description: 'd' }, 'Task #1 created successfully: first'),
    call('TaskCreate', { subject: 'second', description: 'd' }, 'Task #2 created successfully: second'),
    call('TaskCreate', { subject: 'third', description: 'd' }, 'Task #3 created successfully: third'),
    call('TaskUpdate', { taskId: '2', status: 'completed' }),
    call('TaskUpdate', { taskId: '1', status: 'in_progress', subject: 'first, renamed' }),
    call('TaskUpdate', { taskId: '3', status: 'deleted' }),
  ]);
  assert.deepEqual(list.items, [
    { text: 'first, renamed', status: 'in_progress' },
    { text: 'second', status: 'completed' },
  ]);
});

test('a task call that failed changed nothing, and an update of an item that is not there is ignored', () => {
  const list = checklistOf([
    call('TaskCreate', { subject: 'kept' }, 'Task #1 created successfully: kept'),
    call('TaskCreate', { subject: 'never made' }, 'no such thing', true),
    call('TaskUpdate', { taskId: '1', status: 'completed' }, 'refused', true),
    call('TaskUpdate', { taskId: '9', status: 'completed' }),
    call('TaskUpdate', { taskId: '1', status: 'sideways' }),
  ]);
  assert.deepEqual(list.items, [{ text: 'kept', status: 'pending' }]);
});

test('a worker that never planned has an empty checklist and no update time', () => {
  assert.deepEqual(checklistOf([]), { items: [], updatedAt: null });
});

test('touched files are listed newest first, once each, and only where the edit went through', () => {
  const touched = touchedFilesOf([
    call('Write', { file_path: '/p/a.ts' }),
    call('Edit', { file_path: '/p/b.ts' }),
    call('NotebookEdit', { notebook_path: '/p/n.ipynb' }),
    call('Edit', { file_path: '/p/refused.ts' }, 'user rejected', true),
    call('Edit', { file_path: '/p/a.ts' }),
    call('Write', {}),
  ]);
  assert.deepEqual(touched.map((t) => [t.path, t.tool]), [
    ['/p/a.ts', 'Edit'],
    ['/p/n.ipynb', 'NotebookEdit'],
    ['/p/b.ts', 'Edit'],
  ]);
});

test('a transcript on disk is read for the calls of the tools asked for, results paired to their calls', async () => {
  const config = tempConfig();
  const dir = join(config.projectsDir, '-work-demo');
  mkdirSync(dir, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    join(dir, 'sess-1.jsonl'),
    [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T10:00:00Z', cwd: '/work/demo', message: { role: 'user', content: 'plan it' } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'TaskCreate', input: { subject: 'do it' } }] } }),
      line({ type: 'user', uuid: 'u2', timestamp: '2026-01-01T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Task #7 created successfully: do it' }] } }),
      line({ type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T10:00:03Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } }] } }),
      line({ type: 'assistant', uuid: 'a3', timestamp: '2026-01-01T10:00:04Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }] } }),
      line({ type: 'assistant', uuid: 'a4', timestamp: '2026-01-01T10:00:05Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu4', name: 'Write', input: { file_path: '/work/demo/x.ts' } }] } }),
      '{"half written',
    ].join('\n'),
  );
  const sessions = new SessionStore(config);

  const planning = await sessions.toolCalls('sess-1', CHECKLIST_TOOLS);
  assert.deepEqual(planning?.map((c) => c.name), ['TaskCreate', 'TaskUpdate']);
  assert.equal(planning?.[0]?.result, 'Task #7 created successfully: do it');
  assert.deepEqual(checklistOf(planning ?? []).items, [{ text: 'do it', status: 'completed' }]);

  const writing = await sessions.toolCalls('sess-1', WRITING_TOOLS);
  assert.deepEqual(touchedFilesOf(writing ?? []).map((t) => t.path), ['/work/demo/x.ts']);
  assert.equal(await sessions.toolCalls('nope', WRITING_TOOLS), null);
});
