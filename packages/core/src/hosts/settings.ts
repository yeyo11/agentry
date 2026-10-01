import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CodeHostId, CodeHostsSettings } from '@agentry/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';
import { CODE_HOST_MANIFESTS } from './registry.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every host on, searching for its binary: what an absent file reads as. */
export function defaultCodeHostsSettings(ids: readonly CodeHostId[] = CODE_HOST_MANIFESTS.map((m) => m.id)): CodeHostsSettings {
  return { hosts: Object.fromEntries(ids.map((id) => [id, { enabled: true, binaryPath: null }])) as CodeHostsSettings['hosts'] };
}

/**
 * `hosts.json` in the data directory: which code hosts are on and a binary of the person's own.
 * Absent until the first save. Readiness reads it on every project, so the parsed document is kept
 * in memory and replaced by `set`.
 */
export class CodeHostsSettingsStore {
  private readonly file: string;
  private readonly ids: readonly CodeHostId[];
  private cached: CodeHostsSettings | null = null;

  constructor(config: Pick<CoreConfig, 'dataDir'>, ids: readonly CodeHostId[] = CODE_HOST_MANIFESTS.map((m) => m.id)) {
    this.file = join(config.dataDir, 'hosts.json');
    this.ids = ids;
    mkdirSync(config.dataDir, { recursive: true });
  }

  get(): CodeHostsSettings {
    this.cached ??= this.read();
    return structuredClone(this.cached);
  }

  /** Replaces the document whole, validated; a host missing from it keeps the defaults */
  async set(input: unknown): Promise<CodeHostsSettings> {
    const parsed = this.parse(input);
    await writeAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cached = parsed;
    return this.get();
  }

  private read(): CodeHostsSettings {
    if (!existsSync(this.file)) return defaultCodeHostsSettings(this.ids);
    try {
      return this.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // A hand edit that went bad reads as the defaults rather than keeping every host off
      return defaultCodeHostsSettings(this.ids);
    }
  }

  private parse(input: unknown): CodeHostsSettings {
    if (!isObject(input)) throw new Error('settings must be an object');
    const result = defaultCodeHostsSettings(this.ids);
    if (input.hosts === undefined) return result;
    if (!isObject(input.hosts)) throw new Error('hosts must be an object');
    for (const [id, entry] of Object.entries(input.hosts)) {
      if (!(this.ids as readonly string[]).includes(id)) throw new Error(`hosts key must be one of ${this.ids.join(', ')}`);
      if (!isObject(entry)) throw new Error(`hosts.${id} must be an object`);
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`hosts.${id}.enabled must be a boolean`);
      const path = entry.binaryPath ?? null;
      if (path !== null && (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path))) {
        throw new Error(`hosts.${id}.binaryPath must be an absolute path or null`);
      }
      result.hosts[id as CodeHostId] = { enabled: entry.enabled ?? true, binaryPath: path };
    }
    return result;
  }
}
