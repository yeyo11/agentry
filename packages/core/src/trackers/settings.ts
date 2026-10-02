import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { TrackerId, TrackersSettings } from '@agentry/shared';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';
import { TRACKER_IDS } from './ids.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every tracker on, searching for its binary: what an absent file reads as. */
export function defaultTrackersSettings(ids: readonly TrackerId[] = TRACKER_IDS): TrackersSettings {
  return { trackers: Object.fromEntries(ids.map((id) => [id, { enabled: true, binaryPath: null }])) as TrackersSettings['trackers'] };
}

/**
 * `trackers.json` in the data directory: which trackers are on and a binary of the person's own.
 * Absent until the first save. Detection reads it on every pass, so the parsed document is kept in
 * memory and replaced by `set`.
 */
export class TrackersSettingsStore {
  private readonly file: string;
  private readonly ids: readonly TrackerId[];
  private cached: TrackersSettings | null = null;

  constructor(config: Pick<CoreConfig, 'dataDir'>, ids: readonly TrackerId[] = TRACKER_IDS) {
    this.file = join(config.dataDir, 'trackers.json');
    this.ids = ids;
    mkdirSync(config.dataDir, { recursive: true });
  }

  get(): TrackersSettings {
    this.cached ??= this.read();
    return structuredClone(this.cached);
  }

  /** Replaces the document whole, validated; a tracker missing from it keeps the defaults */
  async set(input: unknown): Promise<TrackersSettings> {
    const parsed = this.parse(input);
    await writeAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cached = parsed;
    return this.get();
  }

  private read(): TrackersSettings {
    if (!existsSync(this.file)) return defaultTrackersSettings(this.ids);
    try {
      return this.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // A hand edit that went bad reads as the defaults rather than keeping every tracker off
      return defaultTrackersSettings(this.ids);
    }
  }

  private parse(input: unknown): TrackersSettings {
    if (!isObject(input)) throw new Error('settings must be an object');
    const result = defaultTrackersSettings(this.ids);
    if (input.trackers === undefined) return result;
    if (!isObject(input.trackers)) throw new Error('trackers must be an object');
    for (const [id, entry] of Object.entries(input.trackers)) {
      if (!(this.ids as readonly string[]).includes(id)) throw new Error(`trackers key must be one of ${this.ids.join(', ')}`);
      if (!isObject(entry)) throw new Error(`trackers.${id} must be an object`);
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error(`trackers.${id}.enabled must be a boolean`);
      const path = entry.binaryPath ?? null;
      if (path !== null && (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path))) {
        throw new Error(`trackers.${id}.binaryPath must be an absolute path or null`);
      }
      result.trackers[id as TrackerId] = { enabled: entry.enabled ?? true, binaryPath: path };
    }
    return result;
  }
}
