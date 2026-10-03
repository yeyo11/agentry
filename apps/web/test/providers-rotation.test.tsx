// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelOption, Project, ProjectSettings, ProviderLimit, ProviderMove, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@agentry/ui/components/controls';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import { ToastProvider } from '@agentry/ui/components/Toast';
import i18n from '../src/i18n';
import { DirtyProvider } from '../src/lib/dirty';
import { ProvidersTab } from '../src/pages/config/ProvidersTab';
import { ProjectProviders } from '../src/pages/config/providers/ProjectProviders';
import {
  DEFAULT_ROTATION,
  allowedWith,
  counterpart,
  isStale,
  limitRows,
  namesOf,
  onLimitWith,
  projectProvidersOf,
  rotationOf,
  waitingPairs,
  withCounterpart,
  withOnLimit,
} from '../src/pages/config/providers/rotation';

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: id === 'claude-code' ? 'Claude Code' : 'Codex',
  state: 'ready',
  reason: null,
  version: '1.0.0',
  compatibleRange: '>=1.0.0',
  binaryPath: `/usr/bin/${id}`,
  configHome: null,
  account: id === 'claude-code' ? 'ada@example.com' : null,
  capabilities: [],
  checkedAt: '2026-10-02T10:00:00Z',
  ...over,
});

const settings = (over: Partial<ProvidersSettings> = {}): ProvidersSettings => ({
  providers: { 'claude-code': { enabled: true, binaryPath: null }, codex: { enabled: true, binaryPath: null } },
  order: ['claude-code', 'codex'],
  defaultProvider: null,
  ...over,
});

const limit = (over: Partial<ProviderLimit> = {}): ProviderLimit => ({
  provider: 'claude-code',
  state: 'near',
  window: '5h',
  utilization: 0.72,
  resetsAt: '2099-01-01T14:05:00Z',
  windows: { '7d': { utilization: 0.21, resetsAt: 4_102_444_800 }, '5h': { utilization: 0.72, resetsAt: 4_102_444_800 } },
  observedAt: new Date().toISOString(),
  source: 'stream',
  ...over,
});

const SONNET: ModelOption = { value: 'sonnet', label: 'Sonnet 5.5', tier: 'balanced' };
const OPUS: ModelOption = { value: 'opus', label: 'Opus 5.5', tier: 'strong' };
const GPT: ModelOption = { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol', tier: 'strong' };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

test('a file written before phase 4 reads as the safe defaults: wait, nothing allowed beyond it', () => {
  assert.deepEqual(rotationOf(settings()), DEFAULT_ROTATION);
  assert.deepEqual(DEFAULT_ROTATION.onLimit, { action: 'wait', allowed: ['wait'], maxWaitHours: 6, maxMoves: 2 });
  assert.deepEqual(DEFAULT_ROTATION.modelMap, []);
});

test('the action in force is always an action a decision may pick, in the order of the cards', () => {
  const on = onLimitWith(DEFAULT_ROTATION.onLimit, { action: 'handoff' });
  assert.deepEqual(on.allowed, ['handoff', 'wait']);
  assert.deepEqual(allowedWith(on, 'handoff', false), on);
  assert.deepEqual(allowedWith(on, 'wait', false).allowed, ['handoff']);
  assert.deepEqual(allowedWith(on, 'restart', true).allowed, ['handoff', 'restart', 'wait']);
  // The mapping and the rest of the document are the document's own
  const next = withOnLimit(settings({ rotation: { ...DEFAULT_ROTATION, modelMap: [{ from: { provider: 'a', model: 'x' }, to: { provider: 'b', model: 'y' }, origin: 'person', at: 't' }] } }), on);
  assert.equal(next.rotation?.modelMap.length, 1);
  assert.equal(next.rotation?.onLimit.action, 'handoff');
});

test('a counterpart is set and cleared one pair at a time, and a person always writes origin person', () => {
  const from = { provider: 'claude-code', model: 'sonnet' };
  const one = withCounterpart(settings(), from, { provider: 'codex', model: 'gpt-6.1-sol' }, '2026-10-02T10:00:00Z');
  assert.deepEqual(counterpart(rotationOf(one).modelMap, from, 'codex'), { from, to: { provider: 'codex', model: 'gpt-6.1-sol' }, origin: 'person', at: '2026-10-02T10:00:00Z' });
  const changed = withCounterpart(one, from, { provider: 'codex', model: 'gpt-6.1-mini' }, 't2');
  assert.equal(rotationOf(changed).modelMap.length, 1);
  assert.equal(counterpart(rotationOf(changed).modelMap, from, 'codex')?.to.model, 'gpt-6.1-mini');
  const other = withCounterpart(changed, from, { provider: 'gemini', model: 'g' }, 't3');
  assert.equal(rotationOf(other).modelMap.length, 2);
  assert.equal(rotationOf(withCounterpart(other, from, { provider: 'codex', model: null }, 't4')).modelMap.length, 1);
});

test('an entry whose model left the catalog is stale; a catalog not read yet cannot say so', () => {
  const entry = { from: { provider: 'a', model: 'x' }, to: { provider: 'b', model: 'gone' }, origin: 'person' as const, at: 't' };
  assert.equal(isStale(entry, [GPT]), true);
  assert.equal(isStale(entry, [{ value: 'gone', label: 'Gone', disabled: true }]), true);
  assert.equal(isStale(entry, []), false);
  assert.equal(isStale(entry, undefined), false);
  assert.equal(isStale({ ...entry, to: { provider: 'b', model: 'gpt-6.1-sol' } }, [GPT]), false);
});

test('the windows of a limit read 5 h first, then 7 d, then the rest, as percentages', () => {
  const rows = limitRows(limit({ windows: { opus: { utilization: 0.4, resetsAt: 0 }, '7d': { utilization: 0.21, resetsAt: 4_102_444_800 }, '5h': { utilization: 1.4, resetsAt: 4_102_444_800 } } }));
  assert.deepEqual(rows.map((r) => [r.name, r.percent]), [['5h', 100], ['7d', 21], ['opus', 40]]);
  assert.equal(rows[2]?.resetsAt, null);
  // A provider that reports one figure and no windows still shows it
  assert.deepEqual(limitRows(limit({ windows: {}, window: 'primary', utilization: 0.5, resetsAt: null })), [{ name: 'primary', percent: 50, resetsAt: null }]);
  assert.deepEqual(limitRows(limit({ windows: {}, state: 'unknown', utilization: null })), []);
});

test('open waits name the models that wait; finished moves do not', () => {
  const move = (state: ProviderMove['state'], fromModel: string | null): ProviderMove => ({
    id: state, at: 't', subjectKind: 'task', subjectId: 's', projectId: null, fromChat: 'c', toChat: null, fromProvider: 'claude-code', toProvider: null,
    fromModel, toModel: null, action: 'wait', state, decidedBy: 'setting', decisionId: null, resetsAt: null, reason: null, updatedAt: 't',
  });
  assert.deepEqual([...waitingPairs([move('waiting', 'sonnet'), move('resuming', 'opus'), move('moved', 'haiku'), move('waiting', null)])].sort(), ['claude-code\0opus', 'claude-code\0sonnet']);
});

test('a project that overrides nothing writes nothing; what it sets is all that is written', () => {
  assert.equal(projectProvidersOf(null, {}), undefined);
  assert.deepEqual(projectProvidersOf(['codex'], { maxMoves: 1 }), { order: ['codex'], onLimit: { maxMoves: 1 } });
  assert.deepEqual(projectProvidersOf(null, { action: 'restart' }), { onLimit: { action: 'restart' } });
});

function render(page: React.ReactNode, client: QueryClient): string {
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <DirtyProvider>{page}</DirtyProvider>
            </ConfirmProvider>
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

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status('claude-code', { limit: limit() }), status('codex', { limit: limit({ provider: 'codex', state: 'exhausted', utilization: 1, window: 'primary', windows: { primary: { utilization: 1, resetsAt: 4_102_444_800 } } }) })]);
  client.setQueryData(keys.providerSettings, settings());
  client.setQueryData(keys.providerModels('claude-code'), [SONNET, OPUS]);
  client.setQueryData(keys.providerModels('codex'), [GPT]);
  client.setQueryData(keys.modelMapSuggestions, [{ id: 'd1', from: { provider: 'claude-code', model: 'opus' }, to: { provider: 'codex', model: 'gpt-6.1-sol' }, at: 't' }]);
  client.setQueryData(keys.providerMoves('waiting'), []);
  client.setQueryData(keys.cswapRetirement, { notice: { found: ['accounts', 'managed-copy'], managedCopy: true, policyProjects: ['p1'] } });
  client.setQueryData(keys.projects, [{ id: 'p1', name: 'claude-wrapper' }]);
  return client;
}

test('Settings → Providers shows each limit with its word, the on-limit card, the mapping and the notice', () => {
  const html = render(<ProvidersTab />, seeded());
  const words = text(html);
  // The limit bars: the thresholds, the percentages and the words next to the colour
  assert.match(words, /Limit .*Near its limit/);
  assert.match(words, /72 %/);
  assert.match(words, /Limit reached/);
  assert.match(html, /aria-label="5 h: 72 % used"/);
  assert.match(html, /meter-fill is-bad/);
  // The on-limit card ships with the safe defaults
  assert.match(words, /When a provider reaches its limit/);
  assert.match(words, /Waiting for the reset is what a fresh install does/);
  assert.match(html, /role="radiogroup" aria-label="What to do at a limit"/);
  // The mapping: a suggestion is not a counterpart until accepted
  assert.match(words, /Model mapping/);
  assert.match(words, /Suggested/);
  assert.match(words, /It does not count until you accept it/);
  assert.match(words, /No counterpart/);
  // The retirement notice names the account in force and offers to remove only Agentry's copy
  assert.match(words, /Agentry no longer switches Claude accounts/);
  assert.match(words, /ada@example\.com/);
  assert.match(words, /claude-wrapper/);
  assert.match(words, /Remove Agentry(&#x27;|')s copy of claude-swap/);
});

test('a notice that was dismissed is not drawn, and a provider with no reading shows no limit', () => {
  const client = seeded();
  client.setQueryData(keys.cswapRetirement, { notice: null });
  client.setQueryData(keys.providers, [status('claude-code'), status('codex')]);
  const words = text(render(<ProvidersTab />, client));
  assert.doesNotMatch(words, /no longer switches Claude accounts/);
  assert.doesNotMatch(words, /Near its limit/);
});

test("a project's Providers card inherits the global values and offers the way back only where it overrides", () => {
  const client = seeded();
  const own: ProjectSettings = { providers: { onLimit: { maxMoves: 1 } } } as ProjectSettings;
  client.setQueryData(keys.projectSettings('p1'), own);
  const project = { id: 'p1', name: 'claude-wrapper', path: '/tmp/p' } as Project;
  const html = render(<ProjectProviders project={project} />, client);
  const words = text(html);
  assert.match(words, /Which agents this project may use/);
  assert.match(words, /Global order: Claude Code → Codex/);
  assert.match(words, /inherited · global: Wait for the reset/);
  assert.match(words, /inherited · global: 6 h/);
  assert.match(words, /global: 2/);
  assert.equal((html.match(/Use global/g) ?? []).length, 2);
});

test('the copy of the rotation cards exists in Spanish, once per key, with the same placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const flat = (o: Record<string, unknown>, at = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${at}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const es = new Map(flat(i18n.getResourceBundle('es', 'providers') as Record<string, unknown>));
  for (const [key, value] of flat(i18n.getResourceBundle('en', 'providers') as Record<string, unknown>)) {
    const other = es.get(key);
    assert.ok(other, `es ${key}`);
    assert.equal(holes(value), holes(other), key);
  }
});

test('a row is matched on its alias or any id the CLI reported for it (QA-W M2)', () => {
  const row: ModelOption = { ...SONNET, ids: ['claude-sonnet-5'] };
  const from = { provider: 'claude-code', model: 'sonnet' };
  const names = namesOf(row);
  assert.deepEqual(names, ['sonnet', 'claude-sonnet-5']);
  // An entry written under the resolved id is found, and writing from the row replaces it
  const stored = settings({ rotation: { ...DEFAULT_ROTATION, modelMap: [{ from: { provider: 'claude-code', model: 'claude-sonnet-5' }, to: { provider: 'codex', model: 'gpt-6.1-sol' }, origin: 'decision', at: 't' }] } });
  assert.equal(counterpart(rotationOf(stored).modelMap, from, 'codex'), undefined);
  assert.equal(counterpart(rotationOf(stored).modelMap, from, 'codex', names)?.to.model, 'gpt-6.1-sol');
  const written = withCounterpart(stored, from, { provider: 'codex', model: 'gpt-6.1-mini' }, 't2', names);
  assert.deepEqual(rotationOf(written).modelMap.map((e) => [e.from.model, e.to.model]), [['sonnet', 'gpt-6.1-mini']]);
  // A counterpart saved as an id is not stale while its row is offered
  const entry = { from, to: { provider: 'claude-code', model: 'claude-sonnet-5' }, origin: 'person' as const, at: 't' };
  assert.equal(isStale(entry, [row]), false);
  assert.equal(isStale(entry, [SONNET]), true);
});

test('the mapping editor reads a suggestion and a wait carried under the resolved id, and offers Suggest on an empty cell', () => {
  const client = seeded();
  client.setQueryData(keys.providerModels('claude-code'), [{ ...SONNET, ids: ['claude-sonnet-5'] }, { ...OPUS, ids: ['claude-opus-5'] }]);
  client.setQueryData(keys.modelMapSuggestions, [{ id: 'd1', from: { provider: 'claude-code', model: 'claude-opus-5' }, to: { provider: 'codex', model: 'gpt-6.1-sol' }, at: 't' }]);
  client.setQueryData(keys.providerMoves('waiting'), [{ id: 'm', at: 't', subjectKind: 'task', subjectId: 's', projectId: null, fromChat: 'c', toChat: null, fromProvider: 'claude-code', toProvider: null, fromModel: 'claude-sonnet-5', toModel: null, action: 'wait', state: 'waiting', decidedBy: 'setting', decisionId: null, resetsAt: null, reason: null, updatedAt: 't' }]);
  const html = render(<ProvidersTab />, client);
  assert.match(text(html), /Suggested/);
  assert.match(html, /map-row is-target" data-model="sonnet"/);
  // Sonnet has no counterpart and no suggestion: its cell offers Suggest
  assert.match(html, /aria-label="Suggest a counterpart for Sonnet 5.5 → Codex"/);
});

test('an unknown reading is said, not drawn, even when it still has windows (QA-W m14)', () => {
  const client = seeded();
  client.setQueryData(keys.providers, [status('claude-code', { limit: limit({ state: 'unknown' }) }), status('codex')]);
  const html = render(<ProvidersTab />, client);
  assert.match(text(html), /the limit is not known until a new one arrives/);
  assert.doesNotMatch(html, /aria-label="5 h: 72 % used"/);
});

test("a project's own onLimit.allowed survives a save and follows the action (QA-W m7)", () => {
  assert.deepEqual(projectProvidersOf(null, { action: 'handoff', allowed: ['wait'] }), { onLimit: { action: 'handoff', allowed: ['handoff', 'wait'] } });
  assert.deepEqual(projectProvidersOf(['codex'], { allowed: ['restart', 'wait'] }), { order: ['codex'], onLimit: { allowed: ['restart', 'wait'] } });
});
