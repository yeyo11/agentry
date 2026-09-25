import type { AgentryDistribution, AgentryReleaseInfo } from '@agentry/shared';
import type { EventBus } from './events.ts';
import type { CoreConfig } from './paths.ts';
import { VERSION, VersionCheck, compareVersions, type VersionCheckOptions } from './version-check.ts';

// `latest` never answers with a draft or a pre-release, so an edge build is never offered
const RELEASES_URL = 'https://api.github.com/repos/yeyo11/agentry/releases/latest';
const DISTRIBUTIONS: readonly AgentryDistribution[] = ['docker', 'appimage', 'deb'];

interface Stored {
  latest: string | null;
  publishedAt: string | null;
  url: string | null;
  checkedAt: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface ReleaseWatchOptions extends VersionCheckOptions {
  /** The version this server runs */
  current: string;
  /** Where `system.release` goes when a check finds a newer release */
  events?: EventBus;
}

/**
 * Whether a newer Agentry than this one has been released, for every client of this server: the
 * one check a deployment runs, so a desktop window, a browser tab and a phone all agree. GitHub is
 * asked on demand or once a day, and what it said is kept in `release.json`.
 */
export class ReleaseWatch extends VersionCheck<Stored> {
  private readonly current: string;
  private readonly events: EventBus | undefined;
  /** Seeded with what the file holds, so a restart does not announce the same release again */
  private announced: string | null;

  constructor(config: CoreConfig, options: ReleaseWatchOptions) {
    super(
      config,
      {
        file: 'release.json',
        offSwitch: 'AGENTRY_UPDATE_CHECK',
        empty: { latest: null, publishedAt: null, url: null, checkedAt: null },
        parse: (saved) => ({
          latest: text(saved.latest),
          publishedAt: text(saved.publishedAt),
          url: text(saved.url),
          checkedAt: text(saved.checkedAt),
        }),
      },
      options,
    );
    this.current = options.current;
    this.events = options.events;
    this.announced = this.stored.latest;
  }

  get distribution(): AgentryDistribution {
    const value = this.env.AGENTRY_DISTRIBUTION?.trim().toLowerCase();
    return DISTRIBUTIONS.find((d) => d === value) ?? 'source';
  }

  /** What the last check learned. Never touches the network. */
  info(): AgentryReleaseInfo {
    const { latest, publishedAt, url, checkedAt } = this.stored;
    return {
      current: this.current,
      latest,
      publishedAt,
      url,
      checkedAt,
      updateAvailable: latest !== null && compareVersions(latest, this.current) > 0,
      distribution: this.distribution,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  protected async fetchLatest(): Promise<Stored> {
    const url = this.env.AGENTRY_RELEASES_URL || RELEASES_URL;
    const res = await this.fetchFn(url, {
      // GitHub refuses a request without a user-agent
      headers: { accept: 'application/vnd.github+json', 'user-agent': `agentry/${this.current}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
    const version = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
    if (!VERSION.test(version)) throw new Error('the release has no version tag');
    return { latest: version, publishedAt: text(body.published_at), url: text(body.html_url), checkedAt: this.checkedAtIso };
  }

  protected failure(reason: string): string {
    return `Could not reach GitHub: ${reason}`;
  }

  protected afterCheck(): void {
    const release = this.info();
    const { latest } = release;
    if (latest === null || !release.updateAvailable) return;
    if (this.announced !== null && compareVersions(latest, this.announced) <= 0) return;
    this.announced = latest;
    this.events?.emit({ type: 'system.release', title: `Agentry ${latest} is available`, release });
  }
}
