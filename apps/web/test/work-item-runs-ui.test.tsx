// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun, WorkItemComment, WorkItemDetail, WorkItemLink } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import i18n from '../src/i18n';
import { FailedFlowRunNote } from '../src/pages/chat/FailedFlowRun';
import { Activity } from '../src/pages/tasks/item/Activity';
import type { ItemActions } from '../src/pages/tasks/item/hooks';
import { chatlessRuns, linkEntries } from '../src/pages/tasks/item/model';
import { latestOfStep, RunLinkRow } from '../src/pages/tasks/item/RunLink';
import { WaitingBadge } from '../src/pages/tasks/item/Waiting';

// Decision 8 of the ecosystem design review and gap 2 of orchestration 6: a failed flow run says it
// failed, why in the person's words, and what its retry did, on the run's chat, on the item's links
// and in the item's activity, read from the item's own runs (GET /work-items/:itemId/runs).

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const run = (over: Partial<FlowRun>): FlowRun =>
  ({
    id: 'r1',
    projectId: 'p1',
    itemId: 'i1',
    role: 'qa',
    agent: 'qa',
    model: 'sonnet',
    stage: 'verify',
    step: 'verify',
    column: 'in_review',
    state: 'ended',
    chatId: 'c1',
    outcome: 'passed',
    summary: null,
    error: null,
    cause: null,
    retryOf: null,
    queuedBy: null,
    retriedBy: null,
    retryable: false,
    restarts: 0,
    queuedAt: new Date(Date.now() - 3_600_000).toISOString(),
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    endedAt: new Date(Date.now() - 3_000_000).toISOString(),
    ...over,
  }) as FlowRun;

const failed = run({ id: 'r-old', chatId: 'c-old', outcome: 'failed', cause: 'restarts', restarts: 2, error: 'cut off by a restart (restarts: 2 of 2)' });
const passed = run({ id: 'r-new', chatId: 'c-new', retryOf: 'r-old', queuedAt: new Date(Date.now() - 1_000_000).toISOString() });

const link = (chatId: string, over: Partial<WorkItemLink> = {}): WorkItemLink =>
  ({ id: `l-${chatId}`, itemId: 'i1', kind: 'chat', role: 'verify', chatId, teamRole: 'qa', orchestrationId: null, taskId: null, name: null, chatState: 'idle', taskStatus: null, createdAt: '2026-09-27T10:00:00.000Z', ...over }) as WorkItemLink;

const comment = (over: Partial<WorkItemComment>): WorkItemComment => ({
  id: 'k1',
  itemId: 'i1',
  author: { kind: 'agent', role: 'qa' },
  source: { kind: 'chat', chatId: 'c-old', orchestrationId: null, taskId: null },
  body: 'This verification run failed and moved nothing: cut off by a restart (restarts: 2 of 2).',
  createdAt: '2026-09-27T10:05:00.000Z',
  updatedAt: '2026-09-27T10:05:00.000Z',
  ...over,
});

const item = {
  id: 'i1',
  projectId: 'p1',
  key: 'AGN-26',
  status: 'in_review',
  waiting: 'approval',
  links: [link('c-new', { createdAt: '2026-09-27T11:00:00.000Z' }), link('c-old')],
  history: [],
  comments: [comment({}), comment({ id: 'k2', source: { kind: 'chat', chatId: 'c-new', orchestrationId: null, taskId: null }, body: 'All five criteria hold.', createdAt: '2026-09-27T11:05:00.000Z' })],
} as unknown as WorkItemDetail;

function render(node: ReactNode, runs: FlowRun[] = [passed, failed]): string {
  const client = new QueryClient();
  client.setQueryData(keys.workItemRuns('i1'), runs);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  // The toasts' live region is the provider's, not what the component drew
  return html.replace(/<div class="toasts"[^>]*><\/div>/, '');
}

const noActions = { comment: { isPending: false, mutate: () => {} } } as unknown as ItemActions;

test.before(async () => {
  await i18n.changeLanguage('en');
});

test.after(async () => {
  await i18n.changeLanguage('en');
});

test("a failed run's chat leads with why in the person's words, the raw error under it, and what the retry did", () => {
  const html = render(<FailedFlowRunNote item={item} run={{ ...failed, retriedBy: { id: 'r-new', state: 'ended', outcome: 'passed', chatId: 'c-new000', queuedAt: 'q', endedAt: new Date().toISOString() } }} />);
  assert.match(html, /chat-run-failed/);
  const said = text(html);
  assert.match(said, /This verification failed and did not move the task\./);
  assert.match(said, /It was cut off 3 times: Agentry restarted while it verified it\./);
  assert.match(said, /QA said so on AGN-26\./);
  assert.match(html, /class="run-raw mono">cut off by a restart \(restarts: 2 of 2\)</, 'the raw text, in mono');
  assert.match(said, /Retried: passed/);
  assert.match(html, /href="\/chats\/c-new000"/, "the retry's chat");
  assert.match(said, /Open chat c-new0/);
  assert.match(html, /href="\/tasks\/AGN-26"/);
  assert.doesNotMatch(said, /Retry\b(?!ed)/, 'a run retried once offers no second retry');
});

test('a failed run nobody retried yet offers Retry while it can be queued again, and a run that passed carries no banner', () => {
  const retryable = render(<FailedFlowRunNote item={item} run={{ ...failed, retryable: true }} />);
  assert.match(retryable, /chat-run-failed-retry/);
  assert.match(text(retryable), /Retry/);
  assert.doesNotMatch(render(<FailedFlowRunNote item={item} run={{ ...failed, retryable: false }} />), /chat-run-failed-retry/, 'the item left the column');
  assert.equal(render(<FailedFlowRunNote item={item} run={passed} />), '');
  assert.equal(render(<FailedFlowRunNote item={item} run={null} />), '', "a person's own chat");
});

test('in Spanish the banner uses the glossary: fallida, pasó, Reintentar', async () => {
  await i18n.changeLanguage('es');
  try {
    const said = text(render(<FailedFlowRunNote item={item} run={{ ...failed, retryable: true }} />));
    assert.match(said, /Esta verificación falló y no movió la tarea\./);
    assert.match(said, /Se cortó 3 veces: Agentry se reinició mientras verificaba\./);
    assert.match(said, /Reintentar/);
  } finally {
    await i18n.changeLanguage('en');
  }
});

test("the item's links name each flow run by its role and stage, with its outcome and, on a failure, its reason", () => {
  const runs = [passed, failed];
  const row = (r: FlowRun) => render(<RunLinkRow link={link(r.chatId ?? '')} run={r} item={item} chat={undefined} latest={latestOfStep(r, runs)} />);
  const html = row(passed) + row(failed);
  const [newest, oldest] = [text(row(passed)), text(row(failed))];
  assert.match(newest ?? '', /QA verifies AGN-26/);
  assert.match(newest ?? '', /passed/);
  assert.match(newest ?? '', /flow run/);
  assert.match(newest ?? '', /waits for you to move it to Done/, 'the latest verification that passed leaves the move to the person');
  assert.match(oldest ?? '', /failed/);
  assert.match(oldest ?? '', /It was cut off 3 times/);
  assert.match(oldest ?? '', /did not move the task/);
  assert.doesNotMatch(oldest ?? '', /cut off by a restart/, 'with a cause to word it by, the raw text stays on the chat');
  assert.match(html, /role-avatar/, "a run's link leads with the role's squircle");
  assert.match(html, /badge-bad/);
  assert.match(html, /badge-ok/);
});

test("a run that failed before its chat started is on the item's links, with its reason and no chat", () => {
  const noChat = run({ id: 'r-quota', chatId: null, outcome: 'failed', cause: 'no-account', error: 'no account with quota left', startedAt: null });
  const queued = run({ id: 'r-queued', chatId: null, state: 'queued', outcome: null, startedAt: null, endedAt: null });
  // Only the runs no chat link stands for: a run a link stands for is drawn once, on its link
  assert.deepEqual(
    chatlessRuns(item.links, [queued, noChat, passed, failed, run({ id: 'r-gone', chatId: 'c-unlinked' })]).map((r) => r.id),
    ['r-queued', 'r-quota', 'r-gone'],
  );
  const html = render(<RunLinkRow link={null} run={noChat} item={item} chat={undefined} latest />);
  const said = text(html);
  assert.match(said, /QA verifies AGN-26/);
  assert.match(html, /badge-bad/);
  assert.match(said, /No account had quota left/);
  assert.match(said, /no chat · flow run/);
  assert.match(said, /did not move the task/);
  assert.doesNotMatch(html, /href="\/chats\//, 'there is no chat to open');
  const waiting = text(render(<RunLinkRow link={null} run={queued} item={item} chat={undefined} latest />));
  assert.match(waiting, /queued/);
  assert.doesNotMatch(waiting, /did not move/);
});

test("every run in a chat the Developer continued is a link of its own, so a failure a retry covered stays on the item", () => {
  // CW-25 on claude-wrapper: four Developer runs in one chat, two of them failed (no account, then a
  // rate limit) and each retried in that same chat; the item drew only the newest, which passed
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const dev = (over: Partial<FlowRun>) => run({ role: 'developer', agent: 'developer', stage: 'work', step: 'work', column: 'in_progress', chatId: 'c-dev', ...over });
  const runs = [
    dev({ id: 'r4', retryOf: 'r3', queuedAt: at(10) }),
    dev({ id: 'r3', outcome: 'failed', cause: 'rate-limit', error: 'the account hit its rate limit', queuedAt: at(20) }),
    run({ id: 'r-qa', chatId: 'c-qa', outcome: 'rejected', queuedAt: at(30) }),
    dev({ id: 'r2', retryOf: 'r1', queuedAt: at(40) }),
    dev({ id: 'r1', outcome: 'failed', cause: 'no-account', error: 'no account with quota left', queuedAt: at(50) }),
    run({ id: 'r-queued', chatId: null, state: 'queued', outcome: null, startedAt: null, endedAt: null, queuedAt: at(5) }),
  ];
  const links = [link('c-dev', { teamRole: 'developer', role: 'work', createdAt: at(50) }), link('c-qa', { createdAt: at(30) }), link('c-person', { teamRole: null, createdAt: at(60) })];
  const entries = linkEntries(links, runs);
  assert.deepEqual(
    entries.map((e) => e.run?.id ?? e.link?.id),
    ['r-queued', 'r4', 'r3', 'r-qa', 'r2', 'r1', 'l-c-person'],
    'each run once, newest first, and a chat no run stands for as its own link',
  );
  assert.ok(entries.filter((e) => e.run?.chatId === 'c-dev').every((e) => e.link?.chatId === 'c-dev'), "the chat's runs all open that chat");
  const failedRows = entries.flatMap((e) => (e.run?.outcome === 'failed' ? [render(<RunLinkRow link={e.link} run={e.run} item={item} chat={undefined} latest={latestOfStep(e.run, runs)} />)] : []));
  assert.equal(failedRows.length, 2, 'both failures are drawn');
  for (const html of failedRows) {
    assert.match(text(html), /Developer implements AGN-26/);
    assert.match(html, /badge-bad/);
    assert.match(html, /href="\/chats\/c-dev"/, "a failed run's link opens the chat it ran in");
  }
  assert.match(text(failedRows[0] ?? ''), /reached its limit/);
  assert.match(text(failedRows[1] ?? ''), /No account had quota left/);
});

test("a flow's chat link waits for the item's runs rather than flashing as a plain chat", () => {
  // On claude-wrapper the links first read "idle" with no squircle, then turned into their runs
  const links = [link('c-dev', { teamRole: 'developer' }), link('c-person', { teamRole: null, createdAt: '2026-09-27T09:00:00.000Z' })];
  assert.deepEqual(
    linkEntries(links, null).map((e) => e.link?.id),
    ['l-c-person'],
    "until the runs answer, only the links no flow run stands for",
  );
  assert.deepEqual(
    linkEntries(links, []).map((e) => e.link?.id),
    ['l-c-dev', 'l-c-person'],
    'once they answered, a flow chat with no run on record is still drawn, as a chat',
  );
});

test("the activity draws a failed run's comment from the run, names each flow comment's run, and tells the retry", () => {
  const html = render(<Activity item={item} actions={noActions} person="yeyo" />);
  const said = text(html);
  assert.doesNotMatch(said, /moved nothing/, "the core's English comment is not printed");
  assert.match(said, /This verification failed and did not move the task\. It was cut off 3 times: Agentry restarted while it verified it\. The task stays in In review\./);
  assert.match(html, /class="comment-run-chat" href="\/chats\/c-old"/);
  assert.match(said, /flow run · chat c-old/);
  assert.match(said, /Verification retried/);
  assert.match(said, /yeyo · QA started chat c-new/);
  assert.doesNotMatch(said, /\bagent\b/, 'an agent comment carries no repeated "agent" badge');
  // Comments and history keep their counts, the retry among the history
  assert.match(said, /Comments 2/);
  assert.match(said, /History 1/);
});

test('an item the flow left to the person says "waits for you" beside its column', () => {
  assert.match(text(render(<WaitingBadge item={{ waiting: 'approval' }} />)), /waits for you/);
  assert.match(render(<WaitingBadge item={{ waiting: 'bounces' }} />), /badge-idle/);
  assert.equal(render(<WaitingBadge item={{ waiting: null }} />), '');
});
