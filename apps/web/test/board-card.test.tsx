// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardColumn, FlowRun, WorkItem, WorkItemLink, WorkItemStatus } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '../src/components/controls/Tooltip';
import { ToastProvider } from '../src/components/Toast';
import i18n from '../src/i18n';
import { Illustration } from '../src/components/illustrations/Illustration';
import { lastEndedRuns, stripActor, stripInList, stripNamesAssignee, stripTone, workItemStrip, type StripRuns } from '../src/lib/work-items';
import { EmptyBoard } from '../src/pages/tasks/board/EmptyBoards';
import { BoardColumns } from '../src/pages/tasks/board/BoardColumns';
import { PhoneBoard } from '../src/pages/tasks/board/PhoneBoard';
import { BoardTeamProvider, PhoneFlowRow, type BoardTeam } from '../src/pages/tasks/board/team';
import { WorkItemCard } from '../src/pages/tasks/board/WorkItemCard';

// The board's card as DSTablero draws it (design system, decisions 1, 2, 6 and 8): five rows, one
// strip led by who acts, the quiet over-limit column, and Done paged with skeleton cards.

const item = (id: string, status: WorkItemStatus, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  projectId: 'p1',
  number: 1,
  key: `AGN-${id}`,
  type: 'task',
  title: `Item ${id}`,
  description: '',
  status,
  priority: 'medium',
  labels: [],
  assignee: null,
  epicId: null,
  milestoneId: null,
  acceptanceCriteria: [],
  relations: [],
  rank: id,
  worktree: null,
  branch: null,
  createdAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:00Z',
  closedAt: null,
  ...extra,
});

const run = (itemId: string, over: Partial<FlowRun> = {}): FlowRun => ({
  id: `r-${itemId}`,
  projectId: 'p1',
  itemId,
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
  retriedBy: null,
  retryable: false,
  restarts: 0,
  queuedAt: '2026-09-28T10:00:00.000Z',
  startedAt: new Date(Date.now() - 252_000).toISOString(),
  endedAt: null,
  ...over,
});

const chatLink = (over: Partial<WorkItemLink> = {}): WorkItemLink => ({
  id: 'l1',
  itemId: 'x',
  kind: 'chat',
  role: 'work',
  chatId: 'c1',
  orchestrationId: null,
  taskId: null,
  chatState: 'working',
  createdAt: '2026-09-28T10:00:00.000Z',
  ...over,
});

const criteria = (done: number, total: number) =>
  Array.from({ length: total }, (_, i) => ({ id: `c${i}`, text: `criterion ${i}`, checked: i < done, checkedBy: null, checkedAt: null }));

const team = (runs: StripRuns = {}): BoardTeam => ({
  flowOn: true,
  columns: { backlog: 'product-owner', todo: 'product-owner', in_progress: 'developer', in_review: 'qa' },
  maxBounces: 3,
  running: runs.running ?? new Map(),
  queued: runs.queued ?? new Map(),
  ended: runs.ended ?? new Map(),
  maxParallel: 2,
  queuedCount: 0,
  verifier: 'qa',
});

const sources = { chats: [], orchestrations: [] };

function wrap(children: ReactNode, value: BoardTeam | null = null) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <BoardTeamProvider value={value}>{children}</BoardTeamProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const card = (it: WorkItem, value: BoardTeam | null = null, extra: { project?: string; epic?: { done: number; total: number } } = {}) =>
  wrap(<WorkItemCard item={it} live={sources} onOpen={() => {}} {...extra} />, value);

// ---------- the strip's state ----------

test('a strip says one thing, most pressing first: work, then the person, then a failure, QA, the queue', () => {
  const id = 'x';
  const failed = run(id, { state: 'ended', outcome: 'failed', column: 'todo', step: 'check', role: 'product-owner', cause: 'no-account' });
  const queued = run(id, { state: 'queued', role: 'product-owner', step: 'check', column: 'todo' });
  // Running beats everything
  assert.equal(workItemStrip(item(id, 'todo', { waiting: 'approval' }), { running: new Map([[id, run(id)]]) })?.kind, 'run');
  // The person's chat at work, a node, and a flow chat before the flow's own answer arrives
  assert.equal(workItemStrip(item(id, 'in_progress', { activeLink: chatLink() }))?.kind, 'chat');
  assert.equal(workItemStrip(item(id, 'in_progress', { activeLink: chatLink({ kind: 'orchestration', orchestrationId: 'o1', taskId: 't3', chatState: null, taskStatus: 'running' }) }))?.kind, 'node');
  assert.deepEqual(workItemStrip(item(id, 'todo', { activeLink: chatLink({ role: 'refine', teamRole: 'product-owner' }) })), {
    kind: 'run',
    role: 'product-owner',
    step: 'check',
    startedAt: null,
    activity: null,
  });
  assert.equal(workItemStrip(item(id, 'in_progress', { activeLink: chatLink({ chatState: 'waiting' }) }))?.kind, 'chat-waiting');
  assert.equal(workItemStrip(item(id, 'in_review', { waiting: 'approval' }), { ended: new Map([[id, failed]]) })?.kind, 'approval');
  assert.deepEqual(workItemStrip(item(id, 'in_progress', { waiting: 'bounces', bounces: 3 })), { kind: 'bounces', count: 3 });
  assert.deepEqual(workItemStrip(item(id, 'todo'), { ended: new Map([[id, failed]]), queued: new Map([[id, queued]]) }), {
    kind: 'failed',
    role: 'product-owner',
    step: 'check',
    cause: 'no-account',
    error: null,
  });
  assert.equal(workItemStrip(item(id, 'todo'), { queued: new Map([[id, queued]]) })?.kind, 'queued');
  // Nothing on a card at rest, and nothing on a card in Done
  assert.equal(workItemStrip(item(id, 'todo')), null);
  assert.equal(workItemStrip(item(id, 'done', { waiting: 'approval' })), null);
});

test("a failure shows only while it still stands: in the run's column, with nothing run since", () => {
  const id = 'x';
  const failed = run(id, { state: 'ended', outcome: 'failed', column: 'todo', step: 'check', role: 'product-owner' });
  assert.equal(workItemStrip(item(id, 'in_progress'), { ended: new Map([[id, failed]]) }), null, 'the card moved on');
  const answered = { ...failed, retriedBy: { id: 'r2', state: 'ended' as const, outcome: 'passed' as const, chatId: 'c2', queuedAt: '', endedAt: '' } };
  assert.equal(workItemStrip(item(id, 'todo'), { ended: new Map([[id, answered]]) }), null, 'a later run answered it');
});

test("QA's words on a card it sent back win over its place in the queue, and are neutral", () => {
  const id = 'x';
  const rejected = run(id, { state: 'ended', outcome: 'rejected', role: 'qa', stage: 'verify', step: 'verify', column: 'in_review', summary: 'The key changes on rename.' });
  const queued = run(id, { state: 'queued' });
  const strip = workItemStrip(item(id, 'in_progress', { bounces: 1 }), { ended: new Map([[id, rejected]]), queued: new Map([[id, queued]]) });
  assert.deepEqual(strip, { kind: 'rejected', role: 'qa', quote: 'The key changes on rename.' });
  assert.equal(strip && stripTone(strip), null);
  // Once the item is back in review, QA's words are old news
  assert.equal(workItemStrip(item(id, 'in_review', { bounces: 1 }), { ended: new Map([[id, rejected]]) }), null);
});

test('the foot leaves out the assignee the strip already starts with', () => {
  const working = workItemStrip(item('x', 'in_progress'), { running: new Map([['x', run('x')]]) });
  assert.deepEqual(stripActor(working), { kind: 'role', role: 'developer' });
  assert.ok(stripNamesAssignee({ kind: 'role', role: 'developer' }, working));
  assert.ok(!stripNamesAssignee({ kind: 'role', role: 'qa' }, working));
  assert.ok(!stripNamesAssignee({ kind: 'person' }, working));
  const mine = workItemStrip(item('x', 'in_progress', { activeLink: chatLink() }));
  assert.ok(stripNamesAssignee({ kind: 'person' }, mine));
  // "te espera" starts with a word, not an actor: the assignee stays
  assert.ok(!stripNamesAssignee({ kind: 'person' }, { kind: 'approval' }));
});

test('the newest failed or rejected run of each item is the one kept', () => {
  const old = run('a', { id: 'old', queuedAt: '2026-09-27T10:00:00.000Z' });
  const recent = run('a', { id: 'new', queuedAt: '2026-09-28T10:00:00.000Z' });
  const other = run('b', { id: 'b1' });
  const last = lastEndedRuns([old, other, recent]);
  assert.equal(last.get('a')?.id, 'new');
  assert.equal(last.get('b')?.id, 'b1');
});

// ---------- the card ----------

test('a card reads in five rows: what, title, where, facts and the strip', async () => {
  await i18n.changeLanguage('es');
  const it = item('35', 'in_progress', {
    epic: { id: 'e1', key: 'AGN-12', title: 'Ecosistema de proyectos', type: 'epic', status: 'in_progress' },
    labels: ['core', 'api'],
    acceptanceCriteria: criteria(1, 2),
    assignee: { kind: 'role', role: 'developer' },
    bounces: 1,
  });
  const rejected = run('35', { state: 'ended', outcome: 'rejected', role: 'qa', step: 'verify', column: 'in_review', summary: 'La clave cambia al renombrar.' });
  const html = card(it, team({ ended: new Map([['35', rejected]]) }));
  const order = ['workitem-card-top', 'workitem-card-title', 'workitem-context', 'workitem-card-foot', 'workitem-strip'].map((name) => html.indexOf(`class="${name}`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0))), `rows in order (${order})`);
  assert.match(html, /class="workitem-epic is-bare"/);
  assert.match(text(html), /core api/);
  assert.equal((html.match(/class="workitem-tag"/g) ?? []).length, 2);
  assert.match(text(html), /rebote 1 de 3/);
  assert.match(html, /workitem-criteria-bar"[^>]*><i style="width:50%"/);
  assert.match(text(html), /«La clave cambia al renombrar\.»/);
  // The strip starts with QA; the foot still names the Developer who carries it
  assert.match(html, /workitem-card-foot.*role-avatar/);
  await i18n.changeLanguage('en');
});

test('a failed run is said on the card with its stage by column and its reason, in the bad tone', async () => {
  await i18n.changeLanguage('es');
  const failed = run('36', { state: 'ended', outcome: 'failed', role: 'product-owner', stage: 'refine', step: 'check', column: 'todo', cause: 'no-account', error: 'No account had quota' });
  const html = card(item('36', 'todo', { acceptanceCriteria: criteria(0, 4) }), team({ ended: new Map([['36', failed]]) }));
  assert.match(html, /class="workitem-strip is-fail"/);
  assert.doesNotMatch(html, /role="status"/, 'a board of failures does not announce each one on load');
  assert.match(text(html), /PO Falló al comprobarla · ninguna cuenta tenía cupo/);
  // The raw error, in English as the core wrote it, stays behind the words
  assert.match(html, /title="No account had quota"/);
  await i18n.changeLanguage('en');
});

test('a queued run and an approval read as the reference writes them', async () => {
  await i18n.changeLanguage('es');
  const queued = run('45', { state: 'queued', role: 'product-owner', stage: 'refine', step: 'refine', column: 'backlog', startedAt: null });
  const html = card(item('45', 'backlog', { labels: ['web'] }), team({ queued: new Map([['45', queued]]) }));
  assert.match(html, /class="workitem-strip"/);
  assert.match(text(html), /PO En cola: la refinará cuando quede sitio/);
  const approval = card(item('26', 'in_review', { waiting: 'approval', assignee: { kind: 'person' }, acceptanceCriteria: criteria(5, 5) }), team());
  assert.match(approval, /workitem-strip is-wait/);
  assert.match(text(approval), /te espera QA la dio por buena Aprobar y pasar a Hecho/);
  assert.match(approval, /workitem-criteria is-full/);
  // The person carries it, and the strip does not start with them: the foot keeps the monogram
  assert.match(approval, /workitem-card-foot.*workitem-assignee/);
  await i18n.changeLanguage('en');
});

test("a member at work leads with its squircle, verb and clock, and its card's foot does not repeat it", async () => {
  await i18n.changeLanguage('es');
  const it = item('28', 'in_progress', { assignee: { kind: 'role', role: 'developer' }, acceptanceCriteria: criteria(2, 5) });
  const html = card(it, team({ running: new Map([['28', run('28', { activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: new Date().toISOString() } })]]) }));
  assert.match(html, /workitem-card[^"]* live-rail/);
  assert.match(html, /workitem-strip is-live/);
  assert.match(text(html), /DEV \S Implementando 4:1[23] pnpm test/);
  assert.doesNotMatch(html, /workitem-card-foot.*role-avatar-sm/);
  await i18n.changeLanguage('en');
});

test('a done card keeps only what it is and its title; an epic with no items says so', async () => {
  await i18n.changeLanguage('es');
  const done = card(item('24', 'done', { labels: ['web'], acceptanceCriteria: criteria(3, 3), assignee: { kind: 'person' } }));
  assert.match(done, /workitem-card is-done/);
  assert.doesNotMatch(done, /workitem-context|workitem-card-foot|workitem-strip|priority-mark/);
  const epic = card(item('47', 'todo', { type: 'epic' }), null, { epic: { done: 0, total: 0 } });
  assert.match(text(epic), /sin tareas todavía/);
  // On All projects the project leads the context row
  const all = card(item('9', 'todo', { labels: ['oauth'] }), null, { project: 'google-docs-mcp' });
  assert.ok(all.indexOf('workitem-project') < all.indexOf('workitem-tag'));
  await i18n.changeLanguage('en');
});

// ---------- the columns ----------

const column = (status: WorkItemStatus, items: WorkItem[], extra: Partial<BoardColumn> = {}): BoardColumn => ({ status, limit: null, count: items.length, overLimit: false, items, ...extra });

const columns = (done: WorkItem[], more = 0) => [
  column('backlog', []),
  column('todo', []),
  column('in_progress', [item('1', 'in_progress'), item('2', 'in_progress')], { limit: 1, overLimit: true }),
  column('in_review', []),
  column('done', done, { more, count: done.length + more }),
];

test('a column over its limit is a hairline and one line of words; Done ends in "Show N more"', async () => {
  await i18n.changeLanguage('es');
  const done = [item('d1', 'done'), item('d2', 'done'), item('d3', 'done'), item('d4', 'done')];
  const html = wrap(<BoardColumns columns={columns(done, 8)} epics={new Map()} live={sources} selection={null} doneShown={3} onMoreDone={() => {}} onOpen={() => {}} />);
  assert.match(html, /class="workitem-col is-over"/);
  assert.match(text(html), /Sobre el límite: 2 de 1/);
  assert.match(html, /<button type="button" class="workitem-col-more">Mostrar 9 más<svg/);
  assert.doesNotMatch(html, /is-skeleton/);
  await i18n.changeLanguage('en');
});

test('while the next page of Done arrives, two skeleton cards take its place', () => {
  const done = [item('d1', 'done'), item('d2', 'done')];
  const html = wrap(<BoardColumns columns={columns(done, 8)} epics={new Map()} live={sources} selection={null} doneShown={20} doneLoading onMoreDone={() => {}} onOpen={() => {}} />);
  assert.equal((html.match(/workitem-card is-skeleton/g) ?? []).length, 2);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /workitem-col-more/);
});

// ---------- the list, the empty board and the phone ----------

test("the list's Now column says who runs an item or that its run failed, and nothing that waits for the person", () => {
  assert.ok(stripInList({ kind: 'chat', chatId: 'c' }));
  assert.ok(stripInList({ kind: 'node', orchestrationId: 'o', taskId: 't' }));
  assert.ok(stripInList({ kind: 'failed', role: 'qa', step: 'verify', cause: null, error: null }));
  assert.ok(!stripInList({ kind: 'approval' }));
  assert.ok(!stripInList({ kind: 'queued', role: 'qa', step: 'verify' }));
  assert.ok(!stripInList(null));
});

test('the empty board draws the five fixed columns with the project\'s first key, and no "+" disc', () => {
  const html = renderToStaticMarkup(<Illustration name="board" text="PAG-1" />);
  assert.equal((html.match(/rx="8" class="c0"/g) ?? []).length, 5);
  assert.match(html, />PAG-1</);
  assert.doesNotMatch(html, /ln-white|halo/);
});

test('on a phone the empty board is the page itself, with the shorter words', async () => {
  await i18n.changeLanguage('es');
  const project = { id: 'p', name: 'pagos-api', path: '/tmp/p', worktrees: [], exists: true, chatCount: 0, lastActivity: null, key: 'PAG', modules: ['board' as const] };
  const phone = wrap(<EmptyBoard project={project} phone onNew={() => {}} />);
  assert.match(phone, /class="workitem-empty is-phone"/);
  assert.match(text(phone), /o desde un mensaje de cualquier chat\./);
  const desktop = wrap(<EmptyBoard project={project} phone={false} onNew={() => {}} />);
  assert.match(desktop, /class="card glow-top workitem-empty"/);
  await i18n.changeLanguage('en');
});

test("a phone board worked by a team says the flow's state in one row", async () => {
  await i18n.changeLanguage('es');
  const html = wrap(<PhoneFlowRow team={{ ...team(), queuedCount: 1 }} projectId="p" />);
  assert.match(text(html), /Flujo automático · 2 a la vez, 1 en cola Activado/i);
  assert.match(html, /href="\/\?project=p&amp;view=team&amp;section=flow"/);
  await i18n.changeLanguage('en');
});

test('a phone row reads as the card does, and while choosing its epic stays bare', () => {
  const epic = { id: 'e1', key: 'AGN-12', title: 'Ecosistema de proyectos', type: 'epic' as const, status: 'in_progress' as const };
  const it = item('36', 'todo', { epic, labels: ['core'], acceptanceCriteria: criteria(0, 4) });
  const failed = run('36', { state: 'ended', outcome: 'failed', role: 'product-owner', stage: 'refine', step: 'check', column: 'todo', cause: 'no-account' });
  const cols = [column('backlog', []), column('todo', [it]), column('in_progress', []), column('in_review', []), column('done', [])];
  const html = wrap(<PhoneBoard columns={cols} epics={new Map()} live={sources} selection={null} doneShown={3} onMoreDone={() => {}} />, team({ ended: new Map([['36', failed]]) }));
  const order = ['workitem-mrow-top', 'workitem-mrow-title', 'workitem-context', 'workitem-card-foot', 'workitem-strip is-fail'].map((name) => html.indexOf(`class="${name}`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0))), `rows in order (${order})`);
  const choosing = wrap(
    <PhoneBoard columns={cols} epics={new Map()} live={sources} selection={{ selected: new Set(['36']), blockedReason: () => null, toggle: () => {} }} doneShown={3} onMoreDone={() => {}} />,
  );
  assert.match(choosing, /class="workitem-epic is-bare"/);
});
