import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { AppSettingValues, PermissionMode } from '@agentry/shared';

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
  // The desktop app's per-launch secret for its own tray; held in memory, never seeded to disk
  'AGENTRY_DESKTOP_TOKEN',
] as const;

export type AuthEnv = Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>;

export interface CoreConfig {
  claudeBin: string;
  /** The `tailscale` CLI the tunnel runs, from `TAILSCALE_BIN`: the one on the `PATH` unless someone points at another */
  tailscaleBin: string;
  /**
   * Whether this deploy offers the tunnel, from `AGENTRY_TUNNEL`. On by default, and off by default
   * in the Docker image (`AGENTRY_DISTRIBUTION=docker`): the container sees neither the host's
   * `tailscale` CLI nor its daemon, and a way in around the port the operator published and their
   * proxy is theirs to open (docs/plans/tunnel.md, "Answer: the tunnel in Docker").
   */
  tunnelEnabled: boolean;
  /** The HTTPS port of Agentry's `tailscale serve` rule, from `AGENTRY_TUNNEL_PORT`; 8443 by default */
  tunnelPort: number;
  configDir: string;
  /** Global CLI config file holding user-scope mcpServers */
  globalConfigFile: string;
  projectsDir: string;
  workspaceDir: string;
  dataDir: string;
  defaultPermissionMode: PermissionMode;
  setupSeen: boolean;
  maxConcurrentRuns: number;
  /**
   * VAPID `sub` claim of every push the server signs: a `mailto:` or `https:` the push service can
   * complain to. It has to name a real domain — Apple refuses the whole JWT with `403 BadJwtToken`
   * for something like `mailto:agentry@localhost`, and every iPhone goes quiet with it.
   */
  pushSubject: string;
  /**
   * Seeds the guard of an install that has no `auth.json` yet, and carries the desktop app's
   * per-launch secret, which is never written down; see `security/auth.ts`
   */
  authEnv: AuthEnv;
  /**
   * The key the desktop app hands the server to encrypt its secret files with (`AGENTRY_SECRET_KEY`,
   * see `secret-box.ts`); absent on a server, where they stay plain at 0600. The server drops it
   * from `process.env` once read so no chat inherits it.
   */
  secretKey?: string;
  /**
   * How this Agentry was installed, from `AGENTRY_DISTRIBUTION` (lower case): `docker` makes the
   * secret vault keep a key of its own beside the data when the environment brings none.
   */
  distribution?: string;
  /**
   * Host names this wrapper answers to besides loopback, from `AGENTRY_ALLOWED_HOSTS`, each either
   * a name or a `*.domain` pattern standing for its subdomains. Read here for the same reason as
   * `authEnv`: the guard takes its allowlist from a value, so a test can build a wrapper that
   * answers to a name of its own.
   */
  allowedHosts: readonly string[];
  /**
   * The layered settings (`AppSettingValues`) the environment set. The three values above stay the
   * environment's, or the default's; what applies at runtime is read from `AppSettingsStore`, which
   * needs to know which of them the deploy decided and the UI may therefore not change.
   */
  settingsFromEnv: ReadonlySet<keyof AppSettingValues>;
}

/**
 * Why an allowlist entry is not one the guard can match, or null when it is. Shared by the
 * environment and `app-settings.json`, so a pattern refused in one is refused in the other.
 */
export function hostPatternProblem(host: string): string | null {
  const wildcard = host.startsWith('*.');
  if (host.includes('*') && (!wildcard || host.slice(2).includes('*') || host.split('.').length < 3)) {
    return `'${host}' is neither a host name nor a pattern such as '*.example.com'`;
  }
  return null;
}

/**
 * `AGENTRY_ALLOWED_HOSTS` as the names and `*.domain` patterns the guard matches against.
 *
 * A pattern has to name at least two labels below the wildcard. `*.com` is not an allowlist, it is
 * the absence of one, and a wrapper that looks guarded and is not is worse than one that refuses to
 * start: the mistake is a typo at deploy time, which is exactly when someone is still watching.
 */
function parseAllowedHosts(value: string | undefined): string[] {
  const hosts = (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
  for (const host of hosts) {
    const problem = hostPatternProblem(host);
    if (problem) throw new Error(`AGENTRY_ALLOWED_HOSTS: ${problem}`);
  }
  return hosts;
}

/**
 * `AGENTRY_TUNNEL` as a yes or a no, or the default when it says nothing. Anything else stops the
 * wrapper: a typo in the variable that opens a public address is not something to guess about.
 */
function parseTunnelSwitch(value: string | undefined, fallback: boolean): boolean {
  if (!isSet(value)) return fallback;
  const word = value.trim().toLowerCase();
  if (['on', '1', 'true'].includes(word)) return true;
  if (['off', '0', 'false'].includes(word)) return false;
  throw new Error(`AGENTRY_TUNNEL: '${value}' is neither on nor off`);
}

/** A port that is not a port is refused at startup rather than guessed: it decides where a rule lands in the node's shared Serve config. */
function parseTunnelPort(value: string | undefined): number {
  if (!isSet(value)) return 8443;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`AGENTRY_TUNNEL_PORT: '${value}' is not a port between 1 and 65535`);
  return port;
}

function parseSeenSwitch(name: string, value: string): boolean {
  const word = value.trim().toLowerCase();
  if (['on', '1', 'true'].includes(word)) return true;
  if (['off', '0', 'false'].includes(word)) return false;
  throw new Error(`${name}: '${value}' is neither on nor off`);
}

/**
 * The variable an install set before the setup assistant replaced the first-run Providers step. It
 * still counts, so an install that saw the old step is not walked through the assistant again.
 */
export const OLD_SETUP_SEEN_ENV = 'AGENTRY_PROVIDERS_STEP_SEEN';

/** `AGENTRY_SETUP_SEEN`, else the old variable, else nothing */
function setupSeenFromEnv(env: NodeJS.ProcessEnv): boolean | null {
  if (isSet(env.AGENTRY_SETUP_SEEN)) return parseSeenSwitch('AGENTRY_SETUP_SEEN', env.AGENTRY_SETUP_SEEN);
  if (isSet(env[OLD_SETUP_SEEN_ENV])) return parseSeenSwitch(OLD_SETUP_SEEN_ENV, env[OLD_SETUP_SEEN_ENV]);
  return null;
}

/** What a layered setting is when neither the environment nor `app-settings.json` says otherwise. */
export const DEFAULT_APP_SETTINGS: Readonly<AppSettingValues> = Object.freeze({
  allowedHosts: [],
  maxConcurrentRuns: 8,
  defaultPermissionMode: 'acceptEdits',
  setupSeen: false,
});

/** pnpm runs scripts from the package dir; default state dirs belong at the monorepo root instead. */
function baseDir(): string {
  for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
  }
  return process.cwd();
}

/**
 * A variable counts as set when it holds something. Compose files pass `VAR=${VAR:-}` through, and
 * an empty value there means "not configured": treating it as set would lock the setting in the UI
 * to a value nobody chose.
 */
const isSet = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

/** The variable behind each layered setting, which the UI names when it shows one as read-only. */
export const APP_SETTING_ENV = {
  allowedHosts: 'AGENTRY_ALLOWED_HOSTS',
  maxConcurrentRuns: 'AGENTRY_MAX_CONCURRENT_RUNS',
  defaultPermissionMode: 'AGENTRY_DEFAULT_PERMISSION_MODE',
  setupSeen: 'AGENTRY_SETUP_SEEN',
} as const satisfies Record<keyof AppSettingValues, string>;

/**
 * The variables that say where each agent, and each code host's CLI, keeps its sign-in, settings
 * and sessions. The Docker image points them inside the data directory so the one volume holds them
 * (docs/deploy.md); the CLIs would otherwise write to their default homes, which are gone with the
 * container.
 */
export const PROVIDER_HOME_ENV = [
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'COPILOT_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'GH_CONFIG_DIR',
  'GLAB_CONFIG_DIR',
] as const;

/**
 * Creates the provider homes that live inside the data directory. A fresh volume has none of them,
 * and Codex refuses to start with a `CODEX_HOME` that does not exist. A home somewhere else is the
 * operator's own and is left to them. Returns what it created or found, for the log.
 */
export function ensureProviderHomes(env: NodeJS.ProcessEnv, dataDir: string): string[] {
  const homes: string[] = [];
  for (const name of PROVIDER_HOME_ENV) {
    const value = env[name];
    if (!isSet(value) || !isAbsolute(value)) continue;
    const home = resolve(value);
    const inside = relative(dataDir, home);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue;
    mkdirSync(home, { recursive: true });
    homes.push(home);
  }
  return homes;
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
  ensureProviderHomes(env, dataDir);
  return {
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    tailscaleBin: env.TAILSCALE_BIN?.trim() || 'tailscale',
    tunnelEnabled: parseTunnelSwitch(env.AGENTRY_TUNNEL, env.AGENTRY_DISTRIBUTION?.trim().toLowerCase() !== 'docker'),
    tunnelPort: parseTunnelPort(env.AGENTRY_TUNNEL_PORT),
    configDir,
    globalConfigFile,
    projectsDir: join(configDir, 'projects'),
    workspaceDir,
    dataDir,
    defaultPermissionMode: isSet(env.AGENTRY_DEFAULT_PERMISSION_MODE) ? (env.AGENTRY_DEFAULT_PERMISSION_MODE.trim() as PermissionMode) : DEFAULT_APP_SETTINGS.defaultPermissionMode,
    setupSeen: setupSeenFromEnv(env) ?? DEFAULT_APP_SETTINGS.setupSeen,
    maxConcurrentRuns: isSet(env.AGENTRY_MAX_CONCURRENT_RUNS) ? Number(env.AGENTRY_MAX_CONCURRENT_RUNS) : DEFAULT_APP_SETTINGS.maxConcurrentRuns,
    pushSubject: env.AGENTRY_PUSH_SUBJECT?.trim() || 'https://github.com/yeyo11/agentry',
    allowedHosts: parseAllowedHosts(env.AGENTRY_ALLOWED_HOSTS),
    settingsFromEnv: new Set((Object.keys(APP_SETTING_ENV) as (keyof AppSettingValues)[]).filter((key) => isSet(env[APP_SETTING_ENV[key]]) || (key === 'setupSeen' && isSet(env[OLD_SETUP_SEEN_ENV])))),
    authEnv: Object.fromEntries(AUTH_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))) as AuthEnv,
    ...(isSet(env.AGENTRY_SECRET_KEY) ? { secretKey: env.AGENTRY_SECRET_KEY.trim() } : {}),
    ...(isSet(env.AGENTRY_DISTRIBUTION) ? { distribution: env.AGENTRY_DISTRIBUTION.trim().toLowerCase() } : {}),
  };
}
