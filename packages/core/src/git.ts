import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The few git operations orchestrations need to hand back one branch instead of a pile of
 * worktrees. Everything runs through `execFileSync` with arguments, never a shell string, and
 * throws with git's own message so a caller can show it as-is.
 */
export function git(cwd: string, args: string[], timeout = 60_000): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', timeout, encoding: 'utf8' }).trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    const detail = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || e.message;
    throw new Error(`git ${args[0]}: ${detail.split('\n').slice(0, 6).join('\n')}`);
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--git-dir'], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** The checkout `dir` belongs to, which is where the CLI keeps its worktrees whatever subdirectory it runs in. */
export function topLevel(dir: string): string {
  return git(dir, ['rev-parse', '--show-toplevel'], 10_000);
}

/** Whether git ignores `path`, relative to the top level of `repo`, or anything above it. */
export function isIgnored(repo: string, path: string): boolean {
  try {
    git(repo, ['check-ignore', '-q', path], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Locks a worktree so `git worktree prune` leaves it alone, as the CLI does with the ones it runs in. */
export function lockWorktree(repo: string, path: string, reason: string): void {
  try {
    git(repo, ['worktree', 'lock', '--reason', reason, path], 10_000);
  } catch {
    /* already locked */
  }
}

export function headCommit(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']);
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Whether `commit` is already contained in what `dir` has checked out. */
export function contains(dir: string, commit: string): boolean {
  try {
    git(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks `branch` out at `path`, creating the branch from `base` unless it already exists — a
 * resumed task finds the branch its first attempt left and carries on from there.
 */
export function addWorktree(repo: string, path: string, branch: string, base: string): void {
  if (existsSync(path)) return;
  if (branchExists(repo, branch)) git(repo, ['worktree', 'add', path, branch]);
  else git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

/** Paths git left unmerged, i.e. the ones someone has to resolve. */
export function conflictedPaths(dir: string): string[] {
  const out = git(dir, ['diff', '--name-only', '--diff-filter=U']);
  return out ? out.split('\n') : [];
}

export function mergeInProgress(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges `branch` into what `dir` has checked out with a merge commit, so each task's work stays
 * visible as a unit in the history. On a conflict the merge is left in progress for whoever resolves
 * it, and the conflicting paths are returned; `null` means it went in cleanly.
 */
export function merge(dir: string, branch: string, message: string): string[] | null {
  try {
    git(dir, ['merge', '--no-ff', '--no-edit', '-m', message, branch], 120_000);
    return null;
  } catch (err) {
    const paths = conflictedPaths(dir);
    if (paths.length === 0) throw err; // not a conflict: a missing branch, a dirty tree…
    return paths;
  }
}

export function abortMerge(dir: string): void {
  try {
    git(dir, ['merge', '--abort']);
  } catch {
    /* nothing to abort */
  }
}

/** Git needs an author; the repository's own identity when it has one, a neutral one otherwise. */
function identity(dir: string): string[] {
  try {
    if (git(dir, ['config', 'user.email'])) return [];
  } catch {
    /* unset */
  }
  return ['-c', 'user.name=Agentry', '-c', 'user.email=agentry@localhost'];
}

/**
 * Commits whatever is left uncommitted in `dir` and returns the new commit, or `null` when there
 * was nothing to commit. Hooks are skipped on purpose: this is a safety net so finished work is never
 * stranded in a worktree, not a review of it.
 */
export function commitAll(dir: string, message: string): string | null {
  if (!existsSync(dir)) return null;
  git(dir, ['add', '-A']);
  try {
    git(dir, ['diff', '--cached', '--quiet']);
    return null; // nothing staged
  } catch {
    /* there are changes */
  }
  execFileSync('git', ['-C', dir, ...identity(dir), 'commit', '--no-verify', '-q', '-m', message], { stdio: 'pipe', timeout: 60_000 });
  return headCommit(dir);
}

/** `git worktree remove`, unlocking first: the CLI locks the worktrees it runs in. */
export function removeWorktree(repo: string, path: string, force = false): void {
  try {
    git(repo, ['worktree', 'unlock', path], 30_000);
  } catch {
    /* not locked */
  }
  git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}
