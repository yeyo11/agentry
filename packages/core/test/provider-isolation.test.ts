import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Core } from '../src/index.ts';
import { OTHER_PROVIDERS, tempConfig } from './helpers.ts';

// A test core must not find the machine's own agent CLIs: detecting one runs it (a handshake starts the
// agent), and a real CLI that waits for a sign-in leaves a process behind for ever. Anything that starts
// automated work detects first, so this is what keeps those tests on their fakes.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

test('a core made from the test config detects Claude Code and none of the machine\'s other agents', async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const written = JSON.parse(readFileSync(join(config.dataDir, 'providers.json'), 'utf8')) as { providers: Record<string, { enabled: boolean }> };
  for (const id of OTHER_PROVIDERS) assert.equal(written.providers[id]?.enabled, false, `${id} is left out of the test config`);

  const core = new Core(config);
  try {
    const statuses = await core.providers.refresh();
    for (const id of OTHER_PROVIDERS) {
      const status = statuses.find((s) => s.id === id);
      assert.equal(status?.reason, 'disabled', `${id} was detected: ${JSON.stringify(status)}`);
      assert.equal(status?.binaryPath, null, `${id} resolved a binary of the machine's`);
    }
    assert.equal(statuses.find((s) => s.id === 'claude-code')?.binaryPath, FAKE_CLAUDE);
  } finally {
    core.shutdown();
  }
});
