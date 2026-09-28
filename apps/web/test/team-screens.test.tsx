// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun, FlowRunPage, Project, Team, TeamMember } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '../src/components/controls/Tooltip';
import { ConfirmProvider } from '../src/components/Dialog';
import { ToastProvider } from '../src/components/Toast';
import { DirtyProvider } from '../src/lib/dirty';
import i18n from '../src/i18n';
import { TeamActivityView } from '../src/pages/team/Activity';
import { FlowEditor } from '../src/pages/team/Flow';
import { MemberPage } from '../src/pages/team/Member';
import { MemberGrid } from '../src/pages/team/Members';
import { TeamActivity } from '../src/pages/team/parts';

// The Team screens of orchestration 6's gaps: the Flow screen's limits (5), the team's whole
// activity (6), a member's shell commands (7) and the template's responsibilities in the person's
// language (14).

const project: Project = { id: 'p', name: 'shop', path: '/tmp/shop', worktrees: [], exists: true, chatCount: 0, lastActivity: null, key: 'SHOP', modules: ['team'] };

const run = (id: string, over: Partial<FlowRun> = {}): FlowRun => ({
  id,
  projectId: 'p',
  itemId: `i-${id}`,
  item: { id: `i-${id}`, key: `SHOP-${id}`, title: `Item ${id}`, type: 'task', status: 'in_progress' },
  role: 'developer',
  agent: 'developer',
  model: 'sonnet',
  stage: 'work',
  column: 'in_progress',
  state: 'ended',
  chatId: `chat-${id}`,
  outcome: 'passed',
  summary: null,
  error: null,
  restarts: 0,
  queuedAt: '2026-09-27T10:00:00.000Z',
  startedAt: '2026-09-27T10:00:00.000Z',
  endedAt: '2026-09-27T10:05:00.000Z',
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

// A data router, since the dirty guard of the Flow and member screens blocks navigation with it
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

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('the Flow screen edits how many runs go at once and what one may spend, with no limit by default', () => {
  // Both were only reachable through the settings document
  const flow = { enabled: true, columns: { in_progress: 'developer' }, maxBounces: 3 };
  const html = wrap(<FlowEditor project={project} team={team([member('developer')])} flow={flow} proposal={null} switcher={null} />);
  assert.match(text(html), /Limits/);
  assert.match(html, /aria-label="Runs at once"[^>]*value="2"/);
  assert.match(html, /placeholder="No limit"[^>]*aria-label="Spend per run, in USD"[^>]*value=""/);
  const limited = wrap(<FlowEditor project={project} team={team([member('developer')])} flow={{ ...flow, maxParallel: 4, maxCostUsd: 1.5 }} proposal={null} switcher={null} />);
  assert.match(limited, /aria-label="Runs at once"[^>]*value="4"/);
  assert.match(limited, /aria-label="Spend per run, in USD"[^>]*value="1.5"/);
});

test("the team's activity card leads to every run, and the whole view lists them with their state and pages on", () => {
  // "See all" had no route to go to
  const card = wrap(<TeamActivity runs={[run('1')]} allHref="?view=team&section=activity" />);
  assert.match(card, /href="\/\?view=team&amp;section=activity"[^>]*>See all</);

  const client = new QueryClient();
  const page: FlowRunPage = {
    runs: [run('3', { state: 'running', outcome: null, endedAt: null }), run('2', { outcome: 'failed', error: 'the account hit its rate limit' }), run('1')],
    total: 60,
    nextCursor: 'c1',
  };
  client.setQueryData(keys.flowRuns('p', {}), { pages: [page], pageParams: [''] });
  const html = wrap(<TeamActivityView projectId="p" team={team([member('developer'), member('qa')])} backHref="?view=team" phone={false} />, client);
  const words = text(html);
  // Newest first, each with its state in words, the failed one in the bad colour with why
  assert.ok(words.indexOf('SHOP-3') < words.indexOf('SHOP-2') && words.indexOf('SHOP-2') < words.indexOf('SHOP-1'));
  assert.match(words, /SHOP-3 Item 3 running/);
  assert.match(html, /class="team-run-status text-err">failed</);
  assert.match(words, /the account hit its rate limit/);
  assert.match(words, /SHOP-1 Item 1 worked/);
  // The live one carries the rail; the count is every run, and the rest load a page at a time
  assert.equal((html.match(/live-rail/g) ?? []).length, 1);
  assert.match(words, /60 runs/);
  assert.match(words, /Load more · 57 left/);
  // Filters by member and by state, with the controls of the design system
  assert.match(html, /aria-label="Member"/);
  assert.match(html, /aria-label="State"/);
  assert.match(html, /href="\/chats\/chat-2"/);
});

test("a member's shell commands are edited on its page, and a list is shown as its patterns", () => {
  // The route kept `commands`, but nothing in the interface set or showed it
  const limited = member('developer', { commands: ['pnpm test', 'pnpm build *'] });
  const html = wrap(<MemberPage project={project} member={limited} backHref="?view=team" />);
  const words = text(html);
  assert.match(words, /Shell commands/);
  assert.match(html, /aria-checked="true"[^>]*><span[^>]*><\/span><span class="segment-label">These commands</);
  assert.match(words, /pnpm test/);
  assert.match(words, /pnpm build \*/);
  const any = wrap(<MemberPage project={project} member={member('qa')} backHref="?view=team" />);
  assert.match(any, /aria-checked="true"[^>]*><span[^>]*><\/span><span class="segment-label">Any</);
});

test("a responsibility still the template's reads in the person's language, and an edited one as written", async () => {
  // Core writes the template's English into the metadata, which showed in English in Spanish
  await i18n.changeLanguage('es');
  const members = [
    member('developer', { responsibility: 'Implements work items in their own worktree' }),
    member('qa', { responsibility: 'Checks the cart by hand' }),
  ];
  const words = text(wrap(<MemberGrid team={team(members)} memberHref={(agent) => `?member=${agent}`} onAdd={() => {}} />));
  assert.match(words, /Implementa las tareas en su propio worktree/);
  assert.doesNotMatch(words, /Implements work items/);
  assert.match(words, /Checks the cart by hand/);
});
