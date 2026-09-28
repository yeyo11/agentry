// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../src/i18n';
import { FailedFlowRunNote } from '../src/pages/chat/FailedFlowRun';

// Gap 2 of orchestration 6: a failed flow run's chat page says it failed, why, and which item it was
// for, read from the item's own runs (GET /work-items/:itemId/runs), since the chat reads "completed".

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const item = { key: 'AGN-12' };

const run = (chatId: string, over: Partial<FlowRun>): FlowRun =>
  ({ id: `r-${chatId}`, itemId: 'i1', role: 'developer', agent: 'developer', chatId, state: 'ended', outcome: 'passed', error: null, ...over }) as FlowRun;

function render(chatId: string, runs: FlowRun[]): string {
  const client = new QueryClient();
  const wrap = (children: ReactNode) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>,
    );
  return wrap(<FailedFlowRunNote item={item} chatId={chatId} runs={runs} />);
}

test.before(async () => {
  await i18n.changeLanguage('en');
});

test("a failed run's chat says it failed, for which item, and why, though a later run of the member passed", () => {
  // Newest first: the member ran again in another chat after this one failed
  const runs = [run('c-new', {}), run('c-old', { outcome: 'failed', error: 'no account left to rotate to' })];
  const html = render('c-old', runs);
  assert.match(html, /chat-run-failed/);
  const said = text(html);
  assert.match(said, /Run failed/);
  assert.match(said, /AGN-12/);
  assert.match(said, /no account left to rotate to/);
  assert.match(html, /badge-bad/, 'in the bad colour, beside its word');
});

test("a chat whose run passed, or a person's own chat, carries no failure", () => {
  const runs = [run('c-new', {}), run('c-old', { outcome: 'failed', error: 'x' })];
  assert.doesNotMatch(render('c-new', runs), /chat-run-failed/);
  assert.doesNotMatch(render('c-person', runs), /chat-run-failed/);
});
