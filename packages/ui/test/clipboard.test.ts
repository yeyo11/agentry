import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { copyText } from '../src/lib/clipboard.ts';

// No DOM here: each case stands in the few globals copyText reads, the way a browser has them
const g = globalThis as Record<string, unknown>;
const saved = { navigator: g.navigator, window: g.window, document: g.document, HTMLElement: g.HTMLElement };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key];
    else Object.defineProperty(g, key, { value, configurable: true, writable: true });
  }
});

function stand(opts: { secure: boolean; clipboard?: { writeText(text: string): Promise<void> }; execCommand?: (cmd: string) => boolean }) {
  const selected: string[] = [];
  class FakeElement {
    value = '';
    style: Record<string, string> = {};
    setAttribute() {}
    focus() {}
    select() {
      selected.push(this.value);
    }
    setSelectionRange() {}
    remove() {}
    closest() {
      return null;
    }
  }
  Object.defineProperty(g, 'HTMLElement', { value: FakeElement, configurable: true, writable: true });
  Object.defineProperty(g, 'navigator', { value: opts.clipboard ? { clipboard: opts.clipboard } : {}, configurable: true, writable: true });
  Object.defineProperty(g, 'window', { value: { isSecureContext: opts.secure }, configurable: true, writable: true });
  Object.defineProperty(g, 'document', {
    value: {
      activeElement: null,
      body: { appendChild() {} },
      createElement: () => new FakeElement(),
      execCommand: opts.execCommand ?? (() => true),
    },
    configurable: true,
    writable: true,
  });
  return { selected };
}

test('in a secure context the text goes through the asynchronous clipboard', async () => {
  const written: string[] = [];
  const { selected } = stand({ secure: true, clipboard: { writeText: async (text) => void written.push(text) } });
  assert.equal(await copyText('hola'), true);
  assert.deepEqual(written, ['hola']);
  assert.deepEqual(selected, [], 'no fallback when the clipboard took it');
});

test('over plain HTTP, where navigator.clipboard is missing, the text is still copied', async () => {
  const { selected } = stand({ secure: false });
  assert.equal(await copyText('a message'), true);
  assert.deepEqual(selected, ['a message']);
});

test('a refused clipboard write falls back to the selection copy', async () => {
  const { selected } = stand({ secure: true, clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } });
  assert.equal(await copyText('x'), true);
  assert.deepEqual(selected, ['x']);
});

test('when nothing can copy, it says so instead of pretending', async () => {
  stand({ secure: false, execCommand: () => false });
  assert.equal(await copyText('x'), false);
});
