import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

/** Read wherever they stand, like a keyword's built-in value */
const PYTHON_BUILTINS =
  'abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip';

/** The standard library's exception and warning classes: `support.type.exception.python`, a constant wherever named */
const EXCEPTIONS =
  'BaseException Exception ArithmeticError AssertionError AttributeError BlockingIOError BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError EnvironmentError FileExistsError FileNotFoundError FloatingPointError FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError IndexError InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError NotADirectoryError NotImplementedError OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration StopIteration SyntaxError SyntaxWarning SystemError SystemExit TabError TimeoutError TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning ZeroDivisionError';

/** `@staticmethod`, `@classmethod`, `@property`: descriptors the grammar knows, `support.type.python` */
const DESCRIPTORS = new Set(['staticmethod', 'classmethod', 'property', 'abstractmethod', 'cached_property']);

/** `__init__`, `__doc__`… never a name a reader chose: `support.function.magic` / `support.variable.magic` */
const DUNDER = /^__[A-Za-z_]\w*__$/;

/**
 * `f(x=1)`: a call's keyword argument, tight against its `=` the way an unannotated default in a
 * `def`'s own signature is also written (`def f(x=1):`) — the two are textually identical, so this
 * reads a default that closes a `def`'s parameter list as a keyword argument too. Not exercised by
 * the corpus, whose defaults are all annotated (`x: int = 1`, spaced, which this does not match).
 */
const KWARG = /(?<=[(,]\s*)[A-Za-z_]\w*(?==(?!=))/.source;

/**
 * Every word the grammar paints wherever it stands, one regex: a call's keyword argument, dunder
 * names, `self`/`cls` unless they are being declared as a bare parameter (where the grammar leaves
 * them plain like any other parameter name), the exceptions, all-caps module constants, the
 * builtins, and the operators TanStack leaves in the plain text between its tokens.
 */
const PYTHON_PLAIN = new RegExp(
  [
    KWARG,
    /\b__[A-Za-z_]\w*__\b/.source,
    /\b(?:self|cls)\b(?!\s*[,):])/.source,
    `\\b(?:${EXCEPTIONS.split(' ').join('|')})\\b`,
    /\b[A-Z][A-Z0-9_]+\b/.source,
    `(?<![.\\w])(?:${PYTHON_BUILTINS.split(' ').join('|')})\\b`,
    /\.\.\.|->|[=!<>]=|\*\*=?|\/\/=?|[-+*/%@&|^]=?|=|[<>]/.source,
  ].join('|'),
  'g',
);

/** Escapes inside a string that is not raw: the grammar colours them like a keyword */
const ESCAPE = /\\(?:\n|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|N\{[^}]*\}|[0-7]{1,3}|.)/g;

const plainRole = (value: string, m: string, at: number) => {
  if (m === '...') return 'constant';
  if (m === '->') return null;
  // The `(?<=[(,]\s*)…(?==(?!=))` alternative above: always a keyword argument's name
  if (/^[A-Za-z_]/.test(m) && value[at + m.length] === '=' && value[at + m.length + 1] !== '=') return 'entity';
  return /\w/.test(m) ? 'constant' : 'keyword';
};

export function* paintPython(tokens: HighlightToken[]): Generator<Piece> {
  let afterClass = false;
  for (const [i, token] of tokens.entries()) {
    const { value, className } = token;
    if (!className) {
      // `class Name` — the type's own name; TanStack has no notion of a class's declaration
      const name = afterClass ? /^(\s*)([A-Za-z_]\w*)/.exec(value) : null;
      afterClass = false;
      if (name) {
        if (name[1]) yield [name[1], null];
        yield [name[2]!, 'entity'];
        const rest = value.slice(name[0].length);
        yield* pieces(rest, PYTHON_PLAIN, (m, at) => plainRole(rest, m, at));
        continue;
      }
      yield* pieces(value, PYTHON_PLAIN, (m, at) => plainRole(value, m, at));
      continue;
    }
    if (className === 'keyword') {
      afterClass = value === 'class';
      yield [value, 'keyword'];
      continue;
    }
    if (className === 'string') {
      yield* paintString(value);
      continue;
    }
    if (className === 'number') {
      // `0x1f`, `0b1010`, `0o17`: the base prefix is a keyword, the digits a constant
      const prefix = /^0[bBoOxX]/.exec(value);
      if (prefix) yield [prefix[0], 'keyword'];
      const rest = prefix ? value.slice(2) : value;
      if (rest) yield [rest, 'constant'];
      continue;
    }
    if (className === 'function' && value.startsWith('@')) {
      // TanStack keeps the `@` in the decorator's own token; the grammar paints both like a function
      const name = value.slice(1);
      yield ['@', 'function'];
      yield [name, DESCRIPTORS.has(name) ? 'constant' : 'function'];
      continue;
    }
    if (className === 'function') {
      // A magic method's def is `support.function.magic`, coloured like a constant, not a function
      yield [value, DUNDER.test(value) ? 'constant' : 'function'];
      continue;
    }
    if (className === 'type') {
      // `list[str]`: an indexed builtin reads as a subscript expression, plain like any other
      const next = tokens[i + 1];
      yield [value, next && /^\s*\[/.test(next.value) ? null : 'constant'];
      continue;
    }
    yield [value, roleOf(token)];
  }
}

/**
 * A string literal, prefix and all: `r"…"` keeps its escapes literal (the grammar instead reads a
 * raw string's contents as a possible regular expression — a quirk this does not reproduce, since
 * it would need a full regex sub-lexer for a handful of characters in code this repository has
 * none of), everything else colours `\n`, `\x41`… like a keyword inside the quotes.
 */
function* paintString(value: string): Generator<Piece> {
  const prefix = /^[A-Za-z]{1,2}(?=['"])/.exec(value);
  if (prefix) yield [prefix[0], 'keyword'];
  const body = prefix ? value.slice(prefix[0].length) : value;
  const raw = prefix !== null && /r/i.test(prefix[0]);
  if (prefix && /f/i.test(prefix[0])) {
    yield* fstring(body, raw);
    return;
  }
  if (raw) yield [body, 'string'];
  else if (body) yield* pieces(body, ESCAPE, () => 'keyword', 'string');
}

/** A replacement field of an f-string, one level of nested braces deep (`{x:{width}}`) */
const FIELD = /\{\{|\}\}|\{((?:[^{}]|\{[^{}]{0,200}\}){0,400})\}/g;

/**
 * `f"…{expr!r:>{width}}…"`: TanStack reads it as one string, the grammar reads the fields as code.
 * The braces are keywords, the expression is painted like any other, and the conversion and format
 * spec that follow it are keywords too.
 */
function* fstring(body: string, raw: boolean): Generator<Piece> {
  let at = 0;
  for (const m of body.matchAll(FIELD)) {
    if (m[1] === undefined) continue;
    if (m.index > at) yield* raw ? [[body.slice(at, m.index), 'string'] as Piece] : pieces(body.slice(at, m.index), ESCAPE, () => 'keyword', 'string');
    const field = m[1];
    const spec = specAt(field);
    const expr = field.slice(0, spec);
    yield ['{', 'keyword'];
    yield* pieces(expr, FIELD_CODE, (word, at) => fieldRole(expr, word, at));
    if (spec < field.length) yield [field.slice(spec), 'keyword'];
    yield ['}', 'keyword'];
    at = m.index + m[0].length;
  }
  if (at < body.length) yield* raw ? [[body.slice(at), 'string'] as Piece] : pieces(body.slice(at), ESCAPE, () => 'keyword', 'string');
}

/** Where a field's `!r` or `:spec` starts: the first `!`/`:` outside brackets and quotes */
function specAt(field: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < field.length; i++) {
    const c = field[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && ((c === '!' && field[i + 1] !== '=') || (c === ':' && field[i + 1] !== '='))) return i;
  }
  return field.length;
}

/** Inside a field: quoted strings, numbers, and whatever the plain text of code holds */
const FIELD_CODE = new RegExp(`'[^']*'|"[^"]*"|\\b\\d+(?:\\.\\d+)?\\b|${PYTHON_PLAIN.source}`, 'g');

const fieldRole = (expr: string, m: string, at: number) => (/^['"]/.test(m) ? 'string' : /^\d/.test(m) ? 'constant' : plainRole(expr, m, at));
