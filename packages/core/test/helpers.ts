import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type CoreConfig } from '../src/paths.ts';

/** Isolated config/workspace/data dirs so tests never touch the real ~/.claude. */
export function tempConfig(): CoreConfig {
  const root = mkdtempSync(join(tmpdir(), 'agentry-test-'));
  return loadConfig({
    CSWAP_BIN: '/nonexistent/cswap',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
    AGENTRY_DATA_DIR: join(root, 'data'),
  });
}
