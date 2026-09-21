import assert from 'node:assert/strict';
import test from 'node:test';
import { SseParser } from '../src/sse.ts';

test('reads events the way the server writes them, comments skipped', () => {
  const parser = new SseParser();
  const events = parser.push('retry: 3000\n\n: ping\n\nid: 7\nevent: run.updated\ndata: {"id":7}\n\nevent: stream.hello\ndata: {}\n\n');
  assert.deepEqual(events, [
    { type: 'run.updated', data: '{"id":7}', id: '7' },
    { type: 'stream.hello', data: '{}', id: '7' },
  ]);
});

test('an event cut across chunks, and CRLF line ends split between them', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('id: 1\r\nevent: orchestration.ta'), []);
  assert.deepEqual(parser.push('sk\r\ndata: a\r'), []);
  assert.deepEqual(parser.push('\ndata: b\r\n\r\n'), [{ type: 'orchestration.task', data: 'a\nb', id: '1' }]);
});

test('an event without a name is a message', () => {
  assert.deepEqual(new SseParser().push('data: x\n\n'), [{ type: 'message', data: 'x', id: null }]);
});
