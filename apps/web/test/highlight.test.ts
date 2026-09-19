import assert from 'node:assert/strict';
import test from 'node:test';
import { codeToTokens, type BundledLanguage } from 'shiki';
import { bundledThemes } from 'shiki/themes';
import { highlight, PALETTE, type Highlighted, type Segment } from '../src/components/highlight.ts';

const text = (lines: Segment[][]) => lines.map((line) => line.map((run) => (typeof run === 'string' ? run : run.content)).join('')).join('\n');

/** The light colour every character of a highlighted block ends up in */
const colours = (out: Highlighted) =>
  out.lines.flatMap((line, i) => [
    ...(i > 0 ? ['\n'] : []),
    ...line.flatMap((run) => {
      const colour = (typeof run === 'string' ? out.base['--shiki-light'] : run.style['--shiki-light'])!.toLowerCase();
      return [...(typeof run === 'string' ? run : run.content)].map(() => colour);
    }),
  ]);

const SAMPLES: Partial<Record<BundledLanguage, string>> = {
  typescript: `import { readFile } from 'node:fs/promises';
import type { RunEvent } from './events';

const LIMIT = 200;
/** Newest first */
export async function load(path: string, limit = LIMIT): Promise<RunEvent[] | null> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  const events = raw.split('\\n').filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
  return events.length > limit ? events.slice(-limit) : events;
}

export class Store {
  private readonly rows = new Map<string, number>();
  count(id: string): number {
    return this.rows.get(id) ?? 0;
  }
}`,
  tsx: `import { useState } from 'react';
import { CopyButton } from './ui';

export function Card({ title, items }: { title: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card" onClick={() => setOpen(!open)}>
      <h2>{title}</h2>
      {open && items.map((item) => <p key={item}>{item}</p>)}
      <CopyButton text={title} label="Copy" />
    </section>
  );
}`,
  json: `{
  "name": "@agentry/web",
  "private": true,
  "version": "0.11.1",
  "scripts": { "build": "vite build", "test": "tsx --test test/*.test.ts" },
  "files": [1, 2.5, null]
}`,
  css: `.code-block.has-header > .code {
  margin: 0 4px 10%;
  color: var(--shiki-dark);
  border: 1px solid rgba(0, 0, 0, 0.1) !important;
  display: flex;
}
pre:hover span[style] { opacity: 0.5; }`,
  yaml: `name: CI
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest # pinned image
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: |
          pnpm install --frozen-lockfile
          pnpm test`,
  bash: `#!/usr/bin/env bash
set -euo pipefail
# Build and test
cd apps/web && pnpm build 2>&1 | tail -5
VERSION="\${1:-latest}"
if [ -z "$VERSION" ]; then
  echo "no version" >&2
  exit 1
fi
for f in dist/*.js; do wc -c "$f"; done
git log --oneline -5 | grep -v wip`,
  python: `import json


class Store:
    """Rows by id."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.rows = {}

    def load(self):
        with open(self.path) as f:
            for line in f:
                row = json.loads(line)
                if isinstance(row, dict) and len(row) > 0:
                    self.rows[row["id"]] = row
        return self.rows  # all of them`,
  markdown: `# Agentry

A **REST API** and [web UI](https://example.com) around \`claude\`.

- one
- two

\`\`\`bash
pnpm install
\`\`\``,
};

const MIN_SAME = 0.85;
const MAX_OTHER_HUE = 0.05;

test('every sample reads like shiki with the GitHub themes, character by character', async () => {
  const failures: string[] = [];
  for (const [lang, code] of Object.entries(SAMPLES) as [BundledLanguage, string][]) {
    const out = await highlight(code, lang);
    assert.ok(out, lang);
    assert.equal(text(out.lines), code, `${lang} keeps every character`);
    const ours = colours(out);
    const { tokens } = await codeToTokens(code, { lang, theme: 'github-light-default' });
    const theirs = tokens.flatMap((line, i) => [...(i > 0 ? ['\n'] : []), ...line.flatMap((t) => [...t.content].map(() => (t.color ?? PALETTE.fg[0]).toLowerCase()))]);
    let chars = 0;
    let same = 0;
    let otherHue = 0;
    for (let i = 0; i < code.length; i++) {
      if (/\s/.test(code[i]!)) continue;
      chars++;
      if (ours[i] === theirs[i]) same++;
      else if (ours[i] !== PALETTE.fg[0] && theirs[i] !== PALETTE.fg[0]) otherHue++;
    }
    // Where they differ, it is mostly one leaving plain what the other colours, rarely a different colour
    const pct = (n: number) => `${((100 * n) / chars).toFixed(1)}%`;
    if (same / chars < MIN_SAME || otherHue / chars > MAX_OTHER_HUE) failures.push(`${lang}: ${pct(same)} match, ${pct(otherHue)} in another colour`);
  }
  assert.deepEqual(failures, []);
});

test('the palette is the GitHub themes\' own colours for the scopes it stands for', async () => {
  const SCOPES: Record<Exclude<keyof typeof PALETTE, 'fg'>, string> = {
    comment: 'comment',
    keyword: 'keyword',
    constant: 'constant',
    entity: 'entity.name',
    function: 'entity.name.function',
    tag: 'entity.name.tag',
    string: 'string',
    deleted: 'markup.deleted',
  };
  for (const [i, name] of (['github-light-default', 'github-dark-default'] as const).entries()) {
    const theme = (await bundledThemes[name]()).default;
    const colourOf = (scope: string) =>
      theme.tokenColors?.find((rule) => (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).includes(scope) && rule.settings.foreground)?.settings.foreground?.toLowerCase();
    assert.equal(PALETTE.fg[i], theme.colors?.['editor.foreground']?.toLowerCase(), `${name} fg`);
    for (const [role, scope] of Object.entries(SCOPES)) assert.equal(PALETTE[role as keyof typeof SCOPES][i], colourOf(scope), `${name} ${role}`);
  }
});

test('merging tokens into runs keeps every character and loses no colour', async () => {
  const code = 'const answer = compute(1, "two"); // three\nexport default answer;';
  for (const lang of ['typescript', 'rust']) {
    const out = await highlight(code, lang);
    assert.ok(out);
    assert.equal(text(out.lines), code);
    // Text in the theme's own foreground is left bare: the block carries that colour
    const bare = out.lines.flat().filter((run) => typeof run === 'string');
    assert.ok(bare.some((run) => run.includes(' ')), 'foreground whitespace is not wrapped in a span');
    // Neighbouring runs never share a colour, or they would have been one
    for (const line of out.lines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1];
        const b = line[i];
        if (a === undefined || b === undefined || typeof a === 'string' || typeof b === 'string') continue;
        assert.notDeepEqual(a.style, b.style);
      }
    }
  }
});

test('both engines hand the block the same foreground', async () => {
  const tanstack = await highlight('{ "a": 1 }', 'json');
  const shiki = await highlight('fn main() {}', 'rust');
  assert.ok(tanstack && shiki);
  assert.deepEqual(
    Object.fromEntries(Object.entries(tanstack.base).map(([k, v]) => [k, v.toLowerCase()])),
    Object.fromEntries(Object.entries(shiki.base).map(([k, v]) => [k, v.toLowerCase()])),
  );
  assert.match(tanstack.base['--shiki-dark'] ?? '', /^#[0-9a-f]{6}$/i);
});

test('a shell line tells commands from their arguments', async () => {
  const out = await highlight('cd web && pnpm test 2>&1 | tail -5', 'bash');
  assert.ok(out);
  const role = (word: string) => {
    const run = out.lines[0]!.find((r) => typeof r !== 'string' && r.content === word);
    return run && typeof run !== 'string' ? run.style['--shiki-light'] : undefined;
  };
  assert.equal(role('cd'), PALETTE.constant[0]);
  assert.equal(role('pnpm'), PALETTE.entity[0]);
  assert.equal(role('tail'), PALETTE.entity[0]);
  assert.equal(role('-5'), PALETTE.constant[0]);
});

test('an unknown language is left plain', async () => {
  assert.equal(await highlight('whatever', 'not-a-language'), null);
});
