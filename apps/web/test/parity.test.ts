// The floors the colours of the lighter highlighter are held to, language by language: how many
// of the characters a reader sees it colours exactly as shiki colours them with the same themes.
// `pnpm --filter @agentry/web parity` reports what the rest are; the differences left at these
// floors are listed in src/components/highlight.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { corpusFixtures } from './parity-corpus.ts';
import { PARITY_LANGS, parity } from './parity.ts';

/**
 * Per language, the share of visible characters that must keep shiki's colour over the frozen
 * corpus, as measured when it was last raised. Below its floor a language reads differently from
 * the grammar; above it, this is the number to raise.
 */
const FLOORS: Record<(typeof PARITY_LANGS)[number], number> = {
  typescript: 0.991,
  tsx: 0.997,
  javascript: 0.996,
  jsx: 0.991,
  json: 0.999,
  css: 0.981,
  yaml: 0.987,
  markdown: 0.989,
  // Both take shiki's own path for the fixtures that TanStack misreads, so their floor is its answer
  bash: 0.995,
  dockerfile: 0.999,
  python: 0.985,
  html: 0.999,
  diff: 0.99,
};

test('every language keeps shiki\'s colours over the frozen corpus', { timeout: 600_000 }, async () => {
  const measured: string[] = [];
  const failures: string[] = [];
  for (const lang of PARITY_LANGS) {
    const blocks = corpusFixtures(lang);
    assert.ok(blocks.length > 0, `${lang}: no corpus`);
    let chars = 0;
    let same = 0;
    for (const block of blocks) {
      const p = await parity(block, lang);
      chars += p.chars;
      same += p.same;
    }
    const share = same / chars;
    measured.push(`${lang} ${(100 * share).toFixed(2)}%`);
    if (share < FLOORS[lang]) failures.push(`${lang}: ${(100 * share).toFixed(2)}% of ${chars} characters, floor ${(100 * FLOORS[lang]).toFixed(1)}%`);
  }
  assert.deepEqual(failures, [], `measured: ${measured.join(', ')}`);
});
