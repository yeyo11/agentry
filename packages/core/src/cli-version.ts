import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliVersionInfo } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the daily check looks at the clock; the check itself only runs once the answer is a day old */
const TICK_MS = 60 * 60 * 1000;
/** Not at boot: a start-up is already busy, and a restart loop must not turn into a request loop */
const FIRST_CHECK_DELAY_MS = 60_000;
const REGISTRY_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

interface Stored {
  latest: string | null;
  checkedAt: string | null;
}

/** `2.1.278` and nothing looser: `latest` or `stable` mean the image does not pin */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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

export interface CliVersionOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Whether a newer Claude Code than the one in use has been published. The registry is read on
 * demand (`check`) or once a day (`startDaily`), never as a side effect of serving a page: `info`
 * only reads what the last check stored. The answer is a settings-shaped document, so it lives in
 * a JSON file and survives a restart, which keeps a crash loop from re-asking the registry.
 */
export class CliVersionWatch {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private stored: Stored = { latest: null, checkedAt: null };
  private lastError: string | undefined;
  private timers: NodeJS.Timeout[] = [];
  private inflight: Promise<void> | null = null;

  constructor(config: CoreConfig, options: CliVersionOptions = {}) {
    this.file = join(config.dataDir, 'cli-version.json');
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stored>;
        this.stored = {
          latest: typeof saved.latest === 'string' ? saved.latest : null,
          checkedAt: typeof saved.checkedAt === 'string' ? saved.checkedAt : null,
        };
      } catch {
        // A damaged file is only a cache; the next check rewrites it
      }
    }
  }

  /** The version the image was built with, when it pinned an exact one. */
  get pinned(): string | null {
    const value = this.env.AGENTRY_CLAUDE_CODE_PINNED?.trim();
    return value && VERSION.test(value) ? value : null;
  }

  /** What the last check learned. Never touches the network. */
  info(current: string | null): CliVersionInfo {
    const { latest, checkedAt } = this.stored;
    return {
      current,
      pinned: this.pinned,
      latest,
      checkedAt,
      updateAvailable: current !== null && latest !== null && compareVersions(latest, current) > 0,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** Asks the registry now. A failure keeps the previous answer and is reported in `error`. */
  async check(): Promise<void> {
    // Two clicks, or a click during the daily check, are one request
    this.inflight ??= this.fetchLatest().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async fetchLatest(): Promise<void> {
    const url = this.env.AGENTRY_CLI_REGISTRY_URL || REGISTRY_URL;
    try {
      const res = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`the registry answered ${res.status}`);
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new Error('the registry sent no version');
      this.stored = { latest: body.version, checkedAt: new Date(this.now()).toISOString() };
      this.lastError = undefined;
      await writeAtomic(this.file, `${JSON.stringify(this.stored, null, 2)}\n`);
    } catch (err) {
      this.lastError = `Could not reach the registry: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private get stale(): boolean {
    const at = this.stored.checkedAt ? Date.parse(this.stored.checkedAt) : 0;
    return this.now() - at >= DAY_MS;
  }

  /**
   * One check a day while the wrapper runs. An air-gapped install turns it off with
   * `AGENTRY_CLI_UPDATE_CHECK=off`; the button still works there.
   */
  startDaily(): void {
    if (this.env.AGENTRY_CLI_UPDATE_CHECK === 'off' || this.timers.length > 0) return;
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
