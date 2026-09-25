import type { CliVersionInfo } from '@agentry/shared';
import type { CoreConfig } from './paths.ts';
import { VERSION, VersionCheck, compareVersions, type VersionCheckOptions } from './version-check.ts';

export { compareVersions } from './version-check.ts';

const REGISTRY_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

interface Stored {
  latest: string | null;
  checkedAt: string | null;
}

export type CliVersionOptions = VersionCheckOptions;

/**
 * Whether a newer Claude Code than the one in use has been published. The registry is read on
 * demand (`check`) or once a day (`startDaily`), never as a side effect of serving a page: `info`
 * only reads what the last check stored in `cli-version.json`.
 */
export class CliVersionWatch extends VersionCheck<Stored> {
  constructor(config: CoreConfig, options: CliVersionOptions = {}) {
    super(
      config,
      {
        file: 'cli-version.json',
        offSwitch: 'AGENTRY_CLI_UPDATE_CHECK',
        empty: { latest: null, checkedAt: null },
        parse: (saved) => ({
          latest: typeof saved.latest === 'string' ? saved.latest : null,
          checkedAt: typeof saved.checkedAt === 'string' ? saved.checkedAt : null,
        }),
      },
      options,
    );
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

  protected async fetchLatest(): Promise<Stored> {
    const url = this.env.AGENTRY_CLI_REGISTRY_URL || REGISTRY_URL;
    const res = await this.fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the registry answered ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new Error('the registry sent no version');
    return { latest: body.version, checkedAt: this.checkedAtIso };
  }

  protected failure(reason: string): string {
    return `Could not reach the registry: ${reason}`;
  }
}
