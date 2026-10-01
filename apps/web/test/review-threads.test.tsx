// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import type { ReviewThread } from '@agentry/shared';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffView } from '../src/components/changes/DiffView';
import { threadLayer, ThreadCard } from '../src/components/changes/ReviewThreads';
import i18n from '../src/i18n';
import { parseUnified } from '../src/lib/diff';
import { groupThreads } from '../src/lib/reviews';

// Threads in the diff (design system §5): a card under its line, a pill on the line, and a body that
// is someone else's text and never markup.

// chat-ui's components are compiled with the classic runtime by tsx and read `React` as a global
(globalThis as { React?: unknown }).React = React;
void i18n.changeLanguage('en');

const thread = (over: Partial<ReviewThread>): ReviewThread => ({
  id: 't1',
  path: 'a.ts',
  side: 'right',
  line: 2,
  startLine: 2,
  originalLine: 2,
  diffHunk: null,
  isResolved: false,
  isOutdated: false,
  resolvedBy: null,
  viewerCanReply: true,
  viewerCanResolve: true,
  comments: [{ id: 'c1', author: 'marta', body: 'Please <img src=x onerror=alert(1)> check this', suggestion: null, createdAt: null, url: null }],
  commentsTruncated: false,
  ...over,
});

const DIFF = parseUnified(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three', ''].join('\n'));

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <ToastProvider>{node}</ToastProvider>
  </QueryClientProvider>
);

test('a thread card names its state with a word and draws a comment as text, never as markup', () => {
  const html = renderToStaticMarkup(wrap(<ThreadCard changeRequestId="cr-1" thread={thread({})} phone={false} />));
  assert.match(html, /class="rt open"/);
  assert.match(html, />unresolved</);
  assert.match(html, /a\.ts:2/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /Resolve/);
});

test('a resolved thread says so and offers to reopen it; one that cannot be answered has no foot', () => {
  const resolved = renderToStaticMarkup(wrap(<ThreadCard changeRequestId="cr-1" thread={thread({ isResolved: true, resolvedBy: 'dani' })} phone={false} />));
  assert.match(resolved, /class="rt resolved"/);
  assert.match(resolved, /resolved/);
  assert.match(resolved, /by dani/);
  assert.match(resolved, /Reopen/);
  const readOnly = renderToStaticMarkup(wrap(<ThreadCard changeRequestId="cr-1" thread={thread({ viewerCanReply: false, viewerCanResolve: false })} phone={false} />));
  assert.doesNotMatch(readOnly, /rt-foot/);
});

test('a suggestion is drawn as its lines, and its fenced block is not repeated in the text', () => {
  const body = 'Use this:\n```suggestion\nconst b = 2;\n```';
  const withSuggestion = thread({
    comments: [{ id: 'c1', author: 'marta', body, suggestion: { fromLine: 2, toLine: 2, fromContent: 'const a = 1;', toContent: 'const b = 2;' }, createdAt: null, url: null }],
  });
  const html = renderToStaticMarkup(wrap(<ThreadCard changeRequestId="cr-1" thread={withSuggestion} phone={false} />));
  assert.match(html, /rt-sugg-row del/);
  assert.match(html, /rt-sugg-row add/);
  assert.equal((html.match(/const b = 2;/g) ?? []).length, 1);
});

test('the layer puts open threads under their line, with a pill; a resolved one folds', () => {
  const { files } = groupThreads([thread({ id: 'open' }), thread({ id: 'done', line: 3, isResolved: true })]);
  const layer = threadLayer({ changeRequestId: 'cr-1', file: files.get('a.ts') ?? null, phone: false, onAddNote: () => {} });
  const html = renderToStaticMarkup(wrap(<DiffView diff={DIFF} mode="reading" path="a.ts" layer={layer} />));
  assert.match(html, /diff-note-pill is-open/);
  assert.match(html, /class="rt open"/);
  assert.match(html, /rt-fold/);
  assert.doesNotMatch(html, /class="rt resolved"/);
  assert.match(html, /diff-add-note/);
  // The card follows its line, not the one before
  assert.ok(html.indexOf('two') < html.indexOf('class="rt open"'));
  assert.ok(html.indexOf('class="rt open"') < html.indexOf('three'));
});

test('a phone draws no pill: the card under the line says it', () => {
  const { files } = groupThreads([thread({})]);
  const layer = threadLayer({ changeRequestId: 'cr-1', file: files.get('a.ts') ?? null, phone: true });
  const html = renderToStaticMarkup(wrap(<DiffView diff={DIFF} mode="reading" path="a.ts" wrap layer={layer} />));
  assert.doesNotMatch(html, /diff-note-pill/);
  assert.match(html, /class="rt open"/);
});
