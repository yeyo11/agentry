import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, commandNames, matchCommands, slashQuery } from '../src/lib/slash-commands.ts';

test('a command is being typed only while the caret is in a first word that starts with /', () => {
  assert.equal(slashQuery('/', 1), '');
  assert.equal(slashQuery('/con', 4), 'con');
  assert.equal(slashQuery('/con', 2), 'con');
  assert.equal(slashQuery('/context now', 12), null);
  assert.equal(slashQuery('/context now', 8), 'context');
  assert.equal(slashQuery('hi /con', 7), null);
  assert.equal(slashQuery('', 0), null);
  assert.equal(slashQuery('/con', 0), null);
});

test('names lose their slash and repeat once', () => {
  assert.deepEqual(commandNames(['context', '/cost', 'context', ' ', 'engineering:debug']), ['context', 'cost', 'engineering:debug']);
});

test('what starts with the query comes before what only contains it', () => {
  const names = ['engineering:debug', 'debug', 'context', 'compact', 'cost'];
  assert.deepEqual(matchCommands(names, 'co'), ['context', 'compact', 'cost']);
  assert.deepEqual(matchCommands(names, 'DEBUG'), ['debug', 'engineering:debug']);
  assert.deepEqual(matchCommands(names, ''), names);
  assert.equal(matchCommands(Array.from({ length: 80 }, (_, i) => `c${i}`), 'c').length, 50);
});

test('picking replaces the first word and keeps what was written after it', () => {
  assert.deepEqual(applyCommand('/con', 'context'), { text: '/context ', caret: 9 });
  assert.deepEqual(applyCommand('/rev please look at #3', 'review'), { text: '/review please look at #3', caret: 8 });
  assert.deepEqual(applyCommand('/', 'cost'), { text: '/cost ', caret: 6 });
  assert.deepEqual(applyCommand('/x\nsecond line', 'cost'), { text: '/cost \nsecond line', caret: 6 });
});
