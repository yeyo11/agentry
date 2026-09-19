import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdown } from '@tanstack/markdown/parser';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../src/components/controls/Tooltip.tsx';
import Markdown, { pieceOptions } from '../src/components/Markdown.tsx';
import { splitMarkdownBlocks, type BlockSplit } from '../src/lib/markdown-blocks.ts';
import { ANSWERS } from './fixtures/answers.ts';

const html = (text: string, streaming: boolean) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { text, streaming })));

/** Every prefix a stream delivering `step` characters at a time shows, and the final text. */
function prefixes(text: string, step: number): string[] {
  const out: string[] = [];
  for (let end = step; end < text.length; end += step) out.push(text.slice(0, end));
  out.push(text);
  return out;
}

function assertSameMarkup(text: string, label: string) {
  assert.equal(html(text, true), html(text, false), `${label}: ${JSON.stringify(text.slice(-80))}`);
}

for (const [name, answer] of Object.entries(ANSWERS)) {
  test(`${name}: every prefix of a 24-character stream renders the same cut into blocks as whole`, () => {
    for (const prefix of prefixes(answer, 24)) assertSameMarkup(prefix, name);
  });

  test(`${name}: the split kept across updates equals the split made from scratch`, () => {
    let kept: BlockSplit | null = null;
    for (const prefix of prefixes(answer, 1)) {
      kept = splitMarkdownBlocks(kept, prefix);
      assert.deepEqual(kept.starts, splitMarkdownBlocks(null, prefix).starts, JSON.stringify(prefix.slice(-80)));
    }
  });
}

test('answers really are cut, so the equivalence above is not vacuous', () => {
  const blocks = (text: string) => splitMarkdownBlocks(null, text).starts.length;
  assert.ok(blocks(ANSWERS.REVIEW) >= 8, `REVIEW: ${blocks(ANSWERS.REVIEW)}`);
  assert.ok(blocks(ANSWERS.CODE) >= 6, `CODE: ${blocks(ANSWERS.CODE)}`);
  assert.ok(blocks(ANSWERS.NESTED) >= 4, `NESTED: ${blocks(ANSWERS.NESTED)}`);
});

test('a blank line inside a fence, a list or a quote is not a cut', () => {
  const pieces = (text: string) => {
    const { text: source, starts } = splitMarkdownBlocks(null, text);
    return starts.map((start, index) => source.slice(start, starts[index + 1]));
  };
  assert.deepEqual(pieces('```\na\n\nb\n```\n\nafter\n'), ['```\na\n\nb\n```\n\n', 'after\n']);
  assert.deepEqual(pieces('- a\n\n- b\n\n  more b\n\nafter\n'), ['- a\n\n- b\n\n  more b\n\n', 'after\n']);
  assert.deepEqual(pieces('> a\n\n> b\n\nafter\n'), ['> a\n\n> b\n\n', 'after\n']);
});

test('a block after a blank line is only cut off once its first line is complete', () => {
  // `-` alone opens a list item that would carry on the list above
  assert.deepEqual(splitMarkdownBlocks(null, '- a\n\n-').starts, [0]);
  assert.deepEqual(splitMarkdownBlocks(null, '- a\n\nb').starts, [0]);
  assert.deepEqual(splitMarkdownBlocks(null, '- a\n\nb\n').starts, [0, 5]);
});

test('reference definitions and frontmatter keep the answer whole', () => {
  assert.deepEqual(splitMarkdownBlocks(null, 'see [docs][d]\n\nmore\n\n[d]: https://example.com\n').starts, [0]);
  assert.deepEqual(splitMarkdownBlocks(null, 'a[^1]\n\nb\n\n[^1]: note\n').starts, [0]);
  assert.deepEqual(splitMarkdownBlocks(null, '---\ntitle: x\n---\n\nbody\n\nmore\n').starts, [0]);
  for (const text of ['see [docs][d]\n\nmore\n\n[d]: https://example.com\n', 'a[^1] b[^2]\n\nb\n\n[^1]: one\n[^2]: two\n', '---\ntitle: x\n---\n\nbody\n'])
    for (const prefix of prefixes(text, 1)) assertSameMarkup(prefix, 'whole-document');
});

test('`---` lines in a later block are rules, not frontmatter', () => {
  for (const prefix of prefixes('text\n\n---\ntitle\n---\n\nmore\n', 1)) assertSameMarkup(prefix, 'rules');
});

test('carriage returns and a byte order mark are cut the way the parser reads them', () => {
  for (const prefix of prefixes('\uFEFF# Title\r\n\r\ntext\r\n\r\n- a\r\n\r\n- b\r\n', 1)) assertSameMarkup(prefix, 'crlf');
});

/** Deterministic, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// Lines chosen to sit on the parser's edges: markers, indents, fences, quotes, tables and blanks
const LINES = [
  '',
  '',
  '',
  'plain text',
  'text with `code` and **bold**',
  '# heading',
  '#',
  '- item',
  '-',
  '* star',
  '1. one',
  '2. two',
  '  - nested',
  '  indented',
  '    code-ish',
  '   ```',
  '```',
  '```ts',
  '~~~',
  '````',
  '> quote',
  '>',
  '> - quoted item',
  '| a | b |',
  '| - | - |',
  '---',
  '***',
  '\tTabbed',
  '- [ ] task',
  '3. three',
  '1) paren',
  '+ plus',
  '      deep',
  '> > nested quote',
  ' | x |',
];

/** The blocks Markdown renders for `text` cut up, next to the ones it renders for `text` whole. */
function blocksBothWays(text: string, split: BlockSplit) {
  const { text: source, starts } = split;
  const cut = starts.flatMap(
    (start, index) => parseMarkdown(source.slice(start, starts[index + 1]), pieceOptions(index, starts.length)).children,
  );
  return { cut, whole: parseMarkdown(text, pieceOptions(0, 1)).children };
}

// Rendering is a function of the parsed blocks alone, so equal blocks mean equal markup; comparing
// blocks instead of markup lets this cover many more documents in the same time
test('random documents parse into the same blocks cut up as whole, at every prefix', () => {
  const next = random(7);
  let cuts = 0;
  for (let doc = 0; doc < 250; doc++) {
    const count = 4 + Math.floor(next() * 16);
    const lines = Array.from({ length: count }, () => LINES[Math.floor(next() * LINES.length)] ?? '');
    const text = `${lines.join('\n')}\n`;
    let kept: BlockSplit | null = null;
    for (const prefix of prefixes(text, 1)) {
      kept = splitMarkdownBlocks(kept, prefix);
      assert.deepEqual(kept.starts, splitMarkdownBlocks(null, prefix).starts, `random #${doc}`);
      const { cut, whole } = blocksBothWays(prefix, kept);
      assert.deepEqual(cut, whole, `random #${doc}: ${JSON.stringify(prefix)}`);
      cuts += kept.starts.length - 1;
    }
  }
  assert.ok(cuts > 5_000, `only ${cuts} cuts`);
});
