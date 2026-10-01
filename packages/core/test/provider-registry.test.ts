import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatManager } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { PROVIDER_MANIFESTS, ProviderRegistry } from '../src/providers/registry.ts';
import { tempConfig } from './helpers.ts';

test('the shipped manifests share no id and no command', () => {
  const ids = PROVIDER_MANIFESTS.map((m) => m.id);
  const commands = PROVIDER_MANIFESTS.flatMap((m) => m.commands.names);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(commands).size, commands.length);
  assert.doesNotThrow(() => new ProviderRegistry());
});

test('the registry lists the five providers and finds one by id', () => {
  const registry = new ProviderRegistry();
  assert.deepEqual(
    registry.list().map((m) => m.id).sort(),
    ['claude-code', 'codex', 'copilot', 'gemini', 'opencode'],
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
    if (manifest.id === 'codex') continue;
    if (manifest.id === 'claude-code' || manifest.transport === 'acp') {
      assert.ok(manifest.capabilities.length > 0 && manifest.versions.range, manifest.id);
      continue;
    }
    assert.deepEqual(manifest.capabilities, [], manifest.id);
    assert.equal(manifest.versions.range, null, manifest.id);
  }
});

test('driverFor finds the drivers the registry was given and nothing for a provider without one', () => {
  const driver = new ClaudeCodeDriver('claude');
  const registry = new ProviderRegistry(PROVIDER_MANIFESTS, [driver]);
  assert.equal(registry.driverFor('claude-code'), driver);
  assert.equal(registry.driverFor('codex'), null);
  assert.equal(new ProviderRegistry().driverFor('claude-code'), null);
  const orphan = Object.assign(new ClaudeCodeDriver('claude'), { manifest: { ...driver.manifest, id: 'nope' } });
  assert.throws(() => new ProviderRegistry(PROVIDER_MANIFESTS, [orphan]), /has no manifest/);
});

test('the default session provider is the default when it can run chats, else the first in the order that can', () => {
  const registry = new ProviderRegistry(PROVIDER_MANIFESTS, [new ClaudeCodeDriver('claude')]);
  const order = ['codex', 'gemini', 'claude-code'];
  assert.equal(registry.defaultSessionProvider({ order, defaultProvider: null }), 'claude-code');
  assert.equal(registry.defaultSessionProvider({ order, defaultProvider: 'codex' }), 'claude-code');
  assert.equal(registry.defaultSessionProvider({ order, defaultProvider: 'claude-code' }), 'claude-code');
  assert.equal(registry.defaultSessionProvider({ order: ['codex'], defaultProvider: null }), null);
});

test('a provider with a manifest and no driver cannot start a chat', () => {
  const config = tempConfig();
  const chats = new ChatManager(config, new Db(config), []);
  assert.throws(() => chats.start({ prompt: 'hi', provider: 'codex' }), /cannot run chats yet/);
  assert.throws(() => chats.start({ prompt: 'hi' }), /cannot run chats yet/);
});
