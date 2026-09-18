import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ConfigFileContent, ConfigFileNode } from '@agentry/shared';
import { writeAtomic } from './files.ts';
import type { ConfigScope } from './scope.ts';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 6;
const MAX_ENTRIES_PER_DIR = 300;

/**
 * CLI runtime state, caches and secrets inside the user config dir. They are not configuration,
 * can be huge, and `.credentials.json` / `.claude.json` hold tokens.
 */
const USER_HIDDEN = new Set([
  'projects', 'sessions', 'session-env', 'shell-snapshots', 'file-history', 'paste-cache', 'cache', 'telemetry',
  'statsig', 'backups', 'downloads', 'ide', 'tasks', 'todos', 'plans', 'logs', 'history.jsonl',
  '.credentials.json', '.claude.json', '.claude.json.lock',
  '.last-cleanup', '.last-update-result.json', 'mcp-needs-auth-cache.json',
]);
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);
// Plugin payloads are managed by `claude plugin`; only the small json manifests are worth showing
const USER_HIDDEN_NESTED = new Set(['plugins/cache', 'plugins/marketplaces', 'plugins/data', 'plugins/synced', 'skills/synced']);

function isHidden(scope: ConfigScope, relPath: string): boolean {
  const parts = relPath.split('/');
  if (parts.some((p) => ALWAYS_HIDDEN.has(p))) return true;
  if (scope.kind !== 'user') return false;
  if (USER_HIDDEN.has(parts[0] ?? '')) return true;
  return USER_HIDDEN_NESTED.has(parts.slice(0, 2).join('/'));
}

/** Generic editor for everything under a scope's Claude dir: hooks, skill files, rules, keybindings… */
export class ConfigExplorer {
  /** Resolves a user-supplied relative path, refusing anything that escapes the root (also via symlinks). */
  private async locate(scope: ConfigScope, relPath: string): Promise<string> {
    if (typeof relPath !== 'string' || !relPath.trim()) throw new Error('path is required');
    if (relPath.includes('\0')) throw new Error('invalid path');
    const root = resolve(scope.claudeDir);
    const target = resolve(root, relPath);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || rel.startsWith(sep)) throw new Error('path is outside the config root');
    if (isHidden(scope, rel.split(sep).join('/'))) throw new Error('this path is not editable from the wrapper');

    // The deepest existing ancestor must still be inside the root once symlinks are resolved
    let existing = target;
    while (!existsSync(existing) && existing !== root) existing = dirname(existing);
    if (existsSync(existing) && existsSync(root)) {
      const [realExisting, realRoot] = await Promise.all([realpath(existing), realpath(root)]);
      if (realExisting !== realRoot && !realExisting.startsWith(realRoot + sep)) {
        throw new Error('path resolves outside the config root');
      }
    }
    return target;
  }

  async tree(scope: ConfigScope): Promise<ConfigFileNode[]> {
    if (!existsSync(scope.claudeDir)) return [];
    return this.walk(scope, scope.claudeDir, '', 0);
  }

  private async walk(scope: ConfigScope, dir: string, relDir: string, depth: number): Promise<ConfigFileNode[]> {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).slice(0, MAX_ENTRIES_PER_DIR);
    const nodes: ConfigFileNode[] = [];
    for (const entry of entries) {
      const path = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isHidden(scope, path) || entry.name.endsWith('.tmp')) continue;
      const full = join(dir, entry.name);
      // stat() follows symlinks (skills are often symlinked); broken links are skipped
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        // Do not descend through symlinks: locate() would refuse their content anyway
        const children = depth < MAX_DEPTH && !entry.isSymbolicLink() ? await this.walk(scope, full, path, depth + 1) : [];
        nodes.push({ name: entry.name, path, type: 'dir', children });
      } else if (info.isFile()) {
        nodes.push({ name: entry.name, path, type: 'file', size: info.size, updatedAt: info.mtime.toISOString() });
      }
    }
    return nodes.sort((a, b) => Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name));
  }

  async read(scope: ConfigScope, rootId: string, relPath: string): Promise<ConfigFileContent> {
    const file = await this.locate(scope, relPath);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error('file not found');
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > MAX_FILE_BYTES) throw new Error(`file is too large to edit here (${info.size} bytes, max ${MAX_FILE_BYTES})`);
    const buffer = await readFile(file);
    if (buffer.includes(0)) throw new Error('binary files cannot be edited');
    return {
      root: rootId,
      path: relative(resolve(scope.claudeDir), file).split(sep).join('/'),
      absolutePath: file,
      content: buffer.toString('utf8'),
      size: info.size,
      updatedAt: info.mtime.toISOString(),
      executable: (info.mode & 0o111) !== 0,
    };
  }

  async write(scope: ConfigScope, rootId: string, relPath: string, content: unknown, executable?: boolean): Promise<ConfigFileContent> {
    if (typeof content !== 'string') throw new Error('content must be a string');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('content is too large');
    const file = await this.locate(scope, relPath);
    if (existsSync(file) && !(await stat(file)).isFile()) throw new Error('a directory already exists at this path');
    await mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, content);
    if (executable !== undefined) await chmod(file, executable ? 0o755 : 0o644);
    return this.read(scope, rootId, relPath);
  }

  async remove(scope: ConfigScope, relPath: string): Promise<void> {
    const target = await this.locate(scope, relPath);
    if (!existsSync(target)) throw new Error('file not found');
    await rm(target, { recursive: true });
  }
}
