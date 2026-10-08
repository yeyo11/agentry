import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PROJECTS_LAYOUT, WIDGET_RULES, layoutProblem, validateLayout, type DashboardLayout, type DashboardScope, type StoredDashboardLayout } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { AgentryEventInput } from './events.ts';
import type { CoreConfig } from './paths.ts';

/*
 * The Home layout of each project, and one for All projects: a settings-shaped document, so one
 * JSON file in the data directory (`dashboard-layouts.json`) keyed by project id and `all`, not a
 * table. The file is tolerant on read, like the other settings stores: an entry that no longer
 * validates (a widget type from a newer version, a hand edit) is dropped and that Home falls back
 * to its default, and a file that is not JSON at all is left alone and refuses writes until the
 * person fixes it.
 */

const FILE = 'dashboard-layouts.json';

const scopeOf = (key: string): DashboardScope => (key === ALL_PROJECTS_LAYOUT ? 'global' : 'project');

export interface DashboardLayoutDeps {
  /** Whether a project id is one Agentry knows; an unknown one is refused with `project not found` */
  hasProject: (id: string) => Promise<boolean>;
  emit?: (event: AgentryEventInput) => void;
}

export class DashboardLayoutStore {
  private readonly file: string;
  private layouts = new Map<string, DashboardLayout>();
  private readonly broken: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    config: Pick<CoreConfig, 'dataDir'>,
    private readonly deps: DashboardLayoutDeps,
  ) {
    this.file = join(config.dataDir, FILE);
    if (!existsSync(this.file)) return;
    try {
      const doc: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      const stored = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as { layouts?: unknown }).layouts : undefined;
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [key, value] of Object.entries(stored)) {
          const layout = validateLayout(value, WIDGET_RULES, scopeOf(key));
          if (layout) this.layouts.set(key, layout);
        }
      }
    } catch {
      this.broken = `${this.file} is not valid JSON; fix or remove it`;
    }
  }

  /** The stored layout of a project (or `all`), or `null` when the default applies. */
  async get(project: string): Promise<StoredDashboardLayout> {
    await this.known(project);
    return { project, layout: this.layouts.get(project) ?? null };
  }

  /** Saves a layout the shared rules accept as it is; anything else is a 400 that says why. */
  async set(project: string, input: unknown): Promise<StoredDashboardLayout> {
    await this.known(project);
    const problem = layoutProblem(input, scopeOf(project));
    if (problem) throw new Error(`invalid dashboard layout: ${problem}`);
    const layout = validateLayout(input, WIDGET_RULES, scopeOf(project));
    if (!layout) throw new Error('invalid dashboard layout');
    return this.change(project, layout);
  }

  /** Forgets the stored layout, so the default applies again. */
  async reset(project: string): Promise<StoredDashboardLayout> {
    await this.known(project);
    return this.change(project, null);
  }

  private async known(project: string): Promise<void> {
    if (project === ALL_PROJECTS_LAYOUT) return;
    if (!(await this.deps.hasProject(project))) throw new Error('project not found');
  }

  private async change(project: string, layout: DashboardLayout | null): Promise<StoredDashboardLayout> {
    if (this.broken) throw new Error(this.broken);
    // Chained, so two writes in flight land in order and never share a temp file
    const write = this.writing.then(async () => {
      const next = new Map(this.layouts);
      if (layout) next.set(project, layout);
      else next.delete(project);
      await writeAtomic(this.file, `${JSON.stringify({ version: 1, layouts: Object.fromEntries(next) }, null, 2)}\n`);
      this.layouts = next;
    });
    this.writing = write.catch(() => undefined);
    await write;
    this.deps.emit?.({ type: 'dashboard.layout', title: 'Home layout changed', project, layout });
    return { project, layout };
  }
}
