// What the painters share: the palette, the meaning of a TanStack class, and the helper that cuts
// a token into coloured pieces. One painter per language family, each in its own chunk, so a
// TypeScript block never downloads the rules for shell or markdown.
import type { HighlightToken } from '@tanstack/highlight/core';

/**
 * The github-light-default / github-dark-default colours shiki paints with, by the scope family
 * that gets them. A test holds these against the themes themselves.
 */
export const PALETTE = {
  fg: ['#1f2328', '#e6edf3'], // the theme's foreground
  comment: ['#6e7781', '#8b949e'], // comment
  keyword: ['#cf222e', '#ff7b72'], // keyword, storage, keyword.operator, constant.character.escape
  constant: ['#0550ae', '#79c0ff'], // constant, support, variable.language, variable.other.constant
  entity: ['#953800', '#ffa657'], // entity.name, variable, variable.parameter, variable.object.property
  function: ['#8250df', '#d2a8ff'], // entity.name.function
  tag: ['#116329', '#7ee787'], // entity.name.tag, support.type.property-name.json, markup.inserted
  string: ['#0a3069', '#a5d6ff'], // string
  deleted: ['#82071e', '#ffa198'], // markup.deleted
} as const;
export type Role = keyof typeof PALETTE;

export type Piece = [text: string, role: Role | null];
export type Painter = (tokens: HighlightToken[], lang: string) => Generator<Piece>;

/**
 * What each TanStack class is in the GitHub themes, where the class alone settles it. The painters
 * correct it where the grammar tells apart what TanStack lumps into one class, and colour the
 * operators and names it leaves unclassed.
 *
 * No clean equivalent: `meta` (markdown fences, shell shebangs: the themes leave them in the
 * foreground), `link` (the themes colour the link text, not the URL: split by the markdown
 * painter), `property` (a JSON/YAML key is a tag, a CSS property a constant, a JS member plain or
 * a call).
 */
export const CLASS_ROLE: Record<string, Role | null> = {
  attr: 'constant',
  'code-inline': 'constant',
  command: 'entity',
  comment: 'comment',
  deleted: 'deleted',
  function: 'function',
  heading: 'constant',
  inserted: 'tag',
  keyword: 'keyword',
  link: 'string',
  literal: 'constant',
  meta: null,
  number: 'constant',
  operator: 'keyword',
  property: 'constant',
  selector: 'constant',
  string: 'string',
  tag: 'tag',
  type: 'entity',
  variable: 'entity',
};

export const roleOf = (token: HighlightToken): Role | null => (token.className ? (CLASS_ROLE[token.className] ?? null) : null);

/** `value` cut at each match of `pattern`, every match in the role `role` gives it and the rest in `rest` */
export function* pieces(value: string, pattern: RegExp, role: (match: string, at: number) => Role | null, rest: Role | null = null): Generator<Piece> {
  let at = 0;
  for (const m of value.matchAll(pattern)) {
    if (!m[0]) continue;
    if (m.index > at) yield [value.slice(at, m.index), rest];
    yield [m[0], role(m[0], m.index)];
    at = m.index + m[0].length;
  }
  if (at < value.length) yield [value.slice(at), rest];
}
