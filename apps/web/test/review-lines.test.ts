import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewDraft, ReviewThread } from '@agentry/shared';
import { parseUnified } from '../src/lib/diff';
import { draftAnchor, draftsByLine, draftsInFile, newLineText } from '../src/lib/review-lines';
import { groupThreads, lineKey } from '../src/lib/reviews';

const thread = (over: Partial<ReviewThread>): ReviewThread => ({
  id: 't1', path: 'a.ts', side: 'right', line: 2, startLine: 2, originalLine: 2, diffHunk: null, isResolved: false, isOutdated: false,
  resolvedBy: null, viewerCanReply: true, viewerCanResolve: true, comments: [], commentsTruncated: false, ...over,
});

const draft = (over: Partial<ReviewDraft>): ReviewDraft => ({
  id: 'd1', changeRequestId: 'cr-1', path: 'a.ts', side: 'right', line: 2, startLine: null, body: 'x', suggestion: false,
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', ...over,
});

const DIFF = parseUnified(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@', ' one', '-old', '+two', ' three', ''].join('\n'));

test('a thread lands on its head-side line; an outdated one, a file one and a resolved one do not stand on it', () => {
  const { files } = groupThreads([
    thread({ id: 'line' }),
    thread({ id: 'left', side: 'left', line: 2 }),
    thread({ id: 'old', isOutdated: true, line: null, originalLine: 9 }),
    thread({ id: 'whole', line: null }),
    thread({ id: 'done', line: 3, isResolved: true }),
  ]);
  const file = files.get('a.ts');
  assert.deepEqual(file?.byLine.get(lineKey('right', 2))?.map((t) => t.id), ['line']);
  assert.deepEqual(file?.byLine.get(lineKey('left', 2))?.map((t) => t.id), ['left']);
  assert.deepEqual(file?.outdated.map((t) => t.id), ['old']);
  assert.deepEqual(file?.file.map((t) => t.id), ['whole']);
  assert.deepEqual(file?.resolvedByLine.get(lineKey('right', 3))?.map((t) => t.id), ['done']);
});

test('a draft note is anchored to its line and side; one without a line has no anchor', () => {
  assert.deepEqual(draftAnchor(draft({})), { side: 'right', line: 2 });
  assert.deepEqual(draftAnchor(draft({ side: null, line: 5 })), { side: 'right', line: 5 });
  assert.deepEqual(draftAnchor(draft({ side: 'left' })), { side: 'left', line: 2 });
  assert.equal(draftAnchor(draft({ line: null })), null);
  assert.equal(draftAnchor(draft({ path: null, line: null })), null);
});

test('a file\'s drafts are grouped by the line they end on, a range under its last line', () => {
  const list = [draft({ id: 'a' }), draft({ id: 'b', startLine: 1 }), draft({ id: 'c', line: 3 }), draft({ id: 'other', path: 'b.ts' }), draft({ id: 'general', path: null, line: null })];
  const map = draftsByLine(list, 'a.ts');
  assert.deepEqual(map.get(lineKey('right', 2))?.map((d) => d.id), ['a', 'b']);
  assert.deepEqual(map.get(lineKey('right', 3))?.map((d) => d.id), ['c']);
  assert.equal(map.size, 2);
  assert.equal(draftsInFile(list, 'a.ts'), 3);
  assert.equal(draftsInFile(list, 'b.ts'), 1);
});

test('a suggestion starts from the head-side text of the line, and from nothing where the diff lacks it', () => {
  assert.equal(newLineText(DIFF, 2), 'two');
  assert.equal(newLineText(DIFF, 1), 'one');
  assert.equal(newLineText(DIFF, 40), '');
  assert.equal(newLineText(null, 2), '');
});
