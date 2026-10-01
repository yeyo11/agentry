// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import type { ChangeRequestChecks, Check, WorkItemPullRequest } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import { setLanguage } from '../src/i18n';
import enChecks from '../src/i18n/locales/en/checks.json' with { type: 'json' };
import esChecks from '../src/i18n/locales/es/checks.json' with { type: 'json' };
import { Checks, useFixOffered } from '../src/pages/tasks/item/Checks';

// The checks of an item's open change request (docs/plans/code-hosts.md, phase 2): the list with its
// groups, words and colours, the one gradient action, and the fix states.

beforeEach(() => setLanguage('en'));

const check = (over: Partial<Check>): Check => ({
  id: '1', name: 'unit-tests', group: 'test', state: 'passed', allowedToFail: false, required: false,
  startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:02:14Z', url: 'https://gitlab.com/acme/shop/-/jobs/1', rerunnable: true, hasLog: true, source: 'job', ...over,
});

const pr = (over: Partial<WorkItemPullRequest> = {}): WorkItemPullRequest => ({
  id: 'cr1', phase: 'open', host: 'gitlab', number: 12, ref: '!12', url: 'https://gitlab.com/acme/shop/-/merge_requests/12', branch: 'task/agn-26', base: 'main', ci: 'failing',
  conflicts: [], error: null, openedAt: '2026-10-01T09:00:00Z', closedAt: null, checkedAt: '2026-10-01T10:00:00Z', ...over,
});

const list = (checks: Check[], over: Partial<ChangeRequestChecks> = {}): ChangeRequestChecks => ({
  headSha: 'a1b2c3d', rollup: 'failing', checks, truncated: false, checkedAt: '2026-10-01T10:42:00Z', ...over,
});

const FAILING = [
  check({ id: '1', name: 'unit-tests', state: 'failed' }),
  check({ id: '2', name: 'e2e-chrome', state: 'failed' }),
  check({ id: '3', name: 'lint-docs', state: 'failed', allowedToFail: true }),
  check({ id: '4', name: 'build', state: 'passed' }),
];

function render(data: ChangeRequestChecks | null, request: WorkItemPullRequest = pr()) {
  const qc = new QueryClient();
  if (data) qc.setQueryData(keys.changeRequestChecks('cr1'), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <Checks pr={request} itemId="item1" />
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

test('a failing list shows failures first, with the allowed one as a warning and in words', () => {
  const html = render(list(FAILING));
  assert.ok(html.indexOf('unit-tests') < html.indexOf('build') || !html.includes('build'));
  assert.match(html, /badge badge-bad[^>]*>failed</);
  assert.match(html, /badge badge-warn[^>]*>allowed to fail</);
  assert.match(html, /3 failed · 1 passed/);
  assert.match(html, /3 · 1 allowed/);
});

test('the passed group is folded away beside a failure, and its rows stay out of the page', () => {
  const html = render(list(FAILING));
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Passed/);
  assert.ok(!html.includes('View the log of build'));
  assert.ok(html.includes('View the log of unit-tests'));
});

test('Fix failing checks is the one gradient action, offered only for a failure that counts', () => {
  assert.equal(count(render(list(FAILING)), 'btn-primary'), 1);
  assert.match(render(list(FAILING)), /Fix failing checks/);
  assert.match(render(list(FAILING)), /Re-run failed/);
  const allowedOnly = render(list([check({ state: 'failed', allowedToFail: true }), check({ id: '2', state: 'passed' })], { rollup: 'passing' }));
  assert.ok(!allowedOnly.includes('Fix failing checks'));
  assert.equal(count(allowedOnly, 'btn-primary'), 0);
});

test('only a running row is live: the ring and the rail, with its word', () => {
  const html = render(list([check({ id: '1', name: 'test', state: 'running', finishedAt: null }), check({ id: '2', name: 'build', state: 'queued', startedAt: null, finishedAt: null }), check({ id: '3', state: 'failed' })], { rollup: 'pending' }));
  assert.equal(count(html, 'live-rail'), 1);
  assert.equal(count(html, 'spinner-ring'), 1);
  assert.match(html, /badge badge-active[^>]*>running</);
  assert.match(html, />queued</);
  assert.match(html, /Cancel/);
  assert.equal(count(html, '—'), 1);
});

test('a PR without checks says so, in the host\'s word', () => {
  const html = render(list([], { rollup: 'none' }));
  assert.match(html, /This MR has no checks\./);
  assert.ok(!html.includes('Fix failing checks'));
});

test('a used-up rate limit is a warning with the time, and the fix waits', () => {
  const html = render(list(FAILING, { limitedUntil: '2026-10-01T11:20:00Z' }));
  assert.match(html, /check-limit/);
  assert.match(html, /API limit/);
  assert.match(html, /workitem-fix-checks"[^>]*disabled/);
});

test('a fix under way replaces the action: fixing is live, waiting for the push is a button', () => {
  const fixing = render(list(FAILING), pr({ fixState: 'fixing', fixOrigin: 'person', fixAttempts: 1 }));
  assert.ok(!fixing.includes('Fix failing checks'));
  assert.match(fixing, /The Developer is fixing the checks/);
  assert.match(fixing, /at your request · attempt 1/);
  assert.equal(count(fixing, 'live-rail'), 1);
  const verifying = render(list(FAILING), pr({ fixState: 'awaiting-verify', fixOrigin: 'decision' }));
  assert.match(verifying, /QA is verifying the fix/);
  const waiting = render(list(FAILING), pr({ fixState: 'awaiting-push', fixOrigin: 'decision' }));
  assert.match(waiting, /waiting for you/);
  assert.match(waiting, /Push the fix/);
  assert.ok(!waiting.includes('live-rail'));
});

test('a fix of review comments is not drawn as a checks fix: the review block has its own rail and push', () => {
  for (const fixState of ['fixing', 'awaiting-verify', 'awaiting-push'] as const) {
    const html = render(list(FAILING), pr({ fixState, fixKind: 'review', fixOrigin: 'person' }));
    assert.ok(!html.includes('check-fix'), fixState);
    assert.ok(!html.includes('workitem-push-fix'), fixState);
    assert.ok(!html.includes('The Developer is fixing the checks'), fixState);
  }
  assert.match(render(list(FAILING), pr({ fixState: 'fixing', fixKind: 'checks' })), /The Developer is fixing the checks/);
});

test('nothing is drawn before the host numbered the PR or once it is closed', () => {
  assert.ok(!render(null, pr({ id: undefined })).includes('class="checks"'));
  assert.ok(!render(list(FAILING), pr({ phase: 'merged' })).includes('class="checks"'));
});

test('the Spanish copy words the same states', () => {
  setLanguage('es');
  const html = render(list(FAILING));
  assert.match(html, /Comprobaciones/);
  assert.match(html, /Arreglar las comprobaciones fallidas/);
  assert.match(html, /fallo permitido/);
  assert.match(html, /3 fallidas · 1 superada/);
});

test('the header gives its gradient up only while the fix is on the page', () => {
  const probe = (data: ChangeRequestChecks | null, request: WorkItemPullRequest) => {
    const qc = new QueryClient();
    if (data) qc.setQueryData(keys.changeRequestChecks('cr1'), data);
    function Probe() {
      return <>{String(useFixOffered(request))}</>;
    }
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
  };
  assert.equal(probe(list(FAILING), pr()), 'true');
  assert.equal(probe(list(FAILING), pr({ fixState: 'fixing' })), 'false');
  assert.equal(probe(list([check({ state: 'passed' })], { rollup: 'passing' }), pr()), 'false');
  assert.equal(probe(null, pr()), 'false');
});

test('both languages define the same check keys', () => {
  const keysOf = (tree: object, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : keysOf(value as object, `${prefix}${key}.`)));
  assert.deepEqual(keysOf(esChecks).sort(), keysOf(enChecks).sort());
});
