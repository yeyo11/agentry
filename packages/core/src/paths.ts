import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { PermissionMode } from '@agentry/shared';

export interface CoreConfig {
  claudeBin: string;
  /** claude-swap binary: owns the account credentials when several accounts are registered */
  cswapBin: string;
  configDir: string;
  /** Global CLI config file holding user-scope mcpServers */
  globalConfigFile: string;
  projectsDir: string;
  workspaceDir: string;
  dataDir: string;
  defaultPermissionMode: PermissionMode;
  maxConcurrentRuns: number;
}

/** pnpm runs scripts from the package dir; default state dirs belong at the monorepo root instead. */
function baseDir(): string {
  for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
  }
  return process.cwd();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const configDir = resolve(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
  // With CLAUDE_CONFIG_DIR the CLI keeps .claude.json inside that directory; otherwise in $HOME.
  const globalConfigFile = env.CLAUDE_CONFIG_DIR
    ? join(configDir, '.claude.json')
    : join(homedir(), '.claude.json');
  const workspaceDir = resolve(env.AGENTRY_WORKSPACE_DIR ?? join(baseDir(), 'workspace'));
  const dataDir = resolve(env.AGENTRY_DATA_DIR ?? join(baseDir(), 'data'));
  for (const dir of [workspaceDir, dataDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return {
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    cswapBin: env.CSWAP_BIN ?? 'cswap',
    configDir,
    globalConfigFile,
    projectsDir: join(configDir, 'projects'),
    workspaceDir,
    dataDir,
    defaultPermissionMode: (env.AGENTRY_DEFAULT_PERMISSION_MODE as PermissionMode | undefined) ?? 'acceptEdits',
    maxConcurrentRuns: Number(env.AGENTRY_MAX_CONCURRENT_RUNS ?? 8),
  };
}
