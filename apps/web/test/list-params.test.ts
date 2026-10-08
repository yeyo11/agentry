import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStored, pickValues, reconcile, sameValues, stillCurrent, storageKey, withValues } from '../src/lib/list-params.ts';

const OWNED = ['q', 'state', 'sort'] as const;

test('list params: only the page’s own, non-empty parameters are its values', () => {
  const params = new URLSearchParams('q=fix&state=&project=p1&sort=cost');
  assert.deepEqual(pickValues(params, OWNED), { q: 'fix', sort: 'cost' });
});

test('list params: values are stored per page and per scope', () => {
  assert.equal(storageKey('chats', 'p1'), 'agentry:filters:chats:p1');
  assert.notEqual(storageKey('chats', 'p1'), storageKey('chats', 'all'));
  assert.notEqual(storageKey('chats', 'p1'), storageKey('schedules', 'p1'));
});

test('list params: what was stored is trusted only as strings under the page’s own names', () => {
  assert.deepEqual(parseStored(null, OWNED), {});
  assert.deepEqual(parseStored('not json', OWNED), {});
  assert.deepEqual(parseStored('[1,2]', OWNED), {});
  assert.deepEqual(parseStored('{"q":"fix","state":3,"sort":"","other":"x"}', OWNED), { q: 'fix' });
});

test('list params: the address keeps what is not the page’s', () => {
  const next = withValues(new URLSearchParams('project=p1&q=old&state=idle'), OWNED, { q: 'new' });
  assert.equal(next.get('project'), 'p1');
  assert.equal(next.get('q'), 'new');
  assert.equal(next.has('state'), false);
});

test('list params: a plain visit brings the stored values back', () => {
  const stored = { state: 'working' };
  assert.deepEqual(reconcile({ url: {}, stored, scopeChanged: false, urlChanged: false }), { values: stored, save: false });
  assert.deepEqual(reconcile({ url: {}, stored, scopeChanged: false, urlChanged: true }), { values: stored, save: false });
});

test('list params: a link that carries values applies them and they become the stored ones', () => {
  const decision = reconcile({ url: { state: 'waiting' }, stored: { state: 'working' }, scopeChanged: false, urlChanged: false });
  assert.deepEqual(decision, { values: { state: 'waiting' }, save: true });
  assert.equal(reconcile({ url: { q: 'a' }, stored: { q: 'a' }, scopeChanged: false, urlChanged: true }).save, false);
});

test('list params: switching project brings that project’s values, unless the address changed with it', () => {
  const switched = reconcile({ url: { q: 'from p1' }, stored: { sort: 'cost' }, scopeChanged: true, urlChanged: false });
  assert.deepEqual(switched, { values: { sort: 'cost' }, save: false });
  const linked = reconcile({ url: { q: 'linked' }, stored: { sort: 'cost' }, scopeChanged: true, urlChanged: true });
  assert.deepEqual(linked, { values: { q: 'linked' }, save: true });
});

test('list params: values compare by content', () => {
  assert.equal(sameValues({ a: '1', b: '2' }, { b: '2', a: '1' }), true);
  assert.equal(sameValues({ a: '1' }, { a: '1', b: '2' }), false);
});

test('list params: a reset made before the stored values reach the address is not undone', () => {
  // The render read `q` from storage; "Show them all" cleared storage before the effect ran
  const stored = { q: 'no-such-graph' };
  const broughtBack = { ...reconcile({ url: {}, stored, scopeChanged: false, urlChanged: false }), stored };
  assert.equal(stillCurrent(broughtBack, {}), false);
  assert.equal(stillCurrent(broughtBack, { q: 'no-such-graph' }), true);
});

test('list params: a link’s values are not stored over a reset or a change made before they are', () => {
  // A link carried `q` over an older stored value; storing it is what the effect does next
  const stored = { q: 'older' };
  const linked = { ...reconcile({ url: { q: 'linked' }, stored, scopeChanged: false, urlChanged: true }), stored };
  assert.equal(linked.save, true);
  assert.equal(stillCurrent(linked, { q: 'older' }), true);
  // Reset cleared storage first: storing `linked` now would have the next render bring it back
  assert.equal(stillCurrent(linked, {}), false);
  // A change on the page stored its own values first
  assert.equal(stillCurrent(linked, { q: 'typed' }), false);
});
