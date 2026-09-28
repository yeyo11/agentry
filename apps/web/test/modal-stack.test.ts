import assert from 'node:assert/strict';
import test from 'node:test';
import { createModalStack } from '../src/components/modal-stack';

// A dialog opened from another (a relation picker over New task, a confirmation over the item
// panel) takes the keyboard; the one under it hears nothing until it closes. Before, each listened
// on the document itself and Escape closed both.

const escape = () => Object.assign(new Event('keydown'), { key: 'Escape' });

test('only the surface on top hears a key', () => {
  const target = new EventTarget();
  const stack = createModalStack(target);
  const heard: string[] = [];
  const popPanel = stack.push(() => heard.push('panel'));
  const popConfirm = stack.push(() => heard.push('confirm'));
  target.dispatchEvent(escape());
  assert.deepEqual(heard, ['confirm']);

  popConfirm();
  target.dispatchEvent(escape());
  assert.deepEqual(heard, ['confirm', 'panel']);
  popPanel();
});

test('a surface closed out of order leaves the right one on top, and an empty stack stops listening', () => {
  const calls: string[] = [];
  const target = {
    addEventListener: () => calls.push('add'),
    removeEventListener: () => calls.push('remove'),
  };
  const stack = createModalStack(target);
  const heard: string[] = [];
  const popA = stack.push(() => heard.push('a'));
  const popB = stack.push(() => heard.push('b'));
  popA();
  assert.equal(stack.size, 1);
  popA();
  assert.equal(stack.size, 1, 'taking one off twice is harmless');
  popB();
  assert.equal(stack.size, 0);
  assert.deepEqual(calls, ['add', 'remove'], 'one listener for the whole stack, there only while something is open');
});
