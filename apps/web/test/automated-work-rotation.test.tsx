// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentryEvent, DecisionRecord, FlowRun, ProviderMove, ProviderStatus } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import { NoCounterpartWhy, ProviderChain, useNoCounterpart } from '../src/components/ProviderChain';
import i18n from '../src/i18n';
import { targetMatches, targetsFor } from '../src/lib/events';
import { stripInList, stripTone, workItemStrip } from '../src/lib/work-items';
import { RetirementCard } from '../src/pages/dashboard/RetirementCard';
import { RunWaitWords } from '../src/pages/tasks/board/WorkItemStrip';
import { runChain } from '../src/pages/tasks/item/RunState';

// Phase 4, automated work and Home: a flow run that waits shows its wait on the board and the item, a
// move or a pick made by a decision point carries its mark, a task with no counterpart says so and
// where to fix it, and Home carries the retirement notice.

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: id === 'claude-code' ? 'Claude Code' : 'Codex',
  state: 'ready',
  reason: null,
  version: '2.1.282',
  compatibleRange: '>=2.1 <3',
  binaryPath: '/usr/local/bin/x',
  configHome: null,
  account: null,
  capabilities: [],
  checkedAt: '2026-10-02T10:00:00Z',
  ...over,
});

const move = (over: Partial<ProviderMove> = {}): ProviderMove => ({
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
  toModel: 'gpt-5',
  action: 'handoff',
  state: 'moved',
  decidedBy: 'setting',
  decisionId: null,
  resetsAt: null,
  reason: null,
  updatedAt: '2026-10-02T12:00:00.000Z',
  ...over,
});

const decision = (): DecisionRecord =>
  ({
    id: 'd7',
    point: 'provider.pick',
    kind: 'choose',
    projectId: null,
    subjectKind: 'flow_run',
    subjectId: 'r1',
    provider: 'jev',
    model: 'jev-1',
    mode: 'active',
    status: 'answered',
    unavailable: null,
    state: {},
    questions: [{ kind: 'choice', id: 'provider', question: 'Which provider?', options: [{ id: 'codex', label: 'Codex' }] }],
    answers: { provider: { kind: 'choice', value: 'codex', probabilities: { codex: 0.9 }, confidence: 0.9 } },
    confidence: 0.9,
    threshold: 0.8,
    acted: true,
    visible: true,
    savedRun: false,
    latencyMs: 900,
    inputTokens: 1,
    costUsd: 0.001,
    outcome: null,
    agreed: null,
    resolvedAt: null,
    feedback: null,
    feedbackAt: null,
    openedAt: null,
    paletteAction: null,
    at: '2026-10-02T12:00:00.000Z',
  }) as unknown as DecisionRecord;

const waitingRun = (over: Partial<FlowRun> = {}) =>
  ({
    id: 'r1',
    role: 'developer',
    step: 'work',
    state: 'running',
    startedAt: '2026-10-02T11:00:00.000Z',
    activity: null,
    waiting: { provider: 'claude-code', resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), moveId: 'm1' },
    ...over,
  }) as unknown as FlowRun;

const item = { id: 'i1', status: 'in_progress', activeLink: null, waiting: null, bounces: 0, pullRequest: null } as never;

test('a run that waits for its limit is a warn strip, not a live one, and not in the list\'s Now column', () => {
  const run = waitingRun();
  const strip = workItemStrip(item, { running: new Map([['i1', run]]) });
  assert.equal(strip?.kind, 'run-waiting');
  assert.equal(stripTone(strip!), 'warn');
  assert.equal(stripInList(strip), false);
  assert.equal(workItemStrip(item, { running: new Map([['i1', waitingRun({ waiting: null })]]) })?.kind, 'run');
});

test('the strip words the wait: who is waited for and when it resumes', () => {
  void i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code')]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RunWaitWords wait={{ provider: 'claude-code', resetsAt: null }} />
    </QueryClientProvider>,
  );
  assert.match(html, /Waiting for Claude Code/);
  assert.match(html, /the reset time is not known/);
});

test('the chain of a moved run starts at the chat it left and follows each move', () => {
  const chain = runChain({ id: 'r1' }, [
    move({ id: 'a', fromChat: 'c1', toChat: 'c2', at: '2026-10-02T12:00:00.000Z' }),
    move({ id: 'b', fromChat: 'c2', toChat: 'c3', fromProvider: 'codex', toProvider: 'claude-code', at: '2026-10-02T13:00:00.000Z' }),
    move({ id: 'w', action: 'wait', toChat: null, toProvider: null }),
    move({ id: 'x', subjectId: 'other' }),
  ]);
  assert.deepEqual(chain.map((c) => [c.chatId, c.provider]), [['c1', 'claude-code'], ['c2', 'codex'], ['c3', 'claude-code']]);
  assert.deepEqual(runChain({ id: 'none' }, []), []);
});

test('a chip of the chain carries the mark of the decision that moved work into it', () => {
  void i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code'), status('codex')]);
  client.setQueryData(keys.providerMoves('recent'), [move({ decisionId: 'd7' })]);
  client.setQueryData(keys.decision('d7'), decision());
  const chain = [
    { chatId: 'c1', provider: 'claude-code' },
    { chatId: 'c2', provider: 'codex' },
  ];
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProviderChain chain={chain} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  assert.match(html, /data-decision="d7"/);
  assert.match(html, /decided/);
  // No decision, no mark
  const plain = new QueryClient();
  plain.setQueryData(keys.providers, [status('claude-code'), status('codex')]);
  plain.setQueryData(keys.providerMoves('recent'), [move()]);
  const without = renderToStaticMarkup(
    <QueryClientProvider client={plain}>
      <MemoryRouter>
        <ProviderChain chain={chain} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  assert.doesNotMatch(without, /data-decision/);
});

function Probe({ moveId }: { moveId: string }) {
  const found = useNoCounterpart({ moveId });
  return <span>{found ? `no counterpart on ${found.provider}` : 'limit'}</span>;
}

test('a wait whose move found no counterpart says so, and where to choose one, in both languages', async () => {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code'), status('codex')]);
  client.setQueryData(keys.providerMoves('waiting'), [move({ id: 'm1', action: 'wait', toChat: null, toProvider: null, state: 'waiting', reason: 'no counterpart is mapped for its model on codex' }), move({ id: 'm2', action: 'wait', reason: null })]);
  const render = (id: string) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Probe moveId={id} />
      </QueryClientProvider>,
    );
  assert.match(render('m1'), /no counterpart on codex/);
  assert.match(render('m2'), /limit/);
  for (const [lang, said, link] of [['en', /Opus has no counterpart on Codex/, /Choose the counterpart/], ['es', /Opus no tiene equivalente en Codex/, /Elegir el equivalente/]] as const) {
    await i18n.changeLanguage(lang);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <NoCounterpartWhy provider="codex" model="Opus" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    assert.match(html, said);
    assert.match(html, link);
    assert.match(html, /href="\/settings\?tab=providers"/);
  }
});

test('a move or a wait refreshes the moves and the runs of every item that is open', () => {
  const events = [
    { type: 'run.providerMoved', runId: 'c1', from: 'claude-code', to: 'codex', action: 'handoff', decidedBy: 'setting' },
    { type: 'run.limitWaiting', runId: 'c1' },
  ] as unknown as AgentryEvent[];
  for (const event of events) {
    const targets = targetsFor(event);
    assert.ok(targets.some((t) => targetMatches(t, keys.providerMoves('project:p1'))), `${event.type} moves`);
    assert.ok(targets.some((t) => targetMatches(t, keys.workItemRuns('i1'))), `${event.type} runs`);
    assert.ok(targets.some((t) => targetMatches(t, keys.workItemBoards('p1'))), `${event.type} board`);
  }
});

const home = (notice: unknown, account: string | null) => {
  const client = new QueryClient();
  client.setQueryData(keys.cswapRetirement, { notice });
  client.setQueryData(keys.providers, [status('claude-code', { account })]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <RetirementCard />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

test('Home carries the retirement notice, compact, with the account kept, in both languages', async () => {
  await i18n.changeLanguage('en');
  const html = home({ found: ['accounts'], managedCopy: false, policyProjects: [] }, 'ana@example.com');
  assert.match(html, /Agentry no longer switches Claude accounts/);
  assert.match(html, /Claude Code keeps using ana@example.com/);
  assert.match(html, /Understood/);
  assert.match(html, /href="\/settings\?tab=providers"[^>]*>See what changes/);
  await i18n.changeLanguage('es');
  const es = home({ found: ['accounts'], managedCopy: false, policyProjects: [] }, 'ana@example.com');
  assert.match(es, /Entendido/);
  assert.match(es, /Ver qué cambia/);
  assert.match(es, /sigue con ana@example.com/);
  // Dismissed, or nothing to say: no card
  assert.doesNotMatch(home(null, null), /retire-home/);
});
