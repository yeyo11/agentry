// TypeScript, TSX, JavaScript and JSX.
//
// TanStack classes a lexeme by what it looks like — `type` is always a keyword, every capitalised
// name a type, every member plain. The TextMate grammar knows where the lexeme stands, and the
// GitHub themes colour declarations, parameters, members and types apart. This painter keeps the
// little state that takes to tell them apart: the brackets in force, whether a type or an
// expression is being read, and what a declaration is introducing. Measured against shiki over
// this repository, that is the difference between 92% and 99% of the characters in the same
// colour (`pnpm --filter @agentry/web parity`).
import { pieces, type Piece, type Role } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

/** `\n` and friends: the themes colour an escape like a keyword, inside a string of any kind */
const ESCAPE = /\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\s\S])/g;

/** Identifiers, private names and every operator, longest first: what TanStack leaves unclassed */
const PLAIN = /[A-Za-z_$][\w$]*|#[A-Za-z_$][\w$]*|\s+|=>|\.{3}|\?\.|[!=]==?|[<>]=|\*\*=?|&&=?|\|\|=?|\?\?=?|\+\+|--|[-+*/%&|^]=?|[\s\S]/g;

const KEYWORDS_BEFORE_OBJECT = new Set(['return', 'yield', 'typeof', 'await', 'case', 'of', 'in', 'do', 'else']);
const OPENS_OBJECT = new Set(['=', '(', ',', ':', '[', '&&', '||', '??', '?', '...', '+']);
/** A type is being read after these */
const TYPE_KEYWORDS = new Set(['as', 'satisfies', 'is', 'keyof', 'infer', 'asserts']);
const DECLARES_TYPE = new Set(['class', 'interface', 'enum', 'namespace', 'module']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'abstract', 'declare', 'override', 'async', 'export', 'default', 'get', 'set']);
/** `support.type.primitive` and friends: blue wherever they stand, unlike a type's own name */
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'unknown', 'never', 'any', 'void', 'undefined', 'null', 'true', 'false']);
/** `support.variable.property`: the members the grammar knows, coloured like a constant */
const SUPPORT_PROPERTIES = new Set(['constructor', 'length', 'prototype', '__proto__', 'EPSILON', 'MAX_SAFE_INTEGER', 'MAX_VALUE', 'MIN_SAFE_INTEGER', 'MIN_VALUE', 'NEGATIVE_INFINITY', 'POSITIVE_INFINITY']);
/** `variable.language` and `support.class`: names the grammar colours wherever they appear */
const LANGUAGE_NAMES = new Set(['this', 'super', 'arguments']);

/**
 * TanStack takes these for keywords wherever they appear; they are valid names too, and the
 * grammar only reads them as keywords where one can stand. An operator that needs a value on its
 * left settles it: `from.length`, `const type = …`, `stretch(from, 1)`.
 */
const SOFT_KEYWORDS = new Set(['as', 'asserts', 'async', 'declare', 'from', 'get', 'infer', 'is', 'keyof', 'module', 'namespace', 'of', 'override', 'package', 'private', 'protected', 'public', 'readonly', 'satisfies', 'set', 'static', 'type', 'using']);
const FOLLOWS_VALUE = new Set([')', ']', '}', ',', ';', '.', '?.', '=>', '=', '?', '===', '!==', '==', '!=', '+', '-', '*', '/', '%', '&&', '||', '??', '<', '>', '<=', '>=', '|', '&', '+=', '-=', '++', '--']);

/** Deeper nesting than this is not tracked */
const MAX_DEPTH = 256;

const UPPER = /^#?[A-Z][\dA-Z_$]*$/;
const NAME = /^#?[A-Za-z_$][\w$]*$/;

interface Lex {
  text: string;
  /** TanStack's class, where it gave one */
  cls: string | undefined;
  /** Whitespace and comments: passed over when a rule looks at the neighbours */
  skip: boolean;
}

/** What a bracket opened, and the state its members are read in */
interface Frame {
  kind: 'block' | 'object' | 'members' | 'params' | 'paren' | 'array' | 'typeArgs' | 'template' | 'jsxTag' | 'jsxChildren';
  /** Reading a type: `,` and `;` fall back to this, so a type literal's members stay types */
  baseType: boolean;
  type: boolean;
  /** Reading names being declared: parameters, or the left side of a `const` */
  binding: boolean;
  baseBinding: boolean;
  /** Those names are constants, which the themes colour apart from a `let` */
  constant: boolean;
  /** `import`/`export`: every name in between is a binding the themes leave plain */
  importing: boolean;
  /** `class X extends`: what follows is an inherited class, not a type */
  heading: boolean;
  /** `type X =`: the right side is a type, where an initialiser would be an expression */
  alias: boolean;
  /** Open `?` of a ternary, whose `:` is an operator and not an annotation */
  ternary: number;
  /** The `(…)` just closed was a function type's: its `=>` introduces the return type */
  arrowType: boolean;
  /** `case x:`: the colon ends a clause, and the themes leave it plain */
  clause: boolean;
  /** A JSX tag that closes an element (`</a>`) or itself (`<a />`): its `>` opens no children */
  closing: boolean;
  /** Parameters of a function type, whose `=>` is followed by the return type */
  signature: boolean;
  /** Inside `export default …`, where the theme paints unscoped punctuation like a name */
  exported: boolean;
}

const frame = (kind: Frame['kind'], type = false, binding = false, constant = false): Frame => ({
  kind,
  baseType: type,
  type,
  binding,
  baseBinding: binding,
  constant,
  importing: false,
  heading: false,
  alias: false,
  ternary: 0,
  arrowType: false,
  clause: false,
  closing: false,
  signature: false,
  exported: false,
});

function lex(tokens: HighlightToken[]): Lex[] {
  const out: Lex[] = [];
  for (const token of tokens) {
    if (token.className) {
      out.push({ text: token.value, cls: token.className, skip: token.className === 'comment' });
      continue;
    }
    for (const m of token.value.matchAll(PLAIN)) out.push({ text: m[0], cls: undefined, skip: /^\s+$/.test(m[0]) });
  }
  return out;
}

export function* paintScript(tokens: HighlightToken[], lang: string): Generator<Piece> {
  const lexes = lex(tokens);
  const jsx = lang === 'tsx' || lang === 'jsx';
  const stack: Frame[] = [frame('block')];
  const top = () => stack[stack.length - 1]!;
  // Nesting is unbounded in the input and every rule looks at the frame on top, so past a depth no
  // real code reaches the extra frames are only counted: what they would have held is not painted.
  let overflow = 0;
  let templates = 0;
  const push = (f: Frame) => {
    if (stack.length >= MAX_DEPTH) {
      overflow++;
      return;
    }
    if (f.kind === 'template') templates++;
    stack.push(f);
  };
  /** The frame a closing bracket ends; the outermost frame is never popped */
  const pop = (): Frame => {
    if (overflow > 0) {
      overflow--;
      return top();
    }
    if (stack.length <= 1) return top();
    const f = stack.pop()!;
    if (f.kind === 'template') templates--;
    return f;
  };
  const inTemplate = () => templates > 0;

  /** The next lexeme that carries meaning, `steps` of them ahead (or behind, with -1) */
  const sig = (from: number, step: 1 | -1 = 1, steps = 1): Lex | undefined => {
    for (let i = from + step; i >= 0 && i < lexes.length; i += step) {
      const lexeme = lexes[i]!;
      if (lexeme.skip) continue;
      if (--steps === 0) return lexeme;
    }
    return undefined;
  };

  /** Where the bracket opened at `from` closes, or -1 past `limit` lexemes */
  const closes = (from: number, open: string, close: string, limit = 400): number => {
    let depth = 0;
    for (let i = from; i < lexes.length && i < from + limit; i++) {
      const { text, cls } = lexes[i]!;
      if (cls) continue;
      if (text === open) depth++;
      else if (text === close && --depth === 0) return i;
    }
    return -1;
  };

  /** `(…)` that a `=>` follows is a parameter list, whatever it holds */
  const isArrowParams = (at: number): boolean => {
    const end = closes(at, '(', ')');
    if (end < 0) return false;
    const after = sig(end);
    if (after?.text === '=>') return true;
    // A return type stands between the parameters and the arrow: `(a): Promise<void> => …`
    if (after?.text !== ':') return false;
    for (let i = end + 1; i < lexes.length && i < end + 60; i++) {
      const { text, cls } = lexes[i]!;
      if (cls) continue;
      if (text === '=>') return true;
      if (text === ';' || text === '{' || text === ')' || text === ',') return false;
    }
    return false;
  };

  /** A `<` opens type arguments when a `>` closes them with only type-ish text in between */
  const isTypeArgs = (at: number): boolean => {
    let depth = 0;
    let braces = 0;
    for (let i = at; i < lexes.length && i < at + 200; i++) {
      const { text, cls } = lexes[i]!;
      if (cls === 'tag') return false;
      if (cls) continue;
      if (text === '<') depth++;
      else if (text === '>') {
        if (--depth === 0) return true;
      } else if (text === '{') braces++;
      else if (text === '}') braces--;
      // A type literal holds `;` and a function type holds parentheses; outside one, neither can
      else if (braces === 0 && (text === '>=' || text === ';' || text === '(' || text === ')' || text === '=' || text === '&&' || text === '||')) return false;
    }
    return false;
  };

  /** What follows a name and settles whether it is a call, a function-valued key or plain */
  const callsAt = (i: number): boolean => {
    const after = sig(i);
    if (!after) return false;
    if (after.text === '(' || (after.cls === 'string' && after.text.startsWith('`'))) return true;
    // `ref.current?.()`
    if (after.text === '?.' && sig(i, 1, 2)?.text === '(') return true;
    // `f<Type>(…)`: a generic call
    const open = lexes.indexOf(after, i);
    return after.text === '<' && isTypeArgs(open) && sig(closes(open, '<', '>'))?.text === '(';
  };

  /** The index of the next lexeme that carries meaning, or -1 */
  const nextSig = (from: number): number => {
    for (let j = from + 1; j < lexes.length; j++) if (!lexes[j]!.skip && lexes[j]!.cls !== 'comment') return j;
    return -1;
  };

  /** A function stands at `j`: `function`, `async`, a type parameter list, or an arrow's head */
  const startsFunction = (j: number): boolean => {
    const start = lexes[j];
    if (!start) return false;
    if (start.cls === 'keyword' && (start.text === 'function' || start.text === 'async')) return true;
    if (start.text === '<') return isTypeArgs(j);
    if (start.text === '(') return isArrowParams(j) || sig(closes(j, '(', ')'))?.text === '=>';
    return NAME.test(start.text) && sig(j)?.text === '=>';
  };

  /**
   * A name whose value is a function: `const run = () => …`, `onEvent: (e) => void`. The grammar
   * colours those like a function and plain ones like a variable, so the initialiser decides.
   */
  const functionValueAt = (i: number): boolean => {
    let j = nextSig(i);
    while (j >= 0 && (lexes[j]!.text === '?' || lexes[j]!.text === '!')) j = nextSig(j);
    if (j < 0) return false;
    if (lexes[j]!.text === ':') {
      // Either a type — a function type still colours the name — or an object literal's value
      const value = nextSig(j);
      if (value >= 0 && startsFunction(value)) return true;
      j = assignmentAfter(value);
      if (j < 0) return false;
    }
    if (lexes[j]!.text !== '=') return false;
    return startsFunction(nextSig(j));
  };

  /** Where the `=` of an initialiser stands after a type annotation, or -1 if the name has none */
  const assignmentAfter = (from: number): number => {
    let depth = 0;
    for (let j = from; j >= 0 && j < lexes.length && j < from + 120; j++) {
      const { text, cls } = lexes[j]!;
      if (cls) continue;
      if (text === '(' || text === '[' || text === '{' || text === '<') depth++;
      else if (text === ')' || text === ']' || text === '}' || text === '>') depth--;
      else if (depth === 0 && (text === '=' || text === ';' || text === ',')) return text === '=' ? j : -1;
    }
    return -1;
  };

  for (let i = 0; i < lexes.length; i++) {
    const lexeme = lexes[i]!;
    const { text, cls } = lexeme;
    const frameNow = top();
    const before = sig(i, -1);
    const after = sig(i);
    const member = before?.text === '.' || before?.text === '?.';

    if (lexeme.skip || cls === 'comment') {
      yield [text, cls === 'comment' ? 'comment' : null];
      continue;
    }

    // Strings, template pieces, regular expressions and numbers: TanStack's class is right, but
    // the themes colour what is inside them apart.
    if (cls === 'string' || cls === 'operator') {
      if (cls === 'operator') {
        if (text === '${') push(frame('template'));
        else pop();
      }
      yield* pieces(text, ESCAPE, () => 'keyword', 'string');
      continue;
    }
    if (cls === 'literal' && text.startsWith('/') && text.length > 1) {
      yield* regexp(text);
      continue;
    }
    if (cls === 'number') {
      const bigint = text.endsWith('n');
      yield [bigint ? text.slice(0, -1) : text, 'constant'];
      if (bigint) yield ['n', 'keyword'];
      continue;
    }
    if (cls === 'function' && text.startsWith('@')) {
      // A decorator: the `@` is punctuation, the name a call only when it is called
      yield ['@', null];
      yield [text.slice(1), after?.text === '(' ? 'function' : null];
      continue;
    }
    if (jsx) {
      const role = markup(i, lexeme, frameNow);
      if (role !== undefined) {
        yield [text, role];
        continue;
      }
    }

    if (NAME.test(text)) {
      yield [text, cls === 'literal' && !member ? 'constant' : word(i, lexeme, frameNow, before, after, member)];
      continue;
    }
    // Punctuation inside `${…}` has no colour of its own, and the string around it lends it one
    const role = punctuation(i, lexeme, frameNow, before, after);
    yield [text, role ?? (inTemplate() ? 'string' : null)];
  }

  /**
   * JSX: tags and their attributes, and the text between them, which is no code at all. The themes
   * leave the angle brackets plain and colour the braces of an embedded expression like keywords.
   * Undefined hands the lexeme back to the code rules: a string value, or an expression's brace.
   */
  function markup(i: number, lexeme: Lex, frameNow: Frame): Role | null | undefined {
    const { text, cls } = lexeme;
    const next = lexes[i + 1];
    if (!cls && text === '<' && frameNow.kind !== 'jsxTag') {
      // TanStack only makes tag tokens of JSX, so one right after `<` settles it
      const closing = next?.text === '/' && (lexes[i + 2]?.cls === 'tag' || lexes[i + 2]?.text === '>');
      if (next?.cls === 'tag' || closing || (next?.text === '>' && (frameNow.kind === 'jsxChildren' || startsExpression(i)))) {
        push({ ...frame('jsxTag'), closing });
        return null;
      }
      return undefined;
    }
    if (frameNow.kind === 'jsxTag') {
      if (cls === 'tag') return 'tag';
      if (cls === 'string' || cls === 'comment' || lexeme.skip || text === '{') return undefined;
      if (text === '=') return 'keyword';
      if (text === '/') return null;
      // `<Select<Mode> …>`: type arguments, read by the code rules
      if (text === '<' && isTypeArgs(i)) return undefined;
      if (text === '>') {
        pop();
        // `</a>` ends the children it closes, `<a>` opens them, `<a />` neither
        if (frameNow.closing) {
          if (top().kind === 'jsxChildren') pop();
        } else if (sig(i, -1)?.text !== '/') push(frame('jsxChildren'));
        return null;
      }
      // Attribute names, dashes and namespaces included, whether TanStack caught them or not
      return 'constant';
    }
    if (frameNow.kind === 'jsxChildren') return text === '{' ? undefined : null;
    return undefined;
  }

  /** Whether an expression can start at `i`, where `<>` opens a fragment */
  function startsExpression(i: number): boolean {
    const before = sig(i, -1);
    return !before || OPENS_OBJECT.has(before.text) || before.text === '{' || before.text === '=>' || (before.cls === 'keyword' && KEYWORDS_BEFORE_OBJECT.has(before.text));
  }

  function word(i: number, lexeme: Lex, frameNow: Frame, before: Lex | undefined, after: Lex | undefined, member: boolean): Role | null {
    const { text, cls } = lexeme;
    const keyword = cls === 'keyword';

    // TanStack reads `void` as the type it also is; in an expression the grammar reads the operator
    if (text === 'void' && !frameNow.type && !member) return 'keyword';
    if (text === 'constructor' && frameNow.kind === 'members' && startsMember(i) && after?.text === '(') return 'keyword';
    if (member) {
      if (frameNow.type) return typeofValue(i) ? null : 'entity';
      // `es.onopen = () => …`: a member given a function is coloured like one
      if (callsAt(i) || (after?.text === '=' && functionValueAt(i))) return 'function';
      if (SUPPORT_PROPERTIES.has(text)) return 'constant';
      return UPPER.test(text) ? 'constant' : null;
    }

    // A key or a member's name, whatever the word would mean on its own
    const key = !frameNow.binding && (frameNow.kind === 'members' || (frameNow.kind === 'object' && !frameNow.type)) && startsMember(i) && (after?.text === ':' || after?.text === '?' || after?.text === '(' || after?.text === '=' || after?.text === ';' || after?.text === ',' || after?.text === '!' || after?.text === '<');
    if (key && !(keyword && MODIFIERS.has(text) && after?.text !== ':' && after?.text !== '(')) {
      if (after?.text === '(' || (after?.text === '<' && !frameNow.type)) return 'function';
      if (functionValueAt(i)) return 'function';
      return frameNow.kind === 'members' ? 'entity' : null;
    }

    // A soft keyword standing where a value or a new name stands is a name
    const bound = frameNow.binding && !(after && NAME.test(after.text) && after.text !== 'of' && after.text !== 'in') && before !== undefined && (before.text === ',' || before.text === '{' || before.text === '[' || before.text === '(' || (before.cls === 'keyword' && (before.text === 'const' || before.text === 'let' || before.text === 'var')));
    if (keyword && !(SOFT_KEYWORDS.has(text) && (bound || (after && FOLLOWS_VALUE.has(after.text))))) return keywordRole(i, text, frameNow, after);

    if (frameNow.binding) {
      // `const parse = (line) => …`, `onEvent: (e) => void`: the name of what it holds
      if (functionValueAt(i)) return 'function';
      if (frameNow.kind === 'params' || frameNow.kind === 'members') return 'entity';
      return frameNow.constant ? 'constant' : null;
    }
    if (frameNow.importing) return null;
    if (frameNow.heading) return 'constant';
    if (frameNow.type) {
      if (typeofValue(i)) return null;
      return PRIMITIVES.has(text) || LANGUAGE_NAMES.has(text) ? 'constant' : 'entity';
    }
    if (LANGUAGE_NAMES.has(text) || text === 'Promise') return 'constant';
    if (before?.cls === 'keyword' && (before.text === 'function' || before.text === 'new')) return 'function';
    if (before?.cls === 'keyword' && (DECLARES_TYPE.has(before.text) || (before.text === 'type' && frameNow.alias))) return 'entity';
    if (before?.cls === 'keyword' && (before.text === 'break' || before.text === 'continue' || before.text === 'instanceof')) return 'entity';
    if (callsAt(i)) return 'function';
    if (after?.text === '.' || after?.text === '?.') return UPPER.test(text) ? 'constant' : null;
    if (UPPER.test(text)) return frameNow.kind === 'object' && startsMember(i) ? null : 'constant';
    return null;
  }

  /** `typeof x` in a type reads a value: the themes leave the name and its members plain */
  function typeofValue(i: number): boolean {
    for (let j = i - 1; j >= 0 && j > i - 12; j--) {
      const { text, cls, skip } = lexes[j]!;
      if (skip || cls === 'comment') continue;
      if (cls === 'keyword') return text === 'typeof';
      if (text === '.' || text === '?.' || NAME.test(text)) continue;
      return false;
    }
    return false;
  }

  /** Whether the lexeme at `i` opens a member of the object, class or interface it stands in */
  function startsMember(i: number): boolean {
    for (let j = i - 1; j >= 0; j--) {
      const { text, cls, skip } = lexes[j]!;
      if (skip) continue;
      if (cls === 'keyword' && MODIFIERS.has(text)) continue;
      if (cls === 'comment') continue;
      return text === '{' || text === ',' || text === ';' || text === '}';
    }
    return true;
  }

  function keywordRole(i: number, text: string, frameNow: Frame, after: Lex | undefined): Role | null {
    if (text === 'this' || text === 'super') return 'constant';
    if (text === 'const' || text === 'let' || text === 'var') {
      // `const` inside `<const T>` or `as const` is a modifier, not a declaration
      if (!frameNow.type) {
        frameNow.binding = true;
        frameNow.baseBinding = frameNow.kind !== 'block' && frameNow.kind !== 'paren' ? frameNow.baseBinding : false;
        frameNow.constant = text === 'const';
      }
      return 'keyword';
    }
    if (text === 'type' && after && NAME.test(after.text)) {
      frameNow.alias = true;
      frameNow.type = false;
      return 'keyword';
    }
    if (DECLARES_TYPE.has(text)) {
      frameNow.heading = false;
      return 'keyword';
    }
    if (text === 'extends' || text === 'implements') {
      frameNow.heading = frameNow.kind !== 'typeArgs';
      frameNow.type = frameNow.kind === 'typeArgs';
      return 'keyword';
    }
    if (text === 'case') {
      frameNow.clause = true;
      return 'keyword';
    }
    if (text === 'default' && sig(i, -1)?.text === 'export') {
      frameNow.exported = true;
      return 'keyword';
    }
    if (text === 'of' || text === 'in') {
      frameNow.binding = false;
      return 'keyword';
    }
    if (TYPE_KEYWORDS.has(text)) {
      frameNow.type = true;
      return 'keyword';
    }
    if (text === 'import' || text === 'export') {
      // `export const`, `export function`… declare; only `import x`, `export { x }` bind names
      if (text === 'import' ? after?.text !== '(' && after?.text !== '.' : after?.text === '{' || after?.text === '*') frameNow.importing = true;
      return 'keyword';
    }
    if (text === 'from') {
      frameNow.importing = false;
      return 'keyword';
    }
    return 'keyword';
  }

  function punctuation(i: number, lexeme: Lex, frameNow: Frame, before: Lex | undefined, after: Lex | undefined): Role | null {
    const { text } = lexeme;
    switch (text) {
      case '{': {
        if (frameNow.kind === 'jsxChildren' || frameNow.kind === 'jsxTag') {
          push(frame('paren'));
          return 'keyword';
        }
        if (frameNow.type) {
          // `): Result {` opens a body, `: { a: string }` a type
          const body = before !== undefined && before.cls !== 'keyword' && (before.text === ')' || before.text === '>' || before.text === ']' || before.text === '}' || NAME.test(before.text));
          frameNow.type = body ? false : frameNow.type;
          push(frame(body ? 'block' : 'members', !body));
        }
        else if (frameNow.binding) push(frame(frameNow.kind === 'params' || frameNow.kind === 'members' ? 'params' : 'object', false, true, frameNow.constant));
        else if (frameNow.importing) {
          const inner = frame('block');
          inner.importing = true;
          push(inner);
        } else if (frameNow.heading || (before?.cls === 'keyword' && DECLARES_TYPE.has(before.text)) || afterTypeName(i)) push(frame('members'));
        else if (before && (OPENS_OBJECT.has(before.text) || (before.cls === 'keyword' && KEYWORDS_BEFORE_OBJECT.has(before.text)) || (before.text === '{' && frameNow.kind === 'paren'))) push(frame('object'));
        else push(frame('block'));
        frameNow.heading = false;
        const opened = top();
        // The body of what is exported ends the theme's `export default` scope; a pattern does not
        if (frameNow.exported && opened.kind !== 'block') opened.exported = true;
        return frameNow.exported && opened.kind !== 'block' ? 'entity' : null;
      }
      case '}': {
        const closing = pop();
        const parent = top();
        if (closing.exported) return 'entity';
        if (closing.kind === 'block') parent.exported = false;
        // A JSX expression's braces are the only ones the themes colour
        return (parent.kind === 'jsxChildren' || parent.kind === 'jsxTag') && closing.kind === 'paren' ? 'keyword' : null;
      }
      case '(': {
        const params = frameNow.kind === 'members' && frameNow.binding ? false : isParams(i, frameNow, before);
        // A function type's parameters: its `=>` is followed by the return type, not by a body
        push({ ...(params ? frame('params', false, true) : frame('paren')), signature: params && frameNow.type, exported: frameNow.exported });
        return frameNow.exported ? 'entity' : null;
      }
      case ')':
      case ']': {
        const closed = pop();
        if (text === ')' && closed.kind === 'params') top().arrowType = closed.signature;
        return closed.exported ? 'entity' : null;
      }
      case '[': {
        if (frameNow.binding && frameNow.kind !== 'members') push(frame(frameNow.kind === 'params' ? 'params' : 'array', frameNow.type, true, frameNow.constant));
        else push(frame(frameNow.kind === 'members' && startsMember(i) ? 'params' : 'array', frameNow.type, frameNow.kind === 'members' && startsMember(i)));
        return null;
      }
      case '<':
        if (isTypeArgs(i)) {
          push(frame('typeArgs', true));
          return null;
        }
        return 'keyword';
      case '>':
        if (frameNow.kind === 'typeArgs') {
          pop();
          return null;
        }
        return frameNow.kind === 'jsxTag' ? null : 'keyword';
      case ':': {
        if (frameNow.clause || (before?.cls === 'keyword' && before.text === 'default')) {
          frameNow.clause = false;
          return null;
        }
        if (frameNow.ternary > 0) {
          frameNow.ternary--;
          return 'keyword';
        }
        if (frameNow.type) return 'keyword';
        // An object's key, a named tuple's member and a label all keep the colon plain
        if (frameNow.kind === 'object' && !frameNow.binding) return null;
        // `'GET /runs': handler` — a quoted key, wherever the block it stands in starts
        if (before?.cls === 'string') return null;
        if (frameNow.kind === 'array' && before && NAME.test(before.text)) return null;
        if (frameNow.kind === 'block' && isLabel(i, frameNow)) return null;
        frameNow.type = true;
        frameNow.binding = false;
        return 'keyword';
      }
      case '?':
        if (!frameNow.type && !frameNow.binding && frameNow.kind !== 'members') frameNow.ternary++;
        return 'keyword';
      case ',':
        frameNow.type = frameNow.baseType;
        frameNow.binding = frameNow.baseBinding || (frameNow.kind === 'params' ? true : frameNow.binding && frameNow.kind !== 'block');
        if (frameNow.kind === 'block' || frameNow.kind === 'paren') frameNow.binding = frameNow.baseBinding;
        return frameNow.exported ? 'entity' : null;
      case ';':
        frameNow.type = frameNow.baseType;
        frameNow.binding = frameNow.baseBinding;
        frameNow.importing = false;
        frameNow.heading = false;
        frameNow.alias = false;
        frameNow.ternary = 0;
        frameNow.exported = false;
        return null;
      case '=':
        frameNow.type = frameNow.alias;
        frameNow.alias = false;
        frameNow.binding = false;
        return 'keyword';
      case '=>':
        frameNow.type = frameNow.arrowType || frameNow.baseType;
        frameNow.arrowType = false;
        return 'keyword';
      case '.':
      case '?.':
      case '@':
        return null;
      case '`':
        return 'string';
      default:
        return 'keyword';
    }
  }

  /** `class X {`, `interface X<T> {`: the name of the type stands between the keyword and the brace */
  function afterTypeName(i: number): boolean {
    let j = i - 1;
    let depth = 0;
    for (; j >= 0; j--) {
      const { text, cls, skip } = lexes[j]!;
      if (skip || cls === 'comment') continue;
      // Type parameters stand between the name and the brace
      if (text === '>') depth++;
      else if (text === '<' && depth > 0) depth--;
      else if (depth === 0) break;
    }
    const name = lexes[j];
    if (!name || !NAME.test(name.text)) return false;
    const keyword = sig(j, -1);
    return keyword?.cls === 'keyword' && DECLARES_TYPE.has(keyword.text);
  }

  function isParams(i: number, frameNow: Frame, before: Lex | undefined): boolean {
    if (frameNow.type) return true;
    if (!before) return false;
    if (before.cls === 'keyword' && (before.text === 'function' || before.text === 'constructor')) return true;
    return declaresFunction(i) || isArrowParams(i);
  }

  /**
   * The `(` at `i` follows the name of a function or method being declared, not one being called:
   * `function f<T>(`, `private run(`, `{ track(win) {`.
   */
  function declaresFunction(i: number): boolean {
    let j = i - 1;
    let depth = 0;
    for (; j >= 0; j--) {
      const { text, cls, skip } = lexes[j]!;
      if (skip || cls === 'comment') continue;
      if (text === '>') depth++;
      else if (text === '<' && depth > 0) depth--;
      else if (depth === 0) break;
    }
    const name = lexes[j];
    if (!name || !NAME.test(name.text)) return false;
    const previous = sig(j, -1);
    if (previous?.cls === 'keyword' && (previous.text === 'function' || MODIFIERS.has(previous.text))) return true;
    const frameNow = top();
    return (frameNow.kind === 'members' || frameNow.kind === 'object') && startsMember(j);
  }

  function isLabel(i: number, frameNow: Frame): boolean {
    if (frameNow.kind !== 'block') return false;
    const name = sig(i, -1);
    if (!name || !NAME.test(name.text)) return false;
    const previous = sig(i, -1, 2);
    if (previous?.cls === 'keyword' && previous.text === 'case') return true;
    return previous === undefined || previous.text === '{' || previous.text === ';' || previous.text === '}';
  }
}

/**
 * Inside a regular expression the themes colour the pattern like a string, its quantifiers and
 * anchors like keywords, its character classes like constants and its escapes like an inserted
 * line. The flags are a keyword of their own.
 */
const REGEXP = /\\.|\[(?:\\.|[^\]\\])*\]|\{\d+(?:,\d*)?\}|\(\?[:<!=]*|[)|^$*+?]/g;

function* regexp(text: string): Generator<Piece> {
  const end = text.lastIndexOf('/');
  const flags = text.slice(end + 1);
  yield ['/', 'string'];
  yield* pieces(text.slice(1, end), REGEXP, (m) => (m.startsWith('[') ? 'constant' : m.startsWith('\\') ? (/^\\[dDwWsS]$/.test(m) ? 'constant' : /^\\[bB]$/.test(m) ? 'keyword' : 'tag') : m.startsWith('(') || m === ')' ? 'string' : 'keyword'), 'string');
  yield ['/', 'string'];
  if (flags) yield [flags, 'keyword'];
}
