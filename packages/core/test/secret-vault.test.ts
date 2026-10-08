import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { childEnv, useVaultForChildren } from '../src/child-env.ts';
import { CredentialStore } from '../src/credentials.ts';
import { buildHostEnv } from '../src/hosts/env.ts';
import { SecretBox } from '../src/secret-box.ts';
import { SecretVault } from '../src/secret-vault.ts';
import { YoutrackCredentialStore } from '../src/trackers/youtrack/credentials.ts';
import { tempConfig } from './helpers.ts';

const KEY = 'cd'.repeat(32);
const modeOf = (file: string): number => statSync(file).mode & 0o777;

test('with a key in the environment every value is sealed on disk and opened on read', async () => {
  const config = { ...tempConfig(), secretKey: KEY };
  const vault = new SecretVault(config);
  assert.deepEqual([vault.sealed, vault.keyBeside], [true, false]);
  await vault.set('gemini', { GEMINI_API_KEY: 'g-secret' });
  const text = readFileSync(join(config.dataDir, 'secrets.json'), 'utf8');
  assert.ok(!text.includes('g-secret'));
  assert.match(text, /"GEMINI_API_KEY": "enc:v1:/);
  assert.equal(modeOf(join(config.dataDir, 'secrets.json')), 0o600);
  assert.deepEqual(new SecretVault(config).get('gemini'), { GEMINI_API_KEY: 'g-secret' });
  // Another key cannot open it: the value is as good as absent, never garbage
  assert.deepEqual(new SecretVault({ ...config, secretKey: 'ef'.repeat(32) }).get('gemini'), {});
  assert.equal(existsSync(join(config.dataDir, 'secret.key')), false);
});

test('a desktop or source install without a key keeps values plain at 0600 and makes no key', async () => {
  const config = tempConfig();
  const vault = new SecretVault(config);
  assert.deepEqual([vault.sealed, vault.keyBeside], [false, false]);
  await vault.set('opencode', { OPENAI_API_KEY: 'o-plain' });
  assert.ok(readFileSync(join(config.dataDir, 'secrets.json'), 'utf8').includes('o-plain'));
  assert.equal(modeOf(join(config.dataDir, 'secrets.json')), 0o600);
  assert.equal(existsSync(join(config.dataDir, 'secret.key')), false);
});

test('the Docker image without a key makes one beside the data on the first write, 0600, and keeps using it', async () => {
  const config = { ...tempConfig(), distribution: 'docker' };
  const vault = new SecretVault(config);
  assert.deepEqual([vault.sealed, vault.keyBeside], [true, true]);
  // Nothing stored, nothing made
  assert.equal(existsSync(join(config.dataDir, 'secret.key')), false);
  await vault.set('gemini', { GEMINI_API_KEY: 'd-secret' });
  const keyFile = join(config.dataDir, 'secret.key');
  assert.equal(modeOf(keyFile), 0o600);
  assert.match(readFileSync(keyFile, 'utf8').trim(), /^[0-9a-f]{64}$/);
  assert.ok(!readFileSync(join(config.dataDir, 'secrets.json'), 'utf8').includes('d-secret'));
  // A key file already there is used wherever the install is, so moving the volume keeps the secrets
  const elsewhere = new SecretVault({ dataDir: config.dataDir });
  assert.deepEqual([elsewhere.sealed, elsewhere.keyBeside], [true, true]);
  assert.deepEqual(elsewhere.get('gemini'), { GEMINI_API_KEY: 'd-secret' });
  // The environment's key wins over the file, and is not beside the data
  assert.equal(new SecretVault({ ...config, secretKey: KEY }).keyBeside, false);
});

test('clearing a tool forgets its values; a partial clear keeps the rest', async () => {
  const vault = new SecretVault(tempConfig());
  await vault.set('opencode', { OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' });
  await vault.clear('opencode', ['OPENAI_API_KEY']);
  assert.deepEqual(vault.get('opencode'), { ANTHROPIC_API_KEY: 'b' });
  await vault.clear('opencode');
  assert.equal(vault.has('opencode'), false);
});

test('two vaults on one data directory never undo each other\'s write', async () => {
  const config = tempConfig();
  const one = new SecretVault(config);
  const two = new SecretVault(config);
  await one.set('gemini', { GEMINI_API_KEY: 'g' });
  await two.set('youtrack', { YOUTRACK_HOST: 'https://x', YOUTRACK_TOKEN: 't' });
  assert.deepEqual(new SecretVault(config).get('gemini'), { GEMINI_API_KEY: 'g' });
});

test('the old credentials.json moves into the vault once and is removed', () => {
  const config = { ...tempConfig(), secretKey: KEY };
  const old = join(config.dataDir, 'credentials.json');
  writeFileSync(old, JSON.stringify({ oauthToken: 'old-token' }), { mode: 0o600 });
  const vault = new SecretVault(config);
  const store = new CredentialStore(config, vault);
  assert.equal(store.active, true);
  assert.equal(existsSync(old), false);
  assert.deepEqual(vault.get('claude-code'), { CLAUDE_CODE_OAUTH_TOKEN: 'old-token' });
  assert.ok(!readFileSync(join(config.dataDir, 'secrets.json'), 'utf8').includes('old-token'));
});

test('the old youtrack-credentials.json moves into the vault, sealed token included, and is removed', () => {
  const config = { ...tempConfig(), secretKey: KEY };
  const old = join(config.dataDir, 'youtrack-credentials.json');
  writeFileSync(old, JSON.stringify({ host: 'https://x.youtrack.cloud', token: new SecretBox(KEY).seal('perm-old') }), { mode: 0o600 });
  const store = new YoutrackCredentialStore(config, new SecretVault(config));
  assert.deepEqual(store.get(), { host: 'https://x.youtrack.cloud', token: 'perm-old' });
  assert.equal(existsSync(old), false);
});

test('a YouTrack token this key cannot open stays in its old file for a start that has the key', () => {
  const config = tempConfig();
  const old = join(config.dataDir, 'youtrack-credentials.json');
  writeFileSync(old, JSON.stringify({ host: 'https://x.youtrack.cloud', token: new SecretBox(KEY).seal('perm-old') }), { mode: 0o600 });
  assert.equal(new YoutrackCredentialStore(config).get(), null);
  assert.equal(existsSync(old), true);
  assert.deepEqual(new YoutrackCredentialStore({ ...config, secretKey: KEY }).get(), { host: 'https://x.youtrack.cloud', token: 'perm-old' });
  assert.equal(existsSync(old), false);
});

test('a value in the vault wins over the container\'s, reaches only its own tool, and clearing it restores the container\'s', async () => {
  const vault = new SecretVault(tempConfig());
  const release = useVaultForChildren(vault);
  try {
    const container = { GEMINI_API_KEY: 'from-container', ANTHROPIC_API_KEY: 'container-key', PATH: '/bin' };
    await vault.set('gemini', { GEMINI_API_KEY: 'from-vault' });
    assert.equal(childEnv('gemini', container).GEMINI_API_KEY, 'from-vault');
    assert.equal(childEnv('codex', container).GEMINI_API_KEY, 'from-container');
    // Claude's token hides the container's API key, so the CLI never picks between them
    await vault.set('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 'oat' }, { replace: true });
    assert.deepEqual([childEnv('claude-code', container).CLAUDE_CODE_OAUTH_TOKEN, childEnv('claude-code', container).ANTHROPIC_API_KEY], ['oat', undefined]);
    // OpenCode's keys add up and hide nothing
    await vault.set('opencode', { OPENAI_API_KEY: 'oa' });
    assert.deepEqual([childEnv('opencode', container).OPENAI_API_KEY, childEnv('opencode', container).ANTHROPIC_API_KEY], ['oa', 'container-key']);
    await vault.clear('gemini');
    assert.equal(childEnv('gemini', container).GEMINI_API_KEY, 'from-container');
    // A copy every time: the base is never written
    assert.equal(container.GEMINI_API_KEY, 'from-container');
  } finally {
    release();
  }
});

test('youtrack-app gets the vault\'s address and token through the execution layer; gh and glab never do', async () => {
  const vault = new SecretVault(tempConfig());
  const release = useVaultForChildren(vault);
  try {
    await vault.set('youtrack', { YOUTRACK_HOST: 'https://x.youtrack.cloud', YOUTRACK_TOKEN: 'perm' });
    assert.equal(buildHostEnv('youtrack-app', { PATH: '/bin' }).YOUTRACK_TOKEN, 'perm');
    assert.equal(buildHostEnv('gh', { PATH: '/bin' }).YOUTRACK_TOKEN, undefined);
    assert.equal(buildHostEnv('glab', { PATH: '/bin' }).YOUTRACK_TOKEN, undefined);
  } finally {
    release();
  }
});
