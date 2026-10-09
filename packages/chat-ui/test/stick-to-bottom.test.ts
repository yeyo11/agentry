import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrollVerdict } from '../src/composer/stick-to-bottom';

test('a scroll up that is not the reader, while the end is followed, is taken back to the end', () => {
  // Far from the end and near it alike: with every row on screen measured nothing resizes, and only this brings the view back
  assert.equal(scrollVerdict({ following: true, movedUp: true, near: false, byReader: false }), 'pin');
  assert.equal(scrollVerdict({ following: true, movedUp: true, near: true, byReader: false }), 'pin');
});

test('the reader scrolling up away from the end lets go of it', () => {
  assert.equal(scrollVerdict({ following: true, movedUp: true, near: false, byReader: true }), 'release');
});

test('a small nudge up by the reader, still near the end, neither lets go nor is undone', () => {
  // A scrollbar drag starts with a pointer and has no wheel to release on: pulling it back would fight the drag
  assert.equal(scrollVerdict({ following: true, movedUp: true, near: true, byReader: true }), 'none');
});

test('coming back near the end follows it again', () => {
  assert.equal(scrollVerdict({ following: false, movedUp: false, near: true, byReader: true }), 'resume');
  assert.equal(scrollVerdict({ following: false, movedUp: false, near: true, byReader: false }), 'resume');
});

test('a view that is not following the end is left where something else moved it', () => {
  // A search hit or a linked entry being brought into view, or the reader reading back
  assert.equal(scrollVerdict({ following: false, movedUp: true, near: false, byReader: false }), 'none');
  assert.equal(scrollVerdict({ following: false, movedUp: false, near: false, byReader: false }), 'none');
});
