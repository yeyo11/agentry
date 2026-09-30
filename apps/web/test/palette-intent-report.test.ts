import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaletteReporter } from '../src/components/palette-model.ts';
import { takeNotificationParam } from '../src/lib/notification-open.ts';

test('the palette reports the command it ran, and a close after it adds nothing', () => {
  const sent: Array<[string, string | null]> = [];
  const report = createPaletteReporter((id, commandId) => {
    sent.push([id, commandId]);
    return Promise.resolve();
  });
  report('d1', 'go.home');
  report('d1', null);
  assert.deepEqual(sent, [['d1', 'go.home']]);
});

test('the palette reports null when it closes without a command, and nothing without a decision', () => {
  const sent: Array<[string, string | null]> = [];
  const report = createPaletteReporter((id, commandId) => {
    sent.push([id, commandId]);
    return Promise.resolve();
  });
  report(null, null);
  report('d2', null);
  assert.deepEqual(sent, [['d2', null]]);
});

test('a failed report is ignored', async () => {
  const report = createPaletteReporter(() => Promise.reject(new Error('offline')));
  assert.doesNotThrow(() => report('d3', null));
  await new Promise((r) => setTimeout(r, 0));
});

test('the notification parameter is taken off the address and the rest of the query stays', () => {
  assert.deepEqual(takeNotificationParam('?notification=chat%3Ac1%3Awaiting'), { key: 'chat:c1:waiting', search: '' });
  assert.deepEqual(takeNotificationParam('?prompt=p1&notification=k'), { key: 'k', search: '?prompt=p1' });
  assert.deepEqual(takeNotificationParam('?prompt=p1'), { key: null, search: '?prompt=p1' });
  assert.deepEqual(takeNotificationParam(''), { key: null, search: '' });
});
