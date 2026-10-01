import { gitRaw, refExists } from '../git.ts';

/**
 * The diff the person reviews, `<base>...<branch>`, from local git only. The remote-tracking base is
 * preferred: a stale local default branch would show lines the change request does not touch. Null
 * when a ref is missing, which leaves a note's placement to the host.
 */
export function reviewDiff(cwd: string, base: string, branch: string): string | null {
  const from = refExists(cwd, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
  const to = refExists(cwd, branch) ? branch : `origin/${branch}`;
  if (!refExists(cwd, from) || !refExists(cwd, to)) return null;
  try {
    return gitRaw(cwd, ['diff', '--no-color', '--no-ext-diff', `${from}...${to}`], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}
