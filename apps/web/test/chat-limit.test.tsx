// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat, Execution, FlowRun, WorkItemDetail, ProviderCandidates, ProviderLimit, ProviderMove, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { ChatUiProvider, type ChatUiConfig } from '@agentry/chat-ui/lib/context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@agentry/ui/components/controls';
import { ToastProvider } from '@agentry/ui/components/Toast';
import { keys } from '../src/api';
import i18n from '../src/i18n';
import { ContinuedDivider, ContinuedFrom, HandoffCard, LimitStopped } from '../src/pages/chat/HandoffCard';
import { LimitBadge } from '../src/pages/chat/LimitBadge';
import { FlowMovedNote, chainOfMoves } from '../src/pages/chat/FlowMoved';
import { BlockedComposer, LimitBanner, limitPhase, type LimitState } from '../src/pages/chat/LimitBanner';
import { UsageMeter } from '../src/pages/chat/MoveSheet';

// The chat package is compiled with the classic runtime here, so its context needs `React` in scope
(globalThis as { React?: typeof React }).React = React;

const FUTURE = '2099-01-01T14:05:00Z';

const execution = (over: Partial<Execution> = {}): Execution => ({
  id: 'e1',
  startedAt: '2026-10-02T10:00:00Z',
  endedAt: '2026-10-02T11:55:00Z',
  outcome: 'failed',
  error: null,
  permissionMode: 'bypassPermissions',
  model: 'opus',
  maxBudgetUsd: null,
  costUsd: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  turns: 1,
  ...over,
});

const chat = (over: Partial<Chat> = {}): Chat =>
  ({
    id: 'c-old-1',
    title: 'Review the PWA',
    provider: 'claude-code',
    providerSessionId: null,
    firstPrompt: 'Review the PWA and the desktop app',
    model: 'opus',
    cwd: '/work/wrapper',
    state: 'idle',
    execution: null,
    executions: [execution()],
    continuedFrom: null,
    continuedIn: null,
    updatedAt: '2026-10-02T11:55:00Z',
    ...over,
  }) as unknown as Chat;

const limit = (over: Partial<ProviderLimit> = {}): ProviderLimit => ({
  provider: 'claude-code',
  state: 'exhausted',
  window: '5h',
  utilization: 1,
  resetsAt: FUTURE,
  windows: {},
  observedAt: '2026-10-02T11:54:00Z',
  source: 'stream',
  ...over,
});

const status = (id: string, label: string, over: Partial<ProviderStatus> = {}): ProviderStatus =>
  ({ id, label, state: 'ready', reason: null, version: '1', compatibleRange: '*', binaryPath: null, configHome: null, account: null, capabilities: [], ...over }) as ProviderStatus;

const wait = (over: Partial<ProviderMove> = {}): ProviderMove => ({
  id: 'm1',
  at: 't',
  subjectKind: 'chat',
  subjectId: 'c-old-1',
  projectId: null,
  fromChat: 'c-old-1',
  toChat: null,
  fromProvider: 'claude-code',
  toProvider: null,
  fromModel: 'opus',
  toModel: null,
  action: 'wait',
  state: 'waiting',
  decidedBy: 'person',
  decisionId: null,
  resetsAt: FUTURE,
  reason: null,
  updatedAt: 't',
  ...over,
});

const claude = status('claude-code', 'Claude Code', { limit: limit() });
const codex = status('codex', 'Codex');

const settings = (action: 'handoff' | 'restart' | 'wait'): ProvidersSettings =>
  ({
    providers: {},
    order: ['claude-code', 'codex'],
    defaultProvider: null,
    rotation: { onLimit: { action, allowed: [action, 'wait'], maxWaitHours: 6, maxMoves: 2 }, modelMap: [] },
  }) as unknown as ProvidersSettings;

const candidates: ProviderCandidates = {
  candidates: [{ provider: 'codex', model: 'gpt-6.1-sol', utilization: 0.34, resetsAt: null }],
  excluded: [{ provider: 'copilot', excluded: 'not-ready' }],
  movesCapped: false,
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('a chat is at its limit only when the reading says so, it is not working and its last turn did not finish', () => {
  assert.equal(limitPhase(chat(), claude, null), 'limit');
  assert.equal(limitPhase(chat({ state: 'working' }), claude, null), 'none');
  assert.equal(limitPhase(chat({ executions: [execution({ outcome: 'completed' })] }), claude, null), 'none');
  assert.equal(limitPhase(chat(), status('claude-code', 'Claude Code', { limit: limit({ state: 'near' }) }), null), 'none');
  assert.equal(limitPhase(chat(), status('claude-code', 'Claude Code', { limit: limit({ state: 'unknown' }) }), null), 'none');
  assert.equal(limitPhase(chat(), status('claude-code', 'Claude Code', { limit: limit({ resetsAt: '2020-01-01T00:00:00Z' }) }), null), 'none');
  assert.equal(limitPhase(chat(), undefined, null), 'none');
});

test("the server's own fact that the turn died on the limit wins over a reading taken since", () => {
  // A detection or another chat refreshed the reading after this turn ended: the reading alone would hide it
  const later = status('claude-code', 'Claude Code', { limit: limit({ observedAt: '2099-01-01T00:00:00Z' }) });
  assert.equal(limitPhase(chat(), later, null), 'none');
  assert.equal(limitPhase(chat({ atLimit: true }), later, null), 'limit');
  assert.equal(limitPhase(chat({ atLimit: true }), undefined, null), 'limit');
  assert.equal(limitPhase(chat({ atLimit: true, state: 'working' }), claude, null), 'none');
});

test('an open wait is the waiting phase, and a chat that moved on shows no limit at all', () => {
  assert.equal(limitPhase(chat(), claude, wait()), 'waiting');
  assert.equal(limitPhase(chat({ state: 'working' }), claude, wait()), 'waiting');
  const next = { chatId: 'e3d8a1', provider: 'codex', action: 'handoff' as const, at: '2026-10-02T11:58:00Z', moveId: 'm2' };
  assert.equal(limitPhase(chat({ continuedIn: next }), claude, null), 'none');
  assert.equal(limitPhase(chat({ continuedIn: next }), claude, wait()), 'none');
});

function render(page: React.ReactNode, client: QueryClient): string {
  const config = { client: {}, agentNameFor: () => 'x', fallbackInterval: false, paths: { chat: (id: string) => `/chats/${id}`, chatChangeStep: () => '' }, slots: {} } as unknown as ChatUiConfig;
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <TooltipProvider>
          <ToastProvider>
            <ChatUiProvider value={config}>{page}</ChatUiProvider>
          </ToastProvider>
        </TooltipProvider>
      ),
    },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function seeded(action: 'handoff' | 'restart' | 'wait' = 'handoff', over: Partial<ProviderCandidates> = {}): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [claude, codex, status('copilot', 'GitHub Copilot')]);
  client.setQueryData(keys.providerSettings, settings(action));
  client.setQueryData(keys.providerCandidates('c-old-1'), { ...candidates, ...over });
  return client;
}

const state = (phase: LimitState['phase'], wt: ProviderMove | null = null): LimitState => ({ phase, status: claude, wait: wt, resetsAt: wt?.resetsAt ?? FUTURE });

test('at a limit the banner names the window and the reset, offers the feasible actions and lists what is not offered', () => {
  const html = render(<LimitBanner chat={chat()} state={state('limit')} />, seeded());
  const words = text(html);
  assert.match(words, /Claude Code reached its 5 h limit/);
  assert.match(words, /Resets/);
  assert.match(words, /Continue on Codex/);
  assert.match(words, /Start over on Codex/);
  assert.match(words, /Wait for the reset/);
  assert.match(words, /See the handoff/);
  // An excluded provider is listed with its reason in words, never a wire identifier
  assert.match(words, /GitHub Copilot not signed in, or not installed on this computer/);
  assert.doesNotMatch(words, /not-ready/);
  // Nothing animates and nothing is sent without a click
  assert.doesNotMatch(html, /spinner|shimmer|energy/);
});

test("the setting's action is the zone's one primary", () => {
  const primaries = (html: string) => [...html.matchAll(/<button[^>]*class="btn btn-primary"[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1] ?? '').trim());
  assert.deepEqual(primaries(render(<LimitBanner chat={chat()} state={state('limit')} />, seeded('handoff'))), ['Continue on Codex']);
  assert.deepEqual(primaries(render(<LimitBanner chat={chat()} state={state('limit')} />, seeded('restart'))), ['Start over on Codex']);
  assert.deepEqual(primaries(render(<LimitBanner chat={chat()} state={state('limit')} />, seeded('wait'))), ['Wait for the reset']);
});

test('with no candidate, or once the moves cap is reached, the only way on is to wait, and the banner says why', () => {
  const none = text(render(<LimitBanner chat={chat()} state={state('limit')} />, seeded('handoff', { candidates: [], excluded: [{ provider: 'codex', excluded: 'no-mapping' }] })));
  assert.doesNotMatch(none, /Continue on|Start over on|See the handoff/);
  assert.match(none, /Wait for the reset/);
  assert.match(none, /Codex no counterpart is set for this chat&#x27;s model Set the counterpart/);
  const capped = text(render(<LimitBanner chat={chat()} state={state('limit')} />, seeded('handoff', { movesCapped: true })));
  assert.doesNotMatch(capped, /Continue on/);
  assert.match(capped, /as many times as the settings allow/);
});

test('a waiting chat says what it waits for, offers Move now and Stop waiting, and has no primary action', () => {
  const html = render(<LimitBanner chat={chat()} state={state('waiting', wait())} />, seeded());
  const words = text(html);
  assert.match(words, /Waiting for Claude Code/);
  assert.match(words, /Then your last message is sent again in this same chat/);
  assert.match(words, /Move now/);
  assert.match(words, /Stop waiting/);
  assert.doesNotMatch(html, /btn-primary/);
});

test('a chat that is not at a limit draws no banner', () => {
  assert.doesNotMatch(render(<LimitBanner chat={chat()} state={state('none')} />, seeded()), /class="lim"/);
});

test('the box under the banner says why a message cannot be typed', () => {
  const says = (c: Chat, s: LimitState) => /placeholder="([^"]*)"/.exec(render(<BlockedComposer chat={c} state={s} />, seeded()))?.[1];
  assert.equal(says(chat(), state('limit')), 'Choose what to do with this chat to go on');
  assert.equal(says(chat(), state('waiting', wait())), 'This chat waits for Claude Code&#x27;s reset');
  const next = { chatId: 'e3d8a1', provider: 'codex', action: 'handoff' as const, at: '2026-10-02T11:58:00Z', moveId: 'm2' };
  assert.equal(says(chat({ continuedIn: next }), state('none')), 'This chat went on in Codex');
});

test('the old chat ends with a divider linking to the new one; the new one has a header link and a collapsed handoff', () => {
  const client = seeded();
  const next = { chatId: 'e3d8a1', provider: 'codex', action: 'handoff' as const, at: '2026-10-02T11:58:00Z', moveId: 'm2' };
  const divider = render(<ContinuedDivider chat={chat({ continuedIn: next })} />, client);
  assert.match(divider, /href="\/chats\/e3d8a1"/);
  assert.match(text(divider), /Continued on Codex in «e3d8a1»/);
  assert.match(text(divider), /e3d8a1 · with a handoff/);
  assert.match(divider, /aria-label="Continued on Codex, chat e3d8a1"/);
  assert.doesNotMatch(render(<ContinuedDivider chat={chat()} />, client), /cont-div/);

  const prev = { chatId: 'c-old-1', provider: 'claude-code', action: 'handoff' as const, at: '2026-10-02T11:58:00Z', moveId: 'm2' };
  const fresh = chat({ id: 'e3d8a1', provider: 'codex', model: 'gpt-6.1-sol', continuedFrom: prev });
  const header = render(<ContinuedFrom chat={fresh} />, client);
  assert.match(text(header), /Continued from Claude Code/);
  assert.match(header, /href="\/chats\/c-old-1"/);
  assert.doesNotMatch(render(<ContinuedFrom chat={chat()} />, client), /cont-from/);

  const card = render(<HandoffCard chat={fresh} text={'You are taking over a task.\n## What was asked\nReview the PWA'} />, client);
  assert.match(text(card), /Handoff from Claude Code/);
  assert.match(text(card), /sent to gpt-6\.1-sol/);
  assert.match(card, /aria-expanded="false"/);
  // Collapsed: the text itself is not in the page until it is opened
  assert.doesNotMatch(card, /Review the PWA/);
});

test('the line where the old chat stopped says which provider and when, and no time while it waits', () => {
  const client = seeded();
  assert.match(text(render(<LimitStopped chat={chat()} at="2026-10-02T11:55:00Z" />, client)), /Claude Code stopped: it reached its limit\. \d\d:\d\d/);
  assert.doesNotMatch(text(render(<LimitStopped chat={chat()} at="2026-10-02T11:55:00Z" waiting />, client)), /\d\d:\d\d/);
});

test('the copy of the chat at a limit exists in Spanish, once per key, with the same placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const flat = (o: Record<string, unknown>, at = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${at}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const es = new Map(flat((i18n.getResourceBundle('es', 'chats') as { limit: Record<string, unknown> }).limit));
  for (const [key, value] of flat((i18n.getResourceBundle('en', 'chats') as { limit: Record<string, unknown> }).limit)) {
    const other = es.get(key);
    assert.ok(other, `es limit.${key}`);
    assert.equal(holes(value), holes(other), key);
  }
});

test('a chat whose last turn ended before the reading was taken is not at that limit, nor is one that has no end', () => {
  const at = (endedAt: string | null) => chat({ executions: [execution({ endedAt })] });
  assert.equal(limitPhase(at('2026-10-02T11:55:00Z'), claude, null), 'limit');
  // An old failure of an idle chat, on a provider another chat found exhausted since
  assert.equal(limitPhase(at('2026-10-02T09:00:00Z'), claude, null), 'none');
  assert.equal(limitPhase(at(null), claude, null), 'none');
});

test('the banner names a window by the words of the app, and a window it does not know is not named', () => {
  const title = (window: string | null) => {
    const s = status('claude-code', 'Claude Code', { limit: limit({ window }) });
    return text(render(<LimitBanner chat={chat()} state={{ ...state('limit'), status: s }} />, seeded()));
  };
  assert.match(title('five_hour'), /Claude Code reached its 5 h limit/);
  assert.match(title('seven_day'), /Claude Code reached its 7 d limit/);
  assert.match(title('primary'), /Claude Code reached its main window limit/);
  assert.match(title('weekly_opus'), /Claude Code reached its usage limit/);
  assert.doesNotMatch(title('weekly_opus'), /weekly_opus/);
  assert.match(title(null), /Claude Code reached its usage limit/);
});

test('the header says the limit in a warn badge, with the hour it resumes when it waits', () => {
  const badge = (phase: 'limit' | 'waiting', resetsAt: string | null) => text(render(<LimitBadge phase={phase} resetsAt={resetsAt} />, seeded()));
  assert.match(badge('limit', FUTURE), /Limit reached/);
  assert.match(badge('waiting', FUTURE), /waiting · \d\d:\d\d/);
  assert.equal(badge('waiting', null).trim(), 'waiting');
  assert.match(render(<LimitBadge phase="limit" resetsAt={null} />, seeded()), /badge-warn/);
});

test('a candidate in the move sheet shows its use in the usage thresholds', () => {
  const tone = (percent: number) => (/meter-fill ?([^"]*)"/.exec(renderToStaticMarkup(<UsageMeter percent={percent} />))?.[1] ?? '').trim();
  assert.equal(tone(34), '');
  assert.equal(tone(60), 'is-warn');
  assert.equal(tone(74), 'is-warn');
  assert.equal(tone(75), 'is-bad');
});

const flowItem = { id: 'i1', key: 'AGN-28', projectId: 'p1', links: [{ kind: 'chat', chatId: 'e3d8a1', teamRole: 'developer', role: 'work' }] } as unknown as WorkItemDetail;
const flowLink = { item: flowItem, role: 'work', movesOnEnd: true } as unknown as ComponentProps<typeof FlowMovedNote>['link'];
const flowMove = (over: Partial<ProviderMove> = {}): ProviderMove => ({
  ...wait(),
  subjectKind: 'flow_run',
  subjectId: 'r1',
  projectId: 'p1',
  fromChat: 'c-old-1',
  toChat: 'e3d8a1',
  toProvider: 'codex',
  toModel: 'gpt-6.1-sol',
  action: 'handoff',
  state: 'moved',
  at: '2026-10-02T11:58:00Z',
  resetsAt: null,
  ...over,
});

function flowClient(moves: ProviderMove[], chatId = 'e3d8a1'): QueryClient {
  const client = seeded();
  client.setQueryData(keys.workItemRuns('i1'), [{ id: 'r1', chatId, role: 'developer' } as FlowRun]);
  client.setQueryData(keys.providerMoves('project:p1'), moves);
  return client;
}

test("a flow run's chat that came from another provider says so, with the chain and the moves it has made", () => {
  const html = render(<FlowMovedNote chatId="e3d8a1" link={flowLink} />, flowClient([flowMove()]));
  const words = text(html);
  assert.match(words, /This run continues here from Claude Code\./);
  assert.match(words, /reached its limit and the work went on in Codex, with a handoff/);
  assert.match(words, /Claude Code Codex/);
  assert.match(words, /moved · handoff · \d\d:\d\d · gpt-6\.1-sol/);
  assert.match(words, /Moves 1 of 2/);
  assert.match(html, /href="\/chats\/c-old-1"/);
  assert.doesNotMatch(html, /spinner|shimmer|energy/);
  // Two moves: the chain has three chats and the strip speaks of the last one
  const two = [flowMove({ id: 'm0', fromChat: 'c0', fromProvider: 'copilot', toChat: 'c-old-1', toProvider: 'claude-code', at: '2026-10-02T10:00:00Z' }), flowMove()];
  assert.deepEqual(
    chainOfMoves(two).map((c) => c.provider),
    ['copilot', 'claude-code', 'codex'],
  );
  assert.match(text(render(<FlowMovedNote chatId="e3d8a1" link={flowLink} />, flowClient(two))), /Moves 2 of 2/);
});

test('a flow chat that never moved, or whose run went on elsewhere, shows no strip', () => {
  assert.doesNotMatch(render(<FlowMovedNote chatId="e3d8a1" link={flowLink} />, flowClient([])), /flow-moved/);
  // The old chat of a moved run is not the run's chat any more
  assert.doesNotMatch(render(<FlowMovedNote chatId="c-old-1" link={flowLink} />, flowClient([flowMove()], 'e3d8a1')), /flow-moved/);
  assert.doesNotMatch(render(<FlowMovedNote chatId="e3d8a1" link={flowLink} />, flowClient([flowMove({ action: 'wait', toChat: null, toProvider: null })])), /flow-moved/);
});
