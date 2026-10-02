// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChangeRequestChecks, Check, MergeState, Orchestration, OrchestrationPullRequest } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import { headGradients, OrchestrationMerge, useOrchestrationLead } from '../src/components/OrchestrationMerge';
import { OrchestrationChecks } from '../src/components/OrchestrationChecks';
import { canRelaunch } from '../src/lib/orchestration-v2';
import i18n, { setLanguage } from '../src/i18n';
import { blockerMark } from '../src/lib/merge';

// One leading action per zone on the orchestration page (docs/plans/code-hosts.md, phase 4): a push
// that waits, then Fix failing checks, then Merge take the page's one gradient action beside the
// top bar's New chat; Relaunch and the cost figure give way, and every blocker has its remedy.

beforeEach(() => setLanguage('en'));

const src = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');

const pr = (over: Partial<OrchestrationPullRequest> = {}): OrchestrationPullRequest => ({
  id: 'cr1', phase: 'open', host: 'gitlab', ref: '!14', number: 14, url: 'https://git.example.com/acme/shop/-/merge_requests/14', branch: 'orch/spanish-copy', base: 'main', ci: 'passing',
  error: null, openedAt: '2026-10-01T09:00:00Z', closedAt: null, checkedAt: null, ...over,
});

const state = (over: Partial<MergeState> = {}): MergeState => ({
  changeRequestId: 'cr1', host: 'gitlab', headSha: 'a81d3f0'.padEnd(40, '0'), methods: ['squash'], defaultMethod: 'squash', deleteBranchDefault: true,
  canMerge: true, blocker: null, others: [], warning: null,
  autoMerge: { available: false, reason: null, armed: false, method: null, armedBy: null, armedAt: null },
  autoMergeOff: null, waitingForPipeline: false, canRebaseOnHost: false, rebaseOnHostWhy: null, readAt: '2026-10-01T10:00:00Z', ...over,
});

const check = (over: Partial<Check> = {}): Check => ({
  id: 'j1', name: 'unit', group: 'test', state: 'passed', allowedToFail: false, required: true, startedAt: null, finishedAt: null, url: null, rerunnable: true, hasLog: false, source: 'actions', ...over,
});

const checksOf = (checks: Check[]): ChangeRequestChecks => ({ headSha: 'a81d3f0', rollup: 'passing', checks, truncated: false, checkedAt: '2026-10-01T10:00:00Z' });

const orchestration = (request: OrchestrationPullRequest | null, over: Partial<Orchestration> = {}): Orchestration =>
  ({
    id: 'o1', name: 'Spanish copy', objective: null, status: 'completed', cwd: '/work/shop', model: null, permissionMode: 'default', concurrency: 2, synthesize: false, worktree: true,
    maxAttempts: 1, allowedTools: [], permissionPrompts: 'host', createdAt: '2026-10-01T08:00:00Z', endedAt: '2026-10-01T09:00:00Z', tasks: [], finalResult: null, costUsd: 5.61,
    integration: { branch: 'orch/spanish-copy', worktree: null, status: 'merged', merged: [], conflicts: [], commit: 'a81d3f0', error: null, integratorRunId: null, pullRequestUrl: request?.url ?? null },
    pullRequest: request, ...over,
  }) as Orchestration;

interface Scene {
  request?: OrchestrationPullRequest | null;
  merge?: MergeState;
  checks?: ChangeRequestChecks;
  orch?: Partial<Orchestration>;
}

const words = { noun: 'MR', host: 'GitLab', ref: (n: number | null) => (n === null ? '' : `!${n}`) };

/**
 * The page cannot be rendered here (it pulls in the conversation's stylesheet), so this lays out what
 * it does: the head's Relaunch and cost figure take their gradient from `headGradients`, as
 * OrchestrationDetail does (checked below), over the same checks and merge blocks it mounts.
 */
function Page({ orch }: { orch: Orchestration }) {
  const request = orch.pullRequest as (OrchestrationPullRequest & { id: string }) | null;
  const lead = useOrchestrationLead(request);
  const { relaunchLit, costLit } = headGradients({ live: orch.status === 'running', relaunch: canRelaunch(orch), lead });
  return (
    <div>
      {orch.status !== 'running' && <button className={`btn ${relaunchLit ? 'btn-primary' : ''}`.trim()}>Relaunch</button>}
      <div className={`card orch-kpi ${costLit ? 'grad-border' : ''}`.trim()}>
        <span className={costLit ? 'grad-text' : undefined}>5,61</span>
      </div>
      {request && <OrchestrationChecks orch={orch} pr={request} words={words} />}
      {request && <OrchestrationMerge orch={orch} pr={request} words={words} />}
    </div>
  );
}

function page({ request = pr(), merge, checks, orch }: Scene): string {
  const qc = new QueryClient();
  const o = orchestration(request, orch);
  if (merge) qc.setQueryData(keys.changeRequestMerge('cr1'), merge);
  if (checks) qc.setQueryData(keys.changeRequestChecks('cr1'), checks);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Page orch={o} />
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The gradient surfaces of the page itself: the gradient buttons and the cost card, which paints one with its border and its figure. */
const surfaces = (html: string): number => (html.match(/\bbtn-primary\b/g) ?? []).length + (html.match(/\bgrad-border\b/g) ?? []).length;

test('a request that can merge makes Merge the page’s one gradient surface', () => {
  const html = page({ merge: state(), checks: checksOf([check()]), orch: { status: 'completed' } });
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*>(?:(?!<\/button>).)*Merge MR !14/s);
  assert.equal(surfaces(html), 1);
  assert.ok(!html.includes('grad-text'));
});

test('a push that waits leads, and Merge is a plain button', () => {
  const html = page({ request: pr({ fixState: 'awaiting-push' }), merge: state(), checks: checksOf([check()]) });
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*>(?:(?!<\/button>).)*Push the fix/s);
  assert.equal(surfaces(html), 1);
});

test('Fix failing checks leads while checks fail, and Relaunch and the cost give way', () => {
  const html = page({ merge: state({ canMerge: false, blocker: { code: 'checks-failing', detail: 'unit', action: 'fix-checks' } }), checks: checksOf([check({ state: 'failed' })]) });
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*>(?:(?!<\/button>).)*Fix failing checks/s);
  assert.equal(surfaces(html), 1);
});

test('Turn on auto-merge leads while the required checks run', () => {
  const html = page({
    merge: state({ canMerge: false, blocker: { code: 'checks-running', detail: null, action: 'auto-merge' }, autoMerge: { available: true, reason: null, armed: false, method: null, armedBy: null, armedAt: null } }),
    checks: checksOf([check({ state: 'running' })]),
  });
  assert.match(html, /<button[^>]*class="btn btn-small btn-primary"[^>]*>(?:(?!<\/button>).)*Turn on auto-merge/s);
  assert.equal(surfaces(html), 1);
});

test('without a leading action Relaunch has the gradient and the cost figure has none', () => {
  const html = page({ merge: state({ canMerge: false, blocker: { code: 'conflicts', detail: null, action: 'update-from-base' } }), checks: checksOf([check()]) });
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*>(?:(?!<\/button>).)*Relaunch/s);
  assert.equal(surfaces(html), 1);
  assert.ok(!html.includes('grad-text'));
});

test('a running graph keeps the cost figure as its one gradient surface', () => {
  const html = page({ request: null, orch: { status: 'running', endedAt: null, integration: null } });
  assert.equal(surfaces(html), 1);
  assert.ok(html.includes('grad-text'));
});

test('the head’s gradients: a leading action takes the second surface, else Relaunch, else the cost', () => {
  assert.deepEqual(headGradients({ live: false, relaunch: true, lead: 'merge' }), { relaunchLit: false, costLit: false });
  assert.deepEqual(headGradients({ live: false, relaunch: true, lead: null }), { relaunchLit: true, costLit: false });
  assert.deepEqual(headGradients({ live: true, relaunch: false, lead: null }), { relaunchLit: false, costLit: true });
  assert.deepEqual(headGradients({ live: false, relaunch: false, lead: null }), { relaunchLit: false, costLit: true });
  for (const lead of ['push', 'fix', 'merge'] as const) assert.deepEqual(headGradients({ live: false, relaunch: true, lead }), { relaunchLit: false, costLit: false });
});

const block = (merge: MergeState) => {
  const qc = new QueryClient();
  qc.setQueryData(keys.changeRequestMerge('cr1'), merge);
  qc.setQueryData(keys.changeRequestChecks('cr1'), checksOf([check()]));
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <OrchestrationMerge orch={orchestration(pr())} pr={pr()} words={words} />
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

test('the notices of the item page show on the orchestration block too', () => {
  const html = block(
    state({
      canMerge: false,
      blocker: { code: 'behind', detail: null, action: 'update-from-base' },
      autoMergeOff: { why: 'push', by: 'agentry', at: new Date().toISOString(), pushing: true },
      rebaseOnHostWhy: 'unpushed-commits',
      limitedUntil: '2026-10-01T10:30:00Z',
    }),
  );
  assert.match(html, /Agentry turned auto-merge off and is pushing to the branch/);
  assert.match(html, /commits that were never pushed/);
  assert.match(html, /GitLab is limiting reads/);
});

test('auto-merge that the repository does not allow says so beside the checks that run', () => {
  const html = block(state({ canMerge: false, blocker: { code: 'checks-running', detail: null, action: null }, autoMerge: { available: false, reason: 'auto-merge-not-allowed', armed: false, method: null, armedBy: null, armedAt: null } }));
  assert.match(html, /Auto-merge is off in this repository/);
});

test('an armed auto-merge says so when the host does not say who armed it', () => {
  const html = block(state({ canMerge: false, autoMerge: { available: false, reason: null, armed: true, method: 'squash', armedBy: null, armedAt: null } }));
  assert.match(html, /GitLab does not say who armed it/);
  assert.ok(!/armed by GitLab/i.test(html));
});

test('every blocker action has a button or the link to the host', () => {
  const calls: Array<[string, RegExp]> = [
    ['mark-ready', /Mark as ready/], ['update-from-base', /Update from main/], ['rebase-on-host', /Rebase on GitLab/], ['fix-checks', /Fix failing checks/],
    ['rerun-checks', /Re-run the checks/], ['address-review', /Address with an agent/], ['refresh', /Check again/],
  ];
  for (const [action, label] of calls) {
    const html = block(state({ canMerge: false, blocker: { code: 'behind', detail: null, action: action as never } }));
    assert.match(html, new RegExp(`<button[^>]*>(?:<[^>]*>)*${label.source}`), action);
  }
  const links: Array<[string, RegExp]> = [['close', /Close on GitLab/], ['edit-title', /Edit title on GitLab/], ['open-on-host', /Open on GitLab/], ['request-reviewers', /Ask for a review/], ['show-threads', /Show unresolved threads/]];
  for (const [action, label] of links) {
    const html = block(state({ canMerge: false, blocker: { code: 'nothing-to-merge', detail: null, action: action as never } }));
    assert.match(html, new RegExp(`<a class="btn btn-small" href="https://git.example.com/acme/shop/-/merge_requests/14"[^>]*>(?:<[^>]*>)*\\s*${label.source}`), action);
  }
});

test('a failing required check names itself and the host text stays text', () => {
  const html = block(state({ canMerge: false, blocker: { code: 'checks-failing', detail: '<img src=x onerror=alert(1)>', action: null } }));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /Required check &lt;img src=x onerror=alert\(1\)&gt; failed/);
});

test('every refusal reads the state again, and the codes are the item page’s', () => {
  const merge = src('components/OrchestrationMerge.tsx');
  // No refusal is exempt from the re-read: the old reasons list is gone
  assert.ok(!merge.includes('needsReread'));
  assert.match(merge, /const fail = [\s\S]*?reread\(\);/);
  assert.match(merge, /const failUpdate = [\s\S]*?reread\(\);/);
  assert.match(merge, /updateFailure\(/);
  assert.match(merge, /action === 'update-from-base' \|\| action === 'rebase-on-host' \? failUpdate/);
});

test('the lead, the notices and the checks are mounted: nothing built is left without a caller', () => {
  assert.match(src('pages/OrchestrationDetail.tsx'), /useOrchestrationLead\(/);
  assert.match(src('pages/OrchestrationDetail.tsx'), /headGradients\(/);
  assert.match(src('pages/OrchestrationDetail.tsx'), /relaunchLit \? 'btn-primary'/);
  assert.match(src('pages/OrchestrationDetail.tsx'), /costLit \? 'grad-border'/);
  assert.match(src('components/OrchestrationChecks.tsx'), /useOrchestrationLead\(/);
  assert.match(src('components/OrchestrationMerge.tsx'), /<MergeNotices /);
  assert.match(src('pages/tasks/item/Merge.tsx'), /<MergeNotices /);
  assert.equal(blockerMark('checks-failing').tone, 'bad');
});
