import type { InlineNode, MarkdownExtension } from '@tanstack/markdown';

// Bare URLs, www. hosts, <angle> autolinks and e-mail addresses, the GFM literals Claude writes
// all the time and @tanstack/markdown leaves as text. The lookbehinds keep a match from starting
// in the middle of a word or of another address.
const LITERAL = /<(https?:\/\/[^\s<>]+)>|(?<![\w/.@-])(?:https?:\/\/|www\.)[^\s<]+|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

/** Drops the punctuation a sentence puts after a URL, and a closing paren the URL did not open. */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] ?? '';
    if ('?!.,:;*_~\'"'.includes(last)) end--;
    else if (last === ')' && url.slice(0, end).split(')').length > url.slice(0, end).split('(').length) end--;
    else break;
  }
  return url.slice(0, end);
}

function hrefFor(literal: string): string {
  if (/^https?:\/\//i.test(literal)) return literal;
  return literal.toLowerCase().startsWith('www.') ? `http://${literal}` : `mailto:${literal}`;
}

function linkText(value: string): InlineNode[] {
  const out: InlineNode[] = [];
  let from = 0;
  for (const match of value.matchAll(LITERAL)) {
    const angled = match[1];
    const literal = angled ?? trimTrailing(match[0]);
    if (/^(?:https?:\/\/|www\.)?$/i.test(literal)) continue;
    const start = match.index;
    if (start > from) out.push({ type: 'text', value: value.slice(from, start) });
    out.push({ type: 'link', href: hrefFor(literal), children: [{ type: 'text', value: literal }] });
    from = start + (angled ? match[0].length : literal.length);
  }
  if (from === 0) return [{ type: 'text', value }];
  if (from < value.length) out.push({ type: 'text', value: value.slice(from) });
  return out;
}

function autolink(nodes: InlineNode[]): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    if (node.type === 'text') return linkText(node.value);
    if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'strike') return [{ ...node, children: autolink(node.children) }];
    return [node];
  });
}

export function autolinkExtension(): MarkdownExtension {
  return { name: 'autolink-literals', transformInline: autolink };
}
