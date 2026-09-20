import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryFile } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

const PROJECT_RE = /^[\w-]{1,300}$/;
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,80}\.md$/;
const INDEX = 'MEMORY.md';

function frontmatterField(content: string, field: string): string | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
  const match = frontmatter ? new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm').exec(frontmatter) : null;
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
}

/**
 * Claude Code's persistent memory: markdown files in <configDir>/projects/<projectId>/memory,
 * one fact per file plus the MEMORY.md index that is loaded into every session of that project.
 */
export class MemoryStore {
  constructor(private readonly config: CoreConfig) {}

  private dir(projectId: string): string {
    if (!PROJECT_RE.test(projectId)) throw new Error('invalid project id');
    return join(this.config.projectsDir, projectId, 'memory');
  }

  private file(projectId: string, name: string): string {
    if (!NAME_RE.test(name)) throw new Error("invalid memory file name (letters, digits, _ . - and a '.md' extension)");
    return join(this.dir(projectId), name);
  }

  async list(projectId: string): Promise<MemoryFile[]> {
    const dir = this.dir(projectId);
    if (!existsSync(dir)) return [];
    const names = (await readdir(dir)).filter((n) => NAME_RE.test(n));
    const files = await Promise.all(names.map((n) => this.get(projectId, n)));
    return files
      .filter((f): f is MemoryFile => f !== null)
      .sort((a, b) => Number(b.isIndex) - Number(a.isIndex) || a.name.localeCompare(b.name));
  }

  async get(projectId: string, name: string): Promise<MemoryFile | null> {
    const path = this.file(projectId, name);
    if (!existsSync(path)) return null;
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return {
      projectId,
      name,
      path,
      isIndex: name === INDEX,
      description: frontmatterField(content, 'description'),
      type: frontmatterField(content, 'type'),
      content,
      updatedAt: info.mtime.toISOString(),
    };
  }

  async save(projectId: string, name: string, content: unknown): Promise<MemoryFile> {
    if (typeof content !== 'string') throw new Error('content must be a string');
    await writeAtomic(this.file(projectId, name), content);
    const saved = await this.get(projectId, name);
    if (!saved) throw new Error('memory file was not persisted');
    return saved;
  }

  async remove(projectId: string, name: string): Promise<void> {
    const path = this.file(projectId, name);
    if (!existsSync(path)) throw new Error('memory file not found');
    await rm(path);
  }
}
