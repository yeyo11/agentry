import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const SHELL_TIMEOUT_MS = 5_000;

/** Where the `claude` CLI usually lands, in case the login shell cannot be queried */
function commonDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.claude', 'local'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

/** PATH of an interactive login shell: GUI launches skip the profile files that set up nvm, npm prefixes, etc. */
function loginShellPath(): Promise<string> {
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    // Sentinels let us ignore whatever banners an rc file prints
    execFile(
      shell,
      ['-ilc', 'printf "__AGENTRY_PATH__%s__AGENTRY_PATH__" "$PATH"'],
      { timeout: SHELL_TIMEOUT_MS, env: { ...process.env, TERM: 'dumb' } },
      (err, stdout) => {
        const match = /__AGENTRY_PATH__(.*?)__AGENTRY_PATH__/s.exec(stdout ?? '');
        resolve(err || !match?.[1] ? '' : match[1]);
      },
    );
  });
}

/** Login shell PATH first, then the current PATH, then common install dirs; deduplicated, existing dirs only */
export async function resolveUserPath(): Promise<string> {
  const candidates = [...(await loginShellPath()).split(delimiter), ...(process.env.PATH ?? '').split(delimiter), ...commonDirs()];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs.join(delimiter);
}
