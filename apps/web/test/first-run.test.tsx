// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderReadinessState, ProviderStatus } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ProvidersStep } from '../src/components/ProvidersStep';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { firstReady, FIRST_RUN_GROUPS, groupProviders, nothingFound, shouldShowFirstRun } from '../src/lib/first-run';

const status = (id: string, label: string, state: ProviderReadinessState): ProviderStatus => ({
  id,
  label,
  state,
  reason: null,
  version: null,
  compatibleRange: '^1.0.0',
  binaryPath: null,
  configHome: null,
  account: null,
  capabilities: [],
  checkedAt: '2026-09-30T10:00:00Z',
});

const claude = (state: ProviderReadinessState = 'ready') => status('claude-code', 'Claude Code', state);
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the step shows on the first start, and whenever nothing can run', () => {
  assert.equal(shouldShowFirstRun(false, [claude()]), true, 'first start, even with a ready provider');
  assert.equal(shouldShowFirstRun(true, [claude()]), false, 'answered before, and something is ready');
  assert.equal(shouldShowFirstRun(true, [claude('signed-out'), status('codex', 'Codex', 'not-installed')]), true, 'answered before, nothing ready');
  assert.equal(shouldShowFirstRun(true, [claude('degraded')]), false, 'a provider working with a warning can start a chat');
  assert.equal(shouldShowFirstRun(true, [claude('signed-out')], '/settings'), false, 'once seen, it never hides Settings, where a provider gets fixed');
  assert.equal(shouldShowFirstRun(false, [claude('signed-out')], '/settings'), true, 'the very first start still opens on it');
});

test('providers are grouped by what is left to do, in a fixed order', () => {
  const groups = groupProviders([
    status('a', 'A', 'not-installed'),
    status('b', 'B', 'used-before'),
    status('c', 'C', 'signed-out'),
    status('d', 'D', 'degraded'),
    status('e', 'E', 'ready'),
    status('f', 'F', 'unknown'),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.group, g.providers.map((p) => p.id).join('')]),
    [['ready', 'de'], ['signed-out', 'c'], ['attention', 'f'], ['used-before', 'b'], ['not-installed', 'a']],
  );
  assert.deepEqual(groupProviders([claude()]).map((g) => g.group), ['ready'], 'a group with nobody in it is left out');
});

test('Continue names the first ready provider, or else one that works with a warning', () => {
  const list = [status('a', 'A', 'signed-out'), status('b', 'B', 'degraded'), status('c', 'C', 'ready')];
  assert.equal(firstReady(list)?.id, 'c');
  assert.equal(firstReady(list.slice(0, 2))?.id, 'b');
  assert.equal(firstReady(list.slice(0, 1)), null);
});

test('nothing is found only when every provider is missing', () => {
  assert.equal(nothingFound([claude('not-installed'), status('codex', 'Codex', 'not-installed')]), true);
  assert.equal(nothingFound([claude('not-installed'), status('codex', 'Codex', 'used-before')]), false);
  assert.equal(nothingFound([]), false);
});

test('the list step offers Continue with the first ready provider, and Skip for now', async () => {
  await i18n.changeLanguage('en');
  const html = render(<ProvidersStep statuses={[claude(), status('codex', 'Codex', 'used-before'), status('gemini', 'Gemini CLI', 'not-installed')]} onFinish={() => undefined} />);
  const words = text(html);
  assert.match(words, /These are the agents on your machine/);
  assert.match(words, /Continue with Claude Code/);
  assert.match(words, /Skip for now/);
  assert.match(words, /Check again/);
  for (const group of ['Ready', 'Used before', 'Not installed']) assert.ok(words.includes(group), group);
  assert.ok(html.includes('btn btn-primary'), 'the one primary action');
  assert.ok(html.includes('data-provider="codex"'));
});

test('with nothing ready the list has no Continue, but can still be skipped', async () => {
  await i18n.changeLanguage('en');
  const words = text(render(<ProvidersStep statuses={[claude('signed-out'), status('codex', 'Codex', 'used-before')]} onFinish={() => undefined} />));
  assert.doesNotMatch(words, /Continue/);
  assert.match(words, /Skip for now/);
});

test('when nothing is found the page is an Empty state with an illustration, the install link and the others', async () => {
  await i18n.changeLanguage('en');
  const html = render(
    <ProvidersStep statuses={[claude('not-installed'), status('codex', 'Codex', 'not-installed'), status('gemini', 'Gemini CLI', 'not-installed')]} onFinish={() => undefined} />,
  );
  const words = text(html);
  assert.ok(html.includes('data-step="empty"'));
  assert.ok(html.includes('state-illustrated') && html.includes('<svg'), 'an existing illustration');
  assert.match(words, /No agent found/);
  assert.match(words, /See how to install Claude Code/);
  assert.match(words, /Or pick another/);
  assert.ok(words.includes('Codex') && words.includes('Gemini CLI'));
  assert.match(words, /Skip for now/);
  assert.doesNotMatch(words, /Continue/);
});

test('every string of the step exists in both languages, with the same placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const walk = (a: unknown, b: unknown, path: string) => {
    if (typeof a === 'string') {
      assert.equal(typeof b, 'string', path);
      assert.equal(holes(a), holes(b as string), path);
      return;
    }
    assert.deepEqual(Object.keys(a as object).sort(), Object.keys(b as object).sort(), path);
    for (const key of Object.keys(a as object)) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
  };
  walk(en.providers.firstRun, es.providers.firstRun, 'firstRun');
  for (const group of FIRST_RUN_GROUPS) assert.ok((en.providers.firstRun.group as Record<string, string>)[group], group);
});
