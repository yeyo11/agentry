import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebhookSecrets } from '../src/hosts/webhook-secrets.ts';
import { SecretBox } from '../src/secret-box.ts';

// Decision 3: encrypted with the key the desktop app hands over, plain at 0600 on a server.
const KEY = randomBytes(32).toString('hex');

const withDir = async (fn: (dir: string, file: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-webhook-secrets-'));
  try {
    await fn(dir, join(dir, 'webhook-secrets.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('on a server the secrets stay plain, at 0600', async () => {
  await withDir(async (dir, file) => {
    const secrets = new WebhookSecrets({ dataDir: dir });
    await secrets.set('r1', 'plain-secret');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { r1: 'plain-secret' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test('with the desktop key they are encrypted on disk and read back whole', async () => {
  await withDir(async (dir, file) => {
    const secrets = new WebhookSecrets({ dataDir: dir, secretKey: KEY });
    await secrets.set('r1', 'sealed-secret');
    assert.ok(!readFileSync(file, 'utf8').includes('sealed-secret'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(new WebhookSecrets({ dataDir: dir, secretKey: KEY }).get('r1'), 'sealed-secret');
    // Another key, or no key, opens nothing: the hook fails verification until it is registered again
    assert.equal(new WebhookSecrets({ dataDir: dir, secretKey: randomBytes(32).toString('hex') }).get('r1'), null);
    assert.equal(new WebhookSecrets({ dataDir: dir }).get('r1'), null);
  });
});

test('a plain file is encrypted at first use under a key, without losing a secret', async () => {
  await withDir(async (dir, file) => {
    writeFileSync(file, JSON.stringify({ r1: 'old-one', r2: 'old-two' }), { mode: 0o600 });
    const secrets = new WebhookSecrets({ dataDir: dir, secretKey: KEY });
    assert.equal(secrets.get('r1'), 'old-one');
    const onDisk = readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes('old-one') && !onDisk.includes('old-two'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const again = new WebhookSecrets({ dataDir: dir, secretKey: KEY });
    assert.equal(again.get('r1'), 'old-one');
    assert.equal(again.get('r2'), 'old-two');
  });
});

test('the box refuses a key of the wrong size and a tampered value opens as nothing', () => {
  assert.throws(() => new SecretBox('abcd'));
  const box = new SecretBox(KEY);
  const sealed = box.seal('v');
  assert.equal(box.open(sealed), 'v');
  assert.equal(box.open(`${sealed.slice(0, -4)}AAAA`), null);
  assert.equal(new SecretBox(null).seal('v'), 'v');
});
