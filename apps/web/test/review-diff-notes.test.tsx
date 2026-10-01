// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import type { ChangedFile, ReviewDraft, ReviewThread } from '@agentry/shared';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { useDraftNotes } from '../src/components/changes/DraftNotes';
import { FileReview } from '../src/components/changes/FileReview';
import { ReviewComposer } from '../src/components/changes/ReviewComposer';
import type { ReviewSource } from '../src/components/changes/source';
import i18n from '../src/i18n';
import { openChangeRequestId } from '../src/lib/review-lines';

// What the changes page shows of a change request's review: its threads under their lines, the
// person's draft notes, and a way to leave one. A page with no change request shows none of it.

(globalThis as { React?: unknown }).React = React;
void i18n.changeLanguage('en');

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three', ''].join('\n');
const FILE: ChangedFile = { path: 'a.ts', status: 'modified', additions: 1, deletions: 0 };
const SOURCE: ReviewSource = {
  kind: 'workItem',
  storageKey: 'work-item:w1',
  summary: () => ({ queryKey: ['s'], queryFn: async () => null }),
  diff: (path, opts) => ({ queryKey: ['diff', path, opts], queryFn: async () => ({ path, diff: DIFF, full: false }) }),
  steps: null,
  conversation: null,
  live: false,
  back: { to: '/', label: 'back' },
  subject: null,
  changeRequestId: 'cr-1',
  activity: null,
};

const THREAD: ReviewThread = {
  id: 't1', path: 'a.ts', side: 'right', line: 2, startLine: 2, originalLine: 2, diffHunk: null, isResolved: false, isOutdated: false,
  resolvedBy: null, viewerCanReply: true, viewerCanResolve: true,
  comments: [{ id: 'c1', author: 'marta', body: 'Rename this', suggestion: null, createdAt: null, url: null }], commentsTruncated: false,
};
const DRAFT: ReviewDraft = {
  id: 'd1', changeRequestId: 'cr-1', path: 'a.ts', side: 'right', line: 2, startLine: null, body: 'Why not a constant?', suggestion: false,
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
};

function client(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const main = SOURCE.diff('a.ts', {});
  qc.setQueryData(main.queryKey, { path: 'a.ts', diff: DIFF, full: false });
  qc.setQueryData(keys.changeRequestThreads('cr-1'), { head: 'abc', threads: [THREAD] });
  qc.setQueryData(keys.reviewDrafts('cr-1'), [DRAFT]);
  return qc;
}

const page = (review: { changeRequestId: string } | undefined) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client()}>
      <ToastProvider>
        <TooltipProvider><MemoryRouter>
          <FileReview
            source={SOURCE}
            file={FILE}
            scope={{ kind: 'all' }}
            mode="unified"
            modes={['reading', 'unified']}
            onMode={() => {}}
            seen={false}
            onSeen={() => {}}
            onHash={() => {}}
            steps={null}
            stepHref={() => ''}
            phone={false}
            nav={{ prev: null, next: null, to: () => '', go: () => {} }}
            review={review}
          />
        </MemoryRouter></TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );

test('a file with a change request draws its thread and its draft note under their line, and offers a note', () => {
  const html = page({ changeRequestId: 'cr-1' });
  assert.match(html, /class="rt open"/);
  assert.match(html, /Rename this/);
  assert.match(html, /class="rt draft"/);
  assert.match(html, /Why not a constant\?/);
  assert.match(html, /diff-add-note/);
  assert.match(html, /1 thread/);
  assert.match(html, /1 draft comment/);
  // Both hang under the added line, before the next one
  assert.ok(html.indexOf('two') < html.indexOf('class="rt open"'));
  assert.ok(html.indexOf('class="rt draft"') < html.indexOf('three'));
});

test('a file with no change request draws nothing of the review and offers no note', () => {
  const html = page(undefined);
  assert.doesNotMatch(html, /class="rt /);
  assert.doesNotMatch(html, /diff-add-note/);
  assert.doesNotMatch(html, /draft comment/);
});

test('the notes hook offers a note only where there is a change request to hold it', () => {
  const offered: Record<string, boolean> = {};
  const Probe = ({ id }: { id: string | undefined }) => {
    const notes = useDraftNotes({ changeRequestId: id, path: 'a.ts', diff: null });
    offered[id ?? 'none'] = !!notes.onAddNote && !!notes.extra;
    return null;
  };
  renderToStaticMarkup(
    <QueryClientProvider client={client()}>
      <ToastProvider>
        <Probe id="cr-1" />
        <Probe id={undefined} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  assert.deepEqual(offered, { 'cr-1': true, none: false });
});

test('the composer opens with the suggestion option on a head-side line, and not on a removed one', () => {
  const on = renderToStaticMarkup(<ReviewComposer target={{ path: 'a.ts', side: 'right', line: 2, startLine: null }} onSave={() => {}} onCancel={() => {}} />);
  assert.match(on, /Suggest a change/);
  assert.match(on, /a\.ts:2/);
  const off = renderToStaticMarkup(<ReviewComposer target={{ path: 'a.ts', side: 'left', line: 2, startLine: null }} onSave={() => {}} onCancel={() => {}} />);
  assert.doesNotMatch(off, /Suggest a change/);
});

test('only an open change request with an id is read for its review', () => {
  assert.equal(openChangeRequestId({ id: 'cr-1', phase: 'open' }), 'cr-1');
  assert.equal(openChangeRequestId({ id: 'cr-1', phase: 'merged' }), null);
  assert.equal(openChangeRequestId({ phase: 'open' }), null);
  assert.equal(openChangeRequestId(null), null);
});
