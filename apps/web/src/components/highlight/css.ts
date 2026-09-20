import { roleOf, type Piece, type Role } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

/**
 * What TanStack leaves unclassed, one lexeme at a time. Past the first rule its CSS rules lose
 * track of where a selector starts, and they never class at-rules, hex colours or most units, so
 * the plain text between its tokens holds much of the stylesheet.
 */
const LEXEME = /@[\w-]+|#[\w-]+|!important|-?(?:\d*\.)?\d+(?:%|[a-z]+)?|::?-?[\w-]+|\.-?[A-Za-z_][\w-]*|--[\w-]+|-?[A-Za-z_][\w-]*|[\^$*|~]?=|\s+|[\s\S]/gi;

/** A number's unit, coloured like a keyword; `%` too */
const UNIT = /(?<=\d)(?:%|[a-z]+)$/i;

/**
 * A `transition` or `animation` names properties and keyframes, which the grammar leaves plain:
 * only these keywords of theirs are coloured.
 */
const NAMING = new Set(['transition', 'transition-property', 'will-change', 'animation', 'animation-name']);
const TIMING = new Set(['all', 'none', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end', 'infinite', 'alternate', 'alternate-reverse', 'reverse', 'normal', 'forwards', 'backwards', 'both', 'running', 'paused']);

/** What the text between braces is: rules, the rules of a group (`@media`), keyframes, or declarations */
type Block = 'rules' | 'keyframes' | 'declarations';

/**
 * The grammar colours by where a lexeme stands: in a selector a bare word is a tag and `.x` an
 * attribute, in a declaration's value a word is a keyword value, in an at-rule's header the words
 * are its own. That position is all the state this keeps.
 */
export function* paintCss(tokens: HighlightToken[]): Generator<Piece> {
  const blocks: Block[] = ['rules'];
  /** The at-rule whose header is being read, until its `{` or `;` */
  let atRule: string | null = null;
  /** Past a declaration's `:`, until its `;` */
  let inValue = false;
  /** The property whose value is being read */
  let property = '';
  /** Inside `url(`, whose unquoted argument is a parameter */
  let url = false;
  /** Inside a selector's `[…]`, whose words are attribute names */
  let attribute = false;
  /** The text being cut and where the lexeme being coloured ends, for a rule that looks ahead */
  let source = '';
  let end = 0;
  const ahead = (pattern: RegExp) => pattern.test(source.slice(end, end + 64));
  const block = () => blocks[blocks.length - 1]!;

  function role(m: string): Role | null {
    if (/^\s/.test(m)) return null;
    switch (m) {
      case '{':
        blocks.push(atRule === 'keyframes' ? 'keyframes' : atRule && atRule !== 'font-face' && atRule !== 'page' ? 'rules' : 'declarations');
        atRule = null;
        inValue = false;
        return null;
      case '}':
        if (blocks.length > 1) blocks.pop();
        inValue = false;
        return null;
      case ';':
        atRule = null;
        inValue = false;
        return null;
      case '(':
        return null;
      case '[':
        attribute = true;
        return null;
      case ']':
        attribute = false;
        return null;
      case ')':
        url = false;
        return null;
      case ':':
        if (block() === 'declarations' && !atRule) inValue = true;
        return null;
    }
    if (url) return 'entity';
    if (m.startsWith('@')) {
      atRule = m.slice(1).toLowerCase();
      return 'keyword';
    }
    if (m === '!important') return 'keyword';
    if (atRule !== null) {
      if (/^[\d.-]/.test(m) && /\d/.test(m)) return 'constant';
      if (atRule === 'keyframes') return /^[\w-]/.test(m) ? 'entity' : null;
      // `(max-width: 600px)`: the feature is named like a property, the rest of the header is plain
      return /^[a-z-]+$/i.test(m) && ahead(/^\s*:/) ? 'constant' : null;
    }
    const where = block();
    if (inValue || (where === 'declarations' && !/^[\w-]+$/.test(m))) {
      if (/^#[\da-f]{3,8}$/i.test(m) || (/^[\d.-]/.test(m) && /\d/.test(m))) return 'constant';
      // `-5px`: TanStack leaves the sign out of the number
      if (m === '-' && ahead(/^\.?\d/)) return 'constant';
      if (m === '-' || m === '+' || m === '*') return 'keyword';
      if (NAMING.has(property) && !TIMING.has(m)) return null;
      return /^-?[A-Za-z]/.test(m) ? 'constant' : null;
    }
    if (where === 'declarations') {
      property = m.toLowerCase();
      return m.startsWith('--') ? 'entity' : 'constant';
    }
    if (where === 'keyframes') return m === ',' ? null : 'constant';
    // A selector
    if (/^[>+~]$/.test(m) || /=$/.test(m)) return 'keyword';
    if (/^[.#:]/.test(m) || (attribute && /^[\w-]+$/.test(m))) return 'constant';
    if (m === '*' || /^[A-Za-z]/.test(m)) return 'tag';
    return null;
  }

  function* plain(text: string): Generator<Piece> {
    source = text;
    for (const m of text.matchAll(LEXEME)) {
      end = m.index + m[0].length;
      // `50%` in keyframes is an offset, one colour for the number and its `%`
      const unit = /^-?(?:\d*\.)?\d/.test(m[0]) && block() !== 'keyframes' ? UNIT.exec(m[0]) : null;
      const r = role(m[0]);
      if (unit && r === 'constant') yield* [[m[0].slice(0, unit.index), 'constant'], [unit[0], 'keyword']] as Piece[];
      else yield [m[0], r];
    }
  }

  // TanStack's selector, property and number tokens are cut again with the plain text around
  // them: where they stand is what colours them, and the state must follow every one
  let text = '';
  for (const token of tokens) {
    const { value, className } = token;
    if (!className || className === 'selector' || className === 'number' || className === 'property') {
      text += value;
      continue;
    }
    yield* plain(text);
    text = '';
    if (className === 'function') {
      url = value.toLowerCase() === 'url';
      yield [value, 'constant'];
      continue;
    }
    // A quoted `url("…")` is a string, not a parameter
    if (className === 'string') url = false;
    yield [value, roleOf(token)];
  }
  yield* plain(text);
}
