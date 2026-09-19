import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

export function* paintMarkdown(tokens: HighlightToken[]): Generator<Piece> {
  for (const token of tokens) {
    const { value, className } = token;
    if (className === 'link') {
      const m = /^(!?\[)(.*)(\][\s\S]*)$/.exec(value);
      yield* (m ? [[m[1]!, null], [m[2]!, 'string'], [m[3]!, null]] : [[value, null]]) as Piece[];
    } else if (className === 'meta') yield [value, /^\s*([-*+]|\d+[.)])\s*$/.test(value) ? 'entity' : null];
    // The unclassed rest of a fenced block is the block's own foreground, unlike inline code
    else if (className === 'code-inline') yield [value, value.startsWith('`') ? 'constant' : null];
    else yield [value, roleOf(token)];
  }
}

