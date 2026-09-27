import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AssistantSource, AssistantSourceUnit } from '@agentry/shared';

/**
 * "What it read": the list a run shows while it works and keeps once it ends. Agentry lays it out
 * when the run starts, from a look at the directory and from what it hands the run itself (the
 * journal, the work items, the team, the resources, the chats' titles); the chat's own reads fill
 * it in as they happen and from its answer. What was laid out and never read is dropped when the
 * run ends, so the list it keeps is only what it read.
 */

/** What a run read, as it is stored: every file it opened, whether it read the history. */
export interface AssistantReads {
  files: string[];
  dirs: string[];
  git: boolean;
}

export const NO_READS: AssistantReads = { files: [], dirs: [], git: false };

/** What Agentry knows of a project beside its directory, counted for the list. */
export interface AssistantFacts {
  memoryFiles: number;
  journalEntries: number;
  workItems: number;
  milestones: string[];
  teamMembers: number;
  resources: string[];
  chats: number;
  /** Null outside a git repository */
  commits: number | null;
}

/** Directories that are built or fetched rather than written, which a run has no reason to read. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', 'venv']);
const LOCK_FILE = /(^|[.-])lock(\.|$)|\.lock$|-lock\.(json|yaml)$/i;
const FILES_MAX = 10;
const DIRS_MAX = 10;
const WALK_MAX = 5000;
const LINES_MAX_BYTES = 2 * 1024 * 1024;
const EXTRA_MAX = 30;
const DOCUMENT_DIRS = new Set(['docs', 'doc', 'documentation']);

const visible = (e: Dirent) => !e.name.startsWith('.') && !SKIPPED.has(e.name);

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function lines(path: string): number | null {
  try {
    if (statSync(path).size > LINES_MAX_BYTES) return null;
    const text = readFileSync(path, 'utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
  }
}

/** Files under a directory, skipping what is built or hidden, up to a bound. */
function countFiles(dir: string): number {
  let count = 0;
  const stack = [dir];
  while (stack.length && count < WALK_MAX) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const e of entries(current)) {
      if (!visible(e)) continue;
      if (e.isDirectory()) stack.push(join(current, e.name));
      else if (e.isFile()) count++;
    }
  }
  return count;
}

/** README first, then manifests, then the rest by name: what a person opening the repository reads first. */
function fileRank(name: string): number {
  if (/^readme/i.test(name)) return 0;
  if (/^(package\.json|pnpm-workspace\.yaml|cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle|gemfile|composer\.json|makefile|dockerfile)$/i.test(name)) return 1;
  if (/^(contributing|changelog|license)/i.test(name)) return 3;
  return 2;
}

/**
 * Whether a directory has nothing a run could read: no file or directory but hidden ones, no git
 * history and no chats. A `.claude/` alone is still empty: it is configuration, not the project.
 */
export function projectIsEmpty(path: string, facts: Pick<AssistantFacts, 'chats' | 'commits'>): boolean {
  return !entries(path).some(visible) && !facts.commits && !facts.chats;
}

/** The list as a run starts it: everything Agentry hands it is read, the directory is still to read. */
export function initialSources(path: string, facts: AssistantFacts, empty: boolean): AssistantSource[] {
  const sources: AssistantSource[] = [];
  const source = (s: Partial<AssistantSource> & Pick<AssistantSource, 'kind' | 'state'>): void => {
    sources.push({ path: null, count: null, total: null, unit: null, names: [], ...s });
  };
  const top = entries(path).filter(visible);
  const files = top.filter((e) => e.isFile() && !LOCK_FILE.test(e.name)).sort((a, b) => fileRank(a.name) - fileRank(b.name) || a.name.localeCompare(b.name));
  for (const f of files.slice(0, FILES_MAX)) source({ kind: 'file', path: f.name, state: 'pending', count: lines(join(path, f.name)), unit: 'lines' });
  const dirs = top.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs.slice(0, DIRS_MAX)) {
    const unit: AssistantSourceUnit = DOCUMENT_DIRS.has(d.name.toLowerCase()) ? 'documents' : 'files';
    source({ kind: 'dir', path: `${d.name}/`, state: 'pending', total: countFiles(join(path, d.name)), unit });
  }
  // The CLI loads CLAUDE.md and its memory on its own, from the directory it runs in
  const instructions = lines(join(path, 'CLAUDE.md'));
  source(instructions === null ? { kind: 'instructions', path: 'CLAUDE.md', state: 'missing' } : { kind: 'instructions', path: 'CLAUDE.md', state: 'read', count: instructions, unit: 'lines' });
  if (facts.memoryFiles) source({ kind: 'memory', state: 'read', count: facts.memoryFiles, unit: 'files' });
  if (facts.chats) source({ kind: 'chats', state: 'read', count: facts.chats, unit: 'chats' });
  if (facts.commits) source({ kind: 'git', state: 'pending', count: facts.commits, unit: 'commits' });
  else if (empty) source({ kind: 'git', state: 'missing' });
  if (facts.journalEntries) source({ kind: 'journal', state: 'read', count: facts.journalEntries, unit: 'entries' });
  if (facts.workItems) source({ kind: 'work-items', state: 'read', count: facts.workItems, unit: 'items' });
  if (facts.milestones.length) source({ kind: 'milestones', state: 'read', count: facts.milestones.length, unit: 'items', names: facts.milestones.slice(0, 5) });
  if (facts.teamMembers) source({ kind: 'team', state: 'read', count: facts.teamMembers, unit: 'members' });
  if (facts.resources.length) source({ kind: 'resources', state: 'read', count: facts.resources.length, unit: 'files', names: facts.resources.slice(0, 5) });
  return sources;
}

/** A path as a chat names it, relative to the project with `/`; null for one outside it. */
export function projectPath(projectDir: string, target: string): string | null {
  const raw = target.trim();
  if (!raw) return null;
  const rel = isAbsolute(raw) ? relative(projectDir, raw) : raw.replace(/^\.\//, '');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Adds what a chat read to what it had read; the same reads again change nothing. */
export function addReads(reads: AssistantReads, added: Partial<AssistantReads>): AssistantReads {
  const files = [...new Set([...reads.files, ...(added.files ?? [])])];
  const dirs = [...new Set([...reads.dirs, ...(added.dirs ?? [])])];
  return { files, dirs, git: reads.git || !!added.git };
}

export function sameReads(a: AssistantReads, b: AssistantReads): boolean {
  return a.git === b.git && a.files.length === b.files.length && a.dirs.length === b.dirs.length;
}

/** What a run is reading this moment, from its chat's activity. */
export interface ReadingNow {
  path: string | null;
  git: boolean;
}

/**
 * The list as it stands: the laid-out entries with what was read of them, then the files read that
 * were not laid out. `finished` drops what was never read.
 */
export function sourcesOf(base: readonly AssistantSource[], reads: AssistantReads, finished: boolean, now: ReadingNow | null = null): AssistantSource[] {
  const out: AssistantSource[] = [];
  const claimed = new Set<string>();
  for (const s of base) {
    if (s.kind === 'file' && s.path) {
      const read = reads.files.includes(s.path);
      if (read) claimed.add(s.path);
      if (read) out.push({ ...s, state: 'read' });
      else if (now?.path === s.path) out.push({ ...s, state: 'reading' });
      else if (!finished) out.push(s);
      continue;
    }
    if (s.kind === 'dir' && s.path) {
      const prefix = s.path;
      const inside = reads.files.filter((f) => f.startsWith(prefix));
      for (const f of inside) claimed.add(f);
      const listed = reads.dirs.some((d) => d === prefix || d.startsWith(prefix));
      const reading = !!now?.path && now.path.startsWith(prefix);
      if (inside.length) {
        const all = s.total !== null && inside.length >= s.total;
        out.push({ ...s, state: reading && !all ? 'reading' : all ? 'read' : 'partial', count: inside.length, names: inside.slice(0, 5) });
      } else if (reading) out.push({ ...s, state: 'reading' });
      else if (listed) out.push({ ...s, state: 'read' });
      else if (!finished) out.push(s);
      continue;
    }
    if (s.kind === 'git' && s.state !== 'missing') {
      if (reads.git) out.push({ ...s, state: 'read' });
      else if (now?.git) out.push({ ...s, state: 'reading' });
      else if (!finished) out.push(s);
      continue;
    }
    out.push(s);
  }
  const extra = reads.files.filter((f) => !claimed.has(f)).slice(0, EXTRA_MAX);
  for (const f of extra) out.push({ kind: 'file', path: f, state: 'read', count: null, total: null, unit: null, names: [] });
  return out;
}
