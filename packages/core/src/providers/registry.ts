import type { ProviderId } from '@agentry/shared';
import { claudeCodeManifest } from './claude-code/manifest.ts';
import { codexManifest } from './codex/manifest.ts';
import { copilotManifest } from './copilot/manifest.ts';
import { geminiManifest } from './gemini/manifest.ts';
import type { ProviderManifest } from './manifest.ts';

export type { ProviderManifest } from './manifest.ts';

/** Adding a provider is adding its folder and one line here; nothing else in core names it. */
export const PROVIDER_MANIFESTS: readonly ProviderManifest[] = [
  claudeCodeManifest,
  codexManifest,
  geminiManifest,
  copilotManifest,
];

/**
 * Manifests keyed by id. Two manifests sharing an id, or a command (which would make one binary
 * belong to two providers), throw when the registry is built, so the mistake fails at start.
 */
export class ProviderRegistry {
  private readonly byId = new Map<ProviderId, ProviderManifest>();

  constructor(manifests: readonly ProviderManifest[] = PROVIDER_MANIFESTS) {
    const commands = new Map<string, ProviderId>();
    for (const manifest of manifests) {
      if (this.byId.has(manifest.id)) throw new Error(`Provider id "${manifest.id}" is declared twice`);
      this.byId.set(manifest.id, manifest);
      for (const name of manifest.commands.names) {
        const owner = commands.get(name);
        if (owner) throw new Error(`Command "${name}" is claimed by both "${owner}" and "${manifest.id}"`);
        commands.set(name, manifest.id);
      }
    }
  }

  list(): ProviderManifest[] {
    return [...this.byId.values()];
  }

  get(id: ProviderId): ProviderManifest | undefined {
    return this.byId.get(id);
  }
}
