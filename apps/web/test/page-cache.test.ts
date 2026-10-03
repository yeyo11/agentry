import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { onBackForwardCache } from '@agentry/ui/lib/page-cache';

// A page kept for Back stays connected: every stream it held takes one of the origin's six
// connections until the page is evicted, and a few chats opened in a row leave the page in front
// queueing its requests (a permission answered from the chat waited half a minute in the browser).

const shown = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted });

test('a page that is hidden lets go at once, and only one shown again from the cache picks up', () => {
  const page = new EventTarget();
  const calls: string[] = [];
  const stop = onBackForwardCache(
    page,
    () => calls.push('release'),
    () => calls.push('resume'),
  );
  page.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(calls, ['release']);
  // A first load is not a return from the cache: the stream it opened is still there
  page.dispatchEvent(shown(false));
  assert.deepEqual(calls, ['release']);
  page.dispatchEvent(shown(true));
  assert.deepEqual(calls, ['release', 'resume']);

  stop();
  page.dispatchEvent(new Event('pagehide'));
  page.dispatchEvent(shown(true));
  assert.deepEqual(calls, ['release', 'resume'], 'a closed stream no longer listens');
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCES = ['apps/web/src', 'packages/chat-ui/src', 'packages/ui/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('every stream the web opens lets go while its page sits in the back/forward cache', () => {
  const opening = SOURCES.flatMap((dir) => files(join(ROOT, dir))).filter((path) => readFileSync(path, 'utf8').includes('new EventSource('));
  assert.ok(opening.length >= 2, 'the app feed and the chat stream are found');
  const leaking = opening.filter((path) => !readFileSync(path, 'utf8').includes('onBackForwardCache(')).map((path) => relative(ROOT, path));
  assert.deepEqual(leaking, []);
});
