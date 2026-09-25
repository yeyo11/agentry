// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Illustration, ILLUSTRATION_NAMES, type IllustrationSize, type IllustrationTone } from '../src/components/illustrations';
import { Empty } from '../src/components/ui';

// The illustrations share one page with the rest of the app (and sometimes with each other), so
// their defs ids must be unique per instance, and they must stay invisible to assistive tech.

const rootTag = (html: string) => html.match(/^<svg[^>]*>/)?.[0] ?? '';
const rootClasses = (html: string) => (rootTag(html).match(/class="([^"]*)"/)?.[1] ?? '').split(' ');

test('every illustration renders its drawing', () => {
  assert.equal(ILLUSTRATION_NAMES.length, 13);
  for (const name of ILLUSTRATION_NAMES) {
    const html = renderToStaticMarkup(<Illustration name={name} />);
    assert.match(rootTag(html), /viewBox="0 0 240 160"/, name);
    // More than the shared backdrop: the drawing itself is there
    assert.ok((html.match(/<(path|circle|rect|text|ellipse)\b/g) ?? []).length > 5, name);
    assert.doesNotMatch(html, /<style|<title|#[0-9a-f]{3,6}\b/i, name);
  }
});

test('two instances on one page share no id', () => {
  const html = renderToStaticMarkup(
    <div>
      <Illustration name="welcome" />
      <Illustration name="welcome" />
      <Illustration name="offline" />
    </div>,
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? '');
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/);
  // Every reference points at a def of the same page
  for (const [, ref = ''] of html.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref), ref);
});

test('the root is hidden from assistive tech', () => {
  const root = rootTag(renderToStaticMarkup(<Illustration name="chats" />));
  assert.match(root, /aria-hidden="true"/);
  assert.match(root, /focusable="false"/);
  assert.doesNotMatch(root, /role=|aria-label/);
});

test('size and tone set their classes, and unknown values fall back to the defaults', () => {
  assert.deepEqual(rootClasses(renderToStaticMarkup(<Illustration name="chats" />)), ['il']);
  assert.deepEqual(rootClasses(renderToStaticMarkup(<Illustration name="chats" size="lg" tone="live" className="x" />)), ['il', 'il-lg', 'il-live', 'x']);
  // A drawing keeps the tone it has in the catalogue unless asked otherwise
  assert.deepEqual(rootClasses(renderToStaticMarkup(<Illustration name="quota" />)), ['il', 'il-bad']);
  assert.deepEqual(rootClasses(renderToStaticMarkup(<Illustration name="quota" tone="accent" />)), ['il']);
  const size = 'huge' as IllustrationSize;
  const tone = 'pink' as IllustrationTone;
  assert.deepEqual(rootClasses(renderToStaticMarkup(<Illustration name="chats" size={size} tone={tone} />)), ['il']);
  assert.deepEqual(rootClasses(renderToStaticMarkup(<Illustration name="signed-out" size={size} tone={tone} />)), ['il', 'il-warn']);
});

test('Empty shows the illustration instead of the icon, and keeps the icon without one', () => {
  const full = renderToStaticMarkup(
    <Empty title="No chats yet" illustration="chats" size="sm" action={<button type="button">New chat</button>}>
      Start one.
    </Empty>,
  );
  assert.match(full, /class="state state-empty state-illustrated"/);
  assert.match(full, /class="il il-sm"/);
  assert.doesNotMatch(full, /state-icon/);
  assert.match(full, /<strong>No chats yet<\/strong>/);
  assert.match(full, /class="state-action"><button/);

  const compact = renderToStaticMarkup(<Empty title="Nothing here" />);
  assert.match(compact, /^<div class="state state-empty"><span class="state-icon"/);
  assert.doesNotMatch(compact, /class="il/);
});
