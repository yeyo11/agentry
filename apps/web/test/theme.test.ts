import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { resolveEffective, resolvePreference } from '../src/lib/theme.tsx';

test('theme preference: nothing stored is dark, and system is a stored value of its own', () => {
  assert.equal(resolvePreference(null), 'dark');
  assert.equal(resolvePreference(undefined), 'dark');
  assert.equal(resolvePreference(''), 'dark');
  assert.equal(resolvePreference('sepia'), 'dark');
  assert.equal(resolvePreference('dark'), 'dark');
  assert.equal(resolvePreference('light'), 'light');
  assert.equal(resolvePreference('system'), 'system');
});

test('effective theme: only system follows the OS', () => {
  assert.equal(resolveEffective('system', true), 'light');
  assert.equal(resolveEffective('system', false), 'dark');
  assert.equal(resolveEffective('dark', true), 'dark');
  assert.equal(resolveEffective('light', false), 'light');
});

/** Runs index.html's pre-paint script against a stored value and returns what it stamped. */
function prePaint(stored: string | null | Error): string | undefined {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?agentry-theme[\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'index.html keeps an inline pre-paint theme script');
  const dataset: Record<string, string> = {};
  runInNewContext(script, {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem: () => {
        if (stored instanceof Error) throw stored;
        return stored;
      },
    },
  });
  return dataset.theme;
}

test('the pre-paint script stamps what lib/theme resolves, so the first paint never flashes', () => {
  for (const stored of [null, 'dark', 'light', 'system', 'bogus']) {
    assert.equal(prePaint(stored), resolvePreference(stored), `stored ${String(stored)}`);
  }
  assert.equal(prePaint(new Error('storage blocked')), 'dark');
});
