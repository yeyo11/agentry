import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type CoreConfig } from '../src/paths.ts';

/**
 * The providers a test machine may have on its PATH and in its home: a core that detects them runs
 * their CLIs (a handshake starts the agent), and the machine's own sign-in is not what a test is about.
 */
export const OTHER_PROVIDERS = ['codex', 'gemini', 'copilot', 'opencode'] as const;

/** Writes `providers.json` so that only Claude Code (and what `keep` names, with its binary) exists for the core under test. */
export function isolateProviders(config: Pick<CoreConfig, 'dataDir'>, keep: Readonly<Record<string, string | null>> = {}): void {
  mkdirSync(config.dataDir, { recursive: true });
  const entries = Object.fromEntries(OTHER_PROVIDERS.map((id) => [id, { enabled: id in keep, binaryPath: keep[id] ?? null }]));
  writeFileSync(join(config.dataDir, 'providers.json'), JSON.stringify({ providers: entries, order: ['claude-code', ...Object.keys(keep)] }));
}

/**
 * Isolated config/workspace/data dirs so tests never touch the real ~/.claude, and a providers file
 * that leaves the machine's other agent CLIs out of detection (a test that wants one calls
 * `isolateProviders` again with its fake).
 */
export function tempConfig(): CoreConfig {
  const root = mkdtempSync(join(tmpdir(), 'agentry-test-'));
  const config = loadConfig({
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENTRY_WORKSPACE_DIR: join(root, 'workspace'),
    AGENTRY_DATA_DIR: join(root, 'data'),
  });
  isolateProviders(config);
  return config;
}
