import assert from 'node:assert/strict';
import test from 'node:test';
import { maskSecrets, recognizeSecrets, redactState, SECRET_MASK } from '../src/decisions/redact.ts';
import { AuthStore } from '../src/security/auth.ts';
import { tempConfig } from './helpers.ts';

// Agentry's own secrets in what may leave the machine. On 2026-10-02 the owner's API token reached
// Jev in a decision's state: a chat's command held it as `T="…"`, which no pattern of a credential
// matches. The token is kept only as a hash, so it is recognised by hashing every word long enough
// to be one; the secrets kept in plain are masked as they are.

test("the owner's token is masked wherever a command holds it, recognised by its hash", async () => {
  const store = new AuthStore(tempConfig(), {});
  const { token } = await store.setToken();
  const forget = recognizeSecrets({ values: () => [], isSecret: (word) => store.isOwnSecret(word) });
  try {
    const command = `T="${token}"; curl -H "X-Key: $T" http://127.0.0.1:8787/api/chats`;
    const masked = maskSecrets(command);
    assert.ok(!masked.includes(token));
    assert.equal(masked, `T="${SECRET_MASK}"; curl -H "X-Key: $T" http://127.0.0.1:8787/api/chats`);
    const state = redactState({ commands: [command], note: `the token is ${token}.` }, 4096);
    assert.ok(!JSON.stringify(state).includes(token));
    // A long word that is not the token stays
    assert.equal(maskSecrets('c0ffee'.repeat(8)), 'c0ffee'.repeat(8));
  } finally {
    forget();
  }
});

test("a chat's token is masked by its prefix, and by the store that minted it", async () => {
  const store = new AuthStore(tempConfig(), {});
  const chat = store.chatTokens.mint('chat-1');
  assert.equal(maskSecrets(`AGENTRY_API_TOKEN=x; echo ${chat}`).includes(chat), false);
  assert.equal(store.isOwnSecret(chat), true);
  assert.equal(store.isOwnSecret(`agc_${'a'.repeat(43)}`), false);
});

test('a secret kept in plain is masked as it is; one too short to tell from a word is left', () => {
  const forget = recognizeSecrets({ values: () => ['jev-live-0123456789abcdef', 'short', ''], isSecret: () => false });
  try {
    assert.equal(maskSecrets('key=jev-live-0123456789abcdef and short'), `key=${SECRET_MASK} and short`);
    assert.equal(maskSecrets('X jev-live-0123456789abcdefjev-live-0123456789abcdef'), `X ${SECRET_MASK}${SECRET_MASK}`);
  } finally {
    forget();
  }
  // Taken back: nothing is recognised any more
  assert.equal(maskSecrets('key jev-live-0123456789abcdef'), 'key jev-live-0123456789abcdef');
});
