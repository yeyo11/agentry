// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@agentry/ui/components/controls';
import { ToastProvider } from '@agentry/ui/components/Toast';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { effectiveDefault, entryOf, latestCheck, moveBy, moveTo, orderedIds, withEntry, withOrder } from '../src/lib/provider-settings';
import { ProvidersTab } from '../src/pages/config/ProvidersTab';
import { GROUPS, isTab, TAB_LABELS } from '../src/pages/config/settingsTabs';

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Gemini CLI',
  state: 'ready',
  reason: null,
  version: '1.0.0',
  compatibleRange: '>=1.0.0',
  binaryPath: `/usr/bin/${id}`,
  configHome: null,
  account: null,
  capabilities: [],
  checkedAt: '2026-09-30T10:00:00Z',
  ...over,
});

const settings = (over: Partial<ProvidersSettings> = {}): ProvidersSettings => ({
  providers: { 'claude-code': { enabled: true, binaryPath: null }, codex: { enabled: true, binaryPath: '/opt/codex' } },
  order: ['claude-code', 'codex'],
  defaultProvider: null,
  ...over,
});

const LIST = [status('claude-code'), status('codex', { state: 'used-before', reason: 'config-home-only' }), status('gemini')];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the list follows the settings, then what the settings have not met, and drops strangers', () => {
  assert.deepEqual(orderedIds(LIST, settings({ order: ['codex', 'ghost', 'claude-code', 'codex'] })), ['codex', 'claude-code', 'gemini']);
  assert.deepEqual(orderedIds(LIST, settings({ order: [] })), ['claude-code', 'codex', 'gemini']);
});

test('moving is by place, stays in the list and leaves the original alone', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(moveTo(order, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveBy(order, 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moveBy(order, 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveBy(order, 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveBy(order, 'nope', 1), ['a', 'b', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a provider the settings never mention is on and searched for', () => {
  assert.deepEqual(entryOf(settings(), 'gemini'), { enabled: true, binaryPath: null });
});

test('changing one entry sends the whole document with the order made explicit', () => {
  const next = withEntry(settings(), ['claude-code', 'codex', 'gemini'], 'gemini', { enabled: false });
  assert.deepEqual(next.order, ['claude-code', 'codex', 'gemini']);
  assert.deepEqual(next.providers.gemini, { enabled: false, binaryPath: null });
  assert.deepEqual(next.providers.codex, { enabled: true, binaryPath: '/opt/codex' });
  assert.equal(withEntry(settings(), ['codex'], 'codex', { binaryPath: null }).providers.codex?.binaryPath, null);
});

test('Automatic is the first provider that is on and ready, in the order of the list', () => {
  assert.equal(effectiveDefault(LIST, settings()), 'claude-code');
  assert.equal(effectiveDefault(LIST, withEntry(settings(), ['claude-code', 'codex', 'gemini'], 'claude-code', { enabled: false })), 'gemini');
  assert.equal(effectiveDefault(LIST, settings({ order: ['gemini', 'claude-code', 'codex'] })), 'gemini');
  assert.equal(effectiveDefault(LIST, withOrder(settings(), ['claude-code', 'codex', 'gemini'], 'codex')), 'codex');
  assert.equal(effectiveDefault([status('codex', { state: 'signed-out' })], settings()), null);
});

test('the newest detection is the one that is shown', () => {
  assert.equal(latestCheck([]), null);
  assert.equal(latestCheck([status('a', { checkedAt: '2026-09-30T10:00:00Z' }), status('b', { checkedAt: '2026-09-30T10:05:00Z' })]), '2026-09-30T10:05:00Z');
});

test('Providers is a tab of the Agentry group, right after Account', () => {
  assert.ok(isTab('providers'));
  const agentry = GROUPS.find((g) => g.id === 'agentry')?.tabs ?? [];
  assert.equal(agentry.indexOf('providers'), agentry.indexOf('account') + 1);
  assert.equal(TAB_LABELS.providers, 'providers:tab');
});

test('the copy of the tab exists in both languages with the same placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const flat = (o: Record<string, unknown>, at = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${at}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const spanish = new Map(flat(es.providers));
  for (const [key, value] of flat(en.providers)) {
    const other = spanish.get(key);
    assert.ok(other, `es ${key}`);
    assert.equal(holes(value), holes(other), key);
  }
  assert.equal(spanish.size, flat(en.providers).length);
});

test('the page lists every provider with its state, the default select, the count and the handles', async () => {
  await i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.providers, LIST);
  client.setQueryData(keys.providerSettings, settings());
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter>
            <ProvidersTab />
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const words = text(html);
  assert.match(words, /3 providers · 2 ready/);
  assert.match(words, /Default provider/);
  assert.match(words, /Claude Code Default/);
  assert.match(words, /Used before/);
  assert.match(words, /Checked/);
  assert.match(words, /Check again/);
  assert.equal((html.match(/class="prov-grip"/g) ?? []).length, 3);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 3);
  assert.match(html, /aria-label="Turn off Claude Code"/);
  assert.match(html, /data-provider="codex"[^>]*data-state="used-before"/);
});
