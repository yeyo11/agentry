// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import type { IssueRef, Project, ProjectTrackerSettings, TrackerIssue, TrackerIssuesPage, WorkItem } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import { setLanguage } from '../src/i18n';
import { canImportFrom, ImportIssuesButton, startingQuery, useImportForm } from '../src/pages/tasks/ImportIssues';
import { IssueFact, IssueFailure, hasFacts } from '../src/pages/tasks/board/WorkItemCard';
import { IssueChips, Issues } from '../src/pages/tasks/item/Issues';

// Tracker issues on the Tasks screens (docs/plans/code-hosts.md, phase 5, P2 tu3): the import dialog,
// the item's chips and panel, and the card's key. Reference: DesktopImportarIssues, DesktopTareaIssues,
// DesktopTableroIssues and their phone twins.

beforeEach(() => setLanguage('en'));

const issue = (over: Partial<IssueRef> = {}): IssueRef => ({
  tracker: 'github-issues', key: '14', scope: 'acme/shop', externalId: null, title: 'Project templates <b>on create</b>', state: 'open', url: 'https://github.com/acme/shop/issues/14',
  importedAt: '2026-10-01T09:00:00Z', syncedAt: null, syncState: 'none', syncReason: null, ...over,
});

const listed = (key: string, over: Partial<TrackerIssue> = {}): TrackerIssue => ({
  tracker: 'github-issues', key, externalId: null, title: `Issue ${key}`, body: '', state: 'open', labels: ['web'], type: null, url: null, updatedAt: '2026-10-01T09:00:00Z', importedItemId: null, triage: null, ...over,
});

const tracker: ProjectTrackerSettings = { id: 'github-issues', scope: 'acme/shop', query: '', statusMap: {} };
const project = { id: 'p1', name: 'shop', path: '/tmp/shop', worktrees: [], exists: true, chatCount: 0, lastActivity: null, key: 'AGN', modules: ['board'] } as Project;

function wrap(node: React.ReactNode, seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient();
  seed?.(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>{node}</ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
/** The dialog's content without its shell: a portal cannot be drawn on the server. */
function Form() {
  const form = useImportForm(project, tracker, () => undefined);
  return (
    <>
      {form.body}
      <div className="dialog-foot">{form.footer}</div>
    </>
  );
}

const bare =(html: string) => html.replace(/<div class="toasts"[^>]*><\/div>/, '');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a chip says the key as its tracker writes it, the sync state in words, and links out', () => {
  const html = wrap(<IssueChips item={{ issues: [issue({ syncState: 'failed' }), issue({ tracker: 'jira', key: 'PROJ-12', url: null })] }} />);
  assert.match(html, /#14/);
  assert.match(html, /PROJ-12/);
  assert.match(text(html), /failed/);
  assert.match(html, /href="https:\/\/github.com\/acme\/shop\/issues\/14"/);
  assert.match(html, /rel="noreferrer"/);
});

test('an issue title is a stranger\'s text: the panel draws it escaped and the chip leaves it out', () => {
  assert.doesNotMatch(wrap(<IssueChips item={{ issues: [issue()] }} />), /Project templates/);
  const panel = wrap(<Issues item={{ id: 'i1', issues: [issue()] }} />);
  assert.match(panel, /Project templates &lt;b&gt;on create&lt;\/b&gt;/);
  assert.doesNotMatch(panel, /<b>on create/);
});

test('Sync again is offered where a write failed and nowhere else', () => {
  const failed = wrap(<Issues item={{ id: 'i1', issues: [issue({ syncState: 'failed', syncReason: 'cli-signed-out', syncedAt: '2026-10-01T09:00:00Z' })] }} />);
  assert.match(failed, /Sync again/);
  assert.match(failed, /cli-signed-out/);
  for (const syncState of ['none', 'synced'] as const) assert.doesNotMatch(wrap(<Issues item={{ id: 'i1', issues: [issue({ syncState })] }} />), /Sync again/);
});

test('an item without issues draws no chips and no panel', () => {
  assert.equal(bare(wrap(<IssueChips item={{}} />)), '');
  assert.equal(bare(wrap(<Issues item={{ id: 'i1' }} />)), '');
});

test('the card carries the first issue\'s key, +1 for more, and a failed write on a done card', () => {
  const item = { issues: [issue({ key: '31' }), issue({ key: '32' })] } as Pick<WorkItem, 'issues'>;
  const html = wrap(<IssueFact item={item} />);
  assert.match(html, /#31/);
  assert.match(html, /\+1/);
  assert.equal(hasFacts({ acceptanceCriteria: [], relations: [], bounces: 0, ...item }), true);
  assert.equal(hasFacts({ acceptanceCriteria: [], relations: [], bounces: 0 }), false);
  assert.equal(bare(wrap(<IssueFailure item={item} />)), '');
  assert.match(text(wrap(<IssueFailure item={{ issues: [issue({ key: '12', syncState: 'failed', syncReason: 'cli-signed-out' })] }} />)), /Failed #12 was not written to cli-signed-out/);
});

test('Import issues is neutral unless it leads', () => {
  assert.doesNotMatch(wrap(<ImportIssuesButton leads={false} onClick={() => undefined} />), /btn-primary/);
  assert.match(wrap(<ImportIssuesButton leads onClick={() => undefined} />), /btn-primary/);
});

test('only a tracker that is built can import, and the query starts from the project\'s', () => {
  assert.equal(canImportFrom(tracker), true);
  assert.equal(canImportFrom({ ...tracker, id: 'jira' }), false);
  assert.equal(canImportFrom(null), false);
  assert.equal(startingQuery(tracker), 'is:open');
  assert.equal(startingQuery({ id: 'gitlab-issues', query: '' }), '');
  assert.equal(startingQuery({ id: 'github-issues', query: 'label:bug' }), 'label:bug');
});

test('the import dialog marks, disables the imported and has one gradient action', () => {
  const page: TrackerIssuesPage = {
    issues: [listed('41', { triage: 'ready', type: 'bug' }), listed('36', { triage: 'needs-refining' }), listed('33', { triage: 'not-for-agents' }), listed('31', { importedItemId: 'it1' })],
    page: 1,
    hasMore: true,
  };
  const html = wrap(<Form />, (qc) => qc.setQueryData(keys.trackerIssues('p1', '', 1), page));
  const plain = text(html);
  for (const word of ['ready', 'needs refining', 'not for agents', 'already imported', 'suggested · issue.triage', 'Choose the ready ones', 'Show more', 'Choose an issue', '0 of 3 chosen']) assert.ok(plain.includes(word), word);
  assert.equal((html.match(/btn-primary/g) ?? []).length, 1);
  // The imported row has no checkbox of its own
  assert.equal((html.match(/aria-label="Choose issue #/g) ?? []).length, 3);
  assert.match(html, /value="is:open"/);
  assert.match(plain, /Other people write these issues/);
});

test('the features are reachable: each piece is mounted or called by a screen', () => {
  const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  assert.match(src('pages/tasks/Board.tsx'), /<ImportIssues\b/);
  assert.match(src('pages/tasks/Board.tsx'), /<ImportIssuesButton\b/);
  assert.match(src('pages/tasks/board/EmptyBoards.tsx'), /importLeads/);
  const view = src('pages/tasks/item/View.tsx');
  assert.equal((view.match(/<IssueChips\b/g) ?? []).length, 2);
  assert.equal((view.match(/<Issues\b/g) ?? []).length, 2);
  const card = src('pages/tasks/board/WorkItemCard.tsx');
  assert.match(card, /<IssueFact\b/);
  assert.match(card, /<IssueFailure\b/);
  const issues = src('pages/tasks/item/Issues.tsx') + src('pages/tasks/ImportIssues.tsx');
  for (const call of ['api.syncWorkItemIssue', 'api.importTrackerIssues', 'api.trackerIssues', 'api.projectTracker', 'api.trackers']) assert.ok(issues.includes(call), call);
});
