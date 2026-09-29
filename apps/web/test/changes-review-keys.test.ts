import assert from 'node:assert/strict';
import test from 'node:test';
import { keys } from '../src/api';
import { targetMatches, type Target } from '../src/lib/events';

// The review screen caches a summary, the chat panel and the work item page cache the whole
// response. Sharing a key served the page's object to the review, which threw on `files`.
test("the review screen's summary never shares a cache key with the panel's whole response", () => {
  for (const scope of [{}, { commit: 'abc' }, { uncommitted: true }]) {
    assert.notDeepEqual(keys.workItemChangesReview('w1', scope), keys.workItemChanges('w1', scope));
    assert.notDeepEqual(keys.chatChangesReview('c1', scope), keys.chatChanges('c1', scope));
  }
});

test('the review keys are still refreshed by what refreshes the item and the chat', () => {
  const item: Target = [keys.workItem('w1'), 0];
  assert.ok(targetMatches(item, keys.workItemChangesReview('w1')));
  // Like the page's own changes, a work item's review is left alone by a 'no-diffs' target
  assert.equal(targetMatches([keys.workItem('w1'), 0, 'no-diffs'], keys.workItemChangesReview('w1')), false);
  assert.ok(targetMatches([['chat', 'c1'], 0], keys.chatChangesReview('c1')));
});
