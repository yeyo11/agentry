import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { Core } from '../src/index.ts';
import { AuthStore } from '../src/security/auth.ts';
import { CHAT_TOKEN_PREFIX, ChatTokenStore } from '../src/security/chat-tokens.ts';
import { tempConfig } from './helpers.ts';

test('the chat-token store holds a hash of each token and never the token itself', () => {
  const store = new ChatTokenStore();
  const token = store.mint('chat-1', 1234);
  const entries = [...(store as unknown as { tokens: Map<string, Record<string, unknown>> }).tokens];
  const held = JSON.stringify(entries.map(([key, entry]) => [key, Object.values(entry).map((value) => (Buffer.isBuffer(value) ? value.toString('hex') : value))]));
  assert.ok(!held.includes(token), 'the token is not held');
  assert.ok(!held.includes(token.slice(CHAT_TOKEN_PREFIX.length)));
  assert.ok(held.includes(createHash('sha256').update(token).digest('hex')));
  assert.equal(store.verify(token), 'chat-1');
});

test('a new chat-token store, as after a restart of the wrapper, knows no token', () => {
  const token = new ChatTokenStore().mint('chat-1');
  assert.equal(new ChatTokenStore().verify(token), null);
});

test('a revoked chat token and a stranger are refused, and revoking one leaves the others', () => {
  const store = new ChatTokenStore();
  const one = store.mint('chat-1');
  const two = store.mint('chat-1');
  store.revoke(one);
  assert.equal(store.verify(one), null);
  assert.equal(store.verify(two), 'chat-1');
  assert.equal(store.verify(`${CHAT_TOKEN_PREFIX}not-one-of-ours`), null);
  assert.equal(store.verify(''), null);
});

test('a chat token is honoured only under a guard and only from a local chat', async () => {
  const config = tempConfig();
  const auth = new AuthStore(config, { AGENTRY_AUTH_TOKEN: 'owner-token-owner-token-1234' });
  const token = auth.chatTokens.mint('chat-9');
  assert.equal(auth.chatActorFor(token, true), 'chat:chat-9');
  assert.equal(auth.chatActorFor(token, false), null);
  // The owner's check never takes a chat token for the owner's
  assert.equal(await auth.actorFor(token, true), null);
  const open = new AuthStore(tempConfig(), {});
  const openToken = open.chatTokens.mint('chat-9');
  assert.equal(open.chatActorFor(openToken, true), null);
  assert.equal(await open.actorFor(openToken, true), 'local');
});

test('no chat token or hash of one reaches auth.json or the data dir', () => {
  const config = tempConfig();
  const core = new Core({ ...config, authEnv: { AGENTRY_AUTH_TOKEN: 'owner-token-owner-token-1234' } });
  try {
    const token = core.security.chatTokens.mint('chat-1');
    const hash = createHash('sha256').update(token).digest('hex');
    for (const name of readdirSync(config.dataDir, { recursive: true, encoding: 'utf8' })) {
      let text: string;
      try {
        text = readFileSync(join(config.dataDir, name)).toString('latin1');
      } catch {
        continue;
      }
      assert.ok(!text.includes(token) && !text.includes(hash), `${name} holds a chat token`);
    }
  } finally {
    core.shutdown();
  }
});
