import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  BoardSettings,
  ProjectChange,
  ProjectDocumentsSettings,
  ProjectFlowSettings,
  ProjectModule,
  ProjectSettings,
  ProjectTeamMember,
  ProjectTeamSettings,
  ProjectTemplateId,
  WorkItemStatus,
  WorkItemType,
} from '@agentry/shared';
import { MAX_FLOW_COST_USD, PROJECT_MODULES, PROJECT_TEMPLATE_IDS, WORK_ITEM_KEY_PREFIX_PATTERN, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';
import { projectTemplate } from './project-templates.ts';
import type { ProjectRecord } from './projects.ts';

/*
 * What a project configures, beyond its name and path: a settings document per project, a JSON file
 * in the data directory named after the project's id, read and written whole.
 *
 * The document outlives the project record on purpose. Removing a project only makes Agentry forget
 * the directory, so the document (and the work items keyed by the same id) stays, and importing the
 * same directory again finds it by its path and takes the id back. That is why the file also records
 * the path it was written for.
 */

/** A limit above this is a typo, not a work in progress limit. */
const MAX_COLUMN_LIMIT = 999;
const MAX_BOUNCES = 20;
/** Runs one project's flow may keep going at once; each is a paid agent run */
const MAX_FLOW_PARALLEL = 10;
const MAX_TEAM = 20;
const MAX_TEXT = 500;
const MAX_SHORT = 100;
/** Derived prefixes are two to five letters; the pattern leaves the rest of its room to a person. */
const DERIVED_MIN = 2;
const DERIVED_MAX = 5;
const SINGLE_WORD_LENGTH = 3;
/** What a name with fewer than two letters in it gets, since a prefix cannot be made from it. */
const FALLBACK_PREFIX = 'PRJ';
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isModule = (value: unknown): value is ProjectModule => (PROJECT_MODULES as readonly unknown[]).includes(value);
const isTemplateId = (value: unknown): value is ProjectTemplateId => (PROJECT_TEMPLATE_IDS as readonly unknown[]).includes(value);
const isType = (value: unknown): value is WorkItemType => (WORK_ITEM_TYPES as readonly unknown[]).includes(value);
const isStatus = (value: unknown): value is WorkItemStatus => (WORK_ITEM_STATUSES as readonly unknown[]).includes(value);

/**
 * A key prefix made from a project's name: the initials of its words when it has several (`claude
 * wrapper` → `CW`), or the first letter and the consonants after it when it has one (`Agentry` →
 * `AGN`). Letters only, accents dropped. A prefix already taken gets a digit, from 2 up.
 */
export function deriveKeyPrefix(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // `MyShop` is two words to whoever typed it
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  let base: string;
  if (words.length >= DERIVED_MIN) {
    base = words.map((w) => w[0]).join('').slice(0, DERIVED_MAX);
  } else {
    const word = words[0] ?? '';
    const first = word.slice(0, 1);
    const consonants = word.slice(1).replace(/[AEIOU]/g, '');
    base = (first + consonants).slice(0, SINGLE_WORD_LENGTH);
    // A word of vowels (`Aeo`) still has letters to give
    if (base.length < SINGLE_WORD_LENGTH) base = (base + word.slice(1).replace(/[^AEIOU]/g, '')).slice(0, SINGLE_WORD_LENGTH);
  }
  if (base.length < DERIVED_MIN) base = FALLBACK_PREFIX;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The document of a project that has none: every module off, whatever its template would have said. */
export function defaultProjectSettings(keyPrefix: string): ProjectSettings {
  const { board } = projectTemplate('custom');
  return { modules: [], template: null, keyPrefix, board };
}

/** A new project's document: the template's configuration, with `modules` replacing its choice when given. */
export function settingsFromTemplate(template: ProjectTemplateId | null, modules: ProjectModule[] | null, keyPrefix: string): ProjectSettings {
  const base = template ? projectTemplate(template) : null;
  return {
    modules: normalizeModules(modules ?? base?.modules ?? []),
    template,
    keyPrefix,
    board: base?.board ?? defaultProjectSettings(keyPrefix).board,
  };
}

function normalizeModules(modules: readonly ProjectModule[]): ProjectModule[] {
  return PROJECT_MODULES.filter((m) => modules.includes(m));
}

/** Validates a list of modules a person sent. Returned in the fixed order, without repeats. */
export function parseModules(value: unknown): ProjectModule[] {
  if (!Array.isArray(value)) throw new Error('modules must be an array');
  for (const m of value) if (!isModule(m)) throw new Error(`unknown module ${String(m)}; expected one of ${PROJECT_MODULES.join(', ')}`);
  return normalizeModules(value as ProjectModule[]);
}

/** Validates a key prefix. Lower case is accepted and raised, since keys are always shown upper case. */
export function parseKeyPrefix(value: unknown): string {
  if (typeof value !== 'string') throw new Error('key must be a string');
  const key = value.trim().toUpperCase();
  if (!WORK_ITEM_KEY_PREFIX_PATTERN.test(key)) {
    throw new Error('key must be 2 to 10 upper case letters or digits, starting with a letter');
  }
  return key;
}

export function parseTemplateId(value: unknown): ProjectTemplateId {
  if (!isTemplateId(value)) throw new Error(`unknown template ${String(value)}; expected one of ${PROJECT_TEMPLATE_IDS.join(', ')}`);
  return value;
}

/**
 * The template and modules of a create or import request, checked before anything is created: a
 * bad template must not leave a new directory behind in the workspace.
 */
export function parseProjectSetup(input: { template?: unknown; modules?: unknown }): {
  template: ProjectTemplateId | null;
  modules: ProjectModule[] | null;
} {
  return {
    template: input.template === undefined || input.template === null ? null : parseTemplateId(input.template),
    modules: input.modules === undefined || input.modules === null ? null : parseModules(input.modules),
  };
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > max) throw new Error(`${field} is longer than ${max} characters`);
  return value.trim();
}

/** A path inside the project: relative, and never climbing out of it. */
function relativePath(value: unknown, field: string): string {
  const path = text(value, field, MAX_TEXT);
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`${field} must be a path inside the project`);
  return path;
}

function parseBoard(value: unknown): BoardSettings {
  if (!isObject(value)) throw new Error('board must be an object');
  if (!Array.isArray(value.types) || value.types.length === 0) throw new Error('board.types must list at least one type');
  const types: WorkItemType[] = [];
  for (const t of value.types) {
    if (!isType(t)) throw new Error(`unknown work item type ${String(t)}; expected one of ${WORK_ITEM_TYPES.join(', ')}`);
    if (!types.includes(t)) types.push(t);
  }
  const limits = value.columnLimits ?? {};
  if (!isObject(limits)) throw new Error('board.columnLimits must be an object');
  const columnLimits: BoardSettings['columnLimits'] = {};
  for (const [column, limit] of Object.entries(limits)) {
    if (!isStatus(column)) throw new Error(`unknown column ${column}; expected one of ${WORK_ITEM_STATUSES.join(', ')}`);
    // null clears a limit, the same as leaving the column out
    if (limit === null) continue;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_COLUMN_LIMIT) {
      throw new Error(`the limit of ${column} must be a whole number from 1 to ${MAX_COLUMN_LIMIT}`);
    }
    columnLimits[column] = limit;
  }
  return { types, columnLimits };
}

function parseTeam(value: unknown): ProjectTeamSettings {
  if (!isObject(value) || !Array.isArray(value.members)) throw new Error('team.members must be an array');
  if (value.members.length > MAX_TEAM) throw new Error(`team has more than ${MAX_TEAM} members`);
  const members = value.members.map((raw: unknown, i): ProjectTeamMember => {
    if (!isObject(raw)) throw new Error(`team member ${i} must be an object`);
    const agent = text(raw.agent, `team member ${i} agent`, 64);
    if (!AGENT_NAME.test(agent)) throw new Error(`team member ${i} agent must be an agent file name without .md`);
    const member: ProjectTeamMember = {
      agent,
      role: text(raw.role, `team member ${i} role`, MAX_SHORT),
      model: text(raw.model, `team member ${i} model`, MAX_SHORT),
      responsibility: text(raw.responsibility, `team member ${i} responsibility`, MAX_TEXT),
    };
    if (raw.writes !== undefined) {
      if (!Array.isArray(raw.writes)) throw new Error(`team member ${i} writes must be an array`);
      member.writes = raw.writes.map((w: unknown) => relativePath(w, `team member ${i} writes`));
    }
    return member;
  });
  return { members };
}

function parseFlow(value: unknown): ProjectFlowSettings {
  if (!isObject(value)) throw new Error('flow must be an object');
  if (typeof value.enabled !== 'boolean') throw new Error('flow.enabled must be a boolean');
  const raw = value.columns ?? {};
  if (!isObject(raw)) throw new Error('flow.columns must be an object');
  const columns: ProjectFlowSettings['columns'] = {};
  for (const [column, role] of Object.entries(raw)) {
    if (!isStatus(column)) throw new Error(`unknown column ${column}; expected one of ${WORK_ITEM_STATUSES.join(', ')}`);
    // A person approves `done`: no role answers for it, whatever the document says
    if (role === null || column === 'done') continue;
    columns[column] = text(role, `flow.columns.${column}`, MAX_SHORT);
  }
  const { maxBounces } = value;
  if (typeof maxBounces !== 'number' || !Number.isInteger(maxBounces) || maxBounces < 0 || maxBounces > MAX_BOUNCES) {
    throw new Error(`flow.maxBounces must be a whole number from 0 to ${MAX_BOUNCES}`);
  }
  const flow: ProjectFlowSettings = { enabled: value.enabled, columns, maxBounces };
  // Absent reads as the default; kept absent rather than written, so the default can change later
  const { maxParallel } = value;
  if (maxParallel !== undefined && maxParallel !== null) {
    if (typeof maxParallel !== 'number' || !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_FLOW_PARALLEL) {
      throw new Error(`flow.maxParallel must be a whole number from 1 to ${MAX_FLOW_PARALLEL}`);
    }
    flow.maxParallel = maxParallel;
  }
  // What a run may spend: kept absent the same way, so the default can change later
  const { maxCostUsd } = value;
  if (maxCostUsd !== undefined && maxCostUsd !== null) {
    if (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > MAX_FLOW_COST_USD) {
      throw new Error(`flow.maxCostUsd must be a number of USD above 0 and at most ${MAX_FLOW_COST_USD}`);
    }
    flow.maxCostUsd = maxCostUsd;
  }
  return flow;
}

function parseDocuments(value: unknown): ProjectDocumentsSettings {
  if (!isObject(value)) throw new Error('documents must be an object');
  return { path: relativePath(value.path, 'documents.path') };
}

/**
 * Validates a whole document a person sent (`PUT /projects/:id/settings`). A bad value is refused,
 * not replaced. Fields nobody reads yet (team, flow, documents) are checked all the same, so what
 * orchestration 3 finds stored is already well formed. Unknown fields are dropped.
 */
export function parseProjectSettings(input: unknown): ProjectSettings {
  if (!isObject(input)) throw new Error('project settings must be a JSON object');
  const settings: ProjectSettings = {
    modules: parseModules(input.modules),
    template: input.template === undefined || input.template === null ? null : parseTemplateId(input.template),
    keyPrefix: parseKeyPrefix(input.keyPrefix),
    board: parseBoard(input.board),
  };
  if (input.team !== undefined && input.team !== null) settings.team = parseTeam(input.team);
  if (input.flow !== undefined && input.flow !== null) settings.flow = parseFlow(input.flow);
  if (input.documents !== undefined && input.documents !== null) settings.documents = parseDocuments(input.documents);
  return settings;
}

/**
 * What a stored document is worth. Used on read, where a hand-edited file must not fail every page
 * that lists projects: each part that does not validate falls back to its default on its own, so a
 * bad limit does not also switch the modules off.
 */
function sanitizeSettings(value: unknown, fallbackPrefix: string): ProjectSettings {
  const raw = isObject(value) ? value : {};
  const attempt = <T>(parse: () => T, fallback: T): T => {
    try {
      return parse();
    } catch {
      return fallback;
    }
  };
  const defaults = defaultProjectSettings(fallbackPrefix);
  const settings: ProjectSettings = {
    modules: attempt(() => parseModules(raw.modules), defaults.modules),
    template: attempt(() => (raw.template == null ? null : parseTemplateId(raw.template)), null),
    keyPrefix: attempt(() => parseKeyPrefix(raw.keyPrefix), fallbackPrefix),
    board: attempt(() => parseBoard(raw.board), defaults.board),
  };
  const team = attempt(() => (raw.team == null ? null : parseTeam(raw.team)), null);
  const flow = attempt(() => (raw.flow == null ? null : parseFlow(raw.flow)), null);
  const documents = attempt(() => (raw.documents == null ? null : parseDocuments(raw.documents)), null);
  if (team) settings.team = team;
  if (flow) settings.flow = flow;
  if (documents) settings.documents = documents;
  return settings;
}

/** What `project.updated` should say changed between two documents. */
export function settingsChanges(before: ProjectSettings, after: ProjectSettings): ProjectChange[] {
  const changes: ProjectChange[] = [];
  if (before.keyPrefix !== after.keyPrefix) changes.push('key');
  if (before.modules.join() !== after.modules.join()) changes.push('modules');
  const rest = (s: ProjectSettings) => JSON.stringify({ ...s, keyPrefix: null, modules: null });
  if (rest(before) !== rest(after)) changes.push('settings');
  return changes;
}

/** The file on disk: the settings, and the project they belong to, so a re-import can find them. */
export interface SettingsDoc {
  projectId: string;
  path: string;
  settings: unknown;
}

/**
 * What a read answers, and what it has to write down so the answer stays the same next time: the
 * `settings` value of the file, or null when nothing is written.
 */
interface Resolution {
  settings: ProjectSettings;
  persist: unknown;
}

/** What `create` found and left: the document before, null for a project seen for the first time. */
export interface CreatedSettings {
  settings: ProjectSettings;
  previous: ProjectSettings | null;
}

const ID = /^[A-Za-z0-9-]+$/;

/**
 * `project-settings/<projectId>.json` in the data directory. Read from disk on every call rather than
 * held in memory: several wrapper processes share the data directory, and a document is small.
 *
 * A read writes only what keeps its own answer stable: the document of a project that has none, and
 * the prefix of one that clashes with another project's. A document that does not parse or whose
 * prefix does not validate is answered in memory and left on disk as it is: it is most likely a hand
 * edit with a typo, and writing defaults over it would lose the modules, limits and prefix the typo
 * only hid. Only a write the person asks for replaces it.
 */
export class ProjectSettingsStore {
  private readonly dir: string;
  /** Derivations run one at a time, or two new projects read together could take the same prefix. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(config: CoreConfig) {
    this.dir = join(config.dataDir, 'project-settings');
    mkdirSync(this.dir, { recursive: true });
  }

  private file(projectId: string): string {
    // Ids are ours, but they end up in a path
    if (!ID.test(projectId)) throw new Error('invalid project id');
    return join(this.dir, `${projectId}.json`);
  }

  /** Protected so a test can count the reads. */
  protected readDoc(projectId: string): SettingsDoc | null {
    const file = this.file(projectId);
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!isObject(raw)) return { projectId, path: '', settings: null };
      return { projectId, path: typeof raw.path === 'string' ? raw.path : '', settings: raw.settings };
    } catch {
      return { projectId, path: '', settings: null };
    }
  }

  private allDocs(): SettingsDoc[] {
    const ids = readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((id) => ID.test(id));
    return ids.flatMap((id) => this.readDoc(id) ?? []);
  }

  private prefixOf(doc: SettingsDoc): string | null {
    const prefix = isObject(doc.settings) ? doc.settings.keyPrefix : null;
    return typeof prefix === 'string' && WORK_ITEM_KEY_PREFIX_PATTERN.test(prefix) ? prefix : null;
  }

  /**
   * The id a directory had when it was last a project, so importing it again brings back its
   * settings and work items. Ids in `active` are skipped: they belong to projects imported now.
   */
  idForPath(path: string, active: ReadonlySet<string>): string | null {
    return this.allDocs().find((doc) => doc.path === path && !active.has(doc.projectId))?.projectId ?? null;
  }

  /** Whether a document exists for the project, removed projects included. */
  has(projectId: string): boolean {
    return this.readDoc(projectId) !== null;
  }

  /**
   * The stored document as it is, without writing anything: the work item store reads keys and
   * limits synchronously, inside its transactions. Removed projects' documents still answer, so their
   * items keep their keys. With the project's `name`, a document whose prefix is unusable answers the
   * prefix `read` derives for it, so keys and the project list agree; without it, null.
   */
  stored(projectId: string, name?: string): ProjectSettings | null {
    if (!ID.test(projectId)) return null;
    const doc = this.readDoc(projectId);
    if (!doc) return null;
    const prefix = this.prefixOf(doc) ?? (name === undefined ? null : deriveKeyPrefix(name, this.takenPrefixes(projectId, this.allDocs())));
    return prefix ? sanitizeSettings(doc.settings, prefix) : null;
  }

  /**
   * The project's settings. A project with none gets its document now, every module off and a
   * prefix derived from its name, so the prefix stays the same from then on. `active` is every
   * project imported now: a stored prefix that clashes with one of theirs is derived again.
   */
  async read(project: ProjectRecord, active: readonly ProjectRecord[]): Promise<ProjectSettings> {
    const docOf = (id: string) => this.readDoc(id);
    const first = this.resolve(project, active, docOf, () => this.allDocs());
    if (first.persist === null) return first.settings;
    return this.serialized(async () => {
      // Another call may have written it while this one waited
      const now = this.resolve(project, active, docOf, () => this.allDocs());
      if (now.persist !== null) await this.writeDoc(project, now.persist);
      return now.settings;
    });
  }

  /**
   * `read` for every project at once, as listing them needs: each document is read from disk once,
   * rather than once for the project and again for every other project it is checked against.
   */
  async readAll(projects: readonly ProjectRecord[]): Promise<Map<string, ProjectSettings>> {
    const docs = this.allDocs();
    const byId = new Map(docs.map((doc) => [doc.projectId, doc]));
    const docOf = (id: string) => byId.get(id) ?? null;
    const result = new Map<string, ProjectSettings>();
    for (const project of projects) {
      const resolved = this.resolve(project, projects, docOf, () => docs);
      // Rare: a project with no document yet, or a clash. `read` writes it under the lock
      result.set(project.id, resolved.persist === null ? resolved.settings : await this.read(project, projects));
    }
    return result;
  }

  private resolve(
    project: ProjectRecord,
    active: readonly ProjectRecord[],
    docOf: (id: string) => SettingsDoc | null,
    docs: () => SettingsDoc[],
  ): Resolution {
    const doc = docOf(project.id);
    const stored = doc && this.prefixOf(doc);
    // Two projects holding one prefix: the one imported first keeps it, whichever is read first
    const index = active.findIndex((p) => p.id === project.id);
    const rivals = index < 0 ? active : active.slice(0, index);
    if (doc && stored && !this.clashes(project.id, stored, rivals, docOf)) return { settings: sanitizeSettings(doc.settings, stored), persist: null };
    const prefix = deriveKeyPrefix(project.name, this.takenPrefixes(project.id, docs()));
    if (!doc) {
      const settings = defaultProjectSettings(prefix);
      return { settings, persist: settings };
    }
    // A clash is repaired on disk, and only the prefix changes there, so nothing the file holds that
    // this version does not read is lost. Anything else unusable is answered in memory only
    const persist = stored && isObject(doc.settings) ? { ...doc.settings, keyPrefix: prefix } : null;
    return { settings: { ...sanitizeSettings(doc.settings, prefix), keyPrefix: prefix }, persist };
  }

  /** Replaces the document whole. The caller has validated it; the prefix's uniqueness is checked here. */
  async write(project: ProjectRecord, settings: ProjectSettings, active: readonly ProjectRecord[]): Promise<void> {
    await this.serialized(async () => {
      if (this.clashes(project.id, settings.keyPrefix, active, (id) => this.readDoc(id))) {
        throw new Error(`key ${settings.keyPrefix} is already used by another project`);
      }
      await this.writeDoc(project, settings);
    });
  }

  /**
   * Changes part of the document: `change` is handed what is stored now, read under the lock, so two
   * changes made together (a module switched while a member joins) both land. Only the parts it
   * changed are written; every other part goes back to disk as the file held it, so a part a hand
   * edit broke, or a field this version does not know, is not replaced by what a read made of it.
   */
  async update(
    project: ProjectRecord,
    change: (current: ProjectSettings) => ProjectSettings,
    active: readonly ProjectRecord[],
  ): Promise<{ before: ProjectSettings; after: ProjectSettings }> {
    // Writes the document of a project that has none, or a prefix repaired, as any read would
    await this.read(project, active);
    return this.serialized(async () => {
      // Read again under the lock: `before` may be stale by the time this runs
      const current = this.resolve(project, active, (id) => this.readDoc(id), () => this.allDocs()).settings;
      const after = change(current);
      if (after.keyPrefix !== current.keyPrefix && this.clashes(project.id, after.keyPrefix, active, (id) => this.readDoc(id))) {
        throw new Error(`key ${after.keyPrefix} is already used by another project`);
      }
      if (!settingsChanges(current, after).length) return { before: current, after: current };
      const raw = this.readDoc(project.id)?.settings;
      // A file that does not parse has no part worth keeping: the whole document is written
      if (!isObject(raw)) {
        await this.writeDoc(project, after);
        return { before: current, after };
      }
      const doc: Record<string, unknown> = { ...raw };
      const keys = new Set([...Object.keys(current), ...Object.keys(after)] as Array<keyof ProjectSettings>);
      for (const key of keys) {
        if (JSON.stringify(current[key]) === JSON.stringify(after[key])) continue;
        if (after[key] === undefined) delete doc[key];
        else doc[key] = after[key];
      }
      await this.writeDoc(project, doc);
      return { before: current, after };
    });
  }

  /**
   * A new project's document, derived from its template. A project imported again with a document
   * already on disk keeps it, with its modules replaced by those the request names (or its template
   * offers) and the template it names recorded. What the document holds beyond that is written back
   * as it was, so a part a hand edit broke is still there for the person to fix.
   */
  async create(project: ProjectRecord, setup: ReturnType<typeof parseProjectSetup>, active: readonly ProjectRecord[]): Promise<CreatedSettings> {
    return this.serialized(async () => {
      const existing = this.readDoc(project.id);
      if (existing) {
        const stored = this.prefixOf(existing);
        const prefix =
          stored && !this.clashes(project.id, stored, active, (id) => this.readDoc(id))
            ? stored
            : deriveKeyPrefix(project.name, this.takenPrefixes(project.id, this.allDocs()));
        const previous = sanitizeSettings(existing.settings, stored ?? prefix);
        const modules = setup.modules ?? (setup.template ? projectTemplate(setup.template).modules : null);
        const overrides = {
          keyPrefix: prefix,
          ...(modules ? { modules: normalizeModules(modules) } : {}),
          ...(setup.template ? { template: setup.template } : {}),
        };
        await this.writeDoc(project, { ...(isObject(existing.settings) ? existing.settings : {}), ...overrides });
        return { settings: { ...sanitizeSettings(existing.settings, prefix), ...overrides }, previous };
      }
      const settings = settingsFromTemplate(
        setup.template,
        setup.modules,
        deriveKeyPrefix(project.name, this.takenPrefixes(project.id, this.allDocs())),
      );
      await this.writeDoc(project, settings);
      return { settings, previous: null };
    });
  }

  /**
   * An explicit prefix is only refused when a project imported now holds it: a removed project's
   * document keeps its prefix, but should not stop the person from reusing it. Derivation avoids
   * those too (see `takenPrefixes`), so re-importing rarely has to change a prefix.
   */
  private clashes(projectId: string, prefix: string, active: readonly ProjectRecord[], docOf: (id: string) => SettingsDoc | null): boolean {
    return active.some((p) => {
      if (p.id === projectId) return false;
      const doc = docOf(p.id);
      return !!doc && this.prefixOf(doc) === prefix;
    });
  }

  private takenPrefixes(exceptId: string, docs: readonly SettingsDoc[]): Set<string> {
    return new Set(docs.flatMap((doc) => (doc.projectId === exceptId ? [] : (this.prefixOf(doc) ?? []))));
  }

  private writeDoc(project: ProjectRecord, settings: unknown): Promise<void> {
    const doc: SettingsDoc = { projectId: project.id, path: project.path, settings };
    return writeAtomic(this.file(project.id), `${JSON.stringify(doc, null, 2)}\n`);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}
