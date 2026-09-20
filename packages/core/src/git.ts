import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChangedFile, ChangedFileStatus, Commit } from '@agentry/shared';

/**
 * The few git operations orchestrations need to hand back one branch instead of a pile of
 * worktrees. Everything runs through `execFileSync` with arguments, never a shell string, and
 * throws with git's own message so a caller can show it as-is.
 */
export function git(cwd: string, args: string[], timeout = 60_000): string {
  return gitRaw(cwd, args, { timeout }).trim();
}

/** Like {@link git} but leaves the output as git wrote it: a `-z` list or a diff loses meaning when trimmed. */
export function gitRaw(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      stdio: 'pipe',
      timeout: opts.timeout ?? 60_000,
      encoding: 'utf8',
      ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    const detail = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || e.message;
    // A leading global option (`--literal-pathspecs`) is not what failed
    throw new Error(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]}: ${detail.split('\n').slice(0, 6).join('\n')}`);
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

/**
 * The top level of the main checkout `dir` belongs to. Inside a linked worktree `topLevel` is that
 * worktree, but the CLI keeps the checkouts it makes for `--worktree` under the main one.
 */
export function mainTopLevel(dir: string): string {
  return dirname(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000));
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

/** Deletes a branch whose work is being thrown away; one that is not there is already gone. */
export function deleteBranch(repo: string, branch: string): void {
  if (branchExists(repo, branch)) git(repo, ['branch', '-D', branch]);
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

// ---------- what a branch has changed ----------

/** A diff is shown whole, but one file must not be able to fill the server's memory. */
const DIFF_LIMIT = 8 * 1024 * 1024;
/** The log shows the newest commits; `ahead` still counts them all. */
const COMMIT_LIMIT = 200;
/** Untracked files are counted by reading them, so a huge one is left uncounted. */
const COUNT_LIMIT = 1024 * 1024;

/** The branch `dir` has checked out, or null on a detached head. */
export function currentBranch(dir: string): string | null {
  try {
    return git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], 10_000) || null;
  } catch {
    return null;
  }
}

/** The commit `a` and `b` last had in common, or null when they share none. */
export function mergeBase(dir: string, a: string, b: string): string | null {
  try {
    return git(dir, ['merge-base', a, b], 10_000) || null;
  } catch {
    return null;
  }
}

/** How many commits `ref` has that `base` does not. */
export function aheadCount(dir: string, base: string, ref = 'HEAD'): number {
  return Number(git(dir, ['rev-list', '--count', `${base}..${ref}`], 30_000)) || 0;
}

/** The commits on `ref` that `base` lacks, newest first, merges included. */
export function commitsBetween(dir: string, base: string, ref = 'HEAD', limit = COMMIT_LIMIT): Commit[] {
  const out = gitRaw(dir, ['log', `--max-count=${limit}`, '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', `${base}..${ref}`], { timeout: 30_000 });
  const commits: Commit[] = [];
  for (const record of out.split('\x1e')) {
    const [hash, subject, author, at] = record.trim().split('\x1f');
    if (hash && at) commits.push({ hash, subject: subject ?? '', author: author ?? '', at });
  }
  return commits;
}

const NAME_STATUS: Record<string, ChangedFileStatus> = { A: 'added', D: 'deleted', R: 'renamed', C: 'added' };

/**
 * What differs between `from` and `to`, or between `from` and the working tree when `to` is left
 * out. `-z` on both listings because a path may hold any byte git allows, and git quotes the ones it
 * finds odd in the plain format.
 */
export function diffFiles(dir: string, from: string, to?: string): ChangedFile[] {
  const range = [from, ...(to ? [to] : []), '--'];
  const status = gitRaw(dir, ['diff', '-M', '--name-status', '-z', ...range], { timeout: 60_000, maxBuffer: DIFF_LIMIT }).split('\0');
  const numstat = gitRaw(dir, ['diff', '-M', '--numstat', '-z', ...range], { timeout: 60_000, maxBuffer: DIFF_LIMIT }).split('\0');

  const counts = new Map<string, { additions: number; deletions: number }>();
  for (let i = 0; i < numstat.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(numstat[i] ?? '');
    if (!m) continue;
    // A rename lists the old and the new path as the next two entries, and leaves this one empty
    const path = m[3] === '' ? (numstat[(i += 2)] ?? '') : (m[3] as string);
    // `-` is what git prints for a binary file
    counts.set(path, { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }

  const files: ChangedFile[] = [];
  for (let i = 0; i < status.length; i++) {
    const letter = status[i]?.[0];
    if (!letter) continue;
    const renamed = letter === 'R' || letter === 'C';
    const previousPath = renamed ? status[++i] : undefined;
    const path = status[++i];
    if (path === undefined) break;
    files.push({
      path,
      status: NAME_STATUS[letter] ?? 'modified',
      ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
      ...(previousPath !== undefined ? { previousPath } : {}),
    });
  }
  return files;
}

/** Files git does not track yet and does not ignore. */
export function untrackedPaths(dir: string): string[] {
  return gitRaw(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 30_000, maxBuffer: DIFF_LIMIT })
    .split('\0')
    .filter(Boolean);
}

/** Lines in a text file; 0 for a binary one or one too large to be worth reading. */
function countLines(file: string): number {
  try {
    const size = statSync(file).size;
    if (size === 0 || size > COUNT_LIMIT) return 0;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      if (buf.subarray(0, 8000).includes(0)) return 0;
      let lines = 0;
      for (const byte of buf) if (byte === 10) lines++;
      return buf[size - 1] === 10 ? lines : lines + 1;
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/** What the worker has not committed: tracked changes, staged or not, and the files it created. */
export function uncommittedFiles(dir: string): ChangedFile[] {
  const tracked = diffFiles(dir, 'HEAD');
  const known = new Set(tracked.map((f) => f.path));
  const created = untrackedPaths(dir)
    .filter((path) => !known.has(path))
    .map((path): ChangedFile => ({ path, status: 'added', additions: countLines(join(dir, path)), deletions: 0 }));
  return [...tracked, ...created];
}

/**
 * A path from a request, as git takes it: relative to `dir` and inside it. Anything that climbs out
 * or is absolute is refused before git sees it.
 */
export function pathInside(dir: string, path: string): string {
  const inside = path && !path.includes('\0') && !isAbsolute(path) ? relative(dir, resolve(dir, path)) : '';
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`path must be a file inside the checkout: ${path}`);
  return inside.split(sep).join('/');
}

function capped(out: string): string {
  return out.length > DIFF_LIMIT ? `${out.slice(0, DIFF_LIMIT)}\n… diff truncated\n` : out;
}

/**
 * The unified diff of `paths` between `from` and `to` (the working tree when it is left out). A
 * renamed file is asked for by both names, or git shows the new one as created from nothing.
 * `--literal-pathspecs` so a file called `*.ts` is that file and not a pattern.
 */
export function fileDiff(dir: string, from: string, to: string | undefined, paths: string[]): string {
  try {
    return capped(
      gitRaw(dir, ['--literal-pathspecs', 'diff', '-M', '--no-ext-diff', '--no-color', from, ...(to ? [to] : []), '--', ...paths], {
        timeout: 60_000,
        maxBuffer: DIFF_LIMIT * 2,
      }),
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOBUFS') return '… diff too large to show\n';
    throw err;
  }
}

/** The diff of a file git does not track yet: all of it is new. `--no-index` exits 1 when files differ. */
export function untrackedDiff(dir: string, path: string): string {
  try {
    return capped(execFileSync('git', ['-C', dir, 'diff', '--no-index', '--no-color', '--', '/dev/null', path], { stdio: 'pipe', timeout: 30_000, encoding: 'utf8', maxBuffer: DIFF_LIMIT * 2 }));
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && typeof e.stdout === 'string') return capped(e.stdout);
    throw new Error(`git diff: could not read ${path}`);
  }
}

export function isUntracked(dir: string, path: string): boolean {
  return untrackedPaths(dir).includes(path);
}

function gitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 30_000, encoding: 'utf8', maxBuffer: DIFF_LIMIT }, (err, stdout) => (err ? reject(err) : resolveOut(stdout)));
  });
}

export interface ChangeProbe {
  head: string;
  ahead: number;
  /** Uncommitted files, tracked and new */
  dirty: number;
  /** Changes whenever a commit lands or the uncommitted work moves, and only then */
  fingerprint: string;
}

/**
 * The cheap question a watcher asks over and over: has this worktree moved? It does not block the
 * server while git answers, and it reads no diffs, only their sizes.
 */
export async function probeChanges(dir: string, base: string | null): Promise<ChangeProbe> {
  const [head, ahead, numstat, others] = await Promise.all([
    gitAsync(dir, ['rev-parse', 'HEAD']),
    base ? gitAsync(dir, ['rev-list', '--count', `${base}..HEAD`]) : Promise.resolve('0'),
    gitAsync(dir, ['diff', '--numstat', '-z', 'HEAD', '--']),
    gitAsync(dir, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const created = others.split('\0').filter(Boolean);
  // A new file that keeps being edited never shows in the numstat, so its size and time do
  const stamps = created.slice(0, 500).map((path) => {
    try {
      const s = statSync(join(dir, path));
      return `${path}:${s.size}:${Math.trunc(s.mtimeMs)}`;
    } catch {
      return path;
    }
  });
  const tracked = numstat.split('\0').filter((entry) => /^(\d+|-)\t(\d+|-)\t/.test(entry)).length;
  return {
    head: head.trim(),
    ahead: Number(ahead.trim()) || 0,
    dirty: tracked + created.length,
    fingerprint: [head.trim(), ahead.trim(), numstat, ...stamps].join('\n'),
  };
}
