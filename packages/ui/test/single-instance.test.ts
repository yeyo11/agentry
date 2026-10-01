import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Two copies of React Query would mean two caches, two of i18next untranslated package text, two of
 * the tooltip library a tooltip with no provider. pnpm links one copy while every declared range is
 * the same; this fails when a range drifts in one package.json.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HOLDERS = ['apps/web', 'packages/ui', 'packages/chat-ui'];
const NAMED = ['react', 'react-dom', 'i18next', 'react-i18next', '@tanstack/react-query', 'react-router-dom', 'motion', 'lucide-react'];

function declared(holder: string): Set<string> {
  const manifest = JSON.parse(readFileSync(join(ROOT, holder, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  return new Set(['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {})));
}

test('each stateful library resolves to one copy from the app and both packages', () => {
  const declarations = new Map(HOLDERS.map((holder) => [holder, declared(holder)]));
  const names = new Set([...NAMED, ...[...declarations.values()].flatMap((set) => [...set].filter((name) => name.startsWith('@radix-ui/')))]);
  for (const name of names) {
    const paths = new Map<string, string[]>();
    for (const [holder, set] of declarations) {
      if (!set.has(name)) continue;
      const link = join(ROOT, holder, 'node_modules', name);
      assert.ok(existsSync(link), `${holder} declares ${name} but it is not installed: run pnpm install`);
      const real = realpathSync(link);
      paths.set(real, [...(paths.get(real) ?? []), holder]);
    }
    assert.ok(paths.size <= 1, `${name} resolves to ${paths.size} copies: ${JSON.stringify([...paths])}`);
  }
});
