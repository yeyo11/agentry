// A live card's verb on a narrow board column must end in an ellipsis rather than overflow the
// card. That is CSS alone, so it is checked on the stylesheet: the rule on each verb class, and
// the flex parents between the card and the verb that must be allowed to shrink below their text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BOARD = fileURLToPath(new URL('../src/styles/board.css', import.meta.url));
const PRIMITIVES = fileURLToPath(new URL('../src/styles/primitives.css', import.meta.url));

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of every rule whose selector list holds `selector` exactly, later rules winning. */
function rule(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const part of (match[2] ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) found.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
    }
  }
  return found;
}

function assertTruncates(declarations: Map<string, string>, what: string): void {
  assert.equal(declarations.get('overflow'), 'hidden', `${what}: overflow`);
  assert.equal(declarations.get('text-overflow'), 'ellipsis', `${what}: text-overflow`);
  assert.equal(declarations.get('white-space'), 'nowrap', `${what}: white-space`);
  // A flex item keeps its text's width unless told it may go below it
  assert.equal(declarations.get('min-width'), '0', `${what}: min-width`);
  const flex = declarations.get('flex');
  if (flex) assert.notEqual(flex.split(/\s+/)[1], '0', `${what}: it must be able to shrink`);
}

const board = readFileSync(BOARD, 'utf8');

test("a card's stage verb (no ticker yet) truncates with an ellipsis on a narrow column", () => {
  assertTruncates(rule(board, '.workitem-live-verb'), '.workitem-live-verb');
  // Its flex parent, the live line, may be narrower than its content
  assert.equal(rule(board, '.workitem-card-live').get('min-width'), '0');
  assert.equal(rule(board, '.workitem-card-live').get('display'), 'flex');
});

test("a card's ticker verb truncates with an ellipsis, down to no width, and the time keeps its place", () => {
  const verb = rule(board, '.workitem-card-live.has-ticker .ticker-verb');
  assertTruncates(verb, 'ticker verb');
  assert.equal(verb.get('flex'), '1 1 0');
  // Every box between the live line and the verb may shrink
  assert.equal(rule(board, '.workitem-card-live.has-ticker .ticker').get('min-width'), '0');
  assert.equal(rule(board, '.workitem-card-live.has-ticker .ticker-line').get('min-width'), '0');
  assert.equal(rule(board, '.workitem-card-live.has-ticker .ticker-what').get('display'), 'contents');
  assert.equal(rule(board, '.workitem-card-live.has-ticker .ticker-elapsed').get('flex'), 'none');
});

test('the guard reads rules as the stylesheet writes them', () => {
  const css = '/* .a { overflow: visible } */ .a, .b .c { overflow: hidden; min-width: 0 } .b .c { min-width: 4px }';
  assert.equal(rule(css, '.a').get('overflow'), 'hidden');
  assert.equal(rule(css, '.b .c').get('min-width'), '4px');
  assert.equal(rule(css, '.c').size, 0);
  assert.throws(() => assertTruncates(rule('.v { overflow: hidden; white-space: nowrap; min-width: 0 }', '.v'), 'v'));
  // The shared ticker's own verb does not shrink: the card's rule is what makes it
  assert.equal(rule(readFileSync(PRIMITIVES, 'utf8'), '.ticker-verb').get('flex'), 'none');
});
