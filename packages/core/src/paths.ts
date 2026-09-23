import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { PermissionMode } from '@agentry/shared';

/**
 * What the environment may say about the guard. Read here with everything else the environment
 * configures, so the auth store takes its defaults from a value and not from `process.env`: a
 * wrapper built for a test is then as closed, or as open, as the test asked for.
 */
const AUTH_ENV_KEYS = [
  'AGENTRY_AUTH_MODE',
  'AGENTRY_AUTH_TOKEN',
  'AGENTRY_AUTH_TOKEN_RESET',
  'AGENTRY_READ_ONLY',
  'AGENTRY_OIDC_ISSUER',
  'AGENTRY_OIDC_AUDIENCE',
  'AGENTRY_OIDC_CLIENT_ID',
] as const;

export type AuthEnv = Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>;

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
  /** VAPID `sub` claim of every push the server signs; a `mailto:` or `https:` the push service can complain to */
  pushSubject: string;
  /** Seeds the guard of an install that has no `auth.json` yet; see `security/auth.ts` */
  authEnv: AuthEnv;
  /**
   * Host names this wrapper answers to besides loopback, from `AGENTRY_ALLOWED_HOSTS`. Read here
   * for the same reason as `authEnv`: the guard takes its allowlist from a value, so a test can
   * build a wrapper that answers to a name of its own.
   */
  allowedHosts: readonly string[];
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
    pushSubject: env.AGENTRY_PUSH_SUBJECT?.trim() || 'mailto:agentry@localhost',
    allowedHosts: (env.AGENTRY_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== ''),
    authEnv: Object.fromEntries(AUTH_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))) as AuthEnv,
  };
}
