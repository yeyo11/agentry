// Drift net for the web packages split: no class is lost, renamed or invented, and the stylesheets
// keep their cascade order. No task may update the fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classInventory, FIXTURE, selectorsOf, type ClassInventory } from '../scripts/class-inventory';

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ClassInventory;
const now = classInventory();

function difference(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((item) => !other.has(item));
}

test('every class selector of every stylesheet is still defined, and none is new', () => {
  assert.deepEqual({ lost: difference(fixture.selectors, now.selectors), added: difference(now.selectors, fixture.selectors) }, { lost: [], added: [] });
});

test('every static className token is still used, and none is new', () => {
  assert.deepEqual({ lost: difference(fixture.classNames, now.classNames), added: difference(now.classNames, fixture.classNames) }, { lost: [], added: [] });
});

test('the stylesheets are imported in the same order', () => {
  assert.deepEqual(now.stylesheets, fixture.stylesheets);
});

test('selectors are read from rule preludes only', () => {
  const css = '/* .comment */ .a:hover > .b-c, .d { margin: 1.5rem; background: url("x.svg#.e"); }\n@media (min-width: 40rem) { .f::after { content: ".g"; } }';
  assert.deepEqual(selectorsOf(css).sort(), ['a', 'b-c', 'd', 'f']);
});
