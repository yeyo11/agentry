// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MergeState, WorkItem } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import i18n from '../src/i18n';
import { WorkItemCard } from '../src/pages/tasks/board/WorkItemCard';

// The board card's "auto-merge on" badge (DesktopTableroFusion): shown once the host says it is armed

const item = (): WorkItem => ({
  id: 'i1',
  projectId: 'p1',
  number: 1,
  key: 'AGN-1',
  type: 'task',
  title: 'Item one',
  description: '',
  status: 'in_review',
  priority: 'medium',
  labels: [],
  assignee: null,
  epicId: null,
  milestoneId: null,
  acceptanceCriteria: [],
  relations: [],
  rank: 'a',
  worktree: null,
  branch: null,
  createdAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:00Z',
  closedAt: null,
  waiting: 'merge',
  pullRequest: {
    id: 'cr1',
    phase: 'open',
    number: 12,
    url: 'https://gitlab.com/acme/shop/-/merge_requests/12',
    branch: 'task/agn-1',
    base: 'main',
    ci: 'pending',
    conflicts: [],
    error: null,
    openedAt: null,
    closedAt: null,
    checkedAt: null,
  },
});

const state = (armed: boolean): MergeState => ({
  changeRequestId: 'cr1',
  host: 'github',
  headSha: 'abc',
  methods: ['squash'],
  defaultMethod: 'squash',
  deleteBranchDefault: false,
  canMerge: false,
  blocker: null,
  others: [],
  warning: null,
  autoMerge: { available: !armed, reason: null, armed, method: armed ? 'squash' : null, armedBy: null, armedAt: null },
  waitingForPipeline: false,
  canRebaseOnHost: false,
  readAt: '2026-09-28T10:00:00Z',
});

function card(merge: MergeState | null) {
  const client = new QueryClient();
  if (merge) client.setQueryData(keys.changeRequestMerge('cr1'), merge);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <WorkItemCard item={item()} live={{ chats: [], orchestrations: [] }} onOpen={() => {}} />
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('a card whose request has auto-merge armed says so in a badge and in words', async () => {
  await i18n.changeLanguage('en');
  const html = card(state(true));
  assert.match(html, /workitem-strip-auto/);
  assert.match(html, /auto-merge on/);
  assert.match(html, /merges on its own once the checks pass · squash/);
  await i18n.changeLanguage('es');
  assert.match(card(state(true)), /fusión automática/);
  await i18n.changeLanguage('en');
});

test('a card says nothing of auto-merge while it is off or not yet read', () => {
  assert.doesNotMatch(card(state(false)), /workitem-strip-auto/);
  assert.doesNotMatch(card(null), /workitem-strip-auto/);
});
