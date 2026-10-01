import type { ProjectCodeHostRemote } from '@agentry/shared';

/**
 * A remote as Agentry reads it. The user and the secret of the URL are dropped while parsing and
 * exist in no field, so nothing built from this can store, log or serve them.
 */
export interface ParsedRemote extends ProjectCodeHostRemote {
  /** Kept for `https` only: a ported host is `unsupported-host` for now. SSH ports never matter, the alias decides. */
  port: number | null;
}

/** The documented SSH-over-443 names of the two hosts, folded to the host they stand for. */
const FOLDED_HOSTS: Readonly<Record<string, string>> = {
  'ssh.github.com': 'github.com',
  'altssh.gitlab.com': 'gitlab.com',
};

export function foldHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return FOLDED_HOSTS[lower] ?? lower;
}

const unbracket = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

/** `owner/repo` from what follows the host: no leading or trailing slash, no `.git`. */
function cleanPath(raw: string): string {
  let path = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.endsWith('.git')) path = path.slice(0, -4).replace(/\/+$/, '');
  return path;
}

function build(hostname: string, rawPath: string, protocol: ParsedRemote['protocol'], port: number | null): ParsedRemote | null {
  const host = foldHost(unbracket(hostname));
  const path = cleanPath(rawPath);
  if (!host || !path) return null;
  return { hostname: host, path, protocol, port };
}

// `[user[:secret]@]host:path`, the host a name or a bracketed IPv6 address. The user part may hold
// a colon but never a slash, so `./a:b` and `/a:b` stay local paths.
const SCP = /^(?:[^@/]*@)?(\[[^\]]+\]|[^:/@[\]]+):(.*)$/;

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Null for a local path, `file://`, an unknown scheme (plain `http` included, which no host
 * accepts for a push) and anything without both a host and a path.
 */
export function parseRemote(url: string): ParsedRemote | null {
  const text = url.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const scp = SCP.exec(text);
    // `C:\repo` and `C:/repo` are drive letters, not a host named `C`
    if (!scp || /^[a-z]:[\\/]/i.test(text)) return null;
    return build(scp[1] ?? '', scp[2] ?? '', 'ssh', null);
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  const path = decodePath(parsed.pathname);
  if (scheme === 'https') return build(parsed.hostname, path, 'https', parsed.port ? Number(parsed.port) : null);
  if (scheme === 'ssh') return build(parsed.hostname, path, 'ssh', null);
  if (scheme === 'git') return build(parsed.hostname, path, 'git', null);
  return null;
}

/** Runs `ssh` with these arguments and resolves with its stdout; rejects on a non-zero exit. Injected so tests run no process. */
export type SshExec = (args: string[], timeoutMs: number) => Promise<string>;

export const SSH_G_TIMEOUT_MS = 5_000;

/**
 * The real host behind an SSH alias, from `ssh -G`, which prints the configuration with `Host`
 * and `Match` applied and exits without connecting. `ssh` missing, a timeout or no `hostname`
 * line keeps the alias, which then simply fails to match a known host.
 */
export async function resolveSshHost(host: string, exec: SshExec): Promise<string> {
  const alias = unbracket(host);
  // A host that starts with `-` would be read as an option; one with whitespace is not a host
  if (!alias || alias.startsWith('-') || /\s/.test(alias)) return foldHost(alias);
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      exec(['-G', '--', alias], SSH_G_TIMEOUT_MS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ssh -G timed out')), SSH_G_TIMEOUT_MS);
      }),
    ]);
    for (const line of out.split(/\r?\n/)) {
      const match = /^hostname\s+(\S+)\s*$/i.exec(line);
      if (match?.[1]) return foldHost(unbracket(match[1]));
    }
  } catch {
    // keep the alias
  } finally {
    if (timer) clearTimeout(timer);
  }
  return foldHost(alias);
}
