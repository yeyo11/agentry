// A live card's verb on a narrow board column must stay inside the card rather than overflow it.
// Since orchestration 7 the card says it in its strip (`WorkItemStrip`), which wraps as the
// reference's `.wi-strip` does. That is CSS alone, so it is checked on the stylesheet: the rule on
// the verb, and the strip around it, which must let the verb shrink and wrap while the clock keeps
// its width.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BOARD = fileURLToPath(new URL('../src/styles/board.css', import.meta.url));

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

/** A flex item that may go below its text's width, and whose text may break onto another line. */
function assertGivesWay(declarations: Map<string, string>, what: string): void {
  assert.equal(declarations.get('min-width'), '0', `${what}: min-width`);
  const flex = declarations.get('flex');
  if (flex) assert.notEqual(flex.split(/\s+/)[1], '0', `${what}: it must be able to shrink`);
  assert.notEqual(declarations.get('white-space'), 'nowrap', `${what}: it must be able to wrap`);
}

const board = readFileSync(BOARD, 'utf8');

test("a card's live verb gives way inside its strip on a narrow column", () => {
  const verb = rule(board, '.workitem-strip-verb');
  assertGivesWay(verb, '.workitem-strip-verb');
  assert.equal(verb.get('flex'), '1 1 0');
  // Its flex parent, the strip, may be narrower than its content and wraps what does not fit
  const strip = rule(board, '.workitem-strip');
  assert.equal(strip.get('display'), 'flex');
  assert.equal(strip.get('flex-wrap'), 'wrap');
  assert.equal(strip.get('min-width'), '0');
});

test("the strip's clock keeps its width beside the verb", () => {
  assert.equal(rule(board, '.workitem-strip time').get('flex-shrink'), '0');
});

test('the guard reads rules as the stylesheet writes them', () => {
  const css = '/* .a { overflow: visible } */ .a, .b .c { overflow: hidden; min-width: 0 } .b .c { min-width: 4px }';
  assert.equal(rule(css, '.a').get('overflow'), 'hidden');
  assert.equal(rule(css, '.b .c').get('min-width'), '4px');
  assert.equal(rule(css, '.c').size, 0);
  assert.throws(() => assertGivesWay(rule('.v { min-width: 0; white-space: nowrap }', '.v'), 'v'));
  assert.throws(() => assertGivesWay(rule('.v { flex: 1 0 auto; min-width: 0 }', '.v'), 'v'));
});
