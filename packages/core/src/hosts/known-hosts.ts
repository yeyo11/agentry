import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface GlabKnownHost {
  hostname: string;
  /** The `user:` of that host's entry, which names the account; null when there is none */
  user: string | null;
}

export interface KnownHostsOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Where glab keeps `config.yml`, in the order the plan lists: GLAB_CONFIG_DIR, then
 * `~/.config/glab-cli`, then `XDG_CONFIG_HOME/glab-cli` (https://docs.gitlab.com/cli/configuration/).
 * The caller opens the first that exists.
 */
export function glabConfigCandidates(options: KnownHostsOptions = {}): string[] {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  if (env.GLAB_CONFIG_DIR) candidates.push(join(env.GLAB_CONFIG_DIR, 'config.yml'));
  candidates.push(join(options.home ?? homedir(), '.config', 'glab-cli', 'config.yml'));
  if (env.XDG_CONFIG_HOME) candidates.push(join(env.XDG_CONFIG_HOME, 'glab-cli', 'config.yml'));
  return candidates;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** `key:` or `"key":` with nothing after it: a host name, since a host's own fields have values. */
function hostKey(trimmed: string): string | null {
  const match = /^(?:"([^"]+)"|'([^']+)'|([^\s:'"#][^\s'"#]*?))\s*:\s*(?:#.*)?$/.exec(trimmed);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function userValue(trimmed: string): string | null {
  const match = /^user\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#'"][^\s#]*))\s*(?:#.*)?$/.exec(trimmed);
  const value = match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
  return value ? value : null;
}

/**
 * The host names, and each one's user, under `hosts:` in glab's `config.yml`. The file is read a
 * line at a time and a line is kept only when it is a host's name or its `user:`: a `token:` line
 * (which glab keeps there when it has no keyring) is dropped as it is read, so no secret is ever
 * held, returned or logged. A missing or unreadable file is an empty list: glab knows no host.
 */
export async function readGlabKnownHosts(file: string): Promise<GlabKnownHost[]> {
  const found: GlabKnownHost[] = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let inHosts = false;
  let hostIndent: number | null = null;
  let current: GlabKnownHost | null = null;
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const indent = indentOf(line);
      if (indent === 0) {
        inHosts = /^hosts\s*:\s*(?:#.*)?$/.test(trimmed);
        hostIndent = null;
        current = null;
        continue;
      }
      if (!inHosts) continue;
      hostIndent ??= indent;
      if (indent === hostIndent) {
        const name = hostKey(trimmed);
        current = name ? { hostname: name.toLowerCase(), user: null } : null;
        if (current) found.push(current);
      } else if (indent > hostIndent && current && current.user === null) {
        current.user = userValue(trimmed);
      }
    }
  } catch {
    return [];
  } finally {
    lines.close();
    stream.destroy();
  }
  return found;
}

/** The first `config.yml` among the candidates that exists, as the host list it holds. */
export async function glabKnownHosts(options: KnownHostsOptions = {}): Promise<GlabKnownHost[]> {
  for (const file of glabConfigCandidates(options)) {
    try {
      await access(file);
    } catch {
      continue;
    }
    return readGlabKnownHosts(file);
  }
  return [];
}
