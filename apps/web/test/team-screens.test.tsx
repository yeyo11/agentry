// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowRun, Project, Team, TeamMember } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '../src/components/controls/Tooltip';
import { ConfirmProvider } from '../src/components/Dialog';
import { ToastProvider } from '../src/components/Toast';
import { DirtyProvider } from '../src/lib/dirty';
import i18n from '../src/i18n';
import { workItemStrip } from '../src/lib/work-items';
import { WorkItemStrip } from '../src/pages/tasks/board/WorkItemStrip';
import { MemberPage } from '../src/pages/team/Member';
import { MemberGrid } from '../src/pages/team/Members';

// The Team screens of orchestration 6's gaps: a member's shell commands (7), the template's
// responsibilities in the person's language (14) and the live line. The Flow limits and Team
// activity, as the design review redrew them, are in team-design.test.tsx.

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

test("a member at work says its verb and how long it has gone, the time kept on the verb's line", () => {
  // The live line had no time before the chat reported an activity, and wrapped it on a narrow card
  const started = new Date(Date.now() - 252_000).toISOString();
  const working = member('developer', { running: [run('9', { state: 'running', outcome: null, startedAt: started, endedAt: null })] });
  const html = wrap(<MemberGrid team={team([working])} memberHref={(agent) => `?member=${agent}`} onAdd={() => {}} />);
  // The step's verb (not the chat's tool verb), then the clock at the end of the line
  assert.match(html, /class="flow-run-verb">Implementing<\/span><\/span><time class="team-live-time">4:1[23]</);
  assert.equal((html.match(/live-rail/g) ?? []).length, 1);
});

test('a card a Product Owner refines or QA verifies is live, and says which with the stage verb, by its column', () => {
  // Core only counted `work` links as live; now `refine` and `verify` ones are, and the card said "Working"
  const link = (role: 'refine' | 'verify' | 'work') => ({
    id: `l-${role}`,
    itemId: 'i',
    kind: 'chat' as const,
    role,
    chatId: 'c1',
    orchestrationId: null,
    taskId: null,
    teamRole: role === 'verify' ? 'qa' : 'product-owner',
    chatState: 'working' as const,
    createdAt: '2026-09-28T10:00:00.000Z',
  });
  const sources = { chats: [], orchestrations: [] };
  const words = (role: 'refine' | 'verify' | 'work', status: 'backlog' | 'todo' | 'in_progress' | 'in_review') => {
    const item = { id: 'i', key: 'SHOP-1', status, activeLink: link(role) };
    return text(wrap(<WorkItemStrip item={item} strip={workItemStrip(item)} sources={sources} />));
  };
  assert.match(words('refine', 'backlog'), /PO.*Refining/);
  // In To do the Product Owner only checks the item is ready
  assert.match(words('refine', 'todo'), /PO.*Checking/);
  assert.match(words('verify', 'in_review'), /QA.*Verifying/);
  assert.match(words('work', 'in_progress'), /Implementing/);
});

