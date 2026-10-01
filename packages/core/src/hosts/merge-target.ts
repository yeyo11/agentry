import { execFile } from 'node:child_process';
import type { CodeHostId } from '@agentry/shared';
import { conflictedPaths, identity, mergeInProgress, uncommittedFiles } from '../git.ts';
import type { MergeCodeHostAdapter } from './code-host.ts';
import type { ChecksTarget } from './checks-service.ts';
import type { MergeTarget } from './merge-service.ts';
import { firstLine } from './redact.ts';

// The merge service's view of one change request: the checks target (adapter, repository, the CLI
// bound to its binary) plus the item's own checkouts, which only the owner of the row knows. The
// checkouts are what the GitLab pipeline guard reads the CI file from and what Update from base
// merges in.

/** The project's own checkout, and the worktree the branch is worked on in (null when it has none) */
export interface MergePlace {
  home: string;
  worktree: string | null;
}

function runGit(cwd: string, args: string[], timeout: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { cwd, timeout, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const killed = (err as { killed?: boolean }).killed;
      reject(new Error(firstLine(stderr) || firstLine(stdout) || (killed ? 'git timed out' : err.message)));
    });
  });
}

/**
 * The target of one row. `env` is merged over the process's for git (where a test puts its shims).
 * Nothing here pushes unless the person clicked Update from base, and the service turns auto-merge
 * off before it does.
 */
export function mergeTargetOf(base: ChecksTarget, host: CodeHostId, adapter: MergeCodeHostAdapter, place: MergePlace | null, env: NodeJS.ProcessEnv = {}): MergeTarget {
  const gitEnv = { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' };
  const target: MergeTarget = {
    id: base.id,
    kind: base.kind,
    host,
    adapter,
    repo: base.repo,
    number: base.number,
    branch: base.branch,
    base: base.base,
    run: base.run,
  };
  if (!place) return target;
  const { home, worktree } = place;

  // `git cat-file -e <sha>:<path>`: the commit is local when Agentry pushed it; another person's push is fetched first
  target.fileAt = async (sha, path) => {
    const exists = async (): Promise<boolean | null> => {
      try {
        await runGit(home, ['cat-file', '-e', `${sha}:${path}`], 30_000, gitEnv);
        return true;
      } catch {
        // Missing path or missing commit: `cat-file -t` tells them apart
        try {
          await runGit(home, ['cat-file', '-e', `${sha}^{commit}`], 30_000, gitEnv);
          return false;
        } catch {
          return null;
        }
      }
    };
    const first = await exists();
    if (first !== null) return first;
    try {
      await runGit(home, ['fetch', 'origin', base.branch], 120_000, gitEnv);
    } catch {
      return null;
    }
    return exists();
  };

  if (worktree) {
    target.updateFromBase = async () => {
      if (uncommittedFiles(worktree).length > 0) throw new Error('the worktree has uncommitted changes: finish or commit them first');
      if (mergeInProgress(worktree)) throw new Error('a merge is already in progress in the worktree');
      await runGit(worktree, ['fetch', 'origin', base.base], 120_000, gitEnv);
      try {
        await runGit(worktree, [...identity(worktree), 'merge', '--no-edit', `origin/${base.base}`], 120_000, gitEnv);
      } catch (err) {
        const conflicts = conflictedPaths(worktree);
        // Nothing is pushed and the worktree is left as it was: the conflicts are for the person or the Developer
        try {
          if (mergeInProgress(worktree)) await runGit(worktree, ['merge', '--abort'], 60_000, gitEnv);
        } catch {
          // nothing to abort
        }
        if (conflicts.length > 0) return { conflicts };
        throw err;
      }
      // Pushed as it is, never forced
      await runGit(worktree, ['push', 'origin', base.branch], 180_000, gitEnv);
      return { conflicts: [] };
    };
    // A host-side rebase moved the remote branch: the clean worktree follows it
    target.syncAfterRebase = async () => {
      if (uncommittedFiles(worktree).length > 0) return;
      await runGit(worktree, ['fetch', 'origin', base.branch], 120_000, gitEnv);
      await runGit(worktree, ['reset', '--keep', `origin/${base.branch}`], 60_000, gitEnv);
    };
  }
  return target;
}
