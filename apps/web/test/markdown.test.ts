import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../src/components/controls/Tooltip.tsx';
import Markdown from '../src/components/Markdown.tsx';

// CodeBlock's copy button carries a tooltip
const html = (text: string) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { text })));

test('raw HTML in an answer shows as text and is never interpreted', () => {
  const out = html('<div onclick="alert(1)">hi</div>\n\ninline <b>bold</b> <img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<div onclick|<b>|<img/);
  assert.match(out, /&lt;div onclick=&quot;alert\(1\)&quot;&gt;/);
});

test('links open in a new tab without handing over the opener', () => {
  assert.match(html('[docs](https://example.com)'), /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test('script URLs never become links', () => {
  assert.doesNotMatch(html('[x](javascript:alert(1))'), /javascript:/);
});

test('images show as links instead of fetching the URL', () => {
  const out = html('![diagram](https://example.com/x.png)');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /<a href="https:\/\/example.com\/x.png" target="_blank" rel="noopener noreferrer" class="md-image-link">diagram<\/a>/);
});

test('task list boxes are read-only marks, not form controls', () => {
  const out = html('- [x] typecheck\n- [ ] e2e');
  assert.doesNotMatch(out, /<input/);
  assert.match(out, /<span class="md-task is-done" aria-label="done"><\/span>/);
  assert.match(out, /<span class="md-task " aria-label="to do"><\/span>/);
});

test('fenced code goes through CodeBlock with its language, and a bare fence has none', () => {
  const out = html('```ts\nconst a = 1;\nconst b = 2;\n```\n\n```\nplain\n```');
  assert.doesNotMatch(out, /tm-code/);
  assert.match(out, /const a = 1;\nconst b = 2;/);
  assert.match(out, />ts</);
  assert.doesNotMatch(out, /plaintext/);
});

test('a code fence still being streamed renders as code, not as text', () => {
  assert.match(html('```py\nprint(1)\npri'), /print\(1\)\npri/);
});

test('GFM tables sit in the scrolling wrapper', () => {
  assert.match(html('| a | b |\n| - | -: |\n| 1 | 2 |'), /<div class="md-table"><table><thead>/);
});

test('bare URLs, www hosts, angle autolinks and e-mail addresses become links', () => {
  const out = html('See https://example.com/a_b?x=1. or (www.example.com) or <https://angle.com> or foo@bar.com.');
  assert.match(out, /<a href="https:\/\/example.com\/a_b\?x=1" target="_blank"[^>]*>https:\/\/example.com\/a_b\?x=1<\/a>\. or/);
  assert.match(out, /\(<a href="http:\/\/www.example.com"[^>]*>www.example.com<\/a>\)/);
  assert.match(out, /<a href="https:\/\/angle.com"[^>]*>https:\/\/angle.com<\/a> or/);
  assert.match(out, /<a href="mailto:foo@bar.com"[^>]*>foo@bar.com<\/a>\./);
});

test('a URL keeps the parentheses it opened itself', () => {
  assert.match(html('https://en.wikipedia.org/wiki/Foo_(bar)'), /href="https:\/\/en.wikipedia.org\/wiki\/Foo_\(bar\)"/);
});

test('URLs inside inline code and link text are left alone', () => {
  const out = html('`https://a.com` and [https://b.com](https://c.com)');
  assert.match(out, /<code>https:\/\/a.com<\/code>/);
  assert.equal(out.match(/<a /g)?.length, 1);
});
