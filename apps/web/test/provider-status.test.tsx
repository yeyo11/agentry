// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import { ProviderDots } from '../src/components/shell/ProviderDots';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { enabledProviders, providerSetup } from '../src/lib/provider-status';

const status = (id: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: id === 'claude-code' ? 'Claude Code' : 'Copilot',
  state: 'ready',
  reason: null,
  version: '2.1.282',
  compatibleRange: '>=2.1 <3',
  binaryPath: '/usr/local/bin/x',
  configHome: null,
  account: null,
  capabilities: [],
  checkedAt: '2026-09-30T10:00:00Z',
  ...over,
});

const settings = (enabled: Record<string, boolean>, order: string[]): ProvidersSettings => ({
  providers: Object.fromEntries(Object.entries(enabled).map(([id, on]) => [id, { enabled: on, binaryPath: null }])),
  order,
  defaultProvider: null,
});

const missing = (id: string) => status(id, { state: 'not-installed', reason: 'binary-not-found', version: null, binaryPath: null });

test('only enabled providers count, in the order of the settings', () => {
  const all = [status('claude-code'), status('copilot'), status('codex')];
  const got = enabledProviders(all, settings({ 'claude-code': true, copilot: true, codex: false }, ['copilot', 'claude-code', 'codex']));
  assert.deepEqual(got.map((s) => s.id), ['copilot', 'claude-code']);
  assert.equal(enabledProviders(all, undefined).length, 3);
});

test('Home: nothing installed is one card, a provider signed out beside a working one is a row', () => {
  assert.equal(providerSetup([missing('claude-code'), missing('copilot')]).kind, 'none');
  assert.equal(providerSetup([]).kind, 'none');
  assert.equal(providerSetup([status('claude-code'), status('copilot')]).kind, 'ok');
  assert.equal(providerSetup([status('claude-code'), missing('copilot')]).kind, 'ok');
  const beside = providerSetup([status('claude-code'), status('copilot', { state: 'signed-out', reason: 'missing-credentials' })]);
  assert.equal(beside.kind, 'attention');
  assert.deepEqual(beside.problems.map((s) => s.id), ['copilot']);
  const blocked = providerSetup([status('claude-code', { state: 'signed-out' }), missing('copilot')]);
  assert.equal(blocked.kind, 'blocked');
  assert.equal(providerSetup([status('claude-code', { state: 'degraded' })]).kind, 'ok');
});

const bar = (statuses: ProviderStatus[] | undefined, lang: 'en' | 'es' = 'en') => {
  void i18n.changeLanguage(lang);
  const client = new QueryClient();
  if (statuses) client.setQueryData(keys.providers, statuses);
  client.setQueryData(keys.providerSettings, settings(Object.fromEntries(['claude-code', 'copilot'].map((id) => [id, true])), ['claude-code', 'copilot']));
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider><ProviderDots /></TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

test('the status bar shows a dot and a word per provider that is there', () => {
  const html = bar([status('claude-code'), status('copilot', { state: 'signed-out', reason: 'missing-credentials', version: '0.0.353' })]);
  assert.match(html, /Claude Code 2\.1\.282/);
  assert.match(html, /Copilot · signed out/);
  assert.match(html, /tone-ok/);
  assert.match(html, /tone-warn/);
  assert.match(html, /statusbar-warn/);
  assert.match(html, /href="\/settings\?tab=providers"/);
});

test('the status bar says so when no agent is found, in both languages', () => {
  assert.match(bar([missing('claude-code'), missing('copilot')]), /No agent detected/);
  assert.match(bar([missing('claude-code'), missing('copilot')], 'es'), /Ningún agente detectado/);
  assert.match(bar(undefined), /Checking agents/);
  void i18n.changeLanguage('en');
});

test('Home copy has en/es parity for the agents rows', () => {
  const keysOf = (o: object) => Object.keys(o).sort();
  assert.deepEqual(keysOf(en.home.activity), keysOf(es.home.activity));
  assert.deepEqual(keysOf(en.providers.statusbar), keysOf(es.providers.statusbar));
});
