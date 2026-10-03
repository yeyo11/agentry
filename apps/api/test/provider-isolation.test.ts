import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Core, loadConfig } from '@agentry/core';
import { OTHER_PROVIDERS } from '../../../packages/core/test/helpers.ts';

// The guard `isolate-providers.ts` sets up for every API test file: a core built the way these tests
// build one detects Claude Code and none of the machine's other agents, so no test starts a real CLI.

const FAKE_CLAUDE = fileURLToPath(new URL('../../../packages/core/test/fixtures/fake-claude.mjs', import.meta.url));

test("an API test's core detects Claude Code and none of the machine's other agents", async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentry-api-isolation-'));
  const core = new Core({
    ...loadConfig({ CLAUDE_CONFIG_DIR: join(root, 'claude'), AGENTRY_WORKSPACE_DIR: join(root, 'workspace'), AGENTRY_DATA_DIR: join(root, 'data') }),
    claudeBin: FAKE_CLAUDE,
  });
  try {
    const statuses = await core.providers.refresh();
    for (const id of OTHER_PROVIDERS) {
      const status = statuses.find((s) => s.id === id);
      assert.equal(status?.reason, 'disabled', `${id} was detected: ${JSON.stringify(status)}`);
      assert.equal(status?.binaryPath, null, `${id} resolved a binary of the machine's`);
    }
  } finally {
    core.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
