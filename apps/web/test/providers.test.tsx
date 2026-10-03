// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderReadinessState, ProviderReasonCode, ProviderStatus } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { ProviderRow } from '../src/components/ProviderRow';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { targetsFor } from '../src/lib/events';
import { actionsFor, providerLink, STATE_TONE } from '../src/lib/provider-state';
import { useProviders } from '../src/lib/providers';

const STATES: ProviderReadinessState[] = ['ready', 'degraded', 'signed-out', 'incompatible', 'used-before', 'not-installed', 'unknown'];
const REASONS: ProviderReasonCode[] = [
  'missing-credentials', 'stale-token', 'version-below-range', 'version-above-range', 'version-unreadable', 'probe-timeout', 'spawn-denied',
  'spawn-failed', 'binary-not-found', 'config-home-only', 'missing-required-command', 'unsupported-platform', 'handshake-failed', 'no-probe', 'auth-required', 'schema-untested', 'busy', 'disabled',
];

const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: 'codex',
  label: 'Codex',
  state: 'ready',
  reason: null,
  version: '1.4.2',
  compatibleRange: '^1.0.0',
  binaryPath: '/usr/local/bin/codex',
  configHome: '~/.codex',
  account: 'ana@example.com',
  capabilities: [],
  checkedAt: '2026-09-30T10:00:00Z',
  ...over,
});

const render = (node: React.ReactNode, client = new QueryClient()) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('every state has a tone and a word in both languages', () => {
  for (const state of STATES) {
    assert.ok(STATE_TONE[state], state);
    assert.ok((en.providers.state as Record<string, string>)[state], `en ${state}`);
    assert.ok((es.providers.state as Record<string, string>)[state], `es ${state}`);
  }
});

test('the tones keep one meaning each: ready ok, needs-a-person warn, broken bad', () => {
  assert.equal(STATE_TONE.ready, 'ok');
  assert.equal(STATE_TONE.degraded, 'warn');
  assert.equal(STATE_TONE['signed-out'], 'warn');
  assert.equal(STATE_TONE.incompatible, 'bad');
  assert.equal(STATE_TONE['used-before'], 'idle');
});

test('every reason code is worded in both languages, and the two agree on their placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  for (const code of REASONS) {
    const a = (en.providers.reason as Record<string, string>)[code];
    const b = (es.providers.reason as Record<string, string>)[code];
    assert.ok(a && b, code);
    assert.equal(holes(a), holes(b), code);
  }
});

test('each state offers the remedy the prototype shows, one primary at most', () => {
  const kinds = (s: ProviderReadinessState) => actionsFor(s).map((a) => a.kind);
  assert.deepEqual(kinds('ready'), []);
  assert.deepEqual(kinds('signed-out'), ['sign-in']);
  assert.deepEqual(kinds('not-installed'), ['install']);
  assert.deepEqual(kinds('used-before'), ['choose-binary', 'install']);
  assert.deepEqual(kinds('incompatible'), ['choose-binary', 'install']);
  assert.deepEqual(kinds('unknown'), ['retry']);
  // Nothing to retry where there is no check: Copilot with only a token in the environment
  assert.deepEqual(actionsFor('unknown', 'no-probe'), []);
  assert.deepEqual(actionsFor('unknown', 'probe-timeout').map((a) => a.kind), ['retry']);
  for (const state of STATES) assert.ok(actionsFor(state).filter((a) => a.primary).length <= 1, state);
});

test('a vendor page is known for the providers Agentry ships', () => {
  for (const id of ['claude-code', 'codex', 'gemini', 'copilot']) assert.match(providerLink(id, 'install') ?? '', /^https:\/\//);
  assert.equal(providerLink('nope', 'install'), null);
});

test('providers.changed reads the statuses and the settings again', () => {
  const targets = targetsFor({ id: 1, at: '2026-09-30T10:00:00Z', title: 'Providers', type: 'providers.changed', providers: [] }).map(([key]) => key);
  assert.ok(targets.some((prefix) => prefix.every((part, i) => keys.providers[i] === part)));
  assert.equal(keys.providerSettings[0], keys.providers[0]);
});

test('useProviders reads the cache under the providers key', () => {
  const client = new QueryClient();
  client.setQueryData(keys.providers, [status({ id: 'claude-code', label: 'Claude Code' })]);
  function Probe() {
    const { data } = useProviders();
    return <p>{data?.map((p) => p.label).join(',')}</p>;
  }
  assert.match(render(<Probe />, client), /Claude Code/);
});

test('a row shows the state as a word, the reason and the path in mono', async () => {
  await i18n.changeLanguage('en');
  const html = render(<ProviderRow status={status({ state: 'degraded', reason: 'version-below-range', version: '2.0.8', id: 'claude-code', label: 'Claude Code' })} isDefault />);
  const words = text(html);
  assert.match(words, /Warnings/);
  assert.match(words, /v2\.0\.8 is older than the versions Agentry has been tested with \(\^1\.0\.0\)/);
  assert.match(words, /Default/);
  assert.match(html, /prov-meta[^>]*>v2\.0\.8 · \^1\.0\.0 · \/usr\/local\/bin\/codex/);
  assert.match(html, /href="https:\/\/code\.claude\.com\/docs\/en\/setup"/);
});

test('Sign in opens Settings → Account for Claude Code and the vendor page for the others', async () => {
  await i18n.changeLanguage('en');
  const own = render(<ProviderRow status={status({ id: 'claude-code', label: 'Claude Code', state: 'signed-out', reason: 'missing-credentials' })} />);
  assert.match(own, /data-action="sign-in" href="\/settings\?tab=account"/);
  const other = render(<ProviderRow status={status({ id: 'copilot', label: 'GitHub Copilot', state: 'signed-out', reason: 'missing-credentials' })} />);
  assert.match(other, /data-action="sign-in"/);
});

test('a missing program offers Install, a check that failed offers Retry, and Choose binary needs its handler', async () => {
  await i18n.changeLanguage('es');
  const missing = render(<ProviderRow status={status({ state: 'not-installed', reason: 'binary-not-found', version: null, binaryPath: null, configHome: null, account: null })} />);
  assert.match(text(missing), /No instalado/);
  assert.match(text(missing), /No hay rastro de Codex en este equipo/);
  assert.match(text(missing), /Instalar/);
  const unknown = render(<ProviderRow status={status({ state: 'unknown', reason: 'probe-timeout' })} onRetry={() => undefined} />);
  assert.match(unknown, /data-action="retry"/);
  const before = status({ state: 'used-before', reason: 'config-home-only', binaryPath: null });
  assert.doesNotMatch(render(<ProviderRow status={before} />), /choose-binary/);
  assert.match(render(<ProviderRow status={before} onChooseBinary={() => undefined} />), /data-action="choose-binary"/);
  await i18n.changeLanguage('en');
});

test('a provider that is off shows Off and offers no remedy', async () => {
  await i18n.changeLanguage('en');
  const html = render(<ProviderRow status={status({ state: 'signed-out', reason: 'missing-credentials' })} enabled={false} />);
  assert.match(text(html), /Off/);
  assert.doesNotMatch(html, /data-action/);
});
