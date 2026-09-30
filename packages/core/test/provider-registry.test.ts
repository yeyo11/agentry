import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_MANIFESTS, ProviderRegistry } from '../src/providers/registry.ts';

test('the shipped manifests share no id and no command', () => {
  const ids = PROVIDER_MANIFESTS.map((m) => m.id);
  const commands = PROVIDER_MANIFESTS.flatMap((m) => m.commands.names);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(commands).size, commands.length);
  assert.doesNotThrow(() => new ProviderRegistry());
});

test('the registry lists the four providers and finds one by id', () => {
  const registry = new ProviderRegistry();
  assert.deepEqual(
    registry.list().map((m) => m.id).sort(),
    ['claude-code', 'codex', 'copilot', 'gemini'],
  );
  assert.equal(registry.get('codex')?.commands.names[0], 'codex');
  assert.equal(registry.get('nope'), undefined);
});

test('the registry rejects a repeated id or command', () => {
  const [claude, codex] = PROVIDER_MANIFESTS;
  assert.ok(claude && codex);
  assert.throws(() => new ProviderRegistry([claude, { ...codex, id: claude.id }]), /declared twice/);
  assert.throws(
    () => new ProviderRegistry([claude, { ...codex, commands: { ...codex.commands, names: ['claude'] } }]),
    /claimed by both/,
  );
});

test('only providers with a driver declare capabilities or a tested range', () => {
  for (const manifest of PROVIDER_MANIFESTS) {
    if (manifest.id === 'claude-code') continue;
    assert.deepEqual(manifest.capabilities, [], manifest.id);
    assert.equal(manifest.versions.range, null, manifest.id);
  }
});
