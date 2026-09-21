import assert from 'node:assert/strict';
import test from 'node:test';
import { listKeyAction, type KeyLike, type TargetLike } from '../src/lib/list-keys.ts';

const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...over });
const el = (tagName: string, role: string | null = null, isContentEditable = false): TargetLike => ({
  tagName,
  isContentEditable,
  getAttribute: (name) => (name === 'role' ? role : null),
});

test('j, k, x, Enter, / and Escape are the list keys when focus is on nothing in particular', () => {
  assert.equal(listKeyAction(key('j'), null), 'next');
  assert.equal(listKeyAction(key('k'), null), 'previous');
  assert.equal(listKeyAction(key('x'), null), 'select');
  assert.equal(listKeyAction(key('Enter'), null), 'open');
  assert.equal(listKeyAction(key('/'), null), 'search');
  assert.equal(listKeyAction(key('Escape'), null), 'clear');
  assert.equal(listKeyAction(key('q'), null), null);
});

test('a letter typed into a field is text, not a command', () => {
  assert.equal(listKeyAction(key('j'), el('INPUT')), null);
  assert.equal(listKeyAction(key('x'), el('TEXTAREA')), null);
  assert.equal(listKeyAction(key('k'), el('DIV', null, true)), null);
  // A listbox or a menu moves with its own keys
  assert.equal(listKeyAction(key('j'), el('DIV', 'listbox')), null);
  assert.equal(listKeyAction(key('j'), el('BUTTON', 'radio')), null);
});

test('a shortcut with a modifier belongs to the browser', () => {
  assert.equal(listKeyAction(key('j', { ctrlKey: true }), null), null);
  assert.equal(listKeyAction(key('x', { metaKey: true }), null), null);
  assert.equal(listKeyAction(key('k', { altKey: true }), null), null);
});

test('Enter on a link or a button does what that element says; the other keys still move', () => {
  assert.equal(listKeyAction(key('Enter'), el('A')), null);
  assert.equal(listKeyAction(key('Enter'), el('BUTTON')), null);
  assert.equal(listKeyAction(key('Enter'), el('BUTTON', 'checkbox')), null);
  assert.equal(listKeyAction(key('j'), el('A')), 'next');
  assert.equal(listKeyAction(key('x'), el('A')), 'select');
});
