import { pieces, roleOf, type Piece } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

/** A YAML scalar the grammar reads as a boolean, null, number or date, where TanStack often reads a string */
const YAML_CONSTANT = /^(?:true|false|yes|no|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[\da-f]+|0o[0-7]+|\d{4}-\d\d-\d\d(?:[tT ][\d:.]+(?:z|[-+]\d\d(?::\d\d)?)?)?)$/i;

/**
 * What TanStack leaves unclassed in YAML: a flow mapping's keys (`{ max-size: 10m }`), and plain
 * scalars, which are strings to the themes unless they read as a constant. A scalar runs to the
 * end of its line; the key is bounded so that a line of thousands of `-` cannot make the scan
 * quadratic by backtracking over every start.
 */
const YAML_PLAIN = /[^\s:[\]{},#'"][^\s:[\]{},]{0,120}(?=:\s)|[^\s:\-[\]{},#][^\n]*/gm;

/** The same inside a flow sequence (`[a, b]`), where an item ends at its comma or bracket */
const FLOW_ITEM = /[^\s:\-[\]{},#][^\n,\]}]*/gm;

/** `\n`, `\u00e9`: the themes colour an escape like a keyword */
const ESCAPE = /\\(?:u[\da-fA-F]{4}|[\s\S])/g;

export function* paintData(tokens: HighlightToken[], lang: string): Generator<Piece> {
  const yaml = lang === 'yaml';
  /** A key TanStack found in `- claude-config:/home`, where no space after the colon makes it a scalar */
  let glued = false;
  for (const [i, token] of tokens.entries()) {
    const { value, className } = token;
    const next = tokens[i + 1]?.value ?? '';
    if (className === 'property') {
      glued = yaml && (/^:\S/.test(next) || (next === ':' && /^\S/.test(tokens[i + 2]?.value ?? ' ')));
      yield [value, glued ? 'string' : 'tag'];
      continue;
    }
    if (glued && !className && value === ':') {
      yield [value, 'string'];
      continue;
    }
    glued = false;
    // Block scalar indicators
    if (className === 'string' && /^[|>][-+]?$/.test(value)) yield [value, 'keyword'];
    else if (className === 'string' && value.startsWith('"')) yield* pieces(value, ESCAPE, () => 'keyword', 'string');
    else if (!yaml) yield [value, roleOf(token)];
    else if ((className === 'string' || className === 'number') && YAML_CONSTANT.test(value)) yield [value, 'constant'];
    // An anchor names what follows it; an alias only refers to one, and stays plain
    else if (className === 'string' && /^&\S+$/.test(value)) yield [value, 'entity'];
    // `[a, b]`: TanStack takes a flow sequence for one string, the grammar colours its items
    else if (className === 'string' && value.startsWith('[')) yield* pieces(value, FLOW_ITEM, (m) => (YAML_CONSTANT.test(m) ? 'constant' : 'string'));
    else if (!className) yield* pieces(value, YAML_PLAIN, (m, at) => (/^:\s/.test(value.slice(at + m.length, at + m.length + 2)) ? 'tag' : YAML_CONSTANT.test(m) ? 'constant' : 'string'));
    else yield [value, roleOf(token)];
  }
}
