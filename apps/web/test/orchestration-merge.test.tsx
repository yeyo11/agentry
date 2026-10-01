// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MergeState, Orchestration, OrchestrationPullRequest } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import i18n, { setLanguage } from '../src/i18n';
import { actionLabelKey, blockerMark, mergeFailure } from '../src/lib/merge';
import { OrchestrationMerge } from '../src/components/OrchestrationMerge';

// The merge block under an orchestration's change request (docs/plans/code-hosts.md, phase 4,
// P2 · mu2): the method, the branch box, the one gradient action, the blocked states in words,
// and that the page mounts it.

// The `merge` namespace is the item page's; these are the words this test reads from it
const MERGE_WORDS = {
  blocker: {
    conflicts: { word: 'Conflicts', text: 'This {{noun}} conflicts with {{base}}.' },
    checks: { word: 'Waiting for checks', text: 'Checks are running.' },
    'checks-running': { word: 'Checks running', text: 'Checks are running.' },
  },
  action: { 'update-from-base': 'Update from {{base}}' },
  failure: { 'head-moved': 'The branch changed.' },
};

beforeEach(() => {
  setLanguage('en');
  i18n.addResourceBundle('en', 'merge', MERGE_WORDS, true, true);
});

const pr = (over: Partial<OrchestrationPullRequest> = {}): OrchestrationPullRequest => ({
  id: 'cr1', phase: 'open', host: 'gitlab', ref: '!14', number: 14, url: 'https://git.example.com/acme/shop/-/merge_requests/14', branch: 'orch/spanish-copy', base: 'main', ci: 'passing',
  error: null, openedAt: '2026-10-01T09:00:00Z', closedAt: null, checkedAt: null, ...over,
});

const state = (over: Partial<MergeState> = {}): MergeState => ({
  changeRequestId: 'cr1', host: 'gitlab', headSha: 'a81d3f0'.padEnd(40, '0'), methods: ['squash', 'merge', 'rebase'], defaultMethod: 'squash', deleteBranchDefault: true,
  canMerge: true, blocker: null, others: [], warning: null,
  autoMerge: { available: false, reason: null, armed: false, method: null, armedBy: null, armedAt: null },
  autoMergeOff: null, waitingForPipeline: false, canRebaseOnHost: false, rebaseOnHostWhy: null, readAt: '2026-10-01T10:00:00Z', ...over,
});

const words = { noun: 'MR', host: 'GitLab', ref: (n: number | null) => (n === null ? '' : `!${n}`) };

function render(data: MergeState, request = pr()) {
  const qc = new QueryClient();
  qc.setQueryData(keys.changeRequestMerge('cr1'), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <OrchestrationMerge orch={{ id: 'o1' } as Orchestration} pr={request} words={words} />
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('a mergeable request offers the methods, the branch box and Merge as the one gradient action', () => {
  const html = render(state());
  assert.match(html, /role="radiogroup"[^>]*aria-label="Merge method"/);
  for (const m of ['Squash', 'Merge commit', 'Rebase']) assert.ok(html.includes(m), m);
  assert.match(html, /Delete .*orch\/spanish-copy.* on GitLab when merged/);
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*>.*Merge MR !14/);
  assert.equal(html.split('btn-primary').length - 1, 1);
  assert.match(html, /Merges commit a81d3f00/);
  assert.match(html, /aria-label="Commit subject"/);
});

test('a rebase carries no commit message of its own', () => {
  const html = render(state({ methods: ['rebase'], defaultMethod: 'rebase' }));
  assert.ok(!html.includes('aria-label="Commit subject"'));
});

test('a blocked request says what blocks it, with its word and remedy, and Merge stays off', () => {
  const html = render(state({ canMerge: false, blocker: { code: 'conflicts', detail: null, action: 'update-from-base' } }));
  assert.match(html, /badge badge-bad[^>]*>Conflicts</);
  assert.match(html, /This MR conflicts with main\./);
  assert.match(html, /Update from main/);
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*disabled/);
});

test('GitLab waiting for the pipeline is the live thing: a spinner beside the words', () => {
  const html = render(state({ canMerge: false, waitingForPipeline: true, blocker: { code: 'checks-running', detail: null, action: null } }));
  assert.match(html, /badge badge-active[^>]*><span class="spinner-glyph/);
  assert.match(html, /GitLab has not attached the pipeline|has not attached the pipeline/);
});

test("the host's own text is text, never markup", () => {
  const html = render(state({ canMerge: false, blocker: { code: 'conflicts', detail: '<img src=x onerror=alert(1)>', action: null } }));
  assert.ok(!html.includes('<img src=x'));
});

test('an armed auto-merge shows who armed it and Turn off, and leaves Merge to the host', () => {
  const html = render(state({ canMerge: false, autoMerge: { available: false, reason: null, armed: true, method: 'squash', armedBy: 'ana', armedAt: '2026-10-01T10:00:00Z' } }));
  assert.match(html, /Auto-merge on/);
  assert.match(html, /armed by ana/);
  assert.match(html, />Turn off</);
  assert.ok(!html.includes('btn-primary'));
});

test('a request that is not open shows no merge block', () => {
  assert.ok(!render(state(), pr({ phase: 'merged' })).includes('omrg'));
});

test('the page mounts the block, and every call it makes has a caller', () => {
  const page = readFileSync(fileURLToPath(new URL('../src/pages/OrchestrationDetail.tsx', import.meta.url)), 'utf8');
  assert.match(page, /<OrchestrationMerge orch=\{orch\}/);
  const block = readFileSync(fileURLToPath(new URL('../src/components/OrchestrationMerge.tsx', import.meta.url)), 'utf8');
  for (const call of ['mergeChangeRequest', 'armAutoMerge', 'disarmAutoMerge', 'updateBranch', 'markReady', 'mergeState']) assert.ok(block.includes(`api.${call}(`), call);
  assert.ok(block.includes('useMergeState('));
});

test('every key the block reads from the merge namespace exists once that namespace does', { skip: !existsSync(fileURLToPath(new URL('../src/i18n/locales/en/merge.json', import.meta.url))) }, () => {
  const read = (lang: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../src/i18n/locales/${lang}/merge.json`, import.meta.url)), 'utf8')) as Record<string, unknown>;
  const has = (tree: Record<string, unknown>, key: string) => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree) !== undefined;
  const keysUsed = [
    ...['conflicts', 'checks-running', 'blocked-by-policy'].flatMap((c) => [blockerMark(c).word, blockerMark(c).text]),
    actionLabelKey('update-from-base'), actionLabelKey('mark-ready'), actionLabelKey('auto-merge'), actionLabelKey('refresh'), actionLabelKey('open-on-host'),
    `failure.${mergeFailure('head-moved')}`, `failure.${mergeFailure(undefined)}`,
  ];
  for (const lang of ['en', 'es']) for (const key of keysUsed) assert.ok(has(read(lang), key), `${lang}: ${key}`);
});
