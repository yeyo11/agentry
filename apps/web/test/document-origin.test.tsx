// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentTie } from '@agentry/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import i18n from '../src/i18n';
import { taskPath } from '../src/lib/work-items';
import { DocumentOrigin } from '../src/pages/documents/Pane';

// The document's byline: the desktop row keeps the key, the chat and the time; a phone draws it as
// one touch-sized link to the task with a chevron (MobileDocumento).

const tie = (over: Partial<DocumentTie> = {}): DocumentTie => ({
  linkId: 'l1',
  item: { id: 'i1', key: 'SHOP-28', title: 'Board with fixed columns', type: 'task', status: 'in_progress' },
  kind: 'spec',
  linkRole: 'refine',
  teamRole: 'architect',
  chatId: 'abcdef123456',
  createdAt: new Date().toISOString(),
  ...over,
});

function render(children: ReactNode): string {
  const router = createMemoryRouter([{ path: '*', element: children }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

test.before(async () => {
  await i18n.changeLanguage('en');
});

test('on a phone the byline is one link to the task, with a chevron and no chat or time', () => {
  const html = render(<DocumentOrigin tie={tie()} phone />);
  assert.equal(count(html, /<a /g), 1, 'a single link');
  assert.match(html, new RegExp(`<a[^>]*class="doc-origin doc-origin-phone"[^>]*href="${taskPath('SHOP-28')}"|<a[^>]*href="${taskPath('SHOP-28')}"[^>]*class="doc-origin doc-origin-phone"`));
  assert.match(html, /Written by the <b>Architect<\/b> from/);
  assert.match(html, /SHOP-28/);
  assert.match(html, /doc-origin-chevron/);
  assert.doesNotMatch(html, /abcdef|\/chats\//, 'no chat on a phone');
  assert.doesNotMatch(html, /doc-origin-chat/);
});

test('a document tied by hand says so on a phone, without an avatar', () => {
  const html = render(<DocumentOrigin tie={tie({ teamRole: null, chatId: null })} phone />);
  assert.match(html, /Tied to/);
  assert.doesNotMatch(html, /role-avatar/);
  assert.equal(count(html, /<a /g), 1);
});

test('the desktop byline keeps the key and chat links', () => {
  const html = render(<DocumentOrigin tie={tie()} />);
  assert.doesNotMatch(html, /doc-origin-phone/);
  assert.equal(count(html, /<a /g), 2, 'the key and the chat');
  assert.match(html, /chat abcdef/);
});
