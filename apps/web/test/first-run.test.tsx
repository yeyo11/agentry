// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderReadinessState, ProviderStatus } from '@agentry/shared';
import { en, es } from '../src/i18n/resources';
import { nothingFound, shouldShowSetup } from '../src/lib/first-run';

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

test('the setup assistant stands in for the app until it is finished or skipped, and never again', () => {
  assert.equal(shouldShowSetup({ seen: false }), true, 'a first start');
  assert.equal(shouldShowSetup({ seen: true }), false, 'finished or skipped: it does not come back, even with nothing ready');
});

test('nothing is found only when every provider is missing', () => {
  assert.equal(nothingFound([status('claude-code', 'Claude Code', 'not-installed'), status('codex', 'Codex', 'not-installed')]), true);
  assert.equal(nothingFound([status('claude-code', 'Claude Code', 'not-installed'), status('codex', 'Codex', 'used-before')]), false);
  assert.equal(nothingFound([]), false);
});

test('the Agents step\'s nothing-found strings exist in both languages, with the same placeholders', () => {
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
  walk(en.setup, es.setup, 'setup');
});
