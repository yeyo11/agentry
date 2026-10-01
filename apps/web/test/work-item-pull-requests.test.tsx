// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardCheckout, FlowRun, PullRequestReadiness, WorkItem, WorkItemDetail, WorkItemHistoryEntry, WorkItemPullRequest, WorkItemStatus } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import i18n, { setLanguage } from '../src/i18n';
import enTasks from '../src/i18n/locales/en/tasks.json' with { type: 'json' };
import esTasks from '../src/i18n/locales/es/tasks.json' with { type: 'json' };
import enTeam from '../src/i18n/locales/en/team.json' with { type: 'json' };
import esTeam from '../src/i18n/locales/es/team.json' with { type: 'json' };
import enItem from '../src/i18n/locales/en/workItem.json' with { type: 'json' };
import esItem from '../src/i18n/locales/es/workItem.json' with { type: 'json' };
import { approvalOpensPullRequest, checkoutNote, ciTone, notReadyReason, pullRequestErrorKey, stripOffersApproval, stripTone, workItemStrip } from '../src/lib/work-items';
import { BoardReadinessProvider, CheckoutLine } from '../src/pages/tasks/board/PullRequest';
import { BoardTeamProvider, type BoardTeam } from '../src/pages/tasks/board/team';
import { WorkItemStrip } from '../src/pages/tasks/board/WorkItemStrip';
import { causeLine, historyLine, pullRequestAction, pullRequestPanel } from '../src/pages/tasks/item/model';
import { PullRequestRow, PullRequestState } from '../src/pages/tasks/item/PullRequest';
import { failureReason } from '../src/pages/tasks/item/runs';

// An approved card opens its pull request, and a merged one reaches Done
// (docs/plans/work-item-pull-requests.md): what the card's strip, the item's page and the board say
// about it, in both languages, and what the approval calls in a project that can or cannot open one.

const item = (status: WorkItemStatus, extra: Partial<WorkItem> = {}): WorkItem => ({
  id: 'x',
  projectId: 'p1',
  number: 7,
  key: 'AGN-7',
  type: 'task',
  title: 'Item 7',
  description: '',
  status,
  priority: 'medium',
  labels: [],
  assignee: null,
  epicId: null,
  milestoneId: null,
  acceptanceCriteria: [],
  relations: [],
  rank: 'x',
  worktree: null,
  branch: 'task/agn-7',
  createdAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:00Z',
  closedAt: null,
  ...extra,
});

const pr = (over: Partial<WorkItemPullRequest> = {}): WorkItemPullRequest => ({
  phase: 'open',
  number: 123,
  url: 'https://github.com/acme/shop/pull/123',
  branch: 'task/agn-7',
  base: 'main',
  ci: 'passing',
  conflicts: [],
  error: null,
  openedAt: '2026-09-28T10:00:00Z',
  closedAt: null,
  checkedAt: '2026-09-28T10:01:00Z',
  ...over,
});

const detail = (status: WorkItemStatus, extra: Partial<WorkItemDetail> = {}): WorkItemDetail => ({
  ...item(status),
  children: [],
  links: [],
  comments: [],
  history: [],
  ...extra,
});

const READY: PullRequestReadiness = { status: 'ready', detail: null, defaultBranch: 'main', host: 'github', hostname: 'github.com', remedy: null };
const NO_AUTH: PullRequestReadiness = { status: 'cli-signed-out', detail: 'You are not logged into any GitHub hosts. Run gh auth login', defaultBranch: 'main', host: 'github', hostname: 'github.com', remedy: null };

const team: BoardTeam = {
  flowOn: true,
  columns: { in_progress: 'developer', in_review: 'qa' },
  maxBounces: 3,
  running: new Map(),
  queued: new Map(),
  ended: new Map(),
  maxParallel: 2,
  queuedCount: 0,
  verifier: 'qa',
};

const sources = { chats: [], orchestrations: [] };

function wrap(children: ReactNode, readiness: PullRequestReadiness | null = null) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <BoardReadinessProvider value={readiness}>
                <BoardTeamProvider value={team}>{children}</BoardTeamProvider>
              </BoardReadinessProvider>
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const strip = (it: WorkItem, readiness: PullRequestReadiness | null = null) => wrap(<WorkItemStrip item={it} strip={workItemStrip(it)} sources={sources} />, readiness);

async function inSpanish() {
  setLanguage('es');
  await i18n.changeLanguage('es');
}

test.beforeEach(async () => {
  setLanguage('en');
  await i18n.changeLanguage('en');
});

// ---------- the strip's state ----------

test('a fix of review comments reads on the card as comments being addressed, not as the checks', async () => {
  const fixing = item('in_progress', { pullRequest: pr({ fixState: 'fixing', fixKind: 'review', fixOrigin: 'person', fixAttempts: 1 }) });
  const state = workItemStrip(fixing);
  assert.equal(state?.kind === 'pr-fix' && state.fix, 'review');
  const html = text(strip(fixing));
  assert.match(html, /addressing the comments/);
  assert.doesNotMatch(html, /fixing the checks/);
  const waiting = item('in_review', { waiting: 'approval', pullRequest: pr({ fixState: 'awaiting-push', fixKind: 'review', fixOrigin: 'decision' }) });
  assert.match(text(strip(waiting)), /waits for your push/);
  assert.doesNotMatch(strip(waiting), /fix verified/);
});

test('a fix of failing checks reads on the card by its stage, and only the pushable one waits for the person', async () => {
  const fixing = item('in_progress', { pullRequest: pr({ fixState: 'fixing', fixOrigin: 'person', fixAttempts: 1 }) });
  assert.deepEqual(workItemStrip(fixing), { kind: 'pr-fix', fix: 'checks', stage: 'fixing', origin: 'person', attempt: 1, number: 123, ref: null, host: null });
  assert.equal(stripTone(workItemStrip(fixing)!), null);
  const html = text(strip(fixing));
  assert.match(html, /fixing the checks/);
  assert.match(html, /attempt 1 · at your request/);
  assert.doesNotMatch(strip(fixing), /badge-idle/);

  const waiting = item('in_review', { waiting: 'approval', pullRequest: pr({ fixState: 'awaiting-push', fixOrigin: 'decision', fixAttempts: 1 }) });
  assert.equal(workItemStrip(waiting)?.kind, 'pr-fix');
  assert.equal(stripTone(workItemStrip(waiting)!), 'wait');
  assert.match(strip(waiting), /badge-idle/);
  assert.match(text(strip(waiting)), /waits for you .*fix verified, waiting to be pushed.*decided by checks\.fix/);

  await inSpanish();
  assert.match(text(strip(item('in_review', { pullRequest: pr({ fixState: 'awaiting-verify', fixOrigin: 'person', fixAttempts: 1 }) }))), /verificando el arreglo.*se sube solo si QA lo da por bueno/);
});

test("a card's strip says where its pull request stands, each phase only in the column it leaves the card in", () => {
  assert.deepEqual(workItemStrip(item('in_review', { pullRequest: pr({ phase: 'preparing', number: null, url: null, ci: null }) })), { kind: 'pr-preparing', host: null });
  assert.deepEqual(workItemStrip(item('in_progress', { pullRequest: pr({ phase: 'conflict', number: null, url: null, conflicts: ['a.ts', 'b.ts'] }) })), {
    kind: 'pr-conflict',
    base: 'main',
    count: 2,
    host: null,
  });
  assert.deepEqual(workItemStrip(item('in_review', { pullRequest: pr({ phase: 'awaiting-verify', number: null, url: null }) })), { kind: 'pr-awaiting', base: 'main', host: null });
  assert.deepEqual(workItemStrip(item('in_review', { waiting: 'merge', pullRequest: pr({ ci: 'pending' }) })), {
    kind: 'pr-open',
    number: 123,
    ref: null,
    host: null,
    url: 'https://github.com/acme/shop/pull/123',
    ci: 'pending',
  });
  assert.deepEqual(workItemStrip(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'closed' }) })), { kind: 'pr-closed', number: 123, ref: null, host: null });
  assert.deepEqual(workItemStrip(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'failed', number: null, url: null, error: { code: 'push', detail: 'rejected' } }) })), {
    kind: 'pr-failed',
    code: 'push',
    detail: 'rejected',
    host: null,
  });
  // A conflict the person resolved by hand and moved back to review is approved again, not shown again
  assert.equal(workItemStrip(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'conflict', conflicts: ['a.ts'] }) }))?.kind, 'approval');
  // A closed PR of an item that later bounced too often leaves the bounces to say what waits
  assert.equal(workItemStrip(item('in_review', { waiting: 'bounces', bounces: 3, pullRequest: pr({ phase: 'closed' }) }))?.kind, 'bounces');
  // Done draws no strip, merged or not
  assert.equal(workItemStrip(item('done', { pullRequest: pr({ phase: 'merged', error: { code: 'worktree-kept', detail: '2 files' } }) })), null);
});

test('something at work still wins over a pull request, and a pull request wins over a plain approval', () => {
  const running: FlowRun = {
    id: 'r1',
    projectId: 'p1',
    itemId: 'x',
    item: null,
    role: 'developer',
    agent: 'developer',
    model: 'sonnet',
    stage: 'work',
    step: 'work',
    column: 'in_progress',
    state: 'running',
    chatId: 'c1',
    outcome: null,
    summary: null,
    error: null,
    cause: null,
    retryOf: null,
    queuedBy: null,
    retriedBy: null,
    retryable: false,
    restarts: 0,
    continuations: 0,
    queuedAt: '2026-09-28T10:00:00.000Z',
    startedAt: '2026-09-28T10:00:00.000Z',
    endedAt: null,
  };
  const conflicted = item('in_progress', { pullRequest: pr({ phase: 'conflict', conflicts: ['a.ts'] }) });
  assert.equal(workItemStrip(conflicted, { running: new Map([['x', running]]) })?.kind, 'run');
  assert.equal(workItemStrip(item('in_review', { waiting: 'approval', pullRequest: pr() }))?.kind, 'pr-open');
  // `merge` alone is enough, even before the item carries its PR
  assert.equal(workItemStrip(item('in_review', { waiting: 'merge' }))?.kind, 'pr-open');
});

test('each pull request state takes its one status colour, and only live things are live', () => {
  const tone = (it: WorkItem) => {
    const state = workItemStrip(it);
    return state ? stripTone(state) : 'none';
  };
  assert.equal(tone(item('in_review', { pullRequest: pr({ phase: 'preparing' }) })), null, 'Agentry preparing a PR is neutral: no agent works on it');
  assert.equal(tone(item('in_progress', { pullRequest: pr({ phase: 'conflict', conflicts: ['a'] }) })), 'warn');
  assert.equal(tone(item('in_review', { pullRequest: pr({ phase: 'awaiting-verify' }) })), null);
  assert.equal(tone(item('in_review', { pullRequest: pr() })), 'wait', 'waiting for the merge is idle');
  assert.equal(tone(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'closed' }) })), 'wait');
  assert.equal(tone(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'failed' }) })), 'fail');
  assert.equal(ciTone('passing'), 'ok');
  assert.equal(ciTone('failing'), 'bad');
  assert.equal(ciTone('pending'), null, 'pending is neutral, with no loop');
  assert.equal(ciTone('none'), null);
});

// ---------- the strip, drawn ----------

test('an open PR reads "PR #123 · waiting for merge" with its number in mono, its CI in words and a link that leaves the card alone', async () => {
  const html = strip(item('in_review', { waiting: 'merge', pullRequest: pr({ ci: 'passing' }) }));
  assert.match(html, /workitem-strip is-wait/);
  assert.match(html, /<span class="workitem-strip-num">PR #123<\/span>/);
  assert.match(text(html), /PR #123 waiting for merge CI passing/);
  assert.match(html, /class="badge pr-ci badge-ok"/);
  assert.match(html, /<a href="https:\/\/github.com\/acme\/shop\/pull\/123" target="_blank" rel="noreferrer" class="workitem-strip-link" aria-label="Open PR #123 on GitHub"/);
  assert.doesNotMatch(html, /spinner|is-live/, 'nothing moves while a PR waits');

  const pending = strip(item('in_review', { waiting: 'merge', pullRequest: pr({ ci: 'pending' }) }));
  assert.match(pending, /class="badge pr-ci" data-ci="pending"/);
  assert.match(text(pending), /CI pending/);
  assert.doesNotMatch(pending, /spinner|badge-active/, 'pending CI does not loop and is not live');
  const failing = strip(item('in_review', { waiting: 'merge', pullRequest: pr({ ci: 'failing' }) }));
  assert.match(failing, /class="badge pr-ci badge-bad"/);
  assert.match(text(failing), /CI failing/);

  await inSpanish();
  assert.match(text(strip(item('in_review', { waiting: 'merge', pullRequest: pr({ ci: 'passing' }) }))), /PR #123 esperando fusión CI superada/);
  assert.match(text(strip(item('in_review', { waiting: 'merge', pullRequest: pr({ ci: 'failing' }) }))), /CI fallida/);
  assert.match(text(strip(item('in_review', { waiting: 'merge', pullRequest: pr({ ci: 'pending' }) }))), /CI pendiente/);
});

test('preparing, a conflict and a remembered approval are told in words, in both languages', async () => {
  const preparing = strip(item('in_review', { pullRequest: pr({ phase: 'preparing', number: null, url: null, ci: null }) }));
  assert.match(text(preparing), /Preparing the PR/);
  assert.doesNotMatch(preparing, /spinner|is-live|is-wait|is-fail/);
  const conflict = strip(item('in_progress', { pullRequest: pr({ phase: 'conflict', conflicts: ['a.ts', 'b.ts'] }) }));
  assert.match(conflict, /workitem-strip is-warn/);
  assert.match(text(conflict), /Conflict with main · 2 files/);
  assert.match(text(strip(item('in_progress', { pullRequest: pr({ phase: 'conflict', conflicts: ['a.ts'] }) }))), /Conflict with main · 1 file\b/);
  assert.match(text(strip(item('in_review', { pullRequest: pr({ phase: 'awaiting-verify' }) }))), /Approved · its PR opens when the verification passes/);

  await inSpanish();
  assert.match(text(strip(item('in_review', { pullRequest: pr({ phase: 'preparing' }) }))), /Preparando la PR/);
  assert.match(text(strip(item('in_progress', { pullRequest: pr({ phase: 'conflict', conflicts: ['a.ts', 'b.ts'] }) }))), /Conflicto con main · 2 archivos/);
  assert.match(text(strip(item('in_review', { pullRequest: pr({ phase: 'awaiting-verify' }) }))), /Aprobada · su PR se abrirá cuando pase la verificación/);
});

test('a PR closed without merging and one that failed to open offer the approval again', async () => {
  const closed = strip(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'closed' }) }), READY);
  assert.match(text(closed), /PR #123 closed without merging Approve and open PR/);
  const failed = strip(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'failed', number: null, url: null, error: { code: 'push', detail: 'remote: Permission denied' } }) }), READY);
  assert.match(failed, /workitem-strip is-fail/);
  assert.match(text(failed), /Could not open the PR · its branch could not be pushed/);
  assert.match(failed, /title="remote: Permission denied"/, "git's own line stays at hand, never the only message");
  assert.match(failed, /workitem-approve is-pr/);
  // A code this version does not know still reads as a failure
  assert.equal(pullRequestErrorKey('something-new'), 'pr.error.unknown');
  assert.equal(pullRequestErrorKey('cli-signed-out'), 'pr.notReady.cli-signed-out');
  // An older server still sends the names from before hosts: they read as their neutral reason
  assert.equal(pullRequestErrorKey('gh-unauthenticated'), 'pr.notReady.cli-signed-out');
  assert.equal(pullRequestErrorKey('no-gh'), 'pr.notReady.cli-missing');
  assert.equal(pullRequestErrorKey('not-github'), 'pr.notReady.unsupported-host');
  assert.equal(notReadyReason({ status: 'no-gh' as never }), 'cli-missing');
  assert.equal(stripOffersApproval(workItemStrip(item('in_review', { waiting: 'merge', pullRequest: pr() }))), false, 'an open PR is merged on GitHub, not approved again');

  await inSpanish();
  assert.match(text(strip(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'closed' }) }), READY)), /PR #123 cerrada sin fusionar Aprobar y abrir PR/);
  assert.match(
    text(strip(item('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'failed', error: { code: 'create', detail: 'x' } }) }), READY)),
    /No se ha podido abrir la PR · GitHub no la ha creado/,
  );
});

// ---------- the approval, by readiness ----------

test('in a ready project the approval opens the PR; anywhere else it moves the card to Done and says why no PR', async () => {
  assert.equal(approvalOpensPullRequest(READY), true);
  assert.equal(approvalOpensPullRequest(NO_AUTH), false);
  assert.equal(approvalOpensPullRequest(null), false, 'All projects says nothing, and approving moves the card as before');
  assert.equal(notReadyReason(NO_AUTH), 'cli-signed-out');
  assert.equal(notReadyReason(READY), null);
  assert.equal(notReadyReason(null), null);

  const waiting = item('in_review', { waiting: 'approval' });
  const ready = strip(waiting, READY);
  assert.match(ready, /class="btn btn-small workitem-approve is-pr"/);
  assert.match(text(ready), /Approve and open PR/);
  assert.doesNotMatch(ready, /pr-not-ready/);

  const notReady = strip(waiting, NO_AUTH);
  assert.match(notReady, /class="btn btn-small workitem-approve"/);
  assert.match(text(notReady), /No PR: gh is not signed in .*Approve and move to Done/);
  assert.match(notReady, /class="pr-not-ready workitem-strip-note" title="You are not logged into any GitHub hosts/);

  const unknown = strip(waiting, null);
  assert.match(text(unknown), /Approve and move to Done/);
  assert.doesNotMatch(unknown, /pr-not-ready/, 'a board that does not say gives no reason');

  await inSpanish();
  assert.match(text(strip(waiting, READY)), /Aprobar y abrir PR/);
  assert.match(text(strip(waiting, NO_AUTH)), /Sin PR: gh no ha iniciado sesión en github\.com .*Aprobar y pasar a Hecho/);
  assert.match(text(strip(waiting, { status: 'no-remote', detail: null, defaultBranch: null, host: null, hostname: null, remedy: null })), /Sin PR: el proyecto no tiene remoto/);
});

test('every reason a project cannot open a PR, and every step that can fail, is worded in English and Spanish', () => {
  const reasons = ['not-git', 'no-remote', 'unsupported-host', 'cli-missing', 'cli-incompatible', 'cli-signed-out', 'no-default-branch'] as const;
  const steps = ['fetch', 'merge', 'push', 'create', 'commit', 'worktree-kept', 'unknown'] as const;
  for (const locale of [enTasks, esTasks]) {
    for (const reason of reasons) assert.ok(locale.pr.notReady[reason], `pr.notReady.${reason}`);
    for (const step of steps) assert.ok(locale.pr.error[step], `pr.error.${step}`);
    for (const code of ['not-in-review', 'busy', 'nothing-to-propose'] as const) assert.ok(locale.pr.refused[code], `pr.refused.${code}`);
  }
});

// ---------- the board's checkout line ----------

test("the board says how far its checkout is behind the default branch and why, and nothing while it is up to date", async () => {
  const checkout = (over: Partial<BoardCheckout>): BoardCheckout => ({ defaultBranch: 'main', branch: 'main', behind: 3, reason: null, ...over });
  assert.equal(checkoutNote(checkout({ behind: 0, reason: 'dirty' })), null);
  assert.equal(checkoutNote(null), null);
  assert.equal(checkoutNote(checkout({ reason: 'not-on-default', branch: null }))?.reason, 'detached', 'a detached head names no branch');
  const line = (over: Partial<BoardCheckout>) => text(wrap(<CheckoutLine checkout={checkout(over)} />));

  assert.doesNotMatch(wrap(<CheckoutLine checkout={checkout({ behind: 0 })} />), /workitem-checkout-note/);
  assert.equal(line({ reason: 'dirty' }), 'The working copy is 3 commits behind origin/main: it has uncommitted changes');
  assert.equal(line({ behind: 1 }), 'The working copy is 1 commit behind origin/main');
  assert.equal(line({ reason: 'not-on-default', branch: 'feature/x' }), 'The working copy is 3 commits behind origin/main: it is on feature/x, not on main');
  assert.equal(line({ reason: 'diverged' }), 'The working copy is 3 commits behind origin/main: it has commits origin/main does not have');
  const html = wrap(<CheckoutLine checkout={checkout({ reason: 'dirty' })} />);
  assert.match(html, /class="workitem-checkout-note" role="note"/);
  assert.doesNotMatch(html, /<code|git (pull|merge|fetch)/, 'never a command to copy');

  await inSpanish();
  assert.equal(line({ reason: 'dirty' }), 'La copia de trabajo va 3 commits por detrás de origin/main: tiene cambios sin commit');
  assert.equal(line({ behind: 1 }), 'La copia de trabajo va 1 commit por detrás de origin/main');
  assert.equal(line({ reason: 'not-on-default', branch: 'feature/x' }), 'La copia de trabajo va 3 commits por detrás de origin/main: está en feature/x, no en main');
  assert.equal(line({ reason: 'diverged' }), 'La copia de trabajo va 3 commits por detrás de origin/main: tiene commits que origin/main no tiene');
});

// ---------- history and causes ----------

test("a pull request's history entries and causes are told in sentences, with its number or its files in bold", async () => {
  const entry = (to: WorkItemHistoryEntry['to'], change: WorkItemHistoryEntry['change'] = 'pull_request') => ({ change, from: null, to });
  const snapshot = (phase: WorkItemPullRequest['phase'], conflicts: string[] = []) => ({ phase, number: phase === 'conflict' ? null : 42, url: null, conflicts });
  assert.deepEqual(historyLine(entry(snapshot('open'))), { key: 'history.prOpened', values: { noun: 'PR', number: '#42' }, strong: 'number', icon: 'pr' });
  assert.deepEqual(historyLine(entry(snapshot('merged'))), { key: 'history.prMerged', values: { noun: 'PR', number: '#42' }, strong: 'number', icon: 'done' });
  assert.equal(historyLine(entry(snapshot('closed'))).key, 'history.prClosed');
  assert.deepEqual(historyLine(entry(snapshot('conflict', ['a.ts', 'b.ts']))), { key: 'history.prConflict', values: { files: 'a.ts, b.ts' }, strong: 'files', icon: 'pr' });
  assert.equal(historyLine(entry(snapshot('failed'))).key, 'history.prFailed');
  assert.equal(historyLine(entry(null)).key, 'history.prChanged');
  assert.equal(historyLine(entry('merge', 'waiting')).key, 'history.waitingMerge');

  const cause = { kind: 'chat' as const, chatId: null, orchestrationId: null, taskId: null };
  assert.equal(causeLine({ ...cause, event: 'pr.opened' })?.key, 'cause.prOpened');
  assert.equal(causeLine({ ...cause, event: 'pr.conflict' })?.key, 'cause.prConflict');
  assert.equal(causeLine({ ...cause, event: 'pr.merged' })?.key, 'cause.prMerged');
  assert.equal(causeLine({ ...cause, event: 'pr.closed' })?.key, 'cause.prClosed');

  const t = () => i18n.getFixedT(null, 'workItem');
  assert.equal(t()('cause.prMerged', { noun: 'PR', host: 'GitHub' }), 'its PR was merged on GitHub');
  assert.equal(t()('cause.prMerged', { noun: 'MR', host: 'GitLab' }), 'its MR was merged on GitLab');
  assert.equal(t()('history.waitingMerge'), 'Waiting for you to merge it');
  // A merge request's entries are numbered the way GitLab writes it
  assert.deepEqual(historyLine(entry({ ...snapshot('merged'), host: 'gitlab', number: 7 })), { key: 'history.prMerged', values: { noun: 'MR', number: '!7' }, strong: 'number', icon: 'done' });
  assert.equal(causeLine({ ...cause, event: 'pr.merged' }, 'gitlab')?.values['host'], 'GitLab');
  await inSpanish();
  assert.equal(t()('cause.prMerged', { noun: 'MR', host: 'GitLab' }), 'se fusionó su MR en GitLab');
  assert.equal(t()('history.prConflict'), 'Al actualizar su rama quedaron conflictos en');
  assert.equal(t()('history.waitingMerge'), 'Espera que la fusiones');
});

test('a work run that left the merge conflicted is worded wherever a failed run is', async () => {
  for (const [tasks, team, item] of [
    [enTasks, enTeam, enItem],
    [esTasks, esTeam, esItem],
  ] as const) {
    assert.ok(tasks.strip.cause['conflict-unresolved']);
    assert.ok(team.cause['conflict-unresolved'].title && team.cause['conflict-unresolved'].body && team.cause['conflict-unresolved'].short);
    assert.ok(item.run.cause['conflict-unresolved']);
  }
  const run = { state: 'ended' as const, outcome: 'failed' as const, cause: 'conflict-unresolved' as const, restarts: 0, stage: 'work' as const, column: 'in_progress' as const };
  assert.equal(failureReason(run)?.key, 'run.cause.conflict-unresolved');
  const failed: FlowRun = {
    id: 'r1',
    projectId: 'p1',
    itemId: 'x',
    item: null,
    role: 'developer',
    agent: 'developer',
    model: 'sonnet',
    stage: 'work',
    step: 'work',
    column: 'in_progress',
    state: 'ended',
    chatId: 'c1',
    outcome: 'failed',
    summary: null,
    error: null,
    cause: 'conflict-unresolved',
    retryOf: null,
    queuedBy: null,
    retriedBy: null,
    retryable: true,
    restarts: 0,
    continuations: 0,
    queuedAt: '2026-09-28T10:00:00.000Z',
    startedAt: '2026-09-28T10:00:00.000Z',
    endedAt: '2026-09-28T10:05:00.000Z',
  };
  const it = item('in_progress');
  const html = wrap(<WorkItemStrip item={it} strip={workItemStrip(it, { ended: new Map([['x', failed]]) })} sources={sources} />);
  assert.match(text(html), /Failed to implement it · the merge was left conflicted/);
  await inSpanish();
  const es = wrap(<WorkItemStrip item={it} strip={workItemStrip(it, { ended: new Map([['x', failed]]) })} sources={sources} />);
  assert.match(text(es), /Falló al implementarla · la fusión quedó en conflicto/);
});

// ---------- the item's page ----------

test("the item's page says which PR action it offers: approve and open, open, or none, and only in a ready project", () => {
  const panel = (it: WorkItem, readiness: PullRequestReadiness | null = READY) => pullRequestPanel(it, readiness);
  assert.equal(panel(item('in_review', { waiting: 'approval' })), 'offer');
  assert.equal(pullRequestAction({ waiting: 'approval' }, 'offer', READY), 'approve');
  assert.equal(pullRequestAction({ waiting: null }, 'offer', READY), 'open', 'any item in review opens its PR, even with no flow');
  assert.equal(pullRequestAction({ waiting: 'approval' }, 'closed', READY), 'approve');
  assert.equal(pullRequestAction({ waiting: 'approval' }, 'failed', READY), 'approve');
  assert.equal(pullRequestAction({ waiting: 'approval' }, 'failed', NO_AUTH), null);
  assert.equal(pullRequestAction({ waiting: 'merge' }, 'merge', READY), null);
  assert.equal(panel(item('in_review'), NO_AUTH), 'not-ready');
  assert.equal(panel(item('in_review'), null), null, 'an item of a project that is not imported says nothing');
  assert.equal(panel(item('in_progress')), null, 'only an item in review is offered a PR');
  assert.equal(panel(item('in_review', { type: 'epic' })), null);
  assert.equal(panel(item('in_review', { activeLink: { id: 'l', itemId: 'x', kind: 'chat', role: 'verify', chatId: 'c', orchestrationId: null, taskId: null, chatState: 'working', createdAt: '' } })), null, 'not while QA verifies it');
  assert.equal(panel(item('in_review', { waiting: 'merge', pullRequest: pr() })), 'merge');
  assert.equal(panel(item('in_progress', { pullRequest: pr({ phase: 'conflict' }) })), 'conflict');
  assert.equal(panel(item('done', { pullRequest: pr({ phase: 'merged', error: { code: 'worktree-kept', detail: '2 files' } }) })), 'kept');
  assert.equal(panel(item('done', { pullRequest: pr({ phase: 'merged' }) })), null);
});

test('the waiting panel explains a PR waiting for the merge, a conflict with its paths, a failure with its reason, and a project that cannot open one', async () => {
  const merge = wrap(<PullRequestState item={detail('in_review', { waiting: 'merge', pullRequest: pr({ number: 12 }), pullRequestReadiness: READY })} />);
  assert.match(merge, /class="item-wait item-pr-wait is-merge"/);
  assert.match(merge, /class="badge badge-idle"/);
  assert.match(text(merge), /waits for your merge PR #12 waits for you to merge it on GitHub CI passing/);
  assert.match(merge, /href="https:\/\/github.com\/acme\/shop\/pull\/123" target="_blank" rel="noreferrer"/);

  const conflict = wrap(<PullRequestState item={detail('in_progress', { pullRequest: pr({ phase: 'conflict', number: null, url: null, conflicts: ['src/a.ts', 'src/b.ts'] }), pullRequestReadiness: READY })} />);
  assert.match(conflict, /class="badge badge-warn"/);
  assert.match(conflict, /<ul class="item-wait-files"><li>src\/a.ts<\/li><li>src\/b.ts<\/li><\/ul>/);
  assert.match(text(conflict), /Updating its branch with main left conflicts in 2 files/);

  const failed = wrap(
    <PullRequestState item={detail('in_review', { waiting: 'approval', pullRequest: pr({ phase: 'failed', error: { code: 'fetch', detail: 'fatal: unable to access' } }), pullRequestReadiness: READY })} />,
  );
  assert.match(failed, /class="badge badge-bad"/);
  assert.match(text(failed), /Could not open the PR: the default branch could not be fetched/);
  assert.match(failed, /<p class="item-wait-detail">fatal: unable to access<\/p>/);
  assert.match(text(failed), /Approve and open PR/);

  // Before any PR exists it is a quiet line, not a panel: the head already says the item waits
  const notReady = wrap(<PullRequestState item={detail('in_review', { waiting: 'approval', pullRequestReadiness: NO_AUTH })} />);
  assert.match(notReady, /class="item-wait is-quiet item-pr-wait is-not-ready"/);
  assert.doesNotMatch(notReady, /class="badge/, 'no status badge beside the head\'s own');
  assert.match(notReady, /class="pr-not-ready" title="You are not logged into any GitHub hosts/);
  assert.match(text(notReady), /No PR: gh is not signed in/);
  assert.doesNotMatch(notReady, /workitem-open-pr/, 'no PR button where it cannot open one: Move to Done stays in the head');

  const offer = wrap(<PullRequestState item={detail('in_review', { pullRequestReadiness: READY })} />);
  assert.match(offer, /class="item-wait is-quiet item-pr-wait is-offer"/);
  assert.match(text(offer), /Opening its PR pushes its branch and proposes it to main\. Open PR/);

  await inSpanish();
  assert.match(text(wrap(<PullRequestState item={detail('in_review', { waiting: 'merge', pullRequest: pr({ number: 12 }), pullRequestReadiness: READY })} />)), /La PR #12 espera que la fusiones en GitHub/);
  assert.match(text(wrap(<PullRequestState item={detail('in_review', { waiting: 'approval', pullRequestReadiness: READY })} />)), /Aprobar y abrir PR/);
  assert.match(text(wrap(<PullRequestState item={detail('in_review', { pullRequestReadiness: READY })} />)), /Abrir PR/);
  assert.match(text(wrap(<PullRequestState item={detail('in_review', { waiting: 'approval', pullRequestReadiness: NO_AUTH })} />)), /Sin PR: gh no ha iniciado sesión en github\.com/);
});

test("the item's PR row under Changes links to GitHub with its number in mono, its branch into the default one and its state in words", async () => {
  const open = wrap(<PullRequestRow pr={pr({ ci: 'failing' })} />);
  assert.match(open, /<a class="item-pr" href="https:\/\/github.com\/acme\/shop\/pull\/123" target="_blank" rel="noreferrer">/);
  assert.match(open, /<span class="item-pr-num">PR #123<\/span>/);
  assert.match(open, /<span class="item-pr-branch">task\/agn-7 → main<\/span>/);
  assert.match(open, /class="badge pr-ci badge-bad"/);
  assert.match(text(open), /CI failing/);
  const merged = wrap(<PullRequestRow pr={pr({ phase: 'merged' })} />);
  assert.match(merged, /class="badge badge-ok"/);
  assert.match(text(merged), /merged/);
  assert.doesNotMatch(wrap(<PullRequestRow pr={pr({ phase: 'preparing', number: null, url: null })} />), /item-pr/, 'no row before GitHub numbered it');
  assert.doesNotMatch(wrap(<PullRequestRow pr={null} />), /item-pr/);
  await inSpanish();
  assert.match(text(wrap(<PullRequestRow pr={pr({ phase: 'merged' })} />)), /PR #123 task\/agn-7 → main fusionada/);
  assert.match(text(wrap(<PullRequestRow pr={pr({ phase: 'closed' })} />)), /cerrada sin fusionar/);
});

test('a GitLab project says merge request, MR and !7 wherever a GitHub one says PR and #7, and a note carries its remedy link', async () => {
  const mr = pr({ host: 'gitlab', number: 7, ref: '!7', url: 'https://gitlab.example/acme/shop/-/merge_requests/7' });
  const gitlab: PullRequestReadiness = { ...READY, host: 'gitlab', hostname: 'gitlab.example' };
  const merge = text(wrap(<PullRequestState item={detail('in_review', { waiting: 'merge', pullRequest: mr, pullRequestReadiness: gitlab })} />));
  assert.match(merge, /MR !7 waits for you to merge it on GitLab/);
  assert.match(merge, /Open MR !7 on GitLab/);
  assert.match(text(wrap(<PullRequestRow pr={mr} />)), /MR !7 task\/agn-7 → main/);
  assert.match(text(wrap(<PullRequestState item={detail('in_review', { waiting: 'approval', pullRequestReadiness: gitlab })} />)), /Approve and open MR/);

  const signedOut: PullRequestReadiness = {
    ...NO_AUTH,
    host: 'gitlab',
    hostname: 'gitlab.example',
    remedy: { kind: 'sign-in', url: 'https://gitlab.com/gitlab-org/cli#authentication' },
  };
  const note = wrap(<PullRequestState item={detail('in_review', { waiting: 'approval', pullRequestReadiness: signedOut })} />);
  assert.match(text(note), /No MR: glab is not signed in to gitlab\.example Sign-in help/);
  assert.match(note, /class="pr-not-ready-remedy" href="https:\/\/gitlab\.com\/gitlab-org\/cli#authentication" target="_blank"/);
  await inSpanish();
  assert.match(text(wrap(<PullRequestState item={detail('in_review', { waiting: 'merge', pullRequest: mr, pullRequestReadiness: gitlab })} />)), /La MR !7 espera que la fusiones en GitLab/);
  assert.match(text(wrap(<PullRequestState item={detail('in_review', { waiting: 'approval', pullRequestReadiness: signedOut })} />)), /Sin MR: glab no ha iniciado sesión en gitlab\.example Ayuda para iniciar sesión/);
});
