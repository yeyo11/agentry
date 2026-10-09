import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHostCall, type HostCall } from '../hosts/exec.ts';
import { resolveCommand } from './path.ts';

/** A host name, with a port at most; it goes into argv after `--hostname`, so it may never start with a dash */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;

/** Where a CLI that falls back to the GitHub CLI's sign-in asks it for a token */
export interface GhFallback {
  /** The host used when none of `hostEnv` is set */
  hostname: string;
  /** Variables that name the host, first set wins (Copilot: `COPILOT_GH_HOST`, then `GH_HOST`) */
  hostEnv: string[];
}

/**
 * The host the CLI asks gh about, read from the environment it will start with the way the vendor
 * documents it. A value given as a URL (`https://acme.ghe.com`) is read as its host, since that is
 * the form `copilot login --host` takes. Null when the variable holds something that is not a host
 * name: the CLI would ask gh about that and get nothing, so no gh sign-in can stand in for it.
 */
export function ghFallbackHost(fallback: GhFallback, env: NodeJS.ProcessEnv): string | null {
  const named = fallback.hostEnv.map((name) => env[name]?.trim()).find((value) => Boolean(value));
  if (!named) return fallback.hostname;
  const host = named.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  return HOST_NAME.test(host) ? host : null;
}

/**
 * Whether the GitHub CLI holds a token for `hostname`, the way a CLI that falls back to it asks:
 * `gh auth token --hostname <host>` (Copilot's documented last credential source). It runs the `gh`
 * found on the same PATH the agent gets, so the answer is the one the agent will see, through the
 * code-host execution layer (gh's own environment, a process group, a timeout). Only the exit code
 * and whether anything was printed are read; the token is dropped here and never logged.
 */
export async function ghHasToken(hostname: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<boolean> {
  const binaryPath = await resolveCommand('gh', env.PATH ?? '');
  if (!binaryPath) return false;
  const call: HostCall = { cli: 'gh', args: ['auth', 'token', '--hostname', hostname], kind: 'read', class: 'probe', host: hostname };
  try {
    const result = await runHostCall(call, { binaryPath, cwd: tmpdir(), baseEnv: env, timeoutMs, killGraceMs: 1_000, retry: { delaysMs: [] } });
    // A signed-out gh exits 1; a probe is never retried, it is read again at the next detection
    return result.exitCode === 0 && result.stdout.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * gh's configuration directory, in the order `gh help environment` gives: GH_CONFIG_DIR,
 * `$XDG_CONFIG_HOME/gh`, `$AppData/GitHub CLI` on Windows, then `~/.config/gh`.
 */
export function ghConfigDir(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh');
  if (platform === 'win32' && env.AppData) return join(env.AppData, 'GitHub CLI');
  return join(home, '.config', 'gh');
}

/** gh reads these before its stored sign-in for a host other than github.com (`gh help environment`) */
const ENTERPRISE_TOKEN_ENV = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

/**
 * The account gh is signed in to `hostname` with, from the `user:` gh writes for each host in its
 * `hosts.yml`: a file the CLI writes, read with no network call. Only that one field of the host's
 * block is read; a token gh may keep beside it in plain text is never captured. Null when there is
 * no file, no such host or no user, or when an enterprise token in the environment answers for the
 * host instead of the stored sign-in, since its account is not the one the file names.
 */
export async function ghAccount(hostname: string, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): Promise<string | null> {
  if (hostname !== 'github.com' && ENTERPRISE_TOKEN_ENV.some((name) => Boolean(env[name]))) return null;
  let text: string;
  try {
    text = await readFile(join(ghConfigDir(env, home, platform), 'hosts.yml'), 'utf8');
  } catch {
    return null;
  }
  return hostsUser(text, hostname);
}

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * `user:` of one host in gh's hosts.yml: a top-level key per host, and the host's own keys one
 * indentation level below it (`users:` lists every account, `user:` is the active one). A full YAML
 * parser would be a dependency for one field of a file whose shape gh fixes.
 */
export function hostsUser(text: string, hostname: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\S/.test(line) && unquote(line.replace(/:\s*$/, '')).toLowerCase() === hostname);
  if (start < 0) return null;
  let indent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) break;
    const depth = line.length - line.trimStart().length;
    indent ??= depth;
    if (depth !== indent) continue;
    const match = /^\s+user:\s*(.*)$/.exec(line);
    if (match) {
      const user = unquote(match[1] ?? '');
      return user || null;
    }
  }
  return null;
}
