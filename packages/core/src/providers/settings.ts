import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ProviderId, ProvidersSettings } from '@agentry/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';
import { PROVIDER_MANIFESTS } from './registry.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every provider on, searched for, in registry order, with no default: what an absent file reads as. */
export function defaultProvidersSettings(ids: readonly ProviderId[] = PROVIDER_MANIFESTS.map((m) => m.id)): ProvidersSettings {
  return {
    providers: Object.fromEntries(ids.map((id) => [id, { enabled: true, binaryPath: null }])),
    order: [...ids],
    defaultProvider: null,
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
    return result;
  }
}
