import assert from 'node:assert/strict';
import test from 'node:test';
import { DETAIL_PARAM, decodeDetail, detailHref, encodeDetail, type DetailRef } from '../src/lib/detail.ts';

// `?detail=` is the panel's address: it must survive a reload, a shared link and whatever a person
// types over it, so decoding has to say "no panel" rather than guess.

const REFS: DetailRef[] = [
  { kind: 'task', chatId: 'c1', taskId: 'bg-1' },
  { kind: 'subagent', chatId: 'c1', agentId: 'a1b2c3' },
  { kind: 'workflow-agent', chatId: 'c1', workflowId: 'wf_5c79d6c0-b39', agentId: 'a4fdeef8' },
  { kind: 'chat', chatId: 'c1' },
];

test('every kind of panel decodes back to what was encoded', () => {
  for (const ref of REFS) assert.deepEqual(decodeDetail(encodeDetail(ref)), ref);
});

test('the encoding is the kind followed by each id, colon-separated', () => {
  assert.equal(encodeDetail(REFS[0] as DetailRef), 'task:c1:bg-1');
  assert.equal(encodeDetail(REFS[1] as DetailRef), 'subagent:c1:a1b2c3');
  assert.equal(encodeDetail(REFS[2] as DetailRef), 'workflow-agent:c1:wf_5c79d6c0-b39:a4fdeef8');
  assert.equal(encodeDetail(REFS[3] as DetailRef), 'chat:c1');
});

test('an id holding a colon, a slash or a space does not shift the parts after it', () => {
  const awkward: DetailRef[] = [
    { kind: 'task', chatId: 'a:b', taskId: 'c/d e' },
    { kind: 'subagent', chatId: '100%', agentId: 'x:y:z' },
    { kind: 'workflow-agent', chatId: ':', workflowId: '?&=', agentId: 'é' },
  ];
  for (const ref of awkward) {
    const encoded = encodeDetail(ref);
    // Only the separators are bare colons
    assert.equal(encoded.split(':').length, ref.kind === 'workflow-agent' ? 4 : 3, encoded);
    assert.deepEqual(decodeDetail(encoded), ref);
  }
});

test('nothing, or something that is not a panel, decodes to null', () => {
  for (const value of [null, '', 'task', 'task:', 'task:c1', 'task:c1:', 'task::bg-1', 'nope:c1:bg-1', 'Task:c1:bg-1', ':c1:bg-1']) {
    assert.equal(decodeDetail(value), null, JSON.stringify(value));
  }
});

test('the wrong number of ids for a kind is not a panel', () => {
  assert.equal(decodeDetail('chat:c1:extra'), null);
  assert.equal(decodeDetail('task:c1:bg-1:extra'), null);
  assert.equal(decodeDetail('subagent:c1'), null);
  assert.equal(decodeDetail('subagent:c1:a1:extra'), null);
  assert.equal(decodeDetail('workflow-agent:c1:wf_1'), null);
  assert.equal(decodeDetail('workflow-agent:c1:wf_1:a1:extra'), null);
});

test('a malformed escape is dropped instead of throwing', () => {
  assert.doesNotThrow(() => decodeDetail('task:%E0%A4%A:bg-1'));
  assert.equal(decodeDetail('task:%E0%A4%A:bg-1'), null);
  assert.equal(decodeDetail('task:c1:%'), null);
});

test('a link puts the encoded panel in the search of the given path, escaped once more for the URL', () => {
  const ref: DetailRef = { kind: 'subagent', chatId: 'c:1', agentId: 'a1' };
  const href = detailHref(ref, '/chats/c%3A1');
  assert.equal(href, '/chats/c%3A1?detail=subagent%3Ac%253A1%3Aa1');
  // What the router hands back after parsing the address is what the panel decodes
  const params = new URLSearchParams(href.slice(href.indexOf('?')));
  assert.equal(params.get(DETAIL_PARAM), encodeDetail(ref));
  assert.deepEqual(decodeDetail(params.get(DETAIL_PARAM)), ref);
});

test('a link without a path stays on the current page', () => {
  assert.equal(detailHref(REFS[0] as DetailRef), '?detail=task%3Ac1%3Abg-1');
});
