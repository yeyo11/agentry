import type { ChangedFile, ChangeSummary, DecisionRecord, EditStep } from '@agentry/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filesOf,
  groupByDir,
  liveFile,
  neighbour,
  printSegments,
  reviewKey,
  scopeOf,
  scopeParam,
  scopeQuery,
  stableOrder,
  statusLetter,
  stepsFor,
  unexplainedOf,
  workingFiles,
} from '../src/components/changes/review-model.ts';

// The review's choices that need no React: what a scope lists, how the map orders and groups it,
// and which file the agent is editing now.

const f = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: 'modified', additions: 1, deletions: 1, ...extra });

const summary = (extra: Partial<ChangeSummary> = {}): ChangeSummary => ({
  branch: 'feature/x',
  base: 'abc1234',
  ahead: 1,
  commits: [],
  files: [f('a.ts', { additions: 2 }), f('b.ts')],
  uncommitted: [f('b.ts', { additions: 5 }), f('c.ts', { status: 'added' })],
  ...extra,
});

test('a scope reads from and writes to the link', () => {
  assert.deepEqual(scopeOf(null), { kind: 'all' });
  assert.deepEqual(scopeOf('uncommitted'), { kind: 'uncommitted' });
  assert.deepEqual(scopeOf('deadbeef'), { kind: 'commit', sha: 'deadbeef' });
  assert.deepEqual(scopeOf('../etc'), { kind: 'all' }, 'anything that is not a hash is all the work');
  assert.equal(scopeParam({ kind: 'all' }), null);
  assert.deepEqual(scopeQuery({ kind: 'commit', sha: 'abc' }), { commit: 'abc' });
  assert.deepEqual(scopeQuery({ kind: 'uncommitted' }), { uncommitted: true });
});

test('All the work lists `working`, or the committed and uncommitted files merged when the server is older', () => {
  const working = [f('z.ts')];
  assert.deepEqual(workingFiles(summary({ working })), working);
  const merged = workingFiles(summary());
  assert.deepEqual(
    merged.map((x) => [x.path, x.additions]),
    [
      ['a.ts', 2],
      ['b.ts', 5],
      ['c.ts', 1],
    ],
  );
});

test('each scope lists its own files', () => {
  const s = summary();
  assert.deepEqual(filesOf({ kind: 'uncommitted' }, s, null), s.uncommitted);
  assert.deepEqual(filesOf({ kind: 'commit', sha: 'abc' }, s, null), [], 'a commit waits for its own summary');
  const scoped = summary({ files: [f('only.ts')] });
  assert.deepEqual(filesOf({ kind: 'commit', sha: 'abc' }, s, scoped), scoped.files);
});

test('the map reads as a tree, and holds still under the pointer', () => {
  const paths = ['src/b.ts', 'README.md', 'src/a.ts', 'lib/z.ts'];
  const sorted = stableOrder(paths, null);
  assert.deepEqual(sorted, ['README.md', 'lib/z.ts', 'src/a.ts', 'src/b.ts']);
  // A new file arrives while the pointer is over the map: it waits at the end, nothing moves
  const held = stableOrder([...paths, 'lib/a.ts'], sorted);
  assert.deepEqual(held, ['README.md', 'lib/z.ts', 'src/a.ts', 'src/b.ts', 'lib/a.ts']);
  // A file that went away drops out
  assert.deepEqual(stableOrder(['src/a.ts', 'README.md'], sorted), ['README.md', 'src/a.ts']);
  const groups = groupByDir(sorted.map((path) => ({ path })));
  assert.deepEqual(
    groups.map((g) => [g.dir, g.files.length]),
    [
      ['', 1],
      ['lib', 1],
      ['src', 2],
    ],
  );
});

test('a status letter for every file, B for binary', () => {
  assert.equal(statusLetter({ status: 'modified' }), 'M');
  assert.equal(statusLetter({ status: 'added' }), 'A');
  assert.equal(statusLetter({ status: 'deleted' }), 'D');
  assert.equal(statusLetter({ status: 'renamed' }), 'R');
  assert.equal(statusLetter({ status: 'modified', binary: true }), 'B');
});

test('the file being edited: the target resolved against the top level, or nothing', () => {
  const paths = ['packages/core/src/git.ts', 'README.md'];
  const where = { cwd: '/repo/packages/core', top: '/repo' };
  assert.equal(liveFile('src/git.ts', where, paths), 'packages/core/src/git.ts');
  assert.equal(liveFile('../../README.md', where, paths), 'README.md');
  assert.equal(liveFile('/repo/README.md', where, paths), 'README.md');
  assert.equal(liveFile('src/other.ts', where, paths), null, 'a file not listed has no spinner');
  assert.equal(liveFile('src/some/very/long/path/that/was/cut/at/eighty/characters/by/the/serv…', where, paths), null);
  assert.equal(liveFile(null, where, paths), null);
  // A worker's directory is its top level
  assert.equal(liveFile('README.md', { cwd: '/wt', top: '/wt' }, paths), 'README.md');
  // Without a known top level, a relative target is tried as it is
  assert.equal(liveFile('README.md', { cwd: '/x', top: null }, paths), 'README.md');
});

test('the steps of a file, and the neighbours of a list', () => {
  const step = (id: string, path: string): EditStep => ({
    id,
    index: 1,
    at: null,
    tool: 'Edit',
    path,
    additions: 1,
    deletions: 0,
    diff: '',
    created: false,
    intent: null,
    entryIndex: null,
    pending: false,
  });
  const steps = [step('1', 'a.ts'), step('2', 'b.ts'), step('3', 'a.ts')];
  assert.deepEqual(
    stepsFor(steps, 'a.ts').map((s) => s.id),
    ['1', '3'],
  );
  assert.deepEqual(stepsFor(null, 'a.ts'), []);
  assert.equal(neighbour(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(neighbour(['a', 'b', 'c'], 'c', 1), null);
  assert.equal(neighbour(['a', 'b', 'c'], null, 1), 'a');
  assert.equal(neighbour(['a', 'b', 'c'], null, -1), 'c');
});

test('the review keys never fire while typing or with a modifier', () => {
  const key = (k: string, target: unknown = null, extra: Partial<KeyboardEvent> = {}) =>
    reviewKey({ key: k, target: target as EventTarget | null, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...extra });
  assert.equal(key('j'), 'j');
  assert.equal(key('['), '[');
  assert.equal(key('x'), null);
  assert.equal(key('j', { tagName: 'INPUT' }), null);
  assert.equal(key('j', { tagName: 'TEXTAREA' }), null);
  assert.equal(key('j', { tagName: 'DIV', isContentEditable: true }), null);
  assert.equal(key('j', null, { ctrlKey: true }), null);
  assert.equal(key('j', null, { defaultPrevented: true }), null);
});

test('the fingerprint folds the smallest files into one segment once they do not fit', () => {
  const files = [
    { path: 'a', additions: 1, deletions: 0 },
    { path: 'b', additions: 40, deletions: 2 },
    { path: 'c', additions: 3, deletions: 3 },
    { path: 'd', additions: 90, deletions: 0 },
    { path: 'e', additions: 2, deletions: 0 },
  ];
  // Room for all five (4 px each, 2 px between): nothing folds, and the order is kept
  assert.deepEqual(printSegments(files, 28).shown.map((f) => f.path), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(printSegments(files, 28).rest, []);
  // Room for three segments: the two largest keep their own, in their order, and the rest share one
  const split = printSegments(files, 16);
  assert.deepEqual(split.shown.map((f) => f.path), ['b', 'd']);
  assert.deepEqual(split.rest.map((f) => f.path), ['a', 'c', 'e']);
  // Too narrow for anything: the one segment that fits is the folded one, never a lone file
  assert.deepEqual(printSegments(files, 0).shown, []);
  assert.equal(printSegments(files, 0).rest.length, 5);
  // Ties fold the later file first
  const tied = printSegments([{ path: 'x', additions: 1, deletions: 0 }, { path: 'y', additions: 1, deletions: 0 }, { path: 'z', additions: 1, deletions: 0 }], 10);
  assert.deepEqual(tied.shown.map((f) => f.path), ['x']);
});

test('unexplainedOf flags the step whose sentence and patch a "yes" was given for, and only that one', () => {
  const step = { diff: '@@ -1 +1 @@\n-a\n+b', intent: 'Rename a to b' };
  const row = (over: Partial<DecisionRecord> & { value?: boolean } = {}): DecisionRecord =>
    ({
      point: 'changes.unexplained-hunk',
      status: 'answered',
      state: { hunk: step.diff, step: step.intent, title: 'x' },
      answers: { unexplained: { kind: 'noul', value: over.value ?? true, confidence: 0.9 } },
      at: '2026-09-30T10:00:00.000Z',
      ...over,
    }) as unknown as DecisionRecord;
  assert.equal(unexplainedOf([row()], step)?.at, '2026-09-30T10:00:00.000Z');
  // A "no" explains it; another step's row, another point and an unavailable row flag nothing
  assert.equal(unexplainedOf([row({ value: false })], step), null);
  assert.equal(unexplainedOf([row()], { ...step, intent: 'Something else' }), null);
  assert.equal(unexplainedOf([row()], { diff: '@@ -2 +2 @@\n-c\n+d', intent: step.intent }), null);
  assert.equal(unexplainedOf([row({ point: 'flow.scope-drift' })], step), null);
  assert.equal(unexplainedOf([row({ status: 'unavailable' })], step), null);
  assert.equal(unexplainedOf([row()], { diff: '', intent: step.intent }), null);
  // The newest row of the step stands: a later "no" lifts the flag
  assert.equal(unexplainedOf([row(), row({ value: false, at: '2026-09-30T11:00:00.000Z' })], step), null);
  // No sentence before the edit compares as empty on both sides
  assert.ok(unexplainedOf([{ ...row(), state: { hunk: step.diff, step: '' } }], { diff: step.diff, intent: null }));
});
