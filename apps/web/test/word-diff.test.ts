import assert from 'node:assert/strict';
import test from 'node:test';
import { similarity, tokenize, wordDiff, type Range } from '../src/lib/word-diff.ts';

// The changed words of a pair of lines: one mark per changed phrase (design system §5).

const marked = (line: string, ranges: Range[]) => ranges.map(([s, e]) => line.slice(s, e));

test('tokens are words, whitespace runs and single punctuation', () => {
  assert.deepEqual(
    tokenize('a_b  = f(x1);').map((t) => t.text),
    ['a_b', '  ', '=', ' ', 'f', '(', 'x1', ')', ';'],
  );
  assert.deepEqual(tokenize('año→ñu').map((t) => t.text), ['año', '→', 'ñu']);
});

test('a changed number is one mark on each side', () => {
  const a = "  return execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });";
  const b = "  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });";
  const d = wordDiff(a, b);
  assert.deepEqual(marked(a, d.old), ['32']);
  assert.deepEqual(marked(b, d.new), ['64']);
});

test('changed tokens separated only by whitespace are one phrase', () => {
  const a = "import type { ChangedFile, Commit } from '@agentry/shared';";
  const b = "import type { ChangedFile, Commit, DiffContext } from '@agentry/shared';";
  const d = wordDiff(a, b);
  assert.deepEqual(d.old, []);
  assert.deepEqual(marked(b, d.new), [', DiffContext']);
  const c = ' * other side, so what the worker has not committed yet is part of it.';
  const e = ' * other side, so what the worker has not committed yet is part of it. `context` is the number of';
  assert.deepEqual(marked(e, wordDiff(c, e).new), ['`context` is the number of']);
});

test('between equal choices the earlier token is kept', () => {
  const a = "  const args = ['diff', '--no-color', '--find-renames', base];";
  const b = "  const args = ['diff', '--no-color', '--find-renames', `--unified=${unified}`, base];";
  assert.deepEqual(marked(b, wordDiff(a, b).new), ['`--unified=${unified}`,']);
});

test('whitespace alone never counts', () => {
  assert.deepEqual(wordDiff('  if (a) {', '    if (a)  {'), { old: [], new: [] });
  assert.deepEqual(wordDiff('same', 'same'), { old: [], new: [] });
});

test('a line over 400 characters or 200 tokens is marked whole', () => {
  const long = `  ${'x'.repeat(401)}`;
  assert.deepEqual(wordDiff(long, 'y'), { old: [[2, 403]], new: [[0, 1]] });
  const many = Array.from({ length: 120 }, (_, k) => `a${k}`).join(',');
  const d = wordDiff(many, `${many}!`);
  assert.deepEqual(d.new, [[0, many.length + 1]]);
});

test('similarity is 1 for the same line and low for different ones', () => {
  assert.equal(similarity('  a = 1;', 'a = 1;'), 1);
  assert.ok(similarity('maxBuffer: 32 * 1024', 'maxBuffer: 64 * 1024') > 0.7);
  assert.ok(similarity('export function fileDiff(dir)', "const unified = context === 'full'") < 0.45);
  assert.equal(similarity('', 'x'), 0);
});
