import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { secretKeyFor, type KeyVault } from '../src/secret-key.ts';
import { serverEnv } from '../src/server-process.ts';

// A keyring that only reverses the bytes: enough to see that the file never holds the key itself
const vault = (available = true): KeyVault => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(plain).reverse(),
  decryptString: (sealed) => Buffer.from(sealed).reverse().toString(),
});

test('the key is made once, kept sealed at 0600, and the same on the next launch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-secret-key-'));
  try {
    const file = join(dir, 'secret-key.bin');
    const key = secretKeyFor(file, vault());
    assert.match(key ?? '', /^[0-9a-f]{64}$/);
    assert.ok(!readFileSync(file, 'utf8').includes(key ?? 'x'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(secretKeyFor(file, vault()), key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a keyring there is no key, and the server keeps its secrets plain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-secret-key-'));
  try {
    assert.equal(secretKeyFor(join(dir, 'secret-key.bin'), vault(false)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the server is handed the key, and a key in the person’s environment is not passed on', () => {
  const opts = { base: { AGENTRY_SECRET_KEY: 'theirs' }, PATH: '/usr/bin', rememberedPort: null, webDist: '/w', dataDir: '/d', workspaceDir: '/s', version: '1', distribution: undefined, desktopSecret: 's' };
  assert.equal(serverEnv({ ...opts, secretKey: 'ours' }).AGENTRY_SECRET_KEY, 'ours');
  assert.equal(serverEnv({ ...opts, secretKey: null }).AGENTRY_SECRET_KEY, undefined);
});
