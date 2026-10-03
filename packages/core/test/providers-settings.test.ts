import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProvidersSettingsStore } from '../src/providers/settings.ts';

const store = (ids = ['a', 'b', 'c']) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentry-providers-settings-'));
  return { dataDir, store: new ProvidersSettingsStore({ dataDir }, ids) };
};

test('an absent file reads as every provider on, in registry order, with no default', () => {
  const { store: s } = store();
  assert.deepEqual(s.get(), {
    providers: { a: { enabled: true, binaryPath: null }, b: { enabled: true, binaryPath: null }, c: { enabled: true, binaryPath: null } },
    order: ['a', 'b', 'c'],
    defaultProvider: null,
    rotation: { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6, maxMoves: 2 }, modelMap: [] },
  });
});

test('a provider left out of a write keeps the defaults and one left out of the order is appended', async () => {
  const { store: s } = store();
  const saved = await s.set({ providers: { b: { enabled: false } }, order: ['c'] });
  assert.equal(saved.providers.b?.enabled, false);
  assert.equal(saved.providers.a?.enabled, true);
  assert.deepEqual(saved.order, ['c', 'a', 'b']);
});

test('what was saved is what the next store reads, and a broken file reads as the defaults', async () => {
  const { dataDir, store: s } = store();
  await s.set({ defaultProvider: 'b' });
  assert.equal(new ProvidersSettingsStore({ dataDir }, ['a', 'b', 'c']).get().defaultProvider, 'b');
  writeFileSync(join(dataDir, 'providers.json'), '{ not json');
  assert.equal(new ProvidersSettingsStore({ dataDir }, ['a', 'b', 'c']).get().defaultProvider, null);
});

test('a write that fails validation leaves the document as it was', async () => {
  const { store: s } = store();
  await s.set({ defaultProvider: 'a' });
  await assert.rejects(s.set({ defaultProvider: 'zzz' }), /defaultProvider must be one of/);
  await assert.rejects(s.set({ providers: { a: { binaryPath: 'relative/bin' } } }), /absolute path/);
  assert.equal(s.get().defaultProvider, 'a');
});

test('rotation: a partial onLimit keeps the defaults and the chosen action stays among the allowed', async () => {
  const { store: s } = store();
  const saved = await s.set({ rotation: { onLimit: { action: 'handoff', maxMoves: 0 } } });
  assert.deepEqual(saved.rotation?.onLimit, { action: 'handoff', allowed: ['wait', 'handoff'], maxWaitHours: 6, maxMoves: 0 });
  const both = await s.set({ rotation: { onLimit: { action: 'restart', allowed: ['wait'] } } });
  assert.deepEqual(both.rotation?.onLimit.allowed, ['wait', 'restart']);
});

test('rotation: the model mapping is validated, stamped and survives a reload', async () => {
  const { dataDir, store: s } = store();
  const entry = { from: { provider: 'a', model: 'big' }, to: { provider: 'b', model: ' large ' }, origin: 'person' };
  const saved = await s.set({ rotation: { modelMap: [entry] } });
  assert.equal(saved.rotation?.modelMap[0]?.to.model, 'large');
  assert.ok(saved.rotation?.modelMap[0]?.at);
  assert.deepEqual(new ProvidersSettingsStore({ dataDir }, ['a', 'b', 'c']).get().rotation, saved.rotation);
});

test('rotation: values out of range, unknown providers and bad mappings are refused and change nothing', async () => {
  const { store: s } = store();
  const good = await s.set({ rotation: { onLimit: { maxMoves: 3 } } });
  const map = (over: Record<string, unknown>) => ({ rotation: { modelMap: [{ from: { provider: 'a', model: 'x' }, to: { provider: 'b', model: 'y' }, origin: 'person', ...over }] } });
  for (const bad of [
    { rotation: [] },
    { rotation: { onLimit: { action: 'fly' } } },
    { rotation: { onLimit: { allowed: [] } } },
    { rotation: { onLimit: { allowed: ['wait', 'wait'] } } },
    { rotation: { onLimit: { maxWaitHours: 0 } } },
    { rotation: { onLimit: { maxWaitHours: 49 } } },
    { rotation: { onLimit: { maxMoves: 6 } } },
    { rotation: { onLimit: { maxMoves: 1.5 } } },
    map({ to: { provider: 'a', model: 'y' } }),
    map({ to: { provider: 'nope', model: 'y' } }),
    map({ to: { provider: 'b', model: ' ' } }),
    map({ origin: 'robot' }),
    map({ at: 'yesterday-ish' }),
    { rotation: { modelMap: [map({}).rotation.modelMap[0], map({}).rotation.modelMap[0]] } },
  ]) {
    await assert.rejects(s.set(bad), JSON.stringify(bad));
  }
  assert.deepEqual(s.get().rotation, good.rotation);
});
