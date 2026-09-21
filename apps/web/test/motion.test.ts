import assert from 'node:assert/strict';
import test from 'node:test';
import type { MotionLevel } from '../src/lib/motion.ts';

// The motion level decides whether anything on screen loops. What matters is that it is decided
// before the first paint, that the operating system's answer beats the stored one, and that a
// background tab stops paying for animations nobody is watching.

interface Loaded {
  root: { dataset: Record<string, string> };
  stored: Map<string, string>;
  fire: (type: string) => void;
  setMotionPreference: (level: MotionLevel) => void;
  setHidden: (hidden: boolean) => void;
}

let instance = 0;

async function load({ reduced = false, stored }: { reduced?: boolean; stored?: string } = {}): Promise<Loaded> {
  const root = { dataset: {} as Record<string, string> };
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('agentry-motion', stored);
  const handlers = new Map<string, Set<() => void>>();
  const listen = (type: string, fn: () => void) => {
    const set = handlers.get(type) ?? new Set();
    set.add(fn);
    handlers.set(type, set);
  };
  const doc = { documentElement: root, hidden: false, addEventListener: listen };
  Object.assign(globalThis, {
    document: doc,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    window: { matchMedia: () => ({ matches: reduced, addEventListener: listen }) },
  });
  const module = await import(`../src/lib/motion.ts?case=${++instance}`);
  const fire = (type: string) => handlers.get(type)?.forEach((fn) => fn());
  return {
    root,
    stored: store,
    fire,
    setMotionPreference: module.setMotionPreference,
    setHidden: (hidden: boolean) => {
      doc.hidden = hidden;
      fire('visibilitychange');
    },
  };
}

test('the level is stamped on the document at import time, before React has rendered', async () => {
  const { root } = await load();
  assert.equal(root.dataset.motion, 'full');
  assert.equal(root.dataset.hidden, 'false');
});

test('a stored level is in force from the first paint', async () => {
  const { root } = await load({ stored: 'subtle' });
  assert.equal(root.dataset.motion, 'subtle');
});

test('a stored value that is not a level is ignored rather than stamped', async () => {
  const { root } = await load({ stored: 'sparkly' });
  assert.equal(root.dataset.motion, 'full');
});

test('the operating system asking for reduced motion wins over what is stored', async () => {
  const { root } = await load({ reduced: true, stored: 'full' });
  assert.equal(root.dataset.motion, 'off');
});

test('choosing a level stores it, and choosing the default stops storing anything', async () => {
  const { root, stored, setMotionPreference } = await load();
  setMotionPreference('subtle');
  assert.equal(root.dataset.motion, 'subtle');
  assert.equal(stored.get('agentry-motion'), 'subtle');
  setMotionPreference('full');
  assert.equal(root.dataset.motion, 'full');
  assert.equal(stored.has('agentry-motion'), false);
});

test('a hidden tab is marked, so the stylesheet can pause every loop, and unmarked on return', async () => {
  const { root, setHidden } = await load();
  setHidden(true);
  assert.equal(root.dataset.hidden, 'true');
  setHidden(false);
  assert.equal(root.dataset.hidden, 'false');
});
