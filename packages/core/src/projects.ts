import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProjectCandidate } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { WorktreeFacts } from './locations.ts';
import type { CoreConfig } from './paths.ts';

/** What Agentry keeps about a project: an id of its own, a name and where it lives. */
export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
}

/** A chat reduced to what deciding its project needs: the directory it works in and when it last moved. */
export interface ChatPlace {
  cwd: string;
  updatedAt: string | null;
}

/** Where a directory belongs: the project, and the git worktree it is in when it is not the project's own checkout. */
export interface Attachment {
  project: ProjectRecord;
  worktree: WorktreeFacts | null;
}

/** How many directories are offered on the first start. */
const CANDIDATES = 8;

const inside = (root: string, dir: string): boolean => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The deepest project whose directory holds `dir`, so a project nested in another wins for what is under it. */
function deepest(projects: readonly ProjectRecord[], dir: string): ProjectRecord | undefined {
  let best: ProjectRecord | undefined;
  for (const p of projects) {
    if (inside(p.path, dir) && p.path.length > (best?.path.length ?? -1)) best = p;
  }
  return best;
}

/**
 * Decides which project a directory belongs to, or none: a chat whose directory is under no
 * imported project is loose.
 *
 * A worktree belongs to the checkout it came from wherever it lives on disk, so it is first looked
 * up at the same place in that checkout. Only when that finds nothing does the directory count by
 * where it is, which is also how a worktree nested under a project attaches when git cannot say
 * where it came from.
 */
export function attachProject(
  projects: readonly ProjectRecord[],
  dir: string,
  worktreeOf: (dir: string) => WorktreeFacts | null,
): Attachment | null {
  const worktree = worktreeOf(dir);
  if (worktree && inside(worktree.path, dir)) {
    // Also for a project that is a subdirectory of the repository, as in a monorepo
    const project = deepest(projects, worktree.parentPath + dir.slice(worktree.path.length));
    if (project) return { project, worktree };
  }
  const project = deepest(projects, dir);
  return project ? { project, worktree } : null;
}

/**
 * Directories chats have run in that are not imported, the busiest first. A worktree counts for its
 * repository, and scratch directories under the OS temp dir or that no longer exist are left out:
 * they are what would make the first screen the noise this whole model exists to avoid.
 */
export function projectCandidates(
  projects: readonly ProjectRecord[],
  chats: readonly ChatPlace[],
  worktreeOf: (dir: string) => WorktreeFacts | null,
  limit = CANDIDATES,
): ProjectCandidate[] {
  const byPath = new Map<string, { count: number; last: string | null }>();
  for (const chat of chats) {
    if (attachProject(projects, chat.cwd, worktreeOf)) continue;
    const path = worktreeOf(chat.cwd)?.parentPath ?? chat.cwd;
    if (!path || isTemporaryPath(path)) continue;
    const seen = byPath.get(path) ?? { count: 0, last: null };
    seen.count += 1;
    if (chat.updatedAt && (!seen.last || chat.updatedAt > seen.last)) seen.last = chat.updatedAt;
    byPath.set(path, seen);
  }
  return [...byPath]
    .filter(([path]) => isDirectory(path))
    .map(([path, { count, last }]) => ({ path, name: basename(path) || path, chatCount: count, lastActivity: last }))
    .sort((a, b) => b.chatCount - a.chatCount || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export function isTemporaryPath(path: string): boolean {
  const tmp = tmpdir();
  return path === tmp || path.startsWith(`${tmp}/`) || path.startsWith('/tmp/') || path.startsWith('/var/tmp/');
}

/** A path as the filesystem sees it, falling back to the literal path when it does not exist. */
const realOrSelf = (path: string): Promise<string> => realpath(path).catch(() => path);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directories the person imported, in `projects.json`. A settings-shaped document: small, edited
 * whole and read in full on every start. It is held in memory because everything that places a
 * chat or a run asks it, and it changes only through this class.
 */
export class ProjectStore {
  private readonly file: string;
  private readonly configDir: string;
  private records: ProjectRecord[];

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'projects.json');
    this.configDir = resolve(config.configDir);
    mkdirSync(dirname(this.file), { recursive: true });
    this.records = this.read();
  }

  private read(): ProjectRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { projects?: unknown };
      if (!Array.isArray(doc.projects)) return [];
      return doc.projects.filter(
        (p): p is ProjectRecord =>
          !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.path === 'string',
      );
    } catch {
      // A document that does not parse would otherwise be overwritten by the next import
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
  }

  private save(): Promise<void> {
    return writeAtomic(this.file, `${JSON.stringify({ projects: this.records }, null, 2)}\n`);
  }

  list(): readonly ProjectRecord[] {
    return this.records;
  }

  get(id: string): ProjectRecord | undefined {
    return this.records.find((p) => p.id === id);
  }

  /**
   * Imports a directory. A git worktree is refused: it belongs to its repository, and importing it
   * would make the same work appear twice. A directory that is, or holds, the Claude configuration
   * directory is refused too: its project root would be the real `~/.claude`, whose credentials and
   * transcripts the config explorer hides for exactly that reason.
   */
  async add(input: { path: string; name?: string }, worktreeOf: (dir: string) => WorktreeFacts | null): Promise<ProjectRecord> {
    if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('path is required');
    const path = resolve(input.path.trim());
    if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
    if (this.records.some((p) => p.path === path)) throw new Error(`${path} is already a project`);
    const worktree = worktreeOf(path);
    if (worktree?.path === path) throw new Error(`${path} is a git worktree of ${worktree.parentPath}; import that instead`);
    const [real, realConfigDir] = await Promise.all([realOrSelf(path), realOrSelf(this.configDir)]);
    if (inside(real, realConfigDir)) {
      throw new Error(`${path} is or contains the Claude configuration directory ${this.configDir}; importing it would expose the account credentials`);
    }
    const record = { id: randomUUID(), name: this.cleanName(input.name) ?? (basename(path) || path), path };
    this.records = [...this.records, record];
    await this.save();
    return record;
  }

  async rename(id: string, name: string): Promise<ProjectRecord> {
    const project = this.get(id);
    if (!project) throw new Error('project not found');
    const clean = this.cleanName(name);
    if (!clean) throw new Error('name is required');
    const renamed = { ...project, name: clean };
    this.records = this.records.map((p) => (p.id === id ? renamed : p));
    await this.save();
    return renamed;
  }

  /** Forgets the project. Nothing on disk changes, and importing it again adopts its chats again. */
  async remove(id: string): Promise<void> {
    if (!this.get(id)) throw new Error('project not found');
    this.records = this.records.filter((p) => p.id !== id);
    await this.save();
  }

  private cleanName(name: string | undefined): string | null {
    const clean = name?.trim();
    return clean ? clean.slice(0, 100) : null;
  }
}
