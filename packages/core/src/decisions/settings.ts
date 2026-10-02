import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DecisionMode,
  DecisionPointId,
  DecisionPointSettings,
  DecisionProviderId,
  DecisionSettings,
  ProjectDecisionSettings,
} from '@agentry/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';

/*
 * The decision engine's settings: `decisions.json` for the global document (settings-shaped, so a
 * JSON file) and `decision-credentials.json` for the Jev key, mode 0600. Per-project overrides live
 * in the project's own settings document and are parsed here so both sides share one set of rules.
 */

export const DECISION_POINT_IDS: readonly DecisionPointId[] = [
  'flow.refine-needed',
  'flow.bounce',
  'orchestration.retry',
  'supervisor.intervene',
  'memory.triage',
  'assistant.rerank',
  'assistant.sources',
  'journal.relevance',
  'board.triage',
  'team.assign',
  'flow.scope-drift',
  'flow.criteria-precheck',
  'flow.criteria-merge',
  'flow.restart',
  'run.continuation',
  'orchestration.model',
  'orchestration.fixer',
  'health.semantic-loop',
  'health.test-weakening',
  'changes.unexplained-hunk',
  'palette.intent',
  'notification.urgency',
  'checks.fix',
  'review.triage',
  'issue.triage',
  'provider.on-limit',
  'provider.pick',
  'provider.model-map',
];

/**
 * The points of scope G, which a project cannot override. Kept here, next to the parser that
 * enforces it; the engine's catalogue declares the same scope for each point.
 */
const GLOBAL_ONLY_POINTS: ReadonlySet<DecisionPointId> = new Set([
  'supervisor.intervene',
  'health.semantic-loop',
  'health.test-weakening',
  'palette.intent',
  'notification.urgency',
  'provider.model-map',
]);

export const DECISION_MODES: readonly DecisionMode[] = ['off', 'shadow', 'active'];
export const DECISION_PROVIDERS: readonly DecisionProviderId[] = ['cli', 'jev'];
export const DECISION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const JEV_MODEL = 'jev-1.13.0';
export const MIN_THRESHOLD = 0.5;
export const MAX_THRESHOLD = 0.99;
export const DEFAULT_THRESHOLD = 0.85;
export const MIN_HISTORY_DAYS = 1;
export const MAX_HISTORY_DAYS = 365;
/** A ceiling well past what one question costs, so a typo cannot hand a point a worker's budget */
const MAX_COST_USD = 5;
/** What `--model` takes: an alias or a full id; nothing a shell or a flag could misread */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

/** The part of the settings that is stored; the key's state is added on read */
export type StoredDecisionSettings = Omit<DecisionSettings, 'jev'>;

export const DEFAULT_DECISION_SETTINGS: StoredDecisionSettings = {
  provider: 'cli',
  cli: { model: 'haiku', effort: 'low', maxCostUsd: 0.02 },
  points: {},
  historyDays: 30,
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function isPointId(value: string): value is DecisionPointId {
  return (DECISION_POINT_IDS as readonly string[]).includes(value);
}

function parseProvider(value: unknown, field: string): DecisionProviderId {
  if (typeof value !== 'string' || !(DECISION_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${DECISION_PROVIDERS.join(', ')}`);
  }
  return value as DecisionProviderId;
}

function parseMode(value: unknown, field: string): DecisionMode {
  if (typeof value !== 'string' || !(DECISION_MODES as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${DECISION_MODES.join(', ')}`);
  }
  return value as DecisionMode;
}

function parseThreshold(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_THRESHOLD || value > MAX_THRESHOLD) {
    throw new Error(`${field} must be a number from ${String(MIN_THRESHOLD)} to ${String(MAX_THRESHOLD)}`);
  }
  return value;
}

function parseConsent(value: unknown, field: string): DecisionPointSettings['consent'] {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new Error(`${field} must be an object or null`);
  const { at, stateVersion, providers } = value;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new Error(`${field}.at must be a date`);
  if (typeof stateVersion !== 'number' || !Number.isInteger(stateVersion) || stateVersion < 1) {
    throw new Error(`${field}.stateVersion must be a whole number from 1`);
  }
  if (!Array.isArray(providers) || providers.length === 0) throw new Error(`${field}.providers must name at least one provider`);
  return { at, stateVersion, providers: [...new Set(providers.map((p) => parseProvider(p, `${field}.providers`)))] };
}

function parsePoints(value: unknown): Partial<Record<DecisionPointId, DecisionPointSettings>> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error('points must be an object');
  const points: Partial<Record<DecisionPointId, DecisionPointSettings>> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isPointId(id)) throw new Error(`unknown decision point ${id}`);
    if (!isObject(raw)) throw new Error(`points.${id} must be an object`);
    points[id] = {
      mode: raw.mode === undefined ? 'off' : parseMode(raw.mode, `points.${id}.mode`),
      threshold: raw.threshold === undefined ? DEFAULT_THRESHOLD : parseThreshold(raw.threshold, `points.${id}.threshold`),
      consent: parseConsent(raw.consent, `points.${id}.consent`),
    };
  }
  return points;
}

/** Validates a whole document, since `PUT` replaces it: a bad value is refused, not replaced. */
export function parseDecisionSettings(input: unknown): StoredDecisionSettings {
  if (!isObject(input)) throw new Error('the decision settings must be a JSON object');
  const cli = input.cli;
  if (!isObject(cli)) throw new Error('cli must be an object');
  const model = typeof cli.model === 'string' ? cli.model.trim() : '';
  if (!MODEL_RE.test(model)) throw new Error('cli.model must be a model alias or id, such as haiku');
  if (typeof cli.effort !== 'string' || !(DECISION_EFFORTS as readonly string[]).includes(cli.effort)) {
    throw new Error(`cli.effort must be one of ${DECISION_EFFORTS.join(', ')}`);
  }
  const cost = cli.maxCostUsd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || cost > MAX_COST_USD) {
    throw new Error(`cli.maxCostUsd must be a number above 0 and at most ${String(MAX_COST_USD)}`);
  }
  const days = input.historyDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < MIN_HISTORY_DAYS || days > MAX_HISTORY_DAYS) {
    throw new Error(`historyDays must be a whole number from ${String(MIN_HISTORY_DAYS)} to ${String(MAX_HISTORY_DAYS)}`);
  }
  return {
    provider: parseProvider(input.provider, 'provider'),
    cli: { model, effort: cli.effort, maxCostUsd: cost },
    points: parsePoints(input.points),
    historyDays: days,
  };
}

/**
 * A project's overrides: `provider`, and `mode` and `threshold` per point of scope P. Consent is
 * refused here, not dropped, because a project document may be written by a chat and consent is the
 * owner's.
 */
export function parseProjectDecisions(value: unknown): ProjectDecisionSettings {
  if (!isObject(value)) throw new Error('decisions must be an object');
  const result: ProjectDecisionSettings = {};
  if (value.provider !== undefined) {
    result.provider = value.provider === 'inherit' ? 'inherit' : parseProvider(value.provider, 'decisions.provider');
  }
  if (value.points !== undefined && value.points !== null) {
    if (!isObject(value.points)) throw new Error('decisions.points must be an object');
    const points: NonNullable<ProjectDecisionSettings['points']> = {};
    for (const [id, raw] of Object.entries(value.points)) {
      if (!isPointId(id)) throw new Error(`unknown decision point ${id}`);
      if (GLOBAL_ONLY_POINTS.has(id)) throw new Error(`${id} is set globally; a project cannot override it`);
      if (!isObject(raw)) throw new Error(`decisions.points.${id} must be an object`);
      if ('consent' in raw) throw new Error(`decisions.points.${id}: consent is global and cannot be set by a project`);
      const override: Partial<Pick<DecisionPointSettings, 'mode' | 'threshold'>> = {};
      if (raw.mode !== undefined) override.mode = parseMode(raw.mode, `decisions.points.${id}.mode`);
      if (raw.threshold !== undefined) override.threshold = parseThreshold(raw.threshold, `decisions.points.${id}.threshold`);
      points[id] = override;
    }
    if (Object.keys(points).length > 0) result.points = points;
  }
  return result;
}

/** The last four characters of a key, enough to tell two apart and too few to use */
export function keyHintOf(key: string): string {
  return key.slice(-4);
}

/** `decision-credentials.json`: the Jev key, never returned by the API and never logged */
export class DecisionCredentialStore {
  private readonly file: string;
  private key: string | null = null;

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'decision-credentials.json');
    if (existsSync(this.file)) {
      try {
        const stored = JSON.parse(readFileSync(this.file, 'utf8')) as { jevKey?: unknown };
        if (typeof stored.jevKey === 'string' && stored.jevKey) this.key = stored.jevKey;
      } catch {
        this.key = null;
      }
    }
  }

  /** For the Jev adapter only */
  getKey(): string | null {
    return this.key;
  }

  status(): { keySet: boolean; keyHint: string | null } {
    return { keySet: this.key !== null, keyHint: this.key ? keyHintOf(this.key) : null };
  }

  async set(input: unknown): Promise<{ keySet: boolean; keyHint: string | null }> {
    const key = isObject(input) && typeof input.key === 'string' ? input.key.trim() : '';
    // The message never echoes the value: a key pasted into the wrong field is still a key
    if (!key || key.length > 512 || /\s/.test(key)) throw new Error('key must be a single token of at most 512 characters');
    await writeAtomic(this.file, JSON.stringify({ jevKey: key }), 0o600);
    this.key = key;
    return this.status();
  }

  clear(): void {
    this.key = null;
    rmSync(this.file, { force: true });
  }
}

export interface ConsentInput {
  granted: boolean;
  stateVersion: number;
  providers: DecisionProviderId[];
}

/** `decisions.json` in the data directory; absent until the first save, which reads as the defaults. */
export class DecisionSettingsStore {
  private readonly file: string;
  private readonly credentials: DecisionCredentialStore;

  constructor(config: CoreConfig, credentials: DecisionCredentialStore) {
    this.credentials = credentials;
    this.file = join(config.dataDir, 'decisions.json');
    mkdirSync(config.dataDir, { recursive: true });
  }

  private readStored(): StoredDecisionSettings {
    const defaults = (): StoredDecisionSettings => structuredClone(DEFAULT_DECISION_SETTINGS);
    if (!existsSync(this.file)) return defaults();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return defaults();
    }
    if (!isObject(raw)) return defaults();
    // A hand-edited field that went bad falls back on its own, and a bad point on its own, so one
    // typo does not switch every point off (or on)
    const merged = defaults();
    for (const key of ['provider', 'cli', 'historyDays'] as const) {
      try {
        Object.assign(merged, { [key]: parseDecisionSettings({ ...defaults(), [key]: raw[key] })[key] });
      } catch {
        // keep the default for this field
      }
    }
    if (isObject(raw.points)) {
      for (const [id, point] of Object.entries(raw.points)) {
        try {
          Object.assign(merged.points, parsePoints({ [id]: point }));
        } catch {
          // this point stays off
        }
      }
    }
    return merged;
  }

  get(): DecisionSettings {
    return { ...this.readStored(), jev: { model: JEV_MODEL, ...this.credentials.status() } };
  }

  /**
   * Replaces the document. Consent is not part of it: it arrives only through `setConsent`, so a
   * settings write cannot grant it, and one that changes a point keeps what the owner consented to.
   */
  async set(input: unknown): Promise<DecisionSettings> {
    const parsed = parseDecisionSettings(input);
    const before = this.readStored().points;
    for (const [id, point] of Object.entries(parsed.points) as Array<[DecisionPointId, DecisionPointSettings]>) {
      point.consent = before[id]?.consent ?? null;
    }
    await this.write(parsed);
    return this.get();
  }

  async setConsent(point: string, input: ConsentInput, now: Date = new Date()): Promise<DecisionSettings> {
    if (!isPointId(point)) throw new Error(`unknown decision point ${point}`);
    const stored = this.readStored();
    const current = stored.points[point] ?? { mode: 'off', threshold: DEFAULT_THRESHOLD, consent: null };
    const consent = input.granted
      ? parseConsent({ at: now.toISOString(), stateVersion: input.stateVersion, providers: input.providers }, 'consent')
      : null;
    stored.points[point] = { ...current, consent };
    await this.write(stored);
    return this.get();
  }

  private async write(settings: StoredDecisionSettings): Promise<void> {
    await writeAtomic(this.file, `${JSON.stringify(settings, null, 2)}\n`);
  }
}
