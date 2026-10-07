import type { CodeHostId, TrackerId } from '@agentry/shared';
import { githubIssuesManifest } from './github-issues/manifest.ts';
import { gitlabIssuesManifest } from './gitlab-issues/manifest.ts';
import type { TrackerManifest } from './manifest.ts';
import { youtrackManifest } from './youtrack/manifest.ts';

export type { TrackerManifest } from './manifest.ts';

/** Adding a tracker is adding its folder and one line here; nothing else in core names it. */
export const TRACKER_MANIFESTS: readonly TrackerManifest[] = [githubIssuesManifest, gitlabIssuesManifest, youtrackManifest];

/**
 * Manifests keyed by id. Two manifests sharing an id, or two reusing the same code host (one host's
 * issues would have two trackers), throw when the registry is built, so the mistake fails at start.
 */
export class TrackerRegistry {
  private readonly byId = new Map<TrackerId, TrackerManifest>();

  constructor(manifests: readonly TrackerManifest[] = TRACKER_MANIFESTS) {
    const hosts = new Map<CodeHostId, TrackerId>();
    for (const manifest of manifests) {
      if (this.byId.has(manifest.id)) throw new Error(`Tracker id "${manifest.id}" is declared twice`);
      this.byId.set(manifest.id, manifest);
      if (manifest.host === null) continue;
      const owner = hosts.get(manifest.host);
      if (owner) throw new Error(`Code host "${manifest.host}" is reused by both "${owner}" and "${manifest.id}"`);
      hosts.set(manifest.host, manifest.id);
    }
  }

  list(): TrackerManifest[] {
    return [...this.byId.values()];
  }

  get(id: TrackerId): TrackerManifest | undefined {
    return this.byId.get(id);
  }

  /** The tracker that lives on a code host (its own issues), if any. */
  ofHost(host: CodeHostId): TrackerManifest | undefined {
    return this.list().find((manifest) => manifest.host === host);
  }

  /**
   * Whether a project whose code host is `projectHost` can use this tracker: a host's tracker needs
   * that very host; a tracker with its own CLI works on any project, including one with no host.
   */
  fitsProject(id: TrackerId, projectHost: CodeHostId | null): boolean {
    const manifest = this.byId.get(id);
    if (!manifest) return false;
    return manifest.host === null || manifest.host === projectHost;
  }
}
