import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelOption, ProviderId } from '@agentry/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';

/** The models one handshake listed, for the version that listed them */
export interface ProviderCatalog {
  version: string;
  models: ModelOption[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `provider-catalogs.json` in the data directory: the models each provider's handshake listed, per
 * version. A cache rewritten whole, so a provider's picker is not empty before the first handshake
 * of a run. A file that cannot be read is an empty cache, never an error.
 */
export class ProviderCatalogsStore {
  private readonly file: string;
  private cached: Map<ProviderId, ProviderCatalog> | null = null;

  constructor(config: Pick<CoreConfig, 'dataDir'>) {
    this.file = join(config.dataDir, 'provider-catalogs.json');
  }

  get(id: ProviderId): ProviderCatalog | null {
    return this.load().get(id) ?? null;
  }

  /** Stores a catalog; false when the same one was already there, so nothing is rewritten */
  async set(id: ProviderId, catalog: ProviderCatalog): Promise<boolean> {
    const all = this.load();
    const before = all.get(id);
    if (before && before.version === catalog.version && JSON.stringify(before.models) === JSON.stringify(catalog.models)) return false;
    all.set(id, catalog);
    await writeAtomic(this.file, `${JSON.stringify(Object.fromEntries(all), null, 2)}\n`);
    return true;
  }

  private load(): Map<ProviderId, ProviderCatalog> {
    if (this.cached) return this.cached;
    const all = new Map<ProviderId, ProviderCatalog>();
    try {
      const json: unknown = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
      if (isObject(json)) {
        for (const [id, value] of Object.entries(json)) {
          if (!isObject(value) || typeof value.version !== 'string' || !Array.isArray(value.models)) continue;
          const models = value.models.filter((m): m is ModelOption => isObject(m) && typeof m.value === 'string');
          all.set(id, { version: value.version, models });
        }
      }
    } catch {
      // An unreadable cache is refilled by the next handshake
    }
    this.cached = all;
    return all;
  }
}
