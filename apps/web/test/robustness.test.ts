// What highlight() must do with input nobody meant it to read: never throw, never change a
// character of the text, and never hand a block to a tokenizer that would take seconds over it.
// The shapes here are the ones that broke it: nesting deep enough to overflow a stack, openers
// with no closer, quotes that never end, CRLF, tabs and text that is not code at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { highlight, PALETTE, type Highlighted } from '../src/components/highlight.ts';

/** Every language the lighter highlighter takes, by the name a fence uses */
const LANGS = ['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'yaml', 'markdown', 'bash', 'python', 'html', 'diff'];
/** Two shiki takes, whose tokenizer is slow enough that a shorter block says as much */
const SHIKI_LANGS = ['dockerfile', 'rust'];

const text = (out: Highlighted) => out.lines.map((line) => line.map((run) => (typeof run === 'string' ? run : run.content)).join('')).join('\n');

/** Highlighted or left plain, the text must come out as it went in */
async function keepsText(code: string, lang: string, what: string) {
  const out = await highlight(code, lang).catch((e: unknown) => {
    assert.fail(`${lang} threw on ${what}: ${(e as Error).message}`);
  });
  if (out) assert.equal(text(out), code, `${lang} changed ${what}`);
  return out;
}

/** A pattern repeated to `length`, and the same short */
const sizes = (seed: string, length: number) => [seed.repeat(Math.ceil(length / seed.length)).slice(0, length), seed.repeat(3)];

/** Shapes that broke a tokenizer: unclosed brackets, quotes, tags, fences, heredocs, escapes */
const SHAPES = [
  '`${', '${', '{', '}', '(', ')', '[', ']', '<', '>', '</', '<a', '<a "', '<a b=', '<a>', '<>', '/>', '"', "'", '`', '\\', '/', '/*', '*/', '<!--', '#',
  'a/', 'a<b ', 'f(a ', '{ a: ', 'const a = {', 'function f(', 'class A extends ', 'type A<', 'import {', 'x?.', '=>', '?', ':', '@',
  '```\n', '```ts\n', '[', '[a](', '![', '- ', '| a ', '>', '*', '_',
  '<<EOF\n', '$(', 'case a in ', 'a | ', '\\\n', '"""', "'''", 'def a(', 'f"{', '@@ ', '+', '-', 'RUN ', 'a: ', 'a: |\n', '- ',
  '\r\n', '\t', '\u0000', '\u00e9', '👋', '\u200b', 'ñ = "á"\n', '日本語\n', 'a\u0301\n',
];

async function shapes(langs: string[], length: number) {
  for (const seed of SHAPES) {
    for (const code of sizes(seed, length)) {
      for (const lang of langs) {
        const started = performance.now();
        await keepsText(code, lang, JSON.stringify(seed.slice(0, 12)));
        const ms = performance.now() - started;
        // Generous: a loaded machine is slow, but a quadratic scan over a whole block is slower
        assert.ok(ms < 30_000, `${lang} took ${ms.toFixed(0)} ms over ${code.length} characters of ${JSON.stringify(seed)}`);
      }
    }
  }
}

// 20 000 characters is past every guard — hundreds of unclosed openers, a line whose cost is over
// budget — and short enough that the whole matrix runs in a fraction of the time 59 000 takes
test('no shape of input throws, hangs or changes the text', { timeout: 600_000 }, () => shapes(LANGS, 20_000));

test('the same shapes are safe on shiki\'s side', { timeout: 600_000 }, () => shapes(SHIKI_LANGS, 3_000));

test('a block of 59 000 characters of one shape is still read in time', { timeout: 600_000 }, () => shapes(['ts', 'markdown', 'bash', 'yaml'], 59_000));

test('random text is coloured or left plain, never changed', { timeout: 300_000 }, async () => {
  // A fixed sequence, so a failure can be repeated: xorshift over the characters code is made of
  let state = 0x2545f491;
  const random = () => ((state ^= state << 13), (state ^= state >>> 17), (state ^= state << 5), (state >>> 0) / 0x100000000);
  const alphabet = [...'abcdefghijklmnopqrstuvwxyzABZ0123456789 \n\t\r{}[]()<>"\'`\\/*#@$%&|;:,.?!-_=+~^áéñ日👋\u200b\u0000'];
  for (let i = 0; i < 300; i++) {
    const length = Math.floor(random() * 4000);
    let code = '';
    for (let k = 0; k < length; k++) code += alphabet[Math.floor(random() * alphabet.length)];
    const lang = [...LANGS, ...SHIKI_LANGS][Math.floor(random() * (LANGS.length + SHIKI_LANGS.length))]!;
    await keepsText(code, lang, `random block ${i}`);
  }
});

test('a line longer than a page is read without a pause', { timeout: 120_000 }, async () => {
  const line = `const a = ${'"x" + '.repeat(8000)}1;`;
  const started = performance.now();
  await keepsText(line, 'ts', 'one very long line');
  assert.ok(performance.now() - started < 30_000, 'a single long line took too long');
});

test('CRLF, tabs and unbalanced quotes keep every character', async () => {
  const cases: [string, string][] = [
    ['ts', 'const a = 1;\r\n\tif (a) {\r\n\t\treturn "unclosed;\r\n'],
    ['yaml', 'a:\r\n  - "b\r\n  - c\t# d\r\n'],
    ['markdown', '# T\r\n\r\n```ts\r\nconst a = `x;\r\n```\r\n'],
    ['bash', 'echo "a $(b \'c\r\n'],
    ['python', 'def f():\r\n\treturn f"{a\r\n'],
    ['css', '.a { color: red\r\n'],
    ['html', '<p class="a\r\n'],
    ['json', '{"a": "b\r\n'],
  ];
  for (const [lang, code] of cases) await keepsText(code, lang, 'CRLF and unbalanced quotes');
});

test('a language TanStack cannot take falls back to shiki, an unknown one stays plain', async () => {
  const rust = await highlight('fn main() { let x: u8 = 1; }', 'rust');
  assert.ok(rust, 'rust is shiki\'s');
  assert.ok(rust.lines.flat().some((run) => typeof run !== 'string'), 'rust is coloured');
  assert.equal(await highlight('whatever', 'not-a-language'), null);
  // A shell block whose `$( … " … )` TanStack reads wrongly: shiki colours it, comments included
  const shell = await highlight('root="$(dirname "$0")"\n# a comment\necho "$root"\n', 'bash');
  assert.ok(shell);
  const comment = shell.lines[1]?.find((run) => typeof run !== 'string' && run.content.includes('# a comment'));
  assert.ok(comment && typeof comment !== 'string' && comment.style['--shiki-light']?.toLowerCase() === PALETTE.comment[0], 'the comment after a misread string is a comment');
});

test('what a block already showed while it streamed keeps its colours when it ends', { timeout: 600_000 }, async () => {
  const colours = (out: Highlighted) => out.lines.map((line) => line.flatMap((run) => (typeof run === 'string' ? [...run].map(() => 'fg') : [...run.content].map(() => run.style['--shiki-light']!))));
  const dir = join(import.meta.dirname, 'fixtures/parity');
  const LANG: Record<string, string> = { typescript: 'ts', tsx: 'tsx', javascript: 'js', jsx: 'jsx', json: 'json', css: 'css', yaml: 'yaml', markdown: 'md', python: 'py', html: 'html', diff: 'diff' };
  for (const [name, lang] of Object.entries(LANG)) {
    let lines = 0;
    let same = 0;
    for (const file of readdirSync(join(dir, name))) {
      const code = readFileSync(join(dir, name, file), 'utf8');
      const whole = await highlight(code, lang);
      assert.ok(whole);
      const finished = colours(whole);
      const rows = code.split('\n');
      for (let n = 1; n < rows.length; n += Math.max(1, Math.floor(rows.length / 8))) {
        const part = await highlight(rows.slice(0, n).join('\n'), lang);
        assert.ok(part);
        const streaming = colours(part);
        // Every line but the one still being written: what the reader is already looking at
        for (let i = 0; i < n - 1; i++) {
          lines++;
          if (JSON.stringify(streaming[i]) === JSON.stringify(finished[i])) same++;
        }
      }
    }
    // JSX is the one that moves: an element whose tag is not closed yet is not a tag yet
    assert.ok(same / lines >= (lang === 'jsx' || lang === 'tsx' ? 0.99 : 1), `${lang}: ${((100 * same) / lines).toFixed(2)}% of ${lines} streamed lines kept their colours`);
  }
});
