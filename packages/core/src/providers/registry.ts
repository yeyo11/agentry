import type { PolicyTranslation, ProviderCapability, ProviderId, ProvidersSettings, ToolPolicy } from '@agentry/shared';
import { claudeCodeManifest } from './claude-code/manifest.ts';
import { CodexDriver } from './codex/driver.ts';
import { codexManifest } from './codex/manifest.ts';
import { copilotManifest } from './copilot/manifest.ts';
import { geminiManifest } from './gemini/manifest.ts';
import { opencodeManifest } from './opencode/manifest.ts';
import { translateClaudePolicy } from './claude-code/policy.ts';
import type { CapabilityConfirmation, ProviderDriver } from './driver.ts';
import type { ProviderManifest } from './manifest.ts';

export type { ProviderManifest } from './manifest.ts';

/** Adding a provider is adding its folder and one line here; nothing else in core names it. */
export const PROVIDER_MANIFESTS: readonly ProviderManifest[] = [
  claudeCodeManifest,
  codexManifest,
  geminiManifest,
  copilotManifest,
  opencodeManifest,
];

/**
 * A provider's policy translation, without a runtime: the flow, the assistant and the presets
 * build rules before any process exists. Each driver's `translatePolicy` is the same function.
 */
const TRANSLATIONS: Readonly<Partial<Record<ProviderId, (policy: ToolPolicy) => PolicyTranslation>>> = {
  'claude-code': translateClaudePolicy,
};

/** The pure translation for a provider; null when none is registered, so a caller refuses instead of guessing. */
export function translationFor(id: ProviderId): ((policy: ToolPolicy) => PolicyTranslation) | null {
  return TRANSLATIONS[id] ?? null;
}

/**
 * The driver class each `transport` is run by. Each driver adds its own line here, and a manifest
 * whose transport is listed gets a driver built from it.
 */
export const DRIVER_TRANSPORTS: Readonly<Partial<Record<ProviderManifest['transport'], (manifest: ProviderManifest) => ProviderDriver>>> = {
  'json-rpc': () => new CodexDriver(),
};

/** What a session's first event confirmed about a provider's installed version, and when */
export interface ProviderConfirmation extends CapabilityConfirmation {
  at: string;
}

/**
 * Manifests keyed by id. Two manifests sharing an id, or a command (which would make one binary
 * belong to two providers), throw when the registry is built, so the mistake fails at start.
 */
export class ProviderRegistry {
  private readonly byId = new Map<ProviderId, ProviderManifest>();
  private readonly drivers = new Map<ProviderId, ProviderDriver>();
  private readonly confirmations = new Map<ProviderId, ProviderConfirmation>();

  constructor(manifests: readonly ProviderManifest[] = PROVIDER_MANIFESTS, drivers: readonly ProviderDriver[] = []) {
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
    for (const driver of drivers) {
      if (!this.byId.has(driver.manifest.id)) throw new Error(`Driver for "${driver.manifest.id}" has no manifest`);
      this.drivers.set(driver.manifest.id, driver);
    }
  }

  list(): ProviderManifest[] {
    return [...this.byId.values()];
  }

  get(id: ProviderId): ProviderManifest | undefined {
    return this.byId.get(id);
  }

  /** The code half of a provider; null for one that has a manifest and no driver yet. */
  driverFor(id: ProviderId): ProviderDriver | null {
    return this.drivers.get(id) ?? null;
  }

  /**
   * Records what a session's first event confirmed. The same answer again keeps its first moment,
   * so a repeat is not a change; returns whether anything changed.
   */
  confirm(id: ProviderId, confirmation: CapabilityConfirmation, at: string): boolean {
    if (!this.byId.has(id)) return false;
    const before = this.confirmations.get(id);
    const same =
      before !== undefined &&
      before.version === confirmation.version &&
      before.confirmed.join() === confirmation.confirmed.join() &&
      before.missing.join() === confirmation.missing.join();
    if (same) return false;
    this.confirmations.set(id, { ...confirmation, at });
    return true;
  }

  confirmation(id: ProviderId): ProviderConfirmation | null {
    return this.confirmations.get(id) ?? null;
  }

  /** What a provider can do: its declared set, less what its first event contradicted */
  capabilities(id: ProviderId): ProviderCapability[] {
    const declared = this.byId.get(id)?.capabilities ?? [];
    const missing = this.confirmations.get(id)?.missing ?? [];
    return declared.filter((capability) => !missing.includes(capability));
  }

  /**
   * The provider a new chat starts with when the request names none: the person's default when it
   * can run sessions, else the first in their order that can.
   */
  defaultSessionProvider(settings: Pick<ProvidersSettings, 'order' | 'defaultProvider'>): ProviderId | null {
    const { defaultProvider } = settings;
    if (defaultProvider && this.drivers.has(defaultProvider)) return defaultProvider;
    return settings.order.find((id) => this.drivers.has(id)) ?? null;
  }
}
