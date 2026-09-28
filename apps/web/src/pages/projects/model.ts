import type { BoardSettings, ProjectModule, ProjectTemplateId, WorkItemStatus } from '@agentry/shared';
import { PROJECT_MODULES, PROJECT_TEMPLATE_IDS, WORK_ITEM_KEY_PREFIX_PATTERN, WORK_ITEM_STATUSES } from '@agentry/shared';
import { BookText, Box, Code, FileText, FlaskConical, SquareKanban, SlidersHorizontal, Square, Users, type LucideIcon } from 'lucide-react';

export { PROJECT_MODULES, PROJECT_TEMPLATE_IDS };

/** The icon each module is drawn with, in the wizard, the settings and the project's tabs. */
export const MODULE_ICON: Record<ProjectModule, LucideIcon> = {
  board: SquareKanban,
  team: Users,
  documents: FileText,
  memory: BookText,
};

export const TEMPLATE_ICON: Record<ProjectTemplateId, LucideIcon> = {
  simple: Square,
  software: Code,
  library: Box,
  research: FlaskConical,
  custom: SlidersHorizontal,
};

/** The order the wizard offers the templates in, the one the prototype draws. */
export const TEMPLATE_ORDER: readonly ProjectTemplateId[] = PROJECT_TEMPLATE_IDS;

/** Modules in their fixed order, whatever order a document or a request stored them in. */
export const sortModules = (modules: readonly ProjectModule[]): ProjectModule[] => PROJECT_MODULES.filter((m) => modules.includes(m));

export const sameModules = (a: readonly ProjectModule[], b: readonly ProjectModule[]): boolean =>
  sortModules(a).join(',') === sortModules(b).join(',');

export function toggleModule(modules: readonly ProjectModule[], module: ProjectModule, on: boolean): ProjectModule[] {
  return sortModules(on ? [...modules, module] : modules.filter((m) => m !== module));
}

/**
 * The prefix core derives from a name (`deriveKeyPrefix` in packages/core/src/project-settings.ts),
 * for the wizard's preview only: the server derives its own on the first read, and the web never
 * sends this unless the person edited it.
 */
export function deriveKeyPrefix(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  let base: string;
  if (words.length >= 2) {
    base = words.map((w) => w[0]).join('').slice(0, 5);
  } else {
    const word = words[0] ?? '';
    base = (word.slice(0, 1) + word.slice(1).replace(/[AEIOU]/g, '')).slice(0, 3);
    if (base.length < 3) base = (base + word.slice(1).replace(/[^AEIOU]/g, '')).slice(0, 3);
  }
  if (base.length < 2) base = 'PRJ';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type PrefixProblem = 'empty' | 'pattern' | 'taken';

/** What the API would refuse in a key prefix, checked before sending so the field can say it. */
export function prefixProblem(value: string, taken: ReadonlySet<string>): PrefixProblem | null {
  if (!value) return 'empty';
  if (!WORK_ITEM_KEY_PREFIX_PATTERN.test(value)) return 'pattern';
  return taken.has(value) ? 'taken' : null;
}

/** A prefix as it is typed: upper case, and nothing a prefix cannot hold. */
export const normalizePrefix = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

/** A directory the workspace creates: what core's `Workspace.create` accepts (packages/core/src/workspace.ts). */
export const FOLDER_NAME = /^\w[\w.-]{0,63}$/;

/**
 * The directory a new project gets in the workspace, from the name the person gave it: accents
 * dropped and anything else a folder name cannot hold turned into dashes, so "Mi proyecto" lives in
 * `Mi-proyecto` and keeps its name. Empty when nothing of the name can make one.
 */
export function folderNameFor(name: string): string {
  return name
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[^A-Za-z0-9_]+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/**
 * The columns a limit is for, in board order. Done is not one: it only grows, so a limit there
 * would turn warn for good once reached, with nothing anyone could move out of it.
 */
export const LIMIT_STATUSES: readonly WorkItemStatus[] = WORK_ITEM_STATUSES.filter((status) => status !== 'done');

/** Only the limits of the columns that take one: what the settings save. */
export function columnLimitsOf(limits: Partial<Record<WorkItemStatus, number>>): Partial<Record<WorkItemStatus, number>> {
  const out: Partial<Record<WorkItemStatus, number>> = {};
  for (const status of LIMIT_STATUSES) {
    const limit = limits[status];
    if (limit !== undefined) out[status] = limit;
  }
  return out;
}

/** The columns that carry a limit, in board order. */
export function limitedColumns(board: Pick<BoardSettings, 'columnLimits'> | undefined): Array<{ status: WorkItemStatus; limit: number }> {
  if (!board) return [];
  return LIMIT_STATUSES.flatMap((status) => {
    const limit = board.columnLimits[status];
    return limit === undefined ? [] : [{ status, limit }];
  });
}
