import { paintCss } from './css';
import { pieces, roleOf, type Piece } from './paint';
import { paintScript } from './script';
import type { HighlightToken } from '@tanstack/highlight/core';

/** Inside a tag: a bare word is an attribute's name, one after `=` its unquoted value */
const IN_TAG = /(?<==)[^\s>"'=]+|[^\s>"'=/!]+/g;
/** Between tags: `&amp;`, `&#8212;` */
const ENTITY = /&#?\w+;/g;

/**
 * TanStack hands the body of a `<script>` or `<style>` over to the JavaScript or CSS rules, and
 * those bodies are painted like a block of their own. Around them it classes tags, attributes that
 * have a value, and strings; the rest (bare attributes, unquoted values, entities) is cut here.
 */
export function* paintHtml(tokens: HighlightToken[]): Generator<Piece> {
  let inTag = false;
  /** The element whose body is being collected, and the tokens so far */
  let embed: { name: string; tokens: HighlightToken[] } | null = null;
  let opening: string | null = null;
  for (const [i, token] of tokens.entries()) {
    const { value, className } = token;
    const next = tokens[i + 1];
    if (embed) {
      if (closes(token, next, embed.name)) {
        yield* body(embed.name, [...embed.tokens, { ...token, value: value.slice(0, -2) }]);
        yield ['</', null];
        embed = null;
        inTag = true;
      } else embed.tokens.push(token);
      continue;
    }
    if (className === 'tag') {
      const name = value.toLowerCase();
      opening = tokens[i - 1]?.value.endsWith('</') === false && (name === 'script' || name === 'style') ? name : null;
      inTag = true;
      yield [value, 'tag'];
      continue;
    }
    if (className) {
      yield [value, roleOf(token)];
      continue;
    }
    // Plain text: the rest of a tag up to its `>`, then what stands between tags
    let at = 0;
    while (at < value.length) {
      if (inTag) {
        const end = value.indexOf('>', at);
        const stop = end < 0 ? value.length : end + 1;
        // `<!DOCTYPE html>` is a tag of its own, `html` its attribute
        yield* pieces(value.slice(at, stop), IN_TAG, (m, k) => (value[at + k - 1] === '=' ? 'string' : /^doctype$/i.test(m) ? 'tag' : 'constant'));
        at = stop;
        if (end < 0) break;
        inTag = false;
        if (opening) {
          const rest = { ...token, value: value.slice(at) };
          // `<script src="…"></script>`: the body ends in the token it starts in
          if (closes(rest, next, opening)) {
            yield* body(opening, [{ ...rest, value: rest.value.slice(0, -2) }]);
            yield ['</', null];
            inTag = true;
          } else embed = { name: opening, tokens: rest.value ? [rest] : [] };
          opening = null;
          break;
        }
      } else {
        const start = value.indexOf('<', at);
        const stop = start < 0 ? value.length : start + 1;
        yield* pieces(value.slice(at, stop), ENTITY, () => 'keyword');
        at = stop;
        if (start >= 0) inTag = true;
      }
    }
  }
  // A body the block ends inside of, as a streaming block does
  if (embed) yield* body(embed.name, embed.tokens);
}

/** `</script` ends the body: TanStack leaves the `</` at the end of the body's last token */
const closes = (token: HighlightToken, next: HighlightToken | undefined, name: string) =>
  !token.className && token.value.endsWith('</') && next?.className === 'tag' && next.value.toLowerCase() === name;

const body = (name: string, tokens: HighlightToken[]) => (name === 'style' ? paintCss(tokens) : paintScript(tokens, 'js'));
