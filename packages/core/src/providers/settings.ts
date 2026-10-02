import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LimitAction, ModelMapEntry, ProviderId, ProvidersSettings, RotationSettings } from '@agentry/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';
import { PROVIDER_MANIFESTS } from './registry.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const LIMIT_ACTIONS: readonly LimitAction[] = ['handoff', 'restart', 'wait'];
const MAX_WAIT_HOURS = 48;
const MAX_MOVES = 5;
const MAX_MODEL_MAP = 200;
const MAX_MODEL_LENGTH = 200;

/** A fresh install never sends work to a second vendor: it waits for the reset and spends only the replayed turn. */
export function defaultRotationSettings(): RotationSettings {
  return { onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6, maxMoves: 2 }, modelMap: [] };
}

const integerIn = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
};

const limitAction = (value: unknown, name: string): LimitAction => {
  if (typeof value !== 'string' || !(LIMIT_ACTIONS as readonly string[]).includes(value)) throw new Error(`${name} must be one of ${LIMIT_ACTIONS.join(', ')}`);
  return value as LimitAction;
};

/**
 * The `onLimit` fields a document sets. Global settings fill the rest from the defaults; a project
 * passes only what it overrides, so a missing field stays missing and inherits. `allowed` always
 * contains `action` when both are known here, so the chosen action is never one a decision point
 * could not pick.
 */
export function parseOnLimit(input: unknown, name: string): Partial<RotationSettings['onLimit']> {
  if (!isObject(input)) throw new Error(`${name} must be an object`);
  const result: Partial<RotationSettings['onLimit']> = {};
  if (input.action !== undefined) result.action = limitAction(input.action, `${name}.action`);
  if (input.allowed !== undefined) {
    if (!Array.isArray(input.allowed) || input.allowed.length === 0) throw new Error(`${name}.allowed must be a non-empty array`);
    const allowed = input.allowed.map((a) => limitAction(a, `${name}.allowed entry`));
    if (new Set(allowed).size !== allowed.length) throw new Error(`${name}.allowed lists an action twice`);
    result.allowed = allowed;
  }
  if (input.maxWaitHours !== undefined) result.maxWaitHours = integerIn(input.maxWaitHours, `${name}.maxWaitHours`, 1, MAX_WAIT_HOURS);
  if (input.maxMoves !== undefined) result.maxMoves = integerIn(input.maxMoves, `${name}.maxMoves`, 0, MAX_MOVES);
  if (result.action !== undefined && result.allowed !== undefined && !result.allowed.includes(result.action)) {
    result.allowed = [...result.allowed, result.action];
  }
  return result;
}

/** Every provider on, searched for, in registry order, with no default: what an absent file reads as. */
export function defaultProvidersSettings(ids: readonly ProviderId[] = PROVIDER_MANIFESTS.map((m) => m.id)): ProvidersSettings {
  return {
    providers: Object.fromEntries(ids.map((id) => [id, { enabled: true, binaryPath: null }])),
    order: [...ids],
    defaultProvider: null,
    rotation: defaultRotationSettings(),
  };
}

/**
 * `providers.json` in the data directory: which providers are on, their order, the default and a
 * binary of the person's own. Absent until the first save. It is read on every detection, so the
 * parsed document is kept in memory and replaced by `set`.
 */
export class ProvidersSettingsStore {
  private readonly file: string;
  private readonly ids: readonly ProviderId[];
  private cached: ProvidersSettings | null = null;

  constructor(config: Pick<CoreConfig, 'dataDir'>, ids: readonly ProviderId[] = PROVIDER_MANIFESTS.map((m) => m.id)) {
    this.file = join(config.dataDir, 'providers.json');
    this.ids = ids;
    mkdirSync(config.dataDir, { recursive: true });
  }

  get(): ProvidersSettings {
    this.cached ??= this.read();
    return structuredClone(this.cached);
  }

  /** Replaces the document whole, validated; a provider missing from it keeps the defaults */
  async set(input: unknown): Promise<ProvidersSettings> {
    const parsed = this.parse(input);
    await writeAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cached = parsed;
    return this.get();
  }

  private read(): ProvidersSettings {
    if (!existsSync(this.file)) return defaultProvidersSettings(this.ids);
    try {
      return this.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // A hand edit that went bad reads as the defaults rather than keeping every provider off
      return defaultProvidersSettings(this.ids);
    }
  }

  private known(id: unknown, name: string): ProviderId {
    if (typeof id !== 'string' || !this.ids.includes(id)) throw new Error(`${name} must be one of ${this.ids.join(', ')}`);
    return id;
  }

  private parse(input: unknown): ProvidersSettings {
    if (!isObject(input)) throw new Error('settings must be an object');
    const result = defaultProvidersSettings(this.ids);

    if (input.providers !== undefined) {
      if (!isObject(input.providers)) throw new Error('providers must be an object');
      for (const [id, entry] of Object.entries(input.providers)) {
        this.known(id, 'providers key');
        if (!isObject(entry)) throw new Error(`providers.${id} must be an object`);
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`providers.${id}.enabled must be a boolean`);
        const path = entry.binaryPath ?? null;
        if (path !== null && (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path))) {
          throw new Error(`providers.${id}.binaryPath must be an absolute path or null`);
        }
        result.providers[id] = { enabled: entry.enabled ?? true, binaryPath: path };
      }
    }

    if (input.order !== undefined) {
      if (!Array.isArray(input.order)) throw new Error('order must be an array');
      const listed = input.order.map((id) => this.known(id, 'order entry'));
      if (new Set(listed).size !== listed.length) throw new Error('order lists a provider twice');
      // One left out is appended, so a provider added later is still offered
      result.order = [...listed, ...this.ids.filter((id) => !listed.includes(id))];
    }

    if (input.defaultProvider !== undefined && input.defaultProvider !== null) {
      result.defaultProvider = this.known(input.defaultProvider, 'defaultProvider');
    }

    if (input.rotation !== undefined && input.rotation !== null) result.rotation = this.parseRotation(input.rotation);
    return result;
  }

  private parseRotation(input: unknown): RotationSettings {
    if (!isObject(input)) throw new Error('rotation must be an object');
    const result = defaultRotationSettings();
    if (input.onLimit !== undefined) {
      const onLimit = { ...result.onLimit, ...parseOnLimit(input.onLimit, 'rotation.onLimit') };
      // `allowed` missing from the document but the action widened: keep the action pickable
      if (!onLimit.allowed.includes(onLimit.action)) onLimit.allowed = [...onLimit.allowed, onLimit.action];
      result.onLimit = onLimit;
    }
    if (input.modelMap !== undefined) {
      if (!Array.isArray(input.modelMap)) throw new Error('rotation.modelMap must be an array');
      if (input.modelMap.length > MAX_MODEL_MAP) throw new Error(`rotation.modelMap has more than ${MAX_MODEL_MAP} entries`);
      const seen = new Set<string>();
      result.modelMap = input.modelMap.map((entry, i) => {
        const parsed = this.parseModelMapEntry(entry, `rotation.modelMap[${i}]`);
        const key = `${parsed.from.provider}\0${parsed.from.model}`;
        if (seen.has(key)) throw new Error(`rotation.modelMap[${i}] maps ${parsed.from.provider} ${parsed.from.model} a second time`);
        seen.add(key);
        return parsed;
      });
    }
    return result;
  }

  private parseModelMapEntry(entry: unknown, name: string): ModelMapEntry {
    if (!isObject(entry)) throw new Error(`${name} must be an object`);
    const side = (value: unknown, label: string) => {
      if (!isObject(value)) throw new Error(`${name}.${label} must be an object`);
      const provider = this.known(value.provider, `${name}.${label}.provider`);
      // Not checked against a catalog: a catalog changes with a CLI update, and a model that left it shows as missing
      if (typeof value.model !== 'string' || value.model.trim() === '' || value.model.length > MAX_MODEL_LENGTH) {
        throw new Error(`${name}.${label}.model must be a non-empty string of at most ${MAX_MODEL_LENGTH} characters`);
      }
      return { provider, model: value.model.trim() };
    };
    const from = side(entry.from, 'from');
    const to = side(entry.to, 'to');
    if (from.provider === to.provider) throw new Error(`${name} must map between two different providers`);
    if (entry.origin !== 'person' && entry.origin !== 'decision') throw new Error(`${name}.origin must be person or decision`);
    let at = new Date().toISOString();
    if (entry.at !== undefined) {
      if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) throw new Error(`${name}.at must be a date`);
      at = entry.at;
    }
    return { from, to, origin: entry.origin, at };
  }
}
