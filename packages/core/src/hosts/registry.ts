import type { CodeHostId } from '@agentry/shared';
import { githubManifest } from './github/manifest.ts';
import { gitlabManifest } from './gitlab/manifest.ts';
import type { CodeHostManifest } from './manifest.ts';

export type { CodeHostManifest } from './manifest.ts';

/** Adding a host is adding its folder and one line here; nothing else in core names it. */
export const CODE_HOST_MANIFESTS: readonly CodeHostManifest[] = [githubManifest, gitlabManifest];

/**
 * Manifests keyed by id. Two manifests sharing an id, a CLI (one binary would belong to two hosts)
 * or a default host (a hostname would resolve to two) throw when the registry is built, so the
 * mistake fails at start.
 */
export class CodeHostRegistry {
  private readonly byId = new Map<CodeHostId, CodeHostManifest>();

  constructor(manifests: readonly CodeHostManifest[] = CODE_HOST_MANIFESTS) {
    const clis = new Map<string, CodeHostId>();
    const hosts = new Map<string, CodeHostId>();
    for (const manifest of manifests) {
      if (this.byId.has(manifest.id)) throw new Error(`Code host id "${manifest.id}" is declared twice`);
      this.byId.set(manifest.id, manifest);
      const cliOwner = clis.get(manifest.cli);
      if (cliOwner) throw new Error(`CLI "${manifest.cli}" is claimed by both "${cliOwner}" and "${manifest.id}"`);
      clis.set(manifest.cli, manifest.id);
      for (const host of manifest.defaultHosts) {
        const hostOwner = hosts.get(host);
        if (hostOwner) throw new Error(`Host "${host}" is claimed by both "${hostOwner}" and "${manifest.id}"`);
        hosts.set(host, manifest.id);
      }
    }
  }

  list(): CodeHostManifest[] {
    return [...this.byId.values()];
  }

  get(id: CodeHostId): CodeHostManifest | undefined {
    return this.byId.get(id);
  }

  /** The host whose manifest names this hostname by default, compared case-insensitively. */
  byDefaultHost(hostname: string): CodeHostManifest | undefined {
    const wanted = hostname.toLowerCase();
    return this.list().find((manifest) => manifest.defaultHosts.includes(wanted));
  }
}
