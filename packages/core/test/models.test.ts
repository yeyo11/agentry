import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { forgetModelOptions, modelOptions } from '../src/models.ts';

// The models a person may pick come from the CLI's own state file: it keeps there the options it
// offers under /model, already filtered by what the account's subscription allows. The file is the
// CLI's, written whenever it likes, so every shape it could hand back has to be survivable.

const file = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'agentry-models-')), '.claude.json');
  writeFileSync(path, contents);
  forgetModelOptions();
  return path;
};

const aliases = ['fable', 'opus', 'sonnet', 'haiku'];

test('the aliases stand alone when the CLI has written nothing to read', () => {
  forgetModelOptions();
  assert.deepEqual(
    modelOptions(join(tmpdir(), 'agentry-models-missing', '.claude.json')).map((m) => m.value),
    aliases,
  );
  assert.deepEqual(
    modelOptions(file('not json at all')).map((m) => m.value),
    aliases,
  );
  assert.deepEqual(
    modelOptions(file(JSON.stringify({ additionalModelOptionsCache: 'nonsense' }))).map((m) => m.value),
    aliases,
  );
});

test('what the account may run comes after the aliases, with the names and lines the CLI gives it', () => {
  const options = modelOptions(
    file(
      JSON.stringify({
        additionalModelOptionsCache: [
          { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable' },
          { value: 'cc-update-required-1', label: 'Opus 5.5 (disabled)', description: 'Update to 2.1.280+ to use Opus 5.5', disabled: true },
        ],
      }),
    ),
  );
  assert.deepEqual(options.slice(0, 4).map((m) => m.value), aliases);
  assert.deepEqual(options[4], { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable' });
  assert.equal(options[5]?.disabled, true);
});

test('an entry without a usable name is not one, and one already offered is not offered twice', () => {
  const options = modelOptions(
    file(
      JSON.stringify({
        additionalModelOptionsCache: [
          { label: 'no value' },
          { value: 42 },
          { value: 'has a space' },
          { value: `${'x'.repeat(200)}` },
          { value: 'opus' },
          { value: 'claude-sonnet-5' },
        ],
      }),
    ),
  );
  assert.deepEqual(options.map((m) => m.value), [...aliases, 'claude-sonnet-5']);
});

test('the file is read again once it changes, and not on every ask', () => {
  const path = file(JSON.stringify({ additionalModelOptionsCache: [{ value: 'claude-opus-5' }] }));
  assert.equal(modelOptions(path).length, 5);
  // Same file, untouched: the same answer, which is what keeps the overview's polling cheap
  assert.equal(modelOptions(path), modelOptions(path));
  writeFileSync(path, JSON.stringify({ additionalModelOptionsCache: [{ value: 'claude-opus-5' }, { value: 'claude-haiku-4-5' }] }));
  assert.deepEqual(
    modelOptions(path).map((m) => m.value),
    [...aliases, 'claude-opus-5', 'claude-haiku-4-5'],
  );
});
