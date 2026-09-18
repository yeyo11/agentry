import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MarkdownResource, ResourceKind } from '@agentry/shared';
import { writeAtomic } from './files.ts';
import type { ConfigScope } from './scope.ts';

const NAME_RE = /^[\w.-]{1,64}$/;
export const RESOURCE_KINDS: ResourceKind[] = ['agents', 'skills', 'commands', 'output-styles', 'rules'];

function parseDescription(content: string): string | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
  const match = frontmatter ? /^description:\s*(.+)$/m.exec(frontmatter) : null;
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
}

/**
 * Markdown resources of a scope, under its Claude dir (`~/.claude` or `<project>/.claude`):
 *   skills -> skills/<name>/SKILL.md      everything else -> <kind>/<name>.md
 */
export class MarkdownResources {
  private dir(scope: ConfigScope, kind: ResourceKind): string {
    return join(scope.claudeDir, kind);
  }

  private file(scope: ConfigScope, kind: ResourceKind, name: string): string {
    if (!NAME_RE.test(name)) throw new Error('invalid resource name (letters, digits, _ . - only)');
    const dir = this.dir(scope, kind);
    return kind === 'skills' ? join(dir, name, 'SKILL.md') : join(dir, `${name}.md`);
  }

  async list(scope: ConfigScope, kind: ResourceKind): Promise<MarkdownResource[]> {
    const dir = this.dir(scope, kind);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const names =
      kind === 'skills'
        ? entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
        : entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3));
    const items = await Promise.all(names.filter((n) => NAME_RE.test(n)).map((n) => this.get(scope, kind, n)));
    return items.filter((i): i is MarkdownResource => i !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(scope: ConfigScope, kind: ResourceKind, name: string): Promise<MarkdownResource | null> {
    const path = this.file(scope, kind, name);
    if (!existsSync(path)) return null;
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { kind, name, path, description: parseDescription(content), content, updatedAt: info.mtime.toISOString() };
  }

  async save(scope: ConfigScope, kind: ResourceKind, name: string, content: unknown): Promise<MarkdownResource> {
    if (typeof content !== 'string') throw new Error('content must be a string');
    await writeAtomic(this.file(scope, kind, name), content);
    const saved = await this.get(scope, kind, name);
    if (!saved) throw new Error('resource was not persisted');
    return saved;
  }

  async remove(scope: ConfigScope, kind: ResourceKind, name: string): Promise<void> {
    const path = this.file(scope, kind, name);
    if (!existsSync(path)) throw new Error('resource not found');
    // A skill owns its whole directory; the other kinds are single files.
    await rm(kind === 'skills' ? join(this.dir(scope, kind), name) : path, { recursive: true });
  }
}
