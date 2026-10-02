// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, FlowRun, ProviderLimit, ProviderMove, ProviderStatus } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { keys } from '../src/api';
import { ProviderChain, WaitLine } from '../src/components/ProviderChain';
import { ProviderDots } from '../src/components/shell/ProviderDots';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { decisionsOn } from '../src/lib/orchestration-board';
import { activityOf, movedRunsOf } from '../src/pages/tasks/item/model';
import { failureReason } from '../src/pages/tasks/item/runs';

// Phase 4 of the providers plan, in the places automated work and the shell say it: the strip a
// provider's limit takes in the status bar, the chain and the wait of a task, the item's activity
// when a run moved, and the words of the two new causes.

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Copilot',
  state: 'ready',
  reason: null,
  version: '2.1.282',
  compatibleRange: '>=2.1 <3',
  binaryPath: '/usr/local/bin/x',
  configHome: null,
  account: null,
  capabilities: ['rateLimitWindows'],
  checkedAt: '2026-10-02T10:00:00Z',
  ...over,
});

const limit = (provider: string, over: Partial<ProviderLimit> = {}): ProviderLimit => ({
  provider,
  state: 'ok',
  window: '5h',
  utilization: 0.45,
  resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
  windows: {},
  observedAt: new Date(Date.now() - 120_000).toISOString(),
  source: 'stream',
  ...over,
});

const bar = (statuses: ProviderStatus[], limits: ProviderLimit[], lang: 'en' | 'es' = 'en') => {
  void i18n.changeLanguage(lang);
  const client = new QueryClient();
  client.setQueryData(keys.providers, statuses);
  client.setQueryData(keys.providerSettings, {
    providers: Object.fromEntries(statuses.map((s) => [s.id, { enabled: true, binaryPath: null }])),
    order: statuses.map((s) => s.id),
    defaultProvider: null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ProviderDots limits={limits} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

test('the status bar shows a provider with a limit reading as a bar and a figure, neutral below 60 %', () => {
  const html = bar([status('claude-code')], [limit('claude-code')]);
  assert.match(html, /Claude Code 2\.1\.282/);
  assert.match(html, /45 %/);
  assert.doesNotMatch(html, /is-warn|is-bad|statusbar-warn|statusbar-bad/);
});

test('near its limit the word comes with the colour, and exhausted says when it comes back', () => {
  const near = bar([status('claude-code', { state: 'degraded', reason: 'limit-near' })], [limit('claude-code', { state: 'near', utilization: 0.72 })]);
  assert.match(near, /Claude Code · limit/);
  assert.match(near, /statusbar-warn/);
  assert.match(near, /72 %/);
  // 72 % is warn, not bad: the bar turns bad from 75 %
  assert.match(near, /meter-fill is-warn/);
});

test('an exhausted provider shows the word, no bar and its reset', () => {
  const html = bar([status('codex', { state: 'degraded', reason: 'limit-reached' })], [limit('codex', { state: 'exhausted', utilization: 1 })]);
  assert.match(html, /Codex · limit reached/);
  assert.match(html, /statusbar-bad/);
  assert.match(html, /statusbar-age/);
  assert.doesNotMatch(html, /meter-track/);
  assert.match(bar([status('codex', { state: 'degraded', reason: 'limit-reached' })], [limit('codex', { state: 'exhausted', utilization: 1 })], 'es'), /Codex · límite agotado/);
  void i18n.changeLanguage('en');
});

test('a provider with no reading, or a stale one, shows no limit at all', () => {
  const html = bar([status('copilot', { capabilities: [] }), status('claude-code')], [limit('claude-code', { state: 'unknown' })]);
  assert.doesNotMatch(html, /meter-track|statusbar-age| %/);
});

test('the chain of a task is one chip per chat, the newest marked, each opening its chat', () => {
  void i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code'), status('codex')]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProviderChain
          chain={[
            { chatId: 'c1', provider: 'claude-code' },
            { chatId: 'c2', provider: 'codex' },
          ]}
          how="moved · handoff"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  assert.match(html, /href="\/chats\/c1"/);
  assert.match(html, /chain-chip now"[^>]*aria-label="Open the chat on Codex"|aria-label="Open the chat on Codex"[^>]*>/);
  assert.equal((html.match(/class="chain-chip/g) ?? []).length, 2);
  assert.equal((html.match(/chain-chip now/g) ?? []).length, 1);
  assert.match(html, /moved · handoff/);
});

test('a wait says who is waited for and when it resumes, in words, without anything moving', () => {
  void i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code')]);
  const known = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WaitLine wait={{ provider: 'claude-code', resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() }} why="why" />
    </QueryClientProvider>,
  );
  assert.match(known, /role="status"/);
  assert.match(known, /Waiting for Claude Code/);
  assert.match(known, /resumes at/);
  assert.doesNotMatch(known, /spinner|shimmer/);
  const unknown = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WaitLine wait={{ provider: 'claude-code', resetsAt: null }} />
    </QueryClientProvider>,
  );
  assert.match(unknown, /the reset time is not known/);
});

test('a task waiting for a reset has no worker to nudge', () => {
  const task = { id: 't1', status: 'running', waiting: { provider: 'claude-code', resetsAt: null, moveId: 'm1' } } as never;
  const orch = { status: 'running', engine: 'graph' } as never;
  assert.equal(decisionsOn(orch, task).hint, false);
  assert.equal(decisionsOn(orch, { id: 't1', status: 'running' } as never).hint, true);
});

const run = (id: string, over: Partial<FlowRun> = {}): FlowRun => ({ id, role: 'developer', state: 'running', ...over }) as FlowRun;
const move = (over: Partial<ProviderMove>): ProviderMove => ({
  id: 'm1',
  at: '2026-10-02T12:00:00.000Z',
  subjectKind: 'flow_run',
  subjectId: 'r1',
  projectId: 'p1',
  fromChat: 'c1',
  toChat: 'c2',
  fromProvider: 'claude-code',
  toProvider: 'codex',
  fromModel: null,
  toModel: null,
  action: 'handoff',
  state: 'moved',
  decidedBy: 'setting',
  decisionId: null,
  resetsAt: null,
  reason: null,
  updatedAt: '2026-10-02T12:00:00.000Z',
  ...over,
});

test("an item's activity says that a run moved, and ignores waits and moves of other work", () => {
  const runs = [run('r1')];
  const moves = [
    move({}),
    move({ id: 'm2', action: 'wait', toChat: null, toProvider: null, state: 'waiting' }),
    move({ id: 'm3', subjectId: 'other' }),
    move({ id: 'm4', subjectKind: 'task' }),
  ];
  const moved = movedRunsOf(runs, moves);
  assert.deepEqual(moved.map((m) => m.move.id), ['m1']);
  const entries = activityOf([], [], 'all', [], moved);
  assert.deepEqual(entries.map((e) => e.kind), ['moved']);
  // Comments filter hides it, like the rest of the history
  assert.equal(activityOf([], [], 'comments', [], moved).length, 0);
});

test('the two new causes are worded in both languages, for the item and the board', () => {
  for (const cause of ['no-provider', 'limit-wait-expired'] as const) {
    const reason = failureReason({ state: 'ended', outcome: 'failed', cause, restarts: 0, stage: 'work', column: 'in_progress' } as never);
    assert.equal(reason?.key, `run.cause.${cause}`);
    for (const lang of [en, es]) {
      assert.equal(typeof (lang.workItem.run.cause as Record<string, string>)[cause], 'string', `workItem ${cause}`);
      assert.equal(typeof (lang.tasks.strip.cause as Record<string, string>)[cause], 'string', `tasks ${cause}`);
      assert.equal(typeof (lang.team.cause as unknown as Record<string, { title: string }>)[cause]?.title, 'string', `team ${cause}`);
    }
  }
});

test('a move and a wait are worded in the notifications, in the active language', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
  const { notificationsFor } = await import('../src/lib/notifications-model.ts');
  await i18n.changeLanguage('en');
  const base = { id: 1, at: '2026-10-02T12:00:00Z', runId: 'r', runName: 'copy', sessionId: null, orchestrationId: null, internal: false };
  const moved = notificationsFor({ type: 'run.providerMoved', ...base, title: 'copy moved to Codex', from: 'claude-code', to: 'codex', action: 'handoff', decidedBy: 'setting' } as AgentryEvent);
  assert.equal(moved[0]?.body, 'It went on from a record of what was done.');
  const waiting = notificationsFor({ type: 'run.limitWaiting', ...base, title: 'copy waits', provider: 'claude-code', resetsAt: null } as AgentryEvent);
  assert.equal(waiting[0]?.body, 'It goes on when the limit resets; no reset time is known.');
  await i18n.changeLanguage('es');
  const movedEs = notificationsFor({ type: 'run.providerMoved', ...base, title: 'copy', from: 'claude-code', to: 'codex', action: 'restart', decidedBy: 'setting' } as AgentryEvent);
  assert.equal(movedEs[0]?.body, 'Ha empezado de nuevo con su prompt original.');
  await i18n.changeLanguage('en');
});
