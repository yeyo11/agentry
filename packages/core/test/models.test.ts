import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { forgetModelOptions, ModelAliasIds, modelDisplayName, modelOptions } from '../src/models.ts';

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

test('a model id reads as its family and version: `claude-`, a release date and a variant are not part of the name', () => {
  assert.equal(modelDisplayName('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelDisplayName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelDisplayName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelDisplayName('claude-fable-5-1[1m]'), 'Fable 5.1 (1M)');
  assert.equal(modelDisplayName('claude-opus-5-5-20260101[1m]'), 'Opus 5.5 (1M)');
  // The older scheme put the version first
  assert.equal(modelDisplayName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  // Anything off the scheme is left unnamed rather than guessed at
  for (const id of ['sonnet', 'fake', 'claude-', 'claude-sonnet', 'claude-5', 'gpt-5', '<synthetic>', 'claude-sonnet_5', 'claude-sonnet-12345']) {
    assert.equal(modelDisplayName(id), null, id);
  }
});

test('an alias is named after the model a chat reported it as, and stands alone until one has', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-model-ids-'));
  const ids = new ModelAliasIds(dir);
  const cli = join(dir, 'missing', '.claude.json');
  forgetModelOptions();
  assert.equal(modelOptions(cli, ids.get()).find((m) => m.value === 'sonnet')?.label, undefined);

  assert.equal(ids.record('sonnet', 'claude-sonnet-5'), true);
  assert.equal(ids.record('opus', 'claude-opus-5-5[1m]'), true);
  // The same again changes nothing, and only an alias with a real model id is kept
  assert.equal(ids.record('sonnet', 'claude-sonnet-5'), false);
  for (const [requested, reported] of [
    ['claude-sonnet-5', 'claude-sonnet-5'],
    [undefined, 'claude-sonnet-5'],
    ['haiku', 'haiku'],
    ['haiku', '<synthetic>'],
    ['haiku', 42],
    ['my-model', 'claude-haiku-4-5'],
  ] as const) {
    assert.equal(ids.record(requested, reported), false, `${String(requested)} → ${String(reported)}`);
  }
  const options = modelOptions(cli, ids.get());
  assert.equal(options.find((m) => m.value === 'sonnet')?.label, 'Sonnet 5');
  assert.equal(options.find((m) => m.value === 'opus')?.label, 'Opus 5.5 (1M)');
  assert.equal(options.find((m) => m.value === 'haiku')?.label, undefined);

  // Kept across a restart, in a document of its own
  await ids.settled();
  assert.deepEqual(JSON.parse(readFileSync(ids.file, 'utf8')), { sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5[1m]' });
  assert.deepEqual(new ModelAliasIds(dir).get(), { sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5[1m]' });
  // A newer release behind the alias replaces the name
  ids.record('sonnet', 'claude-sonnet-5-1');
  await ids.settled();
  assert.equal(modelOptions(cli, new ModelAliasIds(dir).get()).find((m) => m.value === 'sonnet')?.label, 'Sonnet 5.1');
});

test("a label the CLI gives wins over the derived one, and a broken document of ours is only names lost", () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-model-ids-'));
  writeFileSync(join(dir, 'model-aliases.json'), 'not json');
  const broken = new ModelAliasIds(dir);
  assert.deepEqual(broken.get(), {});
  writeFileSync(join(dir, 'model-aliases.json'), JSON.stringify({ sonnet: 'claude-sonnet-5', nonsense: 'claude-x-1', opus: 12 }));
  assert.deepEqual(new ModelAliasIds(dir).get(), { sonnet: 'claude-sonnet-5' });
  const labelled = file(JSON.stringify({ additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable' }] }));
  const options = modelOptions(labelled, { sonnet: 'claude-sonnet-5', 'claude-fable-5-1[1m]': 'claude-fable-5-1[1m]' });
  assert.equal(options.find((m) => m.value === 'claude-fable-5-1[1m]')?.label, 'Fable');
  assert.equal(options.find((m) => m.value === 'sonnet')?.label, 'Sonnet 5');
});
