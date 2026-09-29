// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun, FlowRunPage, Overview, Project, ProjectFlowSettings, Team, TeamMember } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '../src/components/controls/Tooltip';
import { ConfirmProvider } from '../src/components/Dialog';
import { ToastProvider } from '../src/components/Toast';
import { DirtyProvider } from '../src/lib/dirty';
import i18n, { setLanguage } from '../src/i18n';
import { TeamActivityView } from '../src/pages/team/Activity';
import { FlowEditor } from '../src/pages/team/Flow';
import { MemberPage } from '../src/pages/team/Member';
import { MemberCells, MemberGrid } from '../src/pages/team/Members';
import { TeamActivity } from '../src/pages/team/parts';
import { RoleAvatar } from '../src/pages/team/RoleAvatar';

// The Team screens as the ecosystem design review redrew them (docs/design-system/ecosystem-review.md):
// Team activity as a third view (EquipoActividad), the Flow's one "Límites" card, `.model-pick`, and
// failed runs said in the person's language wherever a member shows one.

const project: Project = { id: 'p', name: 'shop', path: '/tmp/shop', worktrees: [], exists: true, chatCount: 0, lastActivity: null, key: 'SHOP', modules: ['team'] };

const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const yesterdayAt = (hour: number, minute: number) => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const run = (id: string, over: Partial<FlowRun> = {}): FlowRun => ({
  id,
  projectId: 'p',
  itemId: `i-${id}`,
  item: { id: `i-${id}`, key: `SHOP-${id}`, title: `Item ${id}`, type: 'task', status: 'in_progress' },
  role: 'developer',
  agent: 'developer',
  model: 'sonnet',
  stage: 'work',
  step: 'work',
  column: 'in_progress',
  state: 'ended',
  chatId: `chat-${id}`,
  outcome: 'passed',
  summary: null,
  error: null,
  cause: null,
  retryOf: null,
  queuedBy: null,
  retriedBy: null,
  retryable: false,
  restarts: 0,
  continuations: 0,
  queuedAt: minutesAgo(30),
  startedAt: minutesAgo(30),
  endedAt: minutesAgo(25),
  ...over,
});

const member = (role: string, over: Partial<TeamMember> = {}): TeamMember => ({
  role,
  agent: role,
  model: 'sonnet',
  responsibility: '',
  file: { path: `.claude/agents/${role}.md`, state: 'missing', drift: [], description: null, model: null, updatedAt: null },
  columns: [],
  running: [],
  queued: 0,
  lastRun: null,
  ...over,
});

const team = (members: TeamMember[]): Team => ({ projectId: 'p', enabled: true, members, unassignedAgents: [] });
const FLOW: ProjectFlowSettings = { enabled: true, columns: { backlog: 'product-owner', todo: 'product-owner', in_progress: 'developer', in_review: 'qa' }, maxBounces: 3 };

function wrap(children: ReactNode, client = new QueryClient()) {
  const page = (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          <DirtyProvider>{children}</DirtyProvider>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
  const router = createMemoryRouter([{ path: '*', element: page }]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const withModels = () => {
  const client = new QueryClient();
  client.setQueryData(keys.overview, { system: { models: [{ value: 'sonnet', label: 'Sonnet 5' }, { value: 'opus', label: 'Opus 5.5' }] } } as unknown as Overview);
  return client;
};

/** The activity's queries, filled as the server would answer them. */
function activityClient(runs: FlowRun[], { total = runs.length, nextCursor = null as string | null, failed = 0, rejected = 0 } = {}) {
  const client = new QueryClient();
  const page: FlowRunPage = { runs, total, nextCursor };
  client.setQueryData(keys.flowRuns('p', {}), { pages: [page], pageParams: [''] });
  client.setQueryData(keys.flowRuns('p', { limit: 200 }), { pages: [page], pageParams: [''] });
  client.setQueryData(keys.flowRuns('p', { status: ['failed'], limit: 1 }), { pages: [{ runs: [], total: failed, nextCursor: null }], pageParams: [''] });
  client.setQueryData(keys.flowRuns('p', { status: ['rejected'], limit: 1 }), { pages: [{ runs: [], total: rejected, nextCursor: null }], pageParams: [''] });
  return client;
}

test.beforeEach(async () => {
  // setLanguage, not changeLanguage alone: Intl formats ("12m ago") follow the stored language, not i18next's
  setLanguage('en');
  await i18n.changeLanguage('en');
});

test('the Flow screen holds its three limits in one card, with no cost limit by default, and leads to the runs', () => {
  // Bounces, runs at once and the cost of a run are one "Límites" card (gap 5); the bounced list moved to Team activity
  const editor = (over: Partial<ProjectFlowSettings> = {}) =>
    wrap(<FlowEditor project={project} team={team([member('developer')])} flow={{ ...FLOW, ...over }} proposal={null} switcher={null} activityHref="?view=team&section=activity" />);
  const html = editor();
  assert.match(text(html), /Limits See runs/);
  assert.match(html, /aria-label="Bounces at most"[^>]*value="3"/);
  assert.match(html, /aria-label="Runs at once"[^>]*value="2"/);
  assert.match(html, /placeholder="No limit" aria-label="Cost per run, in USD"/);
  assert.match(html, /href="\/\?view=team&amp;section=activity"[^>]*>See runs</);
  assert.doesNotMatch(html, /flow-bounced/);
  const limited = editor({ maxParallel: 4, maxCostUsd: 1.5 });
  assert.match(limited, /aria-label="Runs at once"[^>]*value="4"/);
  assert.match(limited, /value="1.5"/);
});

test("each role's model on the Flow screen is a model picker: the alias as a tag, then the model it resolves to", () => {
  const html = wrap(
    <FlowEditor project={project} team={team([member('developer'), member('architect', { model: 'opus' })])} flow={FLOW} proposal={null} switcher={null} activityHref="" />,
    withModels(),
  );
  assert.match(html, /aria-label="Model of Developer"/);
  assert.match(html, /class="model-pick flow-model-pick"/);
  assert.match(html, /<span class="model-tag">sonnet<\/span><span class="resolved ellipsis">Sonnet 5<\/span>/);
  assert.match(html, /<span class="model-tag is-opus">opus<\/span><span class="resolved ellipsis">Opus 5.5<\/span>/);
});

test("a member's model on its page is the same picker, and keeps a model the CLI does not list", () => {
  const client = withModels();
  const html = wrap(<MemberPage project={project} member={member('developer')} backHref="?view=team" />, client);
  assert.match(html, /class="model-pick member-model-pick"/);
  assert.match(html, /<span class="model-tag">sonnet<\/span><span class="resolved ellipsis">Sonnet 5<\/span>/);
  const custom = wrap(<MemberPage project={project} member={member('qa', { model: 'claude-custom' })} backHref="?view=team" />, client);
  assert.match(custom, /<span class="model-tag">claude-custom<\/span>/);
  assert.doesNotMatch(custom, /class="resolved/);
});

test("the team's activity card leads to the whole view, and says a failure with the step's word", () => {
  const failed = run('2', { outcome: 'failed', cause: 'no-account', stage: 'refine', step: 'check', column: 'todo', role: 'product-owner', agent: 'product-owner' });
  const card = wrap(<TeamActivity runs={[run('1'), failed]} allHref="?view=team&section=activity" />);
  assert.match(card, /href="\/\?view=team&amp;section=activity"[^>]*>See all</);
  assert.match(text(card), /SHOP-2 failed to check it Product Owner · no account had quota left/);
});

test('Team activity lists every run by day, "Now" first, with its step by column, its state and its time', () => {
  const runs = [
    run('5', { state: 'running', outcome: null, stage: 'verify', step: 'verify', column: 'in_review', role: 'qa', agent: 'qa', startedAt: minutesAgo(1), endedAt: null }),
    run('4', { state: 'queued', outcome: null, chatId: null, stage: 'refine', step: 'refine', column: 'backlog', role: 'product-owner', agent: 'product-owner', startedAt: null, endedAt: null, queuedAt: minutesAgo(6) }),
    run('3', { outcome: 'passed', summary: 'Wrote 5 criteria', stage: 'refine', step: 'check', column: 'todo', role: 'product-owner', agent: 'product-owner', startedAt: minutesAgo(15), endedAt: minutesAgo(11) }),
    run('2', { outcome: 'rejected', summary: 'Criterion 2 fails', role: 'qa', agent: 'qa', stage: 'verify', step: 'verify', column: 'in_review', startedAt: yesterdayAt(17, 40), endedAt: yesterdayAt(17, 44) }),
  ];
  const client = activityClient(runs, { total: 60, nextCursor: 'c1', failed: 3, rejected: 1 });
  client.setQueryData(keys.flow('p'), { projectId: 'p', enabled: true, maxParallel: 1, running: [runs[0]], queued: [runs[1]] });
  const members = [member('product-owner'), member('developer'), member('qa'), member('architect')];
  const html = wrap(<TeamActivityView projectId="p" team={team(members)} flow={FLOW} switcher={null} flowHref="?view=team&section=flow" phone={false} />, client);
  const words = text(html);
  // Groups: now (running, then queued), today, then yesterday with its weekday; newest first inside each
  const at = (needle: string) => words.indexOf(needle);
  assert.ok(at('Now') < at('SHOP-5') && at('SHOP-5') < at('SHOP-4') && at('SHOP-4') < at('Today 1') && at('Today 1') < at('SHOP-3') && at('SHOP-3') < at('Yesterday ·'), words);
  assert.match(words, /Now 1 running · 1 queued/);
  // Who, the step by its column (a refine in To do is a check), and the state as a badge with its word
  assert.match(words, /QA · verification running/);
  assert.match(words, /Product Owner · check passed/);
  assert.match(words, /Product Owner · refinement queued/);
  assert.match(words, /QA · verification sent back/);
  assert.match(html, /class="badge flow-run-badge badge-active" data-status="running"/);
  assert.match(html, /class="badge flow-run-badge badge-ok" data-status="passed"/);
  // The live one: the rail, its step's verb, a running clock from the first second, and its chat
  assert.equal((html.match(/flow-run live-rail/g) ?? []).length, 1);
  assert.match(words, /Verifying/);
  assert.match(html, /<time class="flow-run-clock">1:0\d<\/time>/);
  assert.match(html, /href="\/chats\/chat-5"[^>]*>See the chat</);
  // A queued run says why it waits
  assert.match(words, /Waiting for a place: 1 of 1 runs are running/);
  // An ended run: its summary, QA's words quoted, the bare hour before today, the duration in words
  assert.match(words, /Wrote 5 criteria/);
  assert.match(words, /«Criterion 2 fails»/);
  assert.match(html, /<time[^>]*>17:44<\/time>/);
  assert.match(words, /17:44 4\s?m/);
  // Today's figures, the views with their counts, the member chips, today by member, and the limits
  assert.match(words, /Today 3 runs 1 running 1 queued 0 failed/);
  assert.match(words, /All Running 1 Failed 3 Sent back 1/);
  assert.match(html, /aria-pressed="true">All</);
  assert.match(words, /By member today/);
  assert.match(words, /Answers for no column: Architect\./);
  assert.match(words, /Flow limits Edit At once 2 1 in use · 1 queued Cost per run No limit Bounces 3 at most/);
  // A page of 50 at a time, with what is left
  assert.match(words, /Show 50 more 56 left/);
  assert.match(html, /class="list-more flow-log-more"/);
});

test("a failed run says why in the person's language, keeps the raw error, and offers the retry until one ran", async () => {
  setLanguage('es');
  await i18n.changeLanguage('es');
  const failed = run('7', {
    outcome: 'failed',
    cause: 'no-account',
    error: 'the account hit its rate limit',
    stage: 'refine',
    step: 'check',
    column: 'todo',
    role: 'product-owner',
    agent: 'product-owner',
    retryable: true,
    startedAt: minutesAgo(21),
    endedAt: minutesAgo(20),
  });
  const retried = run('6', {
    outcome: 'failed',
    cause: 'restarts',
    restarts: 2,
    error: 'cut off by a restart (restarts: 2 of 2)',
    role: 'qa',
    agent: 'qa',
    stage: 'verify',
    step: 'verify',
    column: 'in_review',
    startedAt: minutesAgo(40),
    endedAt: minutesAgo(38),
    retriedBy: { id: 'r', state: 'ended', outcome: 'passed', chatId: 'chat-r', queuedAt: minutesAgo(16), endedAt: minutesAgo(12) },
  });
  const gone = run('8', { outcome: 'cancelled', cause: 'item-removed', item: null, chatId: null, startedAt: null, endedAt: minutesAgo(60) });
  const html = wrap(
    <TeamActivityView projectId="p" team={team([member('product-owner'), member('qa')])} flow={FLOW} switcher={null} flowHref="" phone={false} />,
    activityClient([failed, retried, gone]),
  );
  const words = text(html);
  assert.match(words, /Product Owner · comprobación fallida/);
  assert.match(words, /Ninguna cuenta tenía cupo\. Las cuentas llegaron a su límite y no quedaba otra a la que pasar\. La tarea sigue en Por hacer, sin cambios\./);
  assert.match(html, /class="flow-run-raw">the account hit its rate limit</);
  assert.match(html, /flow-run-retry/);
  assert.match(words, /Reintentar/);
  // Retried: what the retry did, leading to its chat, and no second "Reintentar"
  assert.match(words, /Se cortó 3 veces\. Agentry se reinició mientras QA trabajaba/);
  assert.match(html, /href="\/chats\/chat-r"[^>]*>Reintentada: pasó hace 12 min</);
  assert.equal((html.match(/flow-run-retry/g) ?? []).length, 1);
  // A run whose item was deleted: said as gone, and why the run never started
  assert.match(words, /Tarea eliminada/);
  assert.match(words, /No llegó a empezar: se eliminó la tarea mientras esperaba/);
  assert.match(html, /class="badge flow-run-badge badge-bad" data-status="failed"/);
});

test("on a phone a run's whole row opens its chat, the member filter is the header's button, and the foot says what a failure does", () => {
  const failed = run('7', { outcome: 'failed', cause: 'budget', error: 'max budget', startedAt: minutesAgo(3), endedAt: minutesAgo(2), retryable: true });
  const html = wrap(
    <TeamActivityView
      projectId="p"
      team={team([member('developer')])}
      flow={FLOW}
      switcher={null}
      flowHref=""
      phone
      head={(action) => <header className="phone-head">{action}</header>}
    />,
    activityClient([failed]),
  );
  assert.match(html, /<a class="flow-run" aria-label="Developer, implementation of SHOP-7" data-status="failed" href="\/chats\/chat-7"/);
  // Nothing inside the row is a control of its own: no retry, no link to the item
  assert.doesNotMatch(html, /flow-run-retry/);
  assert.doesNotMatch(html, /href="\/tasks\/SHOP-7"/);
  assert.match(html, /aria-label="Filter by member"/);
  assert.match(text(html), /A failed run doesn.+t move the item/);
  assert.match(text(html), /It reached the cost limit\./);
  assert.match(text(html), /1\s?m/);
});

test('a member whose last run failed says so in bad with its reason, above the queue it has, until a later run exists', () => {
  const failed = run('4', { outcome: 'failed', cause: 'no-account', error: 'the account hit its rate limit', stage: 'refine', step: 'check', column: 'todo', role: 'product-owner', agent: 'product-owner' });
  const grid = (m: TeamMember) => wrap(<MemberGrid team={team([m])} memberHref={(agent) => `?member=${agent}`} onAdd={() => {}} />);
  const html = grid(member('product-owner', { lastRun: failed, queued: 1 }));
  assert.match(html, /class="member-now is-failed"/);
  assert.match(text(html), /Failed SHOP-4 no account had quota left/);
  // The phone's cell says the same on its line
  const cells = wrap(<MemberCells team={team([member('product-owner', { lastRun: failed })])} memberHref={(agent) => `?member=${agent}`} />);
  assert.match(cells, /class="member-now-line is-failed"/);
  const retried = member('product-owner', { lastRun: { ...failed, retriedBy: { id: 'r', state: 'queued', outcome: null, chatId: null, queuedAt: minutesAgo(1), endedAt: null } } });
  assert.doesNotMatch(grid(retried), /is-failed/);
});

test('a member at work leads its line with the spinner, then the item, the step verb and what it is on', () => {
  const working = run('9', { state: 'running', outcome: null, endedAt: null, startedAt: minutesAgo(4), activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: minutesAgo(1) } });
  const html = wrap(<MemberGrid team={team([member('developer', { running: [working] })])} memberHref={(agent) => `?member=${agent}`} onAdd={() => {}} />);
  assert.match(html, /class="flow-run-now member-now-ticker"><span class="spinner-glyph flow-run-spin"[^>]*>.<\/span><span class="workitem-key[^"]*"[^>]*>SHOP-9<\/span><span class="flow-run-verb">Implementing<\/span><span class="flow-run-target">pnpm test<\/span>/);
});

test('a role avatar has an 18 px size for chips, a card foot and a column head', () => {
  assert.match(renderToStaticMarkup(<RoleAvatar role="qa" size="xs" />), /class="role-avatar role-avatar-xs"/);
});
