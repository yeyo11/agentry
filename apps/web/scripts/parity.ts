// Colour parity of the TanStack path against shiki, on this repository's own files: how many of
// the characters a reader sees are coloured the same, per language, and what the rest are.
//
//   pnpm --filter @agentry/web parity              every language, the ten biggest differences each
//   pnpm --filter @agentry/web parity typescript css --all  those languages, every difference
//   pnpm --filter @agentry/web parity --fixtures   only the frozen corpus the parity test holds
//   pnpm --filter @agentry/web parity --context    each difference with lines it happens on
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpusFixtures } from '../test/parity-corpus.ts';
import { PARITY_LANGS, parity, type Difference } from '../test/parity.ts';

const root = join(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const fixturesOnly = args.includes('--fixtures');
const context = args.includes('--context');
const only = args.filter((a) => !a.startsWith('--'));

/** Language as highlight() and shiki both name it → the repository's files in it */
const GLOBS: Record<string, string[]> = {
  typescript: ['*.ts'],
  tsx: ['*.tsx'],
  javascript: ['*.js', '*.mjs'],
  json: ['*.json'],
  css: ['*.css'],
  yaml: ['*.yml', '*.yaml'],
  markdown: ['*.md'],
  bash: ['*.sh'],
  html: ['*.html'],
  dockerfile: ['**/Dockerfile'],
};

/**
 * A file longer than highlight()'s own limit, cut into blocks. Only blank lines are cut on: a cut
 * inside a declaration would measure how each engine copes with a fragment, not how they colour
 * code. A stretch with no blank line at all is cut where the limit falls.
 */
function chunks(code: string, want = 20_000, max = 55_000): string[] {
  const out: string[] = [];
  let rest = code;
  while (rest.length > max) {
    // A cut lands where a top-level construct starts, so neither engine reads half of one
    const blank = rest.slice(0, max).search(new RegExp(`(?<=[\\s\\S]{${want}})\\n\\n(?=\\S)`));
    const cut = blank >= 0 && blank < max ? blank : max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut + 2);
  }
  return rest ? [...out, rest] : out;
}

const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });

function corpus(lang: string): string[] {
  if (fixturesOnly) return corpusFixtures(lang);
  const files = GLOBS[lang] ? git('ls-files', '--', ...GLOBS[lang]).split('\n').filter(Boolean) : [];
  // The lockfile is YAML but machine-written: one shape repeated thousands of times would drown the rest
  const own = files.filter((f) => f !== 'pnpm-lock.yaml' && f !== 'CHANGELOG.md').map((f) => readFileSync(join(root, f), 'utf8'));
  // The diffs a reader meets: commits, with their message
  if (lang === 'diff') for (const sha of git('log', '-n', '40', '--format=%h').split('\n').filter(Boolean)) own.push(git('show', sha));
  // A fixture copied from the repository is counted once
  return [...new Set([...own, ...corpusFixtures(lang)])].flatMap((c) => chunks(c.replace(/\r\n/g, '\n')));
}

const pct = (n: number, of: number) => `${((100 * n) / of).toFixed(2)}%`;
for (const lang of only.length ? only : PARITY_LANGS) {
  const blocks = corpus(lang);
  let chars = 0;
  let same = 0;
  const grouped = new Map<string, { count: number; examples: Set<string>; lines: string[] } & Omit<Difference, 'text' | 'line'>>();
  for (const block of blocks) {
    const p = await parity(block, lang);
    chars += p.chars;
    same += p.same;
    for (const d of p.differences) {
      const key = `${d.scope}|${d.ours}|${d.theirs}`;
      const g = grouped.get(key) ?? { count: 0, examples: new Set<string>(), lines: [], scope: d.scope, ours: d.ours, theirs: d.theirs };
      if (g.lines.length < 4) g.lines.push(`${JSON.stringify(d.text.slice(0, 30))} in ${d.line.trim().slice(0, 140)}`);
      g.count += d.text.replace(/\s/g, '').length;
      if (g.examples.size < 6) g.examples.add(d.text.length > 40 ? `${d.text.slice(0, 40)}…` : d.text);
      grouped.set(key, g);
    }
  }
  console.log(`\n${lang}: ${blocks.length} blocks, ${chars} characters, ${pct(same, chars)} the same (${chars - same} differ)`);
  const sorted = [...grouped.values()].sort((a, b) => b.count - a.count);
  for (const g of all ? sorted : sorted.slice(0, 10)) {
    console.log(`  ${String(g.count).padStart(6)}  ${g.scope || '(no scope)'}  ours ${g.ours} vs ${g.theirs}  ${[...g.examples].map((e) => JSON.stringify(e)).join(' ')}`);
    if (context) for (const line of g.lines) console.log(`            ${line}`);
  }
}
