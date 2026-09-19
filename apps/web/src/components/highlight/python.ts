import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

const PYTHON_BUILTINS =
  'abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip self cls';
const PYTHON_PLAIN = new RegExp(`(?<![.\\w])(?:${PYTHON_BUILTINS.split(' ').join('|')})\\b|[=!<>]=|\\*\\*=?|//=?|->|[-+*/%@&|^]=?|=|[<>]`, 'g');

export function* paintPython(tokens: HighlightToken[]): Generator<Piece> {
  for (const token of tokens) {
    if (!token.className) yield* pieces(token.value, PYTHON_PLAIN, (m) => (/\w/.test(m) ? 'constant' : 'keyword'));
    // Builtin types (`str`, `int`) are support.type in the grammar
    else yield [token.value, token.className === 'type' ? 'constant' : roleOf(token)];
  }
}

