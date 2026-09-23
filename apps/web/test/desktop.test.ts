import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { titleBarTheme } from '../src/lib/desktop.ts';

// The desktop app paints its window controls with the top bar's colours, which the page reads from
// its own tokens and the shell accepts only as hex.

const style = (vars: Record<string, string>) => ({ getPropertyValue: (name: string) => vars[name] ?? '' });

test('the title bar takes the top bar background and the text colour', () => {
  assert.deepEqual(titleBarTheme(style({ '--bg': ' #0a0a0c', '--text': '#ededf0 ' })), { color: '#0a0a0c', symbolColor: '#ededf0' });
});

test('no title bar colours until the stylesheet has applied, or when a token is not a hex colour', () => {
  assert.equal(titleBarTheme(style({})), null);
  assert.equal(titleBarTheme(style({ '--bg': 'rgb(0 0 0)', '--text': '#fff' })), null);
});

test('every theme block defines --bg and --text as hex, so the title bar can follow it', () => {
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  const values = (name: string) => [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1]?.trim() ?? '');
  for (const name of ['--bg', '--text']) {
    const found = values(name);
    assert.ok(found.length >= 2, `${name} is set for the dark and the light theme`);
    for (const value of found) assert.match(value, /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, `${name}: ${value}`);
  }
});
