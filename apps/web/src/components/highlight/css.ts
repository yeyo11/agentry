import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

export function* paintCss(tokens: HighlightToken[]): Generator<Piece> {
  for (const [i, token] of tokens.entries()) {
    const { value, className } = token;
    if (!className) {
      // Unclassed words in a declaration are keyword values (`flex`, `solid`); `%` is a unit TanStack leaves out of the number
      const afterNumber = tokens[i - 1]?.className === 'number';
      yield* pieces(value, /(?<![\w-])[a-z][\w-]*|!important|^%/gi, (m) => (/^[a-z]/i.test(m) ? 'constant' : m === '%' && !afterNumber ? null : 'keyword'));
    } else if (className === 'number') {
      const unit = /[a-z%]+$/i.exec(value);
      if (unit && unit.index > 0) yield* [[value.slice(0, unit.index), 'constant'], [unit[0], 'keyword']] as Piece[];
      else yield [value, 'constant'];
    } else if (className === 'selector') {
      // The whole prelude is one token: classes, ids and pseudos are attribute names, bare words tags
      yield* pieces(value, /[.#]-?[\w-]+|::?[\w-]+|\[[^\]]*\]|(?<![\w-])[a-z][\w-]*|[>+~*]/gi, (m) =>
        /^[>+~]$/.test(m) ? 'keyword' : /^[a-z*]/i.test(m) ? 'tag' : 'constant',
      );
    } else yield [value, className === 'function' ? 'constant' : roleOf(token)];
  }
}

