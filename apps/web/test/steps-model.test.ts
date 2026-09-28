import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditStep } from '@agentry/shared';
import { parseUnified } from '../src/lib/diff';
import {
  conversationHref,
  currentStep,
  entryParam,
  intentParts,
  patchSpan,
  plainIntent,
  sameFileWindow,
  scrubDots,
  stepBeside,
  stepKey,
  stepPaths,
  swipeOf,
} from '../src/components/changes/steps/steps-model';

// Step by step decides which edit is shown, where the scrubber stands and what a key or a swipe
// does from these rules; the components only draw what they return.

let n = 0;
const step = (path: string, extra: Partial<EditStep> = {}): EditStep => {
  n += 1;
  return {
    id: `toolu_${n}`,
    index: n,
    at: `2026-09-28T14:0${n % 10}:00.000Z`,
    tool: 'Edit',
    path,
    additions: 1,
    deletions: 1,
    diff: '',
    created: false,
    intent: null,
    entryIndex: n * 2,
    pending: false,
    ...extra,
  };
};

const reset = () => {
  n = 0;
};

test('the step a link names is current, and the latest one without a link or with a stale one', () => {
  reset();
  const steps = [step('a.ts'), step('b.ts'), step('a.ts')];
  assert.equal(currentStep(steps, 'toolu_2')?.id, 'toolu_2');
  assert.equal(currentStep(steps, null)?.id, 'toolu_3');
  assert.equal(currentStep(steps, 'toolu_gone')?.id, 'toolu_3');
  assert.equal(currentStep([], null), null);
});

test('previous and next stop at either end', () => {
  reset();
  const steps = [step('a.ts'), step('b.ts'), step('c.ts')];
  assert.equal(stepBeside(steps, steps[0]!, -1), null);
  assert.equal(stepBeside(steps, steps[0]!, 1)?.id, 'toolu_2');
  assert.equal(stepBeside(steps, steps[2]!, 1), null);
  assert.equal(stepBeside(steps, null, 1), null);
});

test('the scrubber marks what came before, the current step, and the one still working', () => {
  reset();
  const steps = [step('a.ts'), step('b.ts'), step('c.ts'), step('d.ts'), step('e.ts', { pending: true })];
  assert.deepEqual(scrubDots(steps, 'toolu_3'), ['done', 'done', 'current', 'ahead', 'live']);
  // On the pending step itself the reader's place wins
  assert.deepEqual(scrubDots(steps, 'toolu_5'), ['done', 'done', 'done', 'done', 'current']);
});

test('the file filter lists each file once, in the order it was first edited', () => {
  reset();
  assert.deepEqual(stepPaths([step('b.ts'), step('a.ts'), step('b.ts')]), ['b.ts', 'a.ts']);
});

test('"this file, step by step" keeps the current step in the middle of three, or at an edge', () => {
  reset();
  const steps = [step('a.ts'), step('a.ts'), step('b.ts'), step('a.ts'), step('a.ts'), step('a.ts')];
  const ids = (s: EditStep) => sameFileWindow(steps, s).steps.map((x) => x.index);
  assert.deepEqual(ids(steps[3]!), [2, 4, 5]);
  assert.deepEqual(ids(steps[0]!), [1, 2, 4]);
  assert.deepEqual(ids(steps[5]!), [4, 5, 6]);
  assert.equal(sameFileWindow(steps, steps[0]!).total, 5);
  assert.deepEqual(sameFileWindow(steps, steps[2]!), { steps: [steps[2]], total: 1 });
});

test('a patch card is titled with the lines of the new file it covers', () => {
  const diff = parseUnified('@@ -31,10 +34,12 @@ export function x()\n a\n-b\n+c\n+d\n e\n@@ -60,2 +64,0 @@\n-f\n-g\n');
  assert.deepEqual(patchSpan(diff), { from: 34, to: 64 });
  assert.equal(patchSpan(parseUnified('')), null);
});

test('what Claude put between backticks reads as code', () => {
  assert.deepEqual(intentParts('`fileDiff` takes a context or `\'full\'`.'), [
    { code: true, text: 'fileDiff' },
    { code: false, text: ' takes a context or ' },
    { code: true, text: "'full'" },
    { code: false, text: '.' },
  ]);
  assert.deepEqual(intentParts('a lone ` stays text'), [{ code: false, text: 'a lone ` stays text' }]);
  // The list and the cards have no room for code: they read the words alone
  assert.equal(plainIntent('`fileDiff` takes `context`'), 'fileDiff takes context');
});

test('"See it in the conversation" opens the chat at the entry that holds the call', () => {
  assert.equal(conversationHref('chat 1', { entryIndex: 41 }), '/chats/chat%201?at=41');
  assert.equal(conversationHref('c', { entryIndex: null }), null);
});

test('a chat link\'s ?at= is an entry index or nothing', () => {
  assert.equal(entryParam('0'), 0);
  assert.equal(entryParam('128'), 128);
  for (const bad of [null, '', '-1', '1.5', 'abc', '1e3', '99999999999']) assert.equal(entryParam(bad), null, String(bad));
});

test('the arrows move between steps, except in a field, with a modifier, or on a control that owns them', () => {
  const key = (k: string, extra: Record<string, unknown> = {}) =>
    stepKey({ key: k, target: null, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...extra } as Parameters<typeof stepKey>[0]);
  assert.equal(key('ArrowLeft'), -1);
  assert.equal(key('ArrowRight'), 1);
  assert.equal(key('ArrowDown'), null);
  assert.equal(key('ArrowRight', { metaKey: true }), null);
  assert.equal(key('ArrowRight', { shiftKey: true }), null);
  assert.equal(key('ArrowRight', { defaultPrevented: true }), null);
  assert.equal(key('ArrowRight', { target: { tagName: 'INPUT' } }), null);
  assert.equal(key('ArrowRight', { target: { tagName: 'BUTTON', getAttribute: () => 'tab' } }), null);
  assert.equal(key('ArrowRight', { target: { tagName: 'A', getAttribute: () => null } }), 1);
});

test('a swipe sideways moves a step; a short or mostly vertical one does not', () => {
  assert.equal(swipeOf(-120, 10), 1);
  assert.equal(swipeOf(120, -20), -1);
  assert.equal(swipeOf(30, 0), null);
  assert.equal(swipeOf(-80, 70), null);
});
