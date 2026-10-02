// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import type { MergeBlockerAction, MergeBlockerCode, MergeState, WorkItemDetail, WorkItemPullRequest } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import { setLanguage } from '../src/i18n';
import enMerge from '../src/i18n/locales/en/merge.json' with { type: 'json' };
import esMerge from '../src/i18n/locales/es/merge.json' with { type: 'json' };
import { mergePrimary } from '../src/lib/merge';
import { Merge } from '../src/pages/tasks/item/Merge';
import type { LeadingAction } from '../src/pages/tasks/item/model';
import { PullRequestState } from '../src/pages/tasks/item/PullRequest';

// The merge block of the item page (docs/plans/code-hosts.md, phase 4, P2): the form that merges,
// armed auto-merge, the GitLab wait, the blocked states with their remedy, and the gradient that
// belongs to one surface only. Reference: DesktopTareaFusion, DesktopTareaFusionEstados, DSFusion.

beforeEach(() => setLanguage('en'));

const pr = (over: Partial<WorkItemPullRequest> = {}): WorkItemPullRequest => ({
  id: 'cr1', phase: 'open', host: 'github', number: 12, ref: '#12', url: 'https://github.com/acme/shop/pull/12', branch: 'task/agn-26', base: 'main', ci: 'passing',
  conflicts: [], error: null, openedAt: '2026-10-01T09:00:00Z', closedAt: null, checkedAt: '2026-10-01T10:00:00Z', ...over,
});

const state = (over: Partial<MergeState> = {}): MergeState => ({
  changeRequestId: 'cr1', host: 'github', headSha: 'a81d3f0b2c4d5e6f708192a3b4c5d6e7f8091a2b', methods: ['squash', 'merge', 'rebase'], defaultMethod: 'squash', deleteBranchDefault: true,
  canMerge: true, blocker: null, others: [], warning: null,
  autoMerge: { available: false, reason: null, armed: false, method: null, armedBy: null, armedAt: null },
  autoMergeOff: null, waitingForPipeline: false, canRebaseOnHost: false, rebaseOnHostWhy: null, readAt: '2026-10-01T10:00:00Z', ...over,
});

const blocked = (code: MergeBlockerCode, detail: string | null = null, action: MergeBlockerAction | null = null, over: Partial<MergeState> = {}) =>
  state({ canMerge: false, blocker: { code, detail, action }, ...over });

function wrap(node: React.ReactNode, data: MergeState | null) {
  const qc = new QueryClient();
  if (data) qc.setQueryData(keys.changeRequestMerge('cr1'), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ConfirmProvider>
            <ToastProvider>{node}</ToastProvider>
          </ConfirmProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const render = (data: MergeState | null, request: WorkItemPullRequest = pr(), lead: LeadingAction | null = 'merge') => wrap(<Merge pr={request} itemId="item1" itemKey="AGN-26" lead={lead} />, data);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const count = (html: string, needle: string) => html.split(needle).length - 1;

test('a ready block offers the methods, the message, the branch box and one gradient Merge', () => {
  const html = render(state());
  const plain = text(html);
  assert.match(plain, /Merge/);
  assert.match(plain, /PR #12 · task\/agn-26 → main · a81d3f0/);
  assert.match(plain, /ready to merge/);
  assert.equal(count(html, 'role="radio"'), 3);
  assert.match(html, /aria-label="Commit subject"/);
  assert.match(plain, /Delete the branch task\/agn-26 on GitHub after merging/);
  assert.match(plain, /The local branch stays/);
  assert.equal(count(html, 'btn-primary'), 1);
  assert.match(html, /<button[^>]*btn-primary[^>]*>.*?Merge<\/button>/);
});

test('with another action leading the zone, Merge is a plain button', () => {
  assert.equal(count(render(state()), 'btn-primary'), 1);
  for (const lead of ['push', 'publish', 'reply', 'submit', 'fix', null] as const) {
    const html = render(state(), pr(), lead);
    assert.equal(count(html, 'btn-primary'), 0, String(lead));
    assert.match(text(html), /Merge/);
  }
});

test('arming is the gradient action only while the required checks run: the block and the lead agree', () => {
  const available = { available: true, reason: null, armed: false, method: null, armedBy: null, armedAt: null } as const;
  assert.equal(mergePrimary(state()), 'merge');
  assert.equal(mergePrimary(blocked('checks-running', null, 'auto-merge', { autoMerge: available })), 'arm');
  // Review required with auto-merge on offer: arming is a plain button, so nothing here leads
  const review = blocked('review-required', null, 'request-reviewers', { autoMerge: available });
  assert.equal(mergePrimary(review), null);
  assert.equal(count(render(review, pr(), 'merge'), 'btn-primary'), 0);
  assert.equal(mergePrimary(blocked('conflicts', null, 'update-from-base')), null);
  assert.equal(mergePrimary(state({ autoMerge: { ...available, armed: true, method: 'squash', armedBy: 'yeyo', armedAt: '2026-10-01T10:00:00Z' } })), null);
  assert.equal(mergePrimary(state({ waitingForPipeline: true, canMerge: false })), null);
  assert.equal(mergePrimary(undefined), null);
});

test('a single allowed method is a badge, a rebase has no message to write', () => {
  const one = render(state({ methods: ['rebase'], defaultMethod: 'rebase' }));
  assert.equal(count(one, 'role="radio"'), 0);
  assert.match(text(one), /GitHub sets it for this project/);
  assert.doesNotMatch(one, /aria-label="Commit subject"/);
});

test('an unstable merge still merges, with its warning and a word', () => {
  const plain = text(render(state({ warning: 'optional-checks-failing' })));
  assert.match(plain, /can merge, with a warning/);
  assert.match(plain, /not required/);
  assert.match(plain, /Some checks that are not required failed/);
});

test('required checks pending: Merge is not offered and arming is the gradient action', () => {
  const html = render(
    blocked('checks-running', null, 'auto-merge', { autoMerge: { available: true, reason: null, armed: false, method: null, armedBy: null, armedAt: null } }),
  );
  const plain = text(html);
  assert.match(plain, /Required checks have not finished/);
  assert.match(plain, /Turn on auto-merge/);
  assert.equal(count(html, 'btn-primary'), 1);
  assert.doesNotMatch(plain, /Delete the branch/);
  assert.match(html, /data-reason="checks-running"/);
  assert.match(html, /spinner-ring/);
});

test('armed auto-merge says who, when and how, offers Turn off and carries no gradient', () => {
  const html = render(
    state({ canMerge: false, blocker: { code: 'checks-running', detail: null, action: null }, autoMerge: { available: false, reason: null, armed: true, method: 'squash', armedBy: 'yeyo', armedAt: '2026-10-01T10:00:00Z' } }),
  );
  const plain = text(html);
  assert.match(plain, /auto-merge on/);
  assert.match(plain, /@yeyo/);
  assert.match(plain, /Squash/);
  assert.match(plain, /Turn off/);
  assert.match(plain, /turns this off first/);
  assert.equal(count(html, 'btn-primary'), 0);
  assert.doesNotMatch(plain, /Delete the branch/);
});

test('GitLab waiting for the pipeline is live: a spinner beside the verb, Merge off', () => {
  const html = render(state({ host: 'gitlab', canMerge: false, waitingForPipeline: true }), pr({ host: 'gitlab', ref: '!12' }));
  const plain = text(html);
  assert.match(plain, /MR !12/);
  assert.match(plain, /waiting for the pipeline/);
  assert.match(plain, /GitLab has not attached it yet/);
  assert.match(html, /spinner-glyph/);
  assert.match(html, /<button[^>]*disabled[^>]*aria-busy="true"/);
  assert.equal(count(html, 'btn-primary'), 0);
  assert.equal(count(html, 'badge-active'), 1);
});

test('each blocker shows its word with its tone, its sentence and one remedy, never a command', () => {
  const cases: Array<[MergeBlockerCode, MergeBlockerAction, string, string, RegExp]> = [
    ['draft', 'mark-ready', 'badge-idle', 'draft', /Mark as ready/],
    ['conflicts', 'update-from-base', 'badge-bad', 'conflicting', /Update from main/],
    ['checks-failing', 'fix-checks', 'badge-bad', 'failing', /Fix failing checks/],
    ['review-required', 'request-reviewers', 'badge-warn', 'not approved', /Ask for a review/],
    ['threads-unresolved', 'show-threads', 'badge-warn', 'unresolved', /Show unresolved threads/],
    ['blocked-by-policy', 'open-on-host', 'badge-warn', 'blocked', /Open on GitHub/],
    ['computing', 'refresh', 'badge-active', 'working it out', /Check again/],
  ];
  for (const [code, action, tone, word, label] of cases) {
    const html = render(blocked(code, 'unit-tests', action));
    assert.match(html, new RegExp(`data-reason="${code}"`), code);
    assert.match(html, new RegExp(`${tone}[^>]*>${word}<`), code);
    assert.match(text(html), label, code);
    assert.equal(count(html, 'btn-primary'), 0, code);
    assert.doesNotMatch(html, /<code/, code);
  }
  assert.match(text(render(blocked('checks-failing', 'unit-tests', 'fix-checks'))), /Required check unit-tests failed/);
});

test('the host\'s own words are drawn as text, and the others that block are listed under the first', () => {
  const html = render(
    blocked('blocked-by-policy', '<img src=x onerror=alert(1)>', 'open-on-host', {
      others: [{ code: 'review-required', detail: null, action: 'request-reviewers' }],
    }),
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<a[^>]*href="https:\/\/github.com\/acme\/shop\/pull\/12"[^>]*rel="noreferrer"/);
  assert.match(html, /mb-others/);
  assert.match(text(html), /review-required not approved/);
});

test('a code this version does not know reads as the policy block', () => {
  const html = render(blocked('made-up' as MergeBlockerCode, null, 'open-on-host'));
  assert.match(text(html), /GitHub&#x27;s rules for main do not allow this merge yet/);
});

test('the person is told when Agentry turned auto-merge off for a push, and why a host rebase is not offered', () => {
  const off = text(render(state({ autoMergeOff: { by: 'agentry', at: '2026-10-01T09:30:00Z', why: 'push', pushing: false } })));
  assert.match(off, /Agentry turned auto-merge off .* because it pushed to the branch/);
  const pushing = text(render(state({ autoMergeOff: { by: 'agentry', at: '2026-10-01T09:30:00Z', why: 'push', pushing: true } })));
  assert.match(pushing, /is pushing to the branch/);
  const update = text(render(state({ autoMergeOff: { by: 'marta', at: '2026-10-01T09:30:00Z', why: 'update', pushing: false } })));
  assert.match(update, /turned off .* by marta for Update from base/);
  const rebase = text(render(state({ host: 'gitlab', rebaseOnHostWhy: 'unpushed-commits' }), pr({ host: 'gitlab', ref: '!12' })));
  assert.match(rebase, /commits that were never pushed/);
  assert.doesNotMatch(text(render(state())), /turned auto-merge off|not offered/, 'nothing to say when nothing happened');
});

test('the block waits for its state, and says so, and renders nothing without an open request', () => {
  assert.match(text(render(null)), /Reading what blocks the merge/);
  assert.doesNotMatch(render(state(), pr({ phase: 'merged' })), /class="mg"/);
  assert.doesNotMatch(render(state(), pr({ number: null })), /class="mg"/);
});

test('the item page mounts the merge block under the review, and its words are in both languages', () => {
  const item = {
    id: 'item1', key: 'AGN-26', pullRequest: pr(), pullRequestReadiness: null, waiting: 'merge', status: 'in_review', children: [], links: [], comments: [], history: [],
  } as unknown as WorkItemDetail;
  const html = wrap(<PullRequestState item={item} />, state());
  assert.match(html, /aria-label="Merge"/);
  setLanguage('es');
  assert.match(wrap(<PullRequestState item={item} />, state()), /aria-label="Fusión"/);
  assert.match(text(render(state())), /Fusionar/);
});

test('every blocker, action and failure the model can name has its words in English and Spanish', () => {
  const tree = (value: unknown, path: string[]): unknown => path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);
  const codes = ['not-open', 'computing', 'draft', 'conflicts', 'nothing-to-merge', 'behind', 'checks-running', 'checks-failing', 'checks-missing', 'external-checks', 'review-required', 'changes-requested', 'threads-unresolved', 'tracker-key-missing', 'title-rejected', 'blocked-by-dependency', 'not-yet', 'locked-files', 'merge-queue', 'blocked-by-policy'];
  const actions = ['mark-ready', 'update-from-base', 'rebase-on-host', 'close', 'auto-merge', 'fix-checks', 'rerun-checks', 'request-reviewers', 'address-review', 'show-threads', 'edit-title', 'open-on-host', 'refresh'];
  const failures = ['head-moved', 'method-not-allowed', 'auto-merge-not-allowed', 'auto-merge-not-needed', 'waiting-for-pipeline', 'rate-limited', 'busy', 'forbidden', 'merge-failed'];
  for (const resource of [enMerge, esMerge]) {
    for (const code of codes) for (const part of ['word', 'text']) assert.equal(typeof tree(resource, ['blocker', code, part]), 'string', `${code}.${part}`);
    for (const action of actions) assert.equal(typeof tree(resource, ['action', action]), 'string', action);
    for (const failure of failures) assert.equal(typeof tree(resource, ['failure', failure]), 'string', failure);
    for (const refusal of ['busy', 'not-offered', 'not-open', 'merge-failed']) assert.equal(typeof tree(resource, ['update', refusal]), 'string', refusal);
    for (const key of ['merged.word', 'merged.text', 'closed.text']) assert.equal(typeof tree(resource, ['blocker', 'not-open', ...key.split('.')]), 'string', key);
    for (const code of ['checks-failing', 'checks-missing']) assert.equal(typeof tree(resource, ['blocker', code, 'named']), 'string', code);
    for (const key of ['counted_one', 'counted_other']) assert.equal(typeof tree(resource, ['blocker', 'threads-unresolved', key]), 'string', key);
  }
});

test('two failing required checks are two lines, each with its name, and no key is repeated', () => {
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const html = render(
      blocked('checks-failing', 'unit-tests', 'fix-checks', {
        others: [
          { code: 'checks-failing', detail: 'e2e-chrome', action: 'fix-checks' },
          { code: 'checks-failing', detail: 'e2e-firefox', action: 'fix-checks' },
          { code: 'threads-unresolved', detail: '3', action: 'show-threads' },
        ],
      }),
    );
    const others = html.slice(html.indexOf('mb-others'));
    assert.equal(count(others, '<li'), 3);
    assert.match(text(others), /checks-failing failing Required check e2e-chrome failed\./);
    assert.match(text(others), /checks-failing failing Required check e2e-firefox failed\./);
    assert.match(text(others), /threads-unresolved unresolved 3 conversations are still unresolved\./);
    assert.deepEqual(errors, []);
  } finally {
    console.error = log;
  }
});

test('a GitLab check without a name reads in the plural, never with an empty name', () => {
  const plain = text(render(blocked('checks-failing', null, 'fix-checks')));
  assert.match(plain, /Required checks failed\./);
  assert.doesNotMatch(plain, /Required check\s+failed/);
  assert.match(text(render(blocked('checks-missing', null, 'rerun-checks'))), /Required checks have not reported for the latest commit\./);
  assert.match(text(render(blocked('threads-unresolved', '1', 'show-threads'))), /1 conversation is still unresolved\./);
});

test('a request the host merged or closed says so in words, with no raw host word and no remedy to copy', () => {
  // Right after a merge the state is read again while the row is still open: the block says merged, in the one colour of done
  const merged = render(blocked('not-open', 'merged', null));
  assert.match(text(merged), /This PR was merged\./);
  assert.match(merged, /badge-ok[^>]*>merged</);
  assert.match(merged, /mb-note is-ok/);
  assert.doesNotMatch(text(merged), /MERGED|This PR is open/);
  const closed = text(render(blocked('not-open', 'closed', null)));
  assert.match(closed, /This PR was closed without merging\./);
  setLanguage('es');
  assert.match(text(render(blocked('not-open', 'merged', null))), /Esta PR ya se ha fusionado\./);
  assert.doesNotMatch(text(render(blocked('not-open', 'closed', null))), /está open/);
  assert.match(text(render(blocked('not-open', null, null))), /Esta PR ya no está abierta\./);
});

test('who turned auto-merge off for an update reads as you or Agentry, never as local', () => {
  const off = (by: string) => text(render(state({ autoMergeOff: { by, at: '2026-10-01T09:30:00Z', why: 'update', pushing: false } })));
  assert.match(off('local'), /You turned auto-merge off .* for Update from base/);
  assert.match(off('agentry'), /Agentry turned auto-merge off .* for Update from base/);
  assert.doesNotMatch(off('local'), /local turned|by local/);
});

test('Update from base and arming have their own words for every refusal, and only conflicts go to the Developer', () => {
  for (const language of ['en', 'es'] as const) {
    const resource = language === 'en' ? enMerge : esMerge;
    assert.match(resource.toast.conflicts, /Developer|desarrollador/);
    for (const refusal of ['busy', 'not-offered', 'not-open', 'merge-failed'] as const) {
      assert.doesNotMatch(resource.update[refusal], /Developer|desarrollador/, refusal);
      assert.doesNotMatch(resource.update[refusal], /conflict/i, refusal);
    }
    // Arming while Agentry is still pushing is not the host rejecting the merge
    assert.doesNotMatch(resource.failure.busy, /refused|rechazado/);
    assert.notEqual(resource.failure.busy, resource.failure['merge-failed']);
  }
});

test('the merge styles keep to the type scale', () => {
  const css = readFileSync(new URL('../src/styles/merge.css', import.meta.url), 'utf8');
  assert.deepEqual([...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1]).filter((size) => !['34', '24', '16', '15', '14', '13', '12', '11'].includes(size ?? '')), []);
});

test('the Spanish pipeline is feminine everywhere', () => {
  for (const file of ['merge.json', 'orchestrationDetail.json']) {
    const body = readFileSync(new URL(`../src/i18n/locales/es/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(body, /\b(el|un|del|al) pipeline\b/i, file);
  }
});
