import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the daily check looks at the clock; the check itself only runs once the answer is a day old */
const TICK_MS = 60 * 60 * 1000;
/** Not at boot: a start-up is already busy, and a restart loop must not turn into a request loop */
const FIRST_CHECK_DELAY_MS = 60_000;

/** `2.1.278` and nothing looser: `latest` or `stable` mean the image does not pin */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const parts = (v: string) => v.split('-')[0]!.split('.').map(Number);

/** Positive when `a` is newer than `b`; a pre-release sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return Number(!a.includes('-')) - Number(!b.includes('-'));
}

export interface VersionCheckOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface VersionCheckSpec<S> {
  /** File name in the data directory */
  file: string;
  /** Environment variable that turns the daily check off when it is `off` */
  offSwitch: string;
  empty: S;
  /** What a saved file becomes; anything it cannot vouch for falls back to `empty`'s values */
  parse(saved: Record<string, unknown>): S;
}

/**
 * The part of a "is there a newer X" check that does not depend on what X is: a JSON document in
 * the data directory holding the last answer, a check on demand that two callers share, and a
 * daily timer. The source is asked on demand or once a day, never as a side effect of serving a
 * page, and the answer survives a restart, which keeps a crash loop from re-asking it.
 */
export abstract class VersionCheck<S extends { checkedAt: string | null }> {
  protected readonly env: NodeJS.ProcessEnv;
  protected readonly fetchFn: typeof fetch;
  protected readonly now: () => number;
  protected stored: S;
  protected lastError: string | undefined;
  private readonly file: string;
  private readonly offSwitch: string;
  private timers: NodeJS.Timeout[] = [];
  private inflight: Promise<void> | null = null;

  constructor(config: CoreConfig, spec: VersionCheckSpec<S>, options: VersionCheckOptions = {}) {
    this.file = join(config.dataDir, spec.file);
    this.offSwitch = spec.offSwitch;
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.stored = spec.empty;
    if (existsSync(this.file)) {
      try {
        const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (saved && typeof saved === 'object') this.stored = spec.parse(saved as Record<string, unknown>);
      } catch {
        // A damaged file is only a cache; the next check rewrites it
      }
    }
  }

  /** Reads the source and returns what to store; throws when it could not. */
  protected abstract fetchLatest(): Promise<S>;
  /** The `error` a failed check reports, from the reason it failed */
  protected abstract failure(reason: string): string;
  /** Called after a successful check has been stored */
  protected afterCheck(_previous: S): void {}

  /** Asks the source now. A failure keeps the previous answer and is reported in `error`. */
  async check(): Promise<void> {
    // Two clicks, or a click during the daily check, are one request
    this.inflight ??= this.run().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async run(): Promise<void> {
    try {
      const previous = this.stored;
      this.stored = await this.fetchLatest();
      this.lastError = undefined;
      await writeAtomic(this.file, `${JSON.stringify(this.stored, null, 2)}\n`);
      this.afterCheck(previous);
    } catch (err) {
      this.lastError = this.failure(err instanceof Error ? err.message : String(err));
    }
  }

  protected get checkedAtIso(): string {
    return new Date(this.now()).toISOString();
  }

  private get stale(): boolean {
    const at = this.stored.checkedAt ? Date.parse(this.stored.checkedAt) : 0;
    return this.now() - at >= DAY_MS;
  }

  /**
   * One check a day while the wrapper runs. An air-gapped install turns it off with its switch set
   * to `off`; the button still works there.
   */
  startDaily(): void {
    if (this.env[this.offSwitch] === 'off' || this.timers.length > 0) return;
    const tick = () => {
      if (this.stale) void this.check();
    };
    const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
    const every = setInterval(tick, TICK_MS);
    // A pending check must never be what keeps the process alive at shutdown
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}
