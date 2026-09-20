import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface WorktreeFacts {
  path: string;
  name: string | null;
  branch: string | null;
  parentPath: string;
}

/** `<repo>/.claude/worktrees/<name>`, where `claude --worktree` puts them. */
const CLI_WORKTREE_RE = /^(.+)\/\.claude\/worktrees\/([^/]+)/;
const CACHE_MS = 30_000;
/** How far up from a directory to look for the `.git` that says which checkout it is in */
const MAX_DEPTH = 8;

/** The branch a git dir has checked out, from its HEAD file; null when detached or unreadable. */
function branchOf(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  } catch {
    return null;
  }
}

/**
 * A linked worktree has a `.git` *file* pointing at `<repo>/.git/worktrees/<name>`; the main
 * checkout has a `.git` directory. Reading that file is all it takes, no git process.
 */
function fromDotGit(dir: string): WorktreeFacts | null | undefined {
  let current = dir;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = join(current, '.git');
    try {
      const info = statSync(dotGit);
      if (info.isDirectory()) return null; // a main checkout: not a worktree
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (!pointer) return null;
      const gitDir = isAbsolute(pointer) ? pointer : resolve(current, pointer);
      const repo = /^(.+)\/\.git\/worktrees\/[^/]+$/.exec(gitDir)?.[1];
      if (!repo) return null; // a submodule, not a worktree
      return { path: current, name: basename(gitDir), branch: branchOf(gitDir), parentPath: repo };
    } catch {
      /* no .git here */
    }
    const up = dirname(current);
    if (up === current) break;
    current = up;
  }
  return undefined; // not in a repository at all
}

/**
 * Resolves a directory to the project it belongs to. A worktree resolves to its repository, which
 * is what lets a graph whose tasks each ran in a worktree read as one project instead of five.
 *
 * In order of trust: the record the CLI writes into a session it ran in a worktree (it survives the
 * worktree being removed), the CLI's own worktree layout, then the `.git` file on disk.
 */
export class Locator {
  private readonly known = new Map<string, WorktreeFacts>();
  private readonly cache = new Map<string, { at: number; facts: WorktreeFacts | null }>();

  /** Remembers a worktree the CLI recorded in a transcript. */
  learn(facts: WorktreeFacts): void {
    if (!this.known.has(facts.path)) this.cache.clear();
    this.known.set(facts.path, facts);
  }

  worktreeOf(dir: string): WorktreeFacts | null {
    const hit = this.cache.get(dir);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.facts;
    const facts = this.resolve(dir);
    this.cache.set(dir, { at: Date.now(), facts });
    return facts;
  }

  private resolve(dir: string): WorktreeFacts | null {
    let best: WorktreeFacts | null = null;
    for (const facts of this.known.values()) {
      if ((dir === facts.path || dir.startsWith(`${facts.path}/`)) && facts.path.length > (best?.path.length ?? 0)) best = facts;
    }
    if (best) return best;
    const cli = CLI_WORKTREE_RE.exec(dir);
    if (cli) {
      const [path, parentPath, name] = cli as unknown as [string, string, string];
      const onDisk = existsSync(path) ? fromDotGit(path) : null;
      return { path, name, branch: onDisk?.branch ?? null, parentPath };
    }
    return fromDotGit(dir) ?? null;
  }
}
