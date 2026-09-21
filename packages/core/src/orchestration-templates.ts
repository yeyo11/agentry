import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrchestrationSpec, OrchestrationTemplate, UpdateOrchestrationTemplateRequest } from '@agentry/shared';

const now = () => new Date().toISOString();

/**
 * Saved graphs, in one JSON file: a template is a settings-shaped document that a person edits, not
 * a record that accumulates. The file is read on every call instead of cached, because the API and
 * the desktop app can be two processes over one data directory.
 */
export class OrchestrationTemplates {
  constructor(
    private readonly file: string,
    /** Throws when the spec's task graph is not one an orchestration could run */
    private readonly validate: (spec: OrchestrationSpec) => void,
  ) {}

  private read(): OrchestrationTemplate[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? (parsed as OrchestrationTemplate[]) : [];
    } catch {
      // A hand-edited file that no longer parses is treated as empty rather than taking the page down;
      // the next write replaces it, so a broken file is never silently extended.
      return [];
    }
  }

  private write(templates: OrchestrationTemplate[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Rename over the old file, so a reader in the other process never sees half of one
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(templates, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  list(): OrchestrationTemplate[] {
    return this.read().sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): OrchestrationTemplate | null {
    return this.read().find((t) => t.id === id) ?? null;
  }

  save(name: string, spec: OrchestrationSpec, description?: string): OrchestrationTemplate {
    const clean = name?.trim();
    if (!clean) throw new Error('a template needs a name');
    this.validate(spec);
    const templates = this.read();
    this.assertFree(templates, clean);
    const at = now();
    const template: OrchestrationTemplate = {
      id: randomUUID(),
      name: clean,
      ...(description?.trim() ? { description: description.trim() } : {}),
      spec: stored(spec),
      createdAt: at,
      updatedAt: at,
    };
    this.write([...templates, template]);
    return template;
  }

  update(id: string, changes: UpdateOrchestrationTemplateRequest): OrchestrationTemplate {
    const templates = this.read();
    const template = templates.find((t) => t.id === id);
    if (!template) throw new Error('template not found');
    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw new Error('a template needs a name');
      this.assertFree(templates, name, id);
      template.name = name;
    }
    if (changes.description !== undefined) {
      if (changes.description.trim()) template.description = changes.description.trim();
      else delete template.description;
    }
    if (changes.spec !== undefined) {
      this.validate(changes.spec);
      template.spec = stored(changes.spec);
    }
    template.updatedAt = now();
    this.write(templates);
    return template;
  }

  remove(id: string): void {
    const templates = this.read();
    if (!templates.some((t) => t.id === id)) throw new Error('template not found');
    this.write(templates.filter((t) => t.id !== id));
  }

  /** Names are what a person picks by, so two templates sharing one could not be told apart. */
  private assertFree(templates: OrchestrationTemplate[], name: string, except?: string): void {
    if (templates.some((t) => t.id !== except && t.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`a template named "${name}" already exists`);
    }
  }
}

/** A copy that shares nothing with the request, so editing the caller's object cannot edit the file's. */
const stored = (spec: OrchestrationSpec): OrchestrationSpec => JSON.parse(JSON.stringify(spec)) as OrchestrationSpec;
