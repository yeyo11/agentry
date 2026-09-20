import assert from 'node:assert/strict';
import test from 'node:test';
import { bundledThemes } from 'shiki/themes';
import { highlight, PALETTE, type Segment } from '../src/components/highlight.ts';

const text = (lines: Segment[][]) => lines.map((line) => line.map((run) => (typeof run === 'string' ? run : run.content)).join('')).join('\n');

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

test('the first block in a grammar shiki compiles on the spot is still coloured', async () => {
  // C++ is not one of the languages the lighter highlighter covers, so it takes shiki's path,
  // where the first call compiles the grammar inside the per-line time budget.
  const out = await highlight('template <typename T> auto twice(const T& x) -> T { return x + x; } int main() { return twice(21); }', 'cpp');
  assert.ok(out);
  const styled = out.lines.flat().filter((run) => typeof run !== 'string');
  assert.ok(styled.length >= 3, `expected keywords, types and literals coloured, got ${styled.length} runs`);
});
