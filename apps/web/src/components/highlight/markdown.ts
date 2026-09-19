import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

/**
 * What TanStack leaves unclassed that the grammar colours: HTML comments, and the text of a
 * reference link (`[title][ref]`, `[ref]: url`), a shortcut link (`[x]`) or an alert (`[!NOTE]`).
 */
const MD_PLAIN = /<!--[\s\S]*?-->|(?<=(?:^|[^\\!\]])\[)[^\][\n]+(?=\])/g;

export function* paintMarkdown(tokens: HighlightToken[]): Generator<Piece> {
  /** After a blockquote's `>`: the themes colour the quote's text, to the end of its line */
  let quote = false;
  for (const token of tokens) {
    const { value, className } = token;
    if (!className) {
      const end: number = quote ? value.indexOf('\n') + 1 || value.length : 0;
      if (end) yield* pieces(value.slice(0, end), MD_PLAIN, (m) => (m.startsWith('<!--') ? 'comment' : 'string'), 'tag');
      yield* pieces(value.slice(end), MD_PLAIN, (m) => (m.startsWith('<!--') ? 'comment' : 'string'));
      quote = quote && end === value.length && !value.endsWith('\n');
      continue;
    }
    quote = (className === 'meta' && value.trim() === '>') || (quote && !value.includes('\n'));
    if (className === 'link') {
      // A badge, `[![alt](image)](target)`: the grammar colours the whole image like a link's text
      const badge = /^\[(!\[[\s\S]*)$/.exec(value);
      const m = /^(!?\[)(.*)(\][\s\S]*)$/.exec(value);
      yield* (badge ? [['[', null], [badge[1]!, 'string']] : m ? [[m[1]!, null], [m[2]!, 'string'], [m[3]!, null]] : [[value, null]]) as Piece[];
    } else if (className === 'meta') yield [value, /^\s*([-*+]|\d+[.)])\s*$/.test(value) ? 'entity' : null];
    // The unclassed rest of a fenced block is the block's own foreground, unlike inline code
    else if (className === 'code-inline') yield [value, value.startsWith('`') ? 'constant' : null];
    else yield [value, roleOf(token)];
  }
}
