import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rememberedPort, rememberPort } from '../src/server-port.ts';

const userData = () => mkdtempSync(join(tmpdir(), 'agentry-port-'));

test('a desktop install keeps the port it bound, so its address survives a restart', () => {
  const dir = userData();

  // Nothing remembered yet: the first start is the one that chooses
  assert.equal(rememberedPort(dir), null);

  rememberPort(dir, 43123);
  assert.equal(rememberedPort(dir), 43123);

  // What is written is what the server bound, so a fallback replaces the preference
  rememberPort(dir, 51000);
  assert.equal(rememberedPort(dir), 51000);
});

test('a port that could not be bound again is not remembered, and neither is a broken file', () => {
  const dir = userData();

  // 0 is "whatever is free" and privileged ports are not ours to ask for
  for (const port of [0, 80, 1023, 65536, 1.5, Number.NaN]) {
    rememberPort(dir, port);
    assert.equal(rememberedPort(dir), null, String(port));
  }

  writeFileSync(join(dir, 'server-port.json'), 'not json at all');
  assert.equal(rememberedPort(dir), null);

  writeFileSync(join(dir, 'server-port.json'), JSON.stringify({ port: 'ochenta' }));
  assert.equal(rememberedPort(dir), null);
});
