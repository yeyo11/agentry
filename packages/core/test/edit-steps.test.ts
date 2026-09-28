import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatSummary, TranscriptEntry } from '@agentry/shared';
import { Changes } from '../src/changes.ts';
import { addedDiff, unifiedOf } from '../src/edit-steps.ts';
import { SessionStore } from '../src/sessions.ts';
import { tempConfig } from './helpers.ts';

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const prompt = (uuid: string, text: string) => line({ type: 'user', uuid, timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: text } });
const say = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', uuid, timestamp: `2026-01-01T10:00:${uuid.padStart(2, '0').slice(-2)}Z`, message: { role: 'assistant', content }, ...extra });
const text = (t: string) => ({ type: 'text', text: t });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const result = (uuid: string, id: string, toolUseResult: unknown, isError = false) =>
  line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] }, toolUseResult });

/** A checkout the chat works in a subdirectory of, so a step's path is measured from its top level. */
function checkout(): { root: string; cwd: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentry-steps-')));
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  const cwd = join(root, 'sub');
  mkdirSync(cwd);
  return { root, cwd };
}

function transcript(root: string): string {
  const big = 'x'.repeat(400);
  return [
    prompt('u0', 'please edit'), // 0
    say('1', [text("I'll fix the greeting.")]), // 1
    say('2', [use('e1', 'Edit', { file_path: join(root, 'src', 'a.ts'), old_string: 'hello', new_string: 'hi' })]), // 2
    result('r1', 'e1', {
      filePath: join(root, 'src', 'a.ts'),
      originalFile: 'hello\nworld\n',
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-hello', '+hi', ' world'] }],
    }), // 3
    // A subagent's edit is not the chat's, and not in the main view's count
    say('3', [use('s1', 'Edit', { file_path: join(root, 'side.ts') })], { isSidechain: true }),
    say('4', [text(`Now the new file. ${big}`), use('w1', 'Write', { file_path: join(root, 'new.txt'), content: 'a\nb\n' })]), // 4
    result('r2', 'w1', { type: 'create', filePath: join(root, 'new.txt'), content: 'a\nb\n', structuredPatch: [] }), // 5
    say('5', [use('bad', 'Edit', { file_path: join(root, 'src', 'a.ts') })]), // 6
    result('r3', 'bad', 'Error: String to replace not found in file.', true), // 7
    say('6', [use('refused', 'Write', { file_path: join(root, 'no.txt') })]), // 8
    // A refusal leaves a string where the patch would be, whatever the block says
    result('r4', 'refused', 'User rejected write to file'), // 9
    line({ type: 'system', subtype: 'informational', content: 'not an entry' }),
    prompt('u1', 'and the one outside'), // 10
    say('7', [use('o1', 'Edit', { file_path: '/elsewhere/b.ts' })]), // 11
    result('r5', 'o1', { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 0, lines: ['-gone'] }] }), // 12
    say('8', [use('p1', 'NotebookEdit', { notebook_path: join(root, 'sub', 'n.ipynb') })]), // 13
  ].join('');
}

function setup(running: boolean, streamed: TranscriptEntry[] | null = null) {
  const config = tempConfig();
  const { root, cwd } = checkout();
  const dir = join(config.projectsDir, '-work-steps');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'sess.jsonl');
  const chat = { id: 'sess', cwd, worktree: null, orchestration: null, execution: running ? { id: 'x' } : null } as unknown as ChatSummary;
  const sessions = new SessionStore(config);
  const changes = new Changes({
    orchestrator: { get: () => null } as never,
    chats: { summaryOf: async (id: string) => (id === 'sess' ? chat : null) } as never,
    sessions,
    runtime: { messages: () => streamed } as never,
  });
  return { root, file, changes, sessions };
}

test('a structured patch becomes unified hunks, and a created file an all-added diff', () => {
  assert.equal(
    unifiedOf([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }, { oldStart: 9, oldLines: 0, newStart: 10, newLines: 1, lines: ['+z'] }]),
    '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n@@ -9,0 +10,1 @@\n+z\n',
  );
  assert.equal(addedDiff('one\ntwo\n'), '@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.equal(addedDiff('last'), '@@ -0,0 +1,1 @@\n+last\n\\ No newline at end of file\n');
  assert.equal(addedDiff(''), '');
});

test('the steps of a transcript: patches, a created file, failures left out, the intent and the entry', async () => {
  const { root, file, changes } = setup(false);
  writeFileSync(file, transcript(root));
  const steps = await changes.chatSteps('sess');

  assert.deepEqual(
    steps.map((s) => [s.index, s.id, s.tool, s.path, s.entryIndex, s.additions, s.deletions, s.created, s.pending]),
    [
      // Relative to the top level of the checkout, not to the subdirectory the chat runs in
      [1, 'e1', 'Edit', 'src/a.ts', 2, 1, 1, false, false],
      [2, 'w1', 'Write', 'new.txt', 4, 2, 0, true, false],
      // Outside the checkout: as the call named it
      [3, 'o1', 'Edit', '/elsewhere/b.ts', 11, 0, 1, false, false],
    ],
  );
  const [edit, write, outside] = steps;
  assert.equal(edit?.diff, '@@ -1,2 +1,2 @@\n-hello\n+hi\n world\n');
  assert.equal(edit?.intent, "I'll fix the greeting.");
  assert.equal(edit?.at, '2026-01-01T10:00:02Z');
  assert.equal(write?.diff, '@@ -0,0 +1,2 @@\n+a\n+b\n');
  // Clipped, and said in the same entry as the call
  assert.equal(write?.intent?.length, 280);
  assert.match(write?.intent ?? '', /^Now the new file\. x+…$/);
  // A new prompt: what was said before it explains nothing after it
  assert.equal(outside?.intent, null);
});

test('an unanswered call is the last step, pending, only while the chat has an execution', async () => {
  const idle = setup(false);
  writeFileSync(idle.file, transcript(idle.root));
  assert.equal((await idle.changes.chatSteps('sess')).some((s) => s.id === 'p1'), false);

  const busy = setup(true);
  writeFileSync(busy.file, transcript(busy.root));
  const last = (await busy.changes.chatSteps('sess')).at(-1);
  assert.deepEqual(
    last && { id: last.id, index: last.index, tool: last.tool, path: last.path, pending: last.pending, diff: last.diff, entryIndex: last.entryIndex },
    { id: 'p1', index: 4, tool: 'NotebookEdit', path: 'sub/n.ipynb', pending: true, diff: '', entryIndex: 13 },
  );
});

test('the entry index is the one the chat page uses, and a later read only adds what was appended', async () => {
  const { root, file, changes, sessions } = setup(false);
  writeFileSync(file, transcript(root));
  await changes.chatSteps('sess');
  const page = await sessions.getSession('sess', { limit: 1000 });
  const entry = page?.entries[2];
  assert.ok(entry?.blocks.some((b) => b.type === 'tool_use' && b.id === 'e1'));

  appendFileSync(file, result('r6', 'p1', { structuredPatch: [] }) + say('9', [text('One more.'), use('e2', 'MultiEdit', { file_path: join(root, 'src', 'a.ts') })]) + result('r7', 'e2', { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hi', '+hey'] }] }));
  const steps = await changes.chatSteps('sess');
  assert.deepEqual(steps.map((s) => s.id), ['e1', 'w1', 'o1', 'p1', 'e2']);
  // A notebook edit whose result kept no patch has none to show
  assert.equal(steps[3]?.diff, '');
  assert.equal(steps[4]?.intent, 'One more.');
  assert.equal(steps[4]?.entryIndex, 15);
});

test('a chat with no transcript yet lists the edits its process streamed, without patches', async () => {
  const message = (role: 'user' | 'assistant', blocks: TranscriptEntry['blocks'], isSidechain = false): TranscriptEntry => ({
    uuid: '', role, timestamp: '2026-01-01T11:00:00Z', model: null, isSidechain, parentToolUseId: null, blocks,
  });
  const streamed: TranscriptEntry[] = [];
  const { root, changes } = setup(false, streamed);
  streamed.push(
    message('user', [{ type: 'text', text: 'go' }]),
    message('assistant', [{ type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: join(root, 'x.md') } }]),
    message('user', [{ type: 'tool_result', toolUseId: 'w1', content: 'done', isError: false }]),
    message('assistant', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(root, 'x.md') } }]),
    message('user', [{ type: 'tool_result', toolUseId: 'e1', content: 'nope', isError: true }]),
  );
  assert.deepEqual(await changes.chatSteps('sess'), [
    { id: 'w1', index: 1, at: '2026-01-01T11:00:00Z', tool: 'Write', path: 'x.md', additions: 0, deletions: 0, diff: '', created: false, intent: 'Writing it.', entryIndex: 1, pending: false },
  ]);
  await assert.rejects(changes.chatSteps('nope'), /chat not found/);
});
