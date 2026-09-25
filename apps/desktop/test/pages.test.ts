import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { errorUrl, OFFLINE_ILLUSTRATION, splashUrl } from '../src/pages.ts';

const html = (url: string) => decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ''));

test('the error page inlines the design system offline illustration unchanged', () => {
  const svg = readFileSync(new URL('../../../docs/design-system/illustrations/offline.svg', import.meta.url), 'utf8');
  assert.equal(OFFLINE_ILLUSTRATION, svg.trim());
  assert.ok(html(errorUrl('Server failed', 'detail', '/tmp/log')).includes(OFFLINE_ILLUSTRATION));
});

test('the error page escapes what it shows', () => {
  const page = html(errorUrl('<b>', 'a & b', '"x"'));
  assert.ok(page.includes('&#60;b&#62;'));
  assert.ok(page.includes('a &#38; b'));
  assert.ok(!page.includes('<b>'));
});

test('the splash spinner stops under reduced motion', () => {
  assert.match(html(splashUrl()), /@media \(prefers-reduced-motion: reduce\) \{ \.spin \{ animation: none; \} \}/);
});
