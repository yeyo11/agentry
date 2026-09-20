import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

export function* paintOther(tokens: HighlightToken[], lang: string): Generator<Piece> {
  for (const token of tokens) {
    const { value, className } = token;
    if (lang === 'diff' && className === 'meta') {
      // A diff's headers: TanStack has one class for all of them, the grammar one colour each
      const range = /^@@[^@]*@@/.exec(value)?.[0];
      if (range) yield* [[range, 'function'], [value.slice(range.length), null]] as Piece[];
      else yield [value, value.startsWith('---') ? 'deleted' : value.startsWith('+++') ? 'tag' : value.startsWith('diff ') ? 'constant' : null];
    }
    else yield [value, roleOf(token)];
  }
}

