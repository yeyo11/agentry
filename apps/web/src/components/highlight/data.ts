import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

export function* paintData(tokens: HighlightToken[], lang: string): Generator<Piece> {
  for (const token of tokens) {
    const { value, className } = token;
    if (className === 'property') yield [value, 'tag'];
    // Block scalar indicators
    else if (className === 'string' && /^[|>][-+]?$/.test(value)) yield [value, 'keyword'];
    // An unquoted YAML scalar is a string to the themes, and TanStack leaves it plain
    else if (!className && lang === 'yaml') yield* pieces(value, /[^\s:\-[\]{},#][^\n]*?(?=\s*$)/gm, () => 'string');
    else yield [value, roleOf(token)];
  }
}

