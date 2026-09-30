import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const SHELL_TIMEOUT_MS = 5_000;
const SENTINEL = '__AGENTRY_PATH__';

/** Set to `1` in the login shell's environment, so an rc file can skip its slow parts (prompts, plugins) */
export const SHELL_PATH_PROBE_ENV = 'AGENTRY_SHELL_PATH_PROBE';

/** Why the login shell's PATH could not be read. "Could not check" is not "there is nothing" */
export type ShellPathFailure = 'no-shell' | 'timeout' | 'spawn-error' | 'empty-path';

export type ShellPathResult = { ok: true; path: string } | { ok: false; reason: ShellPathFailure };

export interface ShellPathOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * PATH of an interactive login shell: a GUI launch, a service or a server started from one skips the
 * profile files that set up nvm, npm prefixes and so on. The failure is typed so a caller can tell
 * a shell that timed out from one that printed nothing.
 */
export function probeLoginShellPath(options: ShellPathOptions = {}): Promise<ShellPathResult> {
  const env = options.env ?? process.env;
  const shell = env.SHELL;
  if (!shell) return Promise.resolve({ ok: false, reason: 'no-shell' });
  return new Promise((resolve) => {
    // Sentinels let us ignore whatever banners an rc file prints
    execFile(
      shell,
      ['-ilc', `printf "${SENTINEL}%s${SENTINEL}" "$PATH"`],
      {
        timeout: options.timeoutMs ?? SHELL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: { ...env, TERM: 'dumb', [SHELL_PATH_PROBE_ENV]: '1' },
      },
      (err, stdout) => {
        // A failing rc file can make the shell exit non-zero after printing the PATH, so output wins over the exit code
        const path = new RegExp(`${SENTINEL}(.*?)${SENTINEL}`, 's').exec(stdout)?.[1];
        if (path) return resolve({ ok: true, path });
        if (err) return resolve({ ok: false, reason: err.killed ? 'timeout' : 'spawn-error' });
        resolve({ ok: false, reason: 'empty-path' });
      },
    );
  });
}

/** `1.10.0` > `1.9.0`: compares the numeric parts of a version such as `v20.11.1` */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

async function readTrimmed(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bin directories of the nvm versions: the one `nvm alias default` points at first, the rest newest
 * first. A new terminal uses the default, so its global installs are the ones the person expects.
 */
export async function nvmBinDirs(nvmDir: string): Promise<string[]> {
  let installed: string[];
  try {
    installed = (await readdir(join(nvmDir, 'versions', 'node')))
      .filter((v) => /^v\d/.test(v))
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
  // An alias file holds a version, another alias (`lts/*`, a custom name) or `node`/`stable` for the newest
  let target = await readTrimmed(join(nvmDir, 'alias', 'default'));
  for (let hops = 0; target && hops < 5; hops++) {
    if (/^v?\d/.test(target) || target === 'node' || target === 'stable') break;
    target = await readTrimmed(join(nvmDir, 'alias', ...target.split('/')));
  }
  let preferred: string | undefined;
  if (target === 'node' || target === 'stable') preferred = installed[0];
  else if (target) {
    const prefix = target.startsWith('v') ? target : `v${target}`;
    preferred = installed.find((v) => v === prefix || v.startsWith(`${prefix}.`));
  }
  const ordered = preferred ? [preferred, ...installed.filter((v) => v !== preferred)] : installed;
  return ordered.map((v) => join(nvmDir, 'versions', 'node', v, 'bin'));
}

/** Where a CLI usually lands when neither the login shell nor the inherited PATH knows it */
export async function installDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<string[]> {
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(env.ASDF_DATA_DIR || join(home, '.asdf'), 'shims'),
    join(env.MISE_DATA_DIR || join(home, '.local', 'share', 'mise'), 'shims'),
    env.PNPM_HOME || join(home, '.local', 'share', 'pnpm'),
    ...(await nvmBinDirs(env.NVM_DIR || join(home, '.nvm'))),
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    join(home, '.nix-profile', 'bin'),
    '/nix/var/nix/profiles/default/bin',
    '/snap/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

export interface UserPathOptions extends ShellPathOptions {
  home?: string;
}

/** Login shell PATH first, then the current PATH, then install directories; deduplicated, existing dirs only */
export async function resolveUserPath(options: UserPathOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const shell = await probeLoginShellPath(options);
  const candidates = [
    ...(shell.ok ? shell.path.split(delimiter) : []),
    ...(env.PATH ?? '').split(delimiter),
    ...(await installDirs(env, options.home)),
  ];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs.join(delimiter);
}

/** An executable regular file, checked with `fs` alone: no `which`, because security software can gate every spawn */
async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first directory of `pathValue` holding an executable `command`; a command with a slash is checked as it is */
export async function resolveCommand(command: string, pathValue: string = process.env.PATH ?? ''): Promise<string | undefined> {
  if (command.includes('/')) return (await isExecutable(command)) ? command : undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, command);
    if (await isExecutable(file)) return file;
  }
  return undefined;
}
