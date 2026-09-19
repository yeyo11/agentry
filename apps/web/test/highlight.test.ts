import assert from 'node:assert/strict';
import test from 'node:test';
import { highlight, type Segment } from '../src/components/highlight.ts';

const text = (lines: Segment[][]) => lines.map((line) => line.map((run) => (typeof run === 'string' ? run : run.content)).join('')).join('\n');

test('merging tokens into runs keeps every character and loses no colour', async () => {
  const code = 'const answer = compute(1, "two"); // three\nexport default answer;';
  const out = await highlight(code, 'typescript');
  assert.ok(out);
  assert.equal(text(out.lines), code);
  // Text in the theme's own foreground is left bare: the block carries that colour
  const bare = out.lines.flat().filter((run) => typeof run === 'string');
  assert.ok(bare.includes(' '), 'foreground whitespace is not wrapped in a span');
  // Neighbouring runs never share a colour, or they would have been one
  for (const line of out.lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      if (a === undefined || b === undefined || typeof a === 'string' || typeof b === 'string') continue;
      assert.notDeepEqual(a.style, b.style);
    }
  }
});

test('the block carries both themes\' foreground for the runs left bare', async () => {
  const out = await highlight('{ "a": 1 }', 'json');
  assert.ok(out);
  assert.match(out.base['--shiki-light'] ?? '', /^#[0-9a-f]{6}$/i);
  assert.match(out.base['--shiki-dark'] ?? '', /^#[0-9a-f]{6}$/i);
});

test('an unknown language is left plain', async () => {
  assert.equal(await highlight('whatever', 'not-a-language'), null);
});
