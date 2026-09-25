// Tokens only (docs/design-system.md §1 and §6): no stylesheet but tokens.css may hold a raw
// colour, a pixel radius or a millisecond value. A value typed into a page's CSS drifts from the
// theme the day the tokens change, and never follows the light theme at all.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TOKENS = 'styles/tokens.css';

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

interface Declaration {
  file: string;
  line: number;
  property: string;
  value: string;
  /** Every declaration of the innermost rule it sits in */
  block: string;
}

/** The declarations of every innermost `{ … }` block, with the line each starts on. */
function declarations(file: string, css: string): Declaration[] {
  const found: Declaration[] = [];
  for (const match of css.matchAll(/\{([^{}]*)\}/g)) {
    const block = match[1] ?? '';
    let offset = (match.index ?? 0) + 1;
    for (const part of block.split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) {
        const property = part.slice(0, colon).trim().toLowerCase();
        const leading = part.length - part.trimStart().length;
        const line = css.slice(0, offset + leading).split('\n').length;
        found.push({ file, line, property, value: part.slice(colon + 1).trim(), block });
      }
      offset += part.length + 1;
    }
  }
  return found;
}

const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
const WHITE = /^#fff(?:fff)?$/i;
const PX = /\d(?:\.\d+)?px\b/;
const TIME = /(?<![\w.-])\d*\.?\d+m?s\b/;

/** `#fff` is allowed as text on the gradient: in a rule that paints the gradient itself. */
function isTextOnGradient(d: Declaration, colour: string): boolean {
  return WHITE.test(colour) && /^(color|fill|stroke|background-color)$/.test(d.property) && /var\(--(grad|gradient-accent)\)/.test(d.block);
}

function violations(d: Declaration): string[] {
  const where = `${d.file}:${d.line} ${d.property}: ${d.value}`;
  const out: string[] = [];
  for (const colour of d.value.match(new RegExp(COLOUR.source, 'gi')) ?? []) {
    if (!isTextOnGradient(d, colour)) out.push(`colour ${colour} — ${where}`);
  }
  if (/radius/.test(d.property) && PX.test(d.value)) out.push(`px radius — ${where}`);
  if (/^(transition|animation)/.test(d.property) && TIME.test(d.value)) out.push(`raw duration — ${where}`);
  return out;
}

test('stylesheets take colours, radii and durations from tokens.css only', () => {
  const files = cssFiles(SRC).filter((path) => relative(SRC, path) !== TOKENS);
  assert.ok(files.length > 10, 'found the app stylesheets');
  const found = files.flatMap((path) => declarations(relative(SRC, path), stripComments(readFileSync(path, 'utf8'))).flatMap(violations));
  assert.deepEqual(found, []);
});

test('the guard catches what it is meant to catch', () => {
  const check = (css: string) => declarations('x.css', css).flatMap(violations);
  assert.equal(check('.a { color: #e58a63; }').length, 1);
  assert.equal(check('.a { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); }').length, 1);
  assert.equal(check('.a { border-radius: 7px; }').length, 1);
  assert.equal(check('.a { border-radius: calc(var(--radius) - 3px); }').length, 1);
  assert.equal(check('.a { animation: spin 0.7s linear infinite; }').length, 1);
  assert.equal(check('.a { transition: color var(--dur-fast, 120ms); }').length, 1);
  assert.equal(check('.a { color: #fff; }').length, 1, '#fff away from the gradient');
  assert.deepEqual(check('.a { background: var(--grad); color: #fff; }'), []);
  assert.deepEqual(check('.a { border-radius: var(--radius-pill); animation: spin var(--spin-cycle) steps(10) infinite; color: var(--text); }'), []);
});

test('the light theme is the same whether chosen or asked for by the OS', () => {
  const css = stripComments(readFileSync(join(SRC, TOKENS), 'utf8'));
  const chosen = /:root\[data-theme='light'\]\s*\{([^}]*)\}/.exec(css)?.[1];
  const system = /:root\[data-theme='system'\]\s*\{([^}]*)\}/.exec(css)?.[1];
  assert.ok(chosen && system, 'both light blocks exist');
  const normalise = (block: string) => block.split(';').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(normalise(system), normalise(chosen));
});

test('the light theme only follows the OS under the system preference', () => {
  const css = stripComments(readFileSync(join(SRC, TOKENS), 'utf8'));
  for (const media of css.matchAll(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*([^{]+)\{/g)) {
    assert.equal(media[1]?.trim(), ":root[data-theme='system']");
  }
});
