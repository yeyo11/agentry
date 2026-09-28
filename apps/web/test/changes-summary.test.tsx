// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import type { ChangeSummary, EditStep } from '@agentry/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ChangesSummary } from '../src/components/observe/Changes';
import i18n from '../src/i18n';
import { editChips, liveFile, reviewLink, reviewPath, statusLetter, stepFiles, workFiles } from '../src/lib/changes-summary';
import type { StepPart } from '../src/lib/chat-steps';

// The compact summary (the reference's `DesktopChatCambios`): the files the whole work touched, the
// one being edited now, the latest step, and the chips a tool group of the transcript shows.

void i18n.changeLanguage('en');

const file = (path: string, status: 'modified' | 'added' | 'deleted' | 'renamed', additions: number, deletions: number) => ({ path, status, additions, deletions });

const SUMMARY: ChangeSummary = {
  branch: 'agentry/b67aa3',
  base: 'abcdef0123456789',
  ahead: 3,
  commits: [],
  files: [file('packages/core/src/changes.ts', 'modified', 11, 3), file('apps/web/src/lib/editor.ts', 'deleted', 0, 10)],
  uncommitted: [file('apps/web/src/components/observe/Changes.tsx', 'modified', 6, 7)],
};

const step = (index: number, path: string, extra: Partial<EditStep> = {}): EditStep => ({
  id: `toolu_${index}`,
  index,
  at: '2026-09-28T10:00:00Z',
  tool: 'Edit',
  path,
  additions: 2,
  deletions: 1,
  diff: '',
  created: false,
  intent: null,
  entryIndex: index * 2,
  pending: false,
  ...extra,
});

test('the work lists `working`, or the commits and the uncommitted files when the server is older', () => {
  assert.deepEqual(
    workFiles(SUMMARY).map((f) => f.path),
    ['packages/core/src/changes.ts', 'apps/web/src/lib/editor.ts', 'apps/web/src/components/observe/Changes.tsx'],
  );
  const both = { ...SUMMARY, uncommitted: [file('packages/core/src/changes.ts', 'modified', 1, 1)] };
  assert.equal(workFiles(both).length, 2, 'a file committed and edited again keeps one row');
  const working = [file('x.ts', 'added', 1, 0)];
  assert.deepEqual(workFiles({ ...SUMMARY, working }), working);
});

test('status letters, B for a binary file whatever git called it', () => {
  assert.equal(statusLetter({ status: 'modified' }), 'M');
  assert.equal(statusLetter({ status: 'added' }), 'A');
  assert.equal(statusLetter({ status: 'deleted' }), 'D');
  assert.equal(statusLetter({ status: 'renamed' }), 'R');
  assert.equal(statusLetter({ status: 'added', binary: true }), 'B');
});

test('the file being edited now is the one an edit activity targets, resolved against the top level', () => {
  const paths = ['apps/web/src/components/observe/Changes.tsx', 'packages/core/src/changes.ts', 'changes.ts'];
  const edit = (target: string, tool = 'Edit') => ({ kind: 'tool' as const, tool, target, since: '' });
  assert.equal(liveFile(edit('src/components/observe/Changes.tsx'), paths), 'apps/web/src/components/observe/Changes.tsx');
  assert.equal(liveFile(edit('./packages/core/src/changes.ts', 'Write'), paths), 'packages/core/src/changes.ts');
  assert.equal(liveFile(edit('changes.ts'), paths), 'changes.ts', 'an exact match wins over one that only ends the same');
  assert.equal(liveFile(edit('src/changes.ts'), ['a/src/changes.ts', 'b/src/changes.ts']), null, 'two candidates: none');
  assert.equal(liveFile(edit('packages/core/src/chan…'), paths), null, 'a target cut at 80 characters');
  assert.equal(liveFile(edit('packages/core/src/changes.ts', 'Read'), paths), null, 'reading is not editing');
  assert.equal(liveFile({ kind: 'thinking', since: '' }, paths), null);
  assert.equal(liveFile(null, paths), null);
});

test('the files of a chat outside git come from its steps, newest edit first', () => {
  const files = stepFiles([step(1, 'a.ts'), step(2, 'b.ts', { created: true, additions: 5, deletions: 0 }), step(3, 'a.ts')]);
  assert.deepEqual(files, [
    { path: 'a.ts', additions: 4, deletions: 2, created: false },
    { path: 'b.ts', additions: 5, deletions: 0, created: true },
  ]);
});

test('a tool group shows one chip per edited file, counted once the steps are known', () => {
  const call = (id: string, name: string, input: unknown, isError = false): StepPart => ({ kind: 'call', id, name, input, result: { content: '', isError } });
  const parts: StepPart[] = [
    call('toolu_1', 'Read', { file_path: '/repo/a.ts' }),
    call('toolu_2', 'Edit', { file_path: '/repo/src/git.ts' }),
    call('toolu_3', 'Edit', { file_path: '/repo/src/git.ts' }),
    call('toolu_4', 'Write', { file_path: '/repo/src/changes.ts' }),
    call('toolu_5', 'Edit', { file_path: '/repo/src/failed.ts' }, true),
    call('toolu_6', 'NotebookEdit', { notebook_path: '/repo/n.ipynb' }),
    { kind: 'thinking', text: '…' },
  ];
  const unknown = editChips(parts, null);
  assert.deepEqual(
    unknown.map((c) => [c.name, c.stepId, c.additions]),
    [
      ['git.ts', 'toolu_3', null],
      ['changes.ts', 'toolu_4', null],
      ['n.ipynb', 'toolu_6', null],
    ],
  );
  const steps = new Map([step(2, 'src/git.ts'), step(3, 'src/git.ts', { additions: 9, deletions: 4 })].map((s) => [s.id, s]));
  const known = editChips(parts, steps);
  assert.deepEqual([known[0]?.additions, known[0]?.deletions], [11, 5], 'the calls of one file add up');
  assert.equal(known[1]?.additions, null, 'a call whose step is not known has no counts');
});

test('review links', () => {
  assert.equal(reviewPath.chat('c 1'), '/chats/c%201/changes');
  assert.equal(reviewPath.task('o1', 't1'), '/orchestration/o1/tasks/t1/changes');
  assert.equal(reviewPath.integration('o1'), '/orchestration/o1/changes');
  assert.equal(reviewLink('/chats/c1/changes'), '/chats/c1/changes');
  assert.equal(reviewLink('/chats/c1/changes', { lens: 'steps', step: 'toolu_1' }), '/chats/c1/changes?lens=steps&step=toolu_1');
  assert.equal(reviewLink('/chats/c1/changes', { file: 'src/a b.ts' }), '/chats/c1/changes?file=src%2Fa+b.ts');
});

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

test('the summary draws the totals, the files, the latest step and the way into the review', () => {
  // No live activity here: the braille spinner reads the motion store, which has no server snapshot
  const steps = [step(1, 'packages/core/src/changes.ts'), step(2, 'apps/web/src/components/observe/Changes.tsx', { intent: 'Now I drop the editor links.' })];
  const html = render(<ChangesSummary summary={SUMMARY} steps={steps} base="/chats/c1/changes" />);
  assert.match(html, /^<section class="obs-changes">/);
  assert.match(html, /agentry\/b67aa3 · 3 commits · 3 files/);
  assert.match(html, /class="changes-print"/);
  assert.equal((html.match(/class="obs-file"/g) ?? []).length, 3);
  assert.match(html, /<span class="obs-file-name mono">changes.ts<\/span>/, 'a row names the file, the path is its title');
  assert.match(html, /href="\/chats\/c1\/changes\?file=packages%2Fcore%2Fsrc%2Fchanges.ts"/);
  assert.match(html, /class="obs-status is-D mono" aria-hidden="true">D</);
  assert.match(html, /class="obs-add">\+17<\/span>/, 'the totals');
  assert.match(html, /<span class="sr-only">11 lines added, 3 lines removed<\/span>/);
  assert.equal((html.match(/class="obs-uncommitted"/g) ?? []).length, 1);
  assert.match(html, /Latest step/);
  assert.match(html, /<span class="obs-step-intent">“Now I drop the editor links.”<\/span>/);
  assert.match(html, /href="\/chats\/c1\/changes\?lens=steps&amp;step=toolu_2"/);
  assert.match(html, /<a class="btn btn-primary btn-block changes-review-link" href="\/chats\/c1\/changes"[^>]*>Review the changes/);
  assert.match(html, /See step by step · 2 steps/);
  assert.doesNotMatch(html, /role="dialog"|vscode:|in the editor/i);
});

test('a chat outside git opens its review on Step by step', () => {
  const html = render(<ChangesSummary summary={null} steps={[step(1, 'notes.md', { created: true, additions: 4, deletions: 0 })]} base="/chats/c1/changes" />);
  assert.match(html, /not work in a git checkout/);
  assert.match(html, /class="obs-status is-A mono"/);
  assert.match(html, /<a class="btn btn-primary btn-block changes-review-link" href="\/chats\/c1\/changes\?lens=steps"[^>]*>Review step by step · 1 step/);
  assert.doesNotMatch(html, /changes-print/);
});

test('nothing changed yet: a sentence, no fingerprint and no review', () => {
  const html = render(<ChangesSummary summary={{ ...SUMMARY, ahead: 0, files: [], uncommitted: [] }} steps={[]} base="/orchestration/o1/changes" />);
  assert.match(html, /Nothing changed yet/);
  assert.doesNotMatch(html, /changes-print|changes-review-link/);
});
