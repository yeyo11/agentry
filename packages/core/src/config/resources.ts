import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RESOURCE_FORMATS, type ConfigResource, type ResourceKind, type WorkflowDefinition } from '@agentry/shared';
import { writeAtomic } from './files.ts';
import { listWorkflowDirectory, scriptMeta } from '../workflows.ts';
import type { ConfigScope } from './scope.ts';

const NAME_RE = /^[\w.-]{1,64}$/;
export const RESOURCE_KINDS: ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules', 'workflows'];

function parseDescription(content: string): string | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
  const match = frontmatter ? /^description:\s*(.+)$/m.exec(frontmatter) : null;
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
}

/**
 * The resources of a scope, under its Claude dir (`~/.claude` or `<project>/.claude`):
 *   skills -> skills/<name>/SKILL.md      workflows -> workflows/<file>.js|.mjs (a script)
 *   everything else -> <kind>/<name>.md
 *
 * A workflow is named by its `meta.name`, as the Workflow tool resolves it, so its file may be
 * called otherwise: the listing of `GET /workflows/saved` is what finds it.
 */
export class ConfigResources {
  private dir(scope: ConfigScope, kind: ResourceKind): string {
    return join(scope.claudeDir, kind);
  }

  private file(scope: ConfigScope, kind: ResourceKind, name: string): string {
    if (!NAME_RE.test(name)) throw new Error('invalid resource name (letters, digits, _ . - only)');
    const dir = this.dir(scope, kind);
    return kind === 'skills' ? join(dir, name, 'SKILL.md') : join(dir, `${name}.${kind === 'workflows' ? 'js' : 'md'}`);
  }

  /** Where a resource lives now, or would be created: an existing workflow keeps its own file. */
  private async locate(scope: ConfigScope, kind: ResourceKind, name: string): Promise<string> {
    const path = this.file(scope, kind, name);
    if (kind !== 'workflows') return path;
    const found = (await this.workflows(scope)).find((w) => w.name === name);
    return found?.path ?? path;
  }

  private workflows(scope: ConfigScope): Promise<WorkflowDefinition[]> {
    return listWorkflowDirectory(this.dir(scope, 'workflows'), scope.kind);
  }

  async list(scope: ConfigScope, kind: ResourceKind): Promise<ConfigResource[]> {
    if (kind === 'workflows') {
      const found = (await this.workflows(scope)).filter((w) => NAME_RE.test(w.name));
      const items = await Promise.all(found.map((w) => this.read(kind, w.name, w.path)));
      return items.filter((i): i is ConfigResource => i !== null).sort((a, b) => a.name.localeCompare(b.name));
    }
    const dir = this.dir(scope, kind);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const names =
      kind === 'skills'
        ? entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
        : entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3));
    const items = await Promise.all(names.filter((n) => NAME_RE.test(n)).map((n) => this.get(scope, kind, n)));
    return items.filter((i): i is ConfigResource => i !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(scope: ConfigScope, kind: ResourceKind, name: string): Promise<ConfigResource | null> {
    return this.read(kind, name, await this.locate(scope, kind, name));
  }

  private async read(kind: ResourceKind, name: string, path: string): Promise<ConfigResource | null> {
    if (!existsSync(path)) return null;
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const description = kind === 'workflows' ? scriptMeta(content).description : parseDescription(content);
    return { kind, name, path, format: RESOURCE_FORMATS[kind], description, content, updatedAt: info.mtime.toISOString() };
  }

  async save(scope: ConfigScope, kind: ResourceKind, name: string, content: unknown): Promise<ConfigResource> {
    if (typeof content !== 'string') throw new Error('content must be a string');
    const path = await this.locate(scope, kind, name);
    await writeAtomic(path, content);
    // A script that renames itself in its `meta` is another workflow from then on: answer with that one
    const saved = kind === 'workflows' ? (await this.list(scope, kind)).find((r) => r.path === path) : await this.get(scope, kind, name);
    if (!saved) throw new Error('resource was not persisted');
    return saved;
  }

  async remove(scope: ConfigScope, kind: ResourceKind, name: string): Promise<void> {
    const path = await this.locate(scope, kind, name);
    if (!existsSync(path)) throw new Error('resource not found');
    // A skill owns its whole directory; the other kinds are single files.
    await rm(kind === 'skills' ? join(this.dir(scope, kind), name) : path, { recursive: true });
  }
}
