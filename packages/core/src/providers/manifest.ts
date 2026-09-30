import type { ProviderCapability, ProviderId, ProviderTransport } from '@agentry/shared';

/** A directory a provider keeps its state in, and the variable that moves it. */
export interface ProviderConfigHome {
  /** Default location, `~` standing for the person's home directory */
  default: string;
  /** The variable that relocates it; null when the CLI has none */
  env: string | null;
  /** When set, the variable names the *parent* of the directory and this is the folder inside it */
  insideEnv?: string;
}

/**
 * How to tell whether a provider is signed in. `none` means the vendor documents no probe that
 * spends nothing, so readiness for that provider stays `unknown` with the reason `no-probe`
 * instead of a guess.
 */
export type ProviderAuthProbe =
  | {
      kind: 'command';
      args: string[];
      /** How the answer reads: `json` has a boolean `loggedIn`, `exit-code` means 0 is signed in */
      result: 'json' | 'exit-code';
    }
  | { kind: 'none' };

/**
 * The data half of a provider: everything detection needs and nothing that runs. One per folder in
 * `providers/<id>/manifest.ts`; the registry is the only place that lists them.
 */
export interface ProviderManifest {
  id: ProviderId;
  label: string;
  vendor: string;
  homepage: string;
  commands: {
    /** The binary name, then its aliases */
    names: string[];
    /** Other commands that must be on the PATH for this one to run */
    requires: string[];
    unsupportedPlatforms: NodeJS.Platform[];
  };
  configHomes: ProviderConfigHome[];
  versions: {
    /** Arguments that print the version */
    args: string[];
    /** The semver range the driver is tested against; null while no driver exists to test */
    range: string | null;
  };
  install: {
    /** The vendor's install page: Agentry links to it and never runs an install */
    url: string;
  };
  auth: {
    probe: ProviderAuthProbe;
    /** Environment variables that supply credentials without a login */
    credentialEnv: string[];
    /** The vendor's sign-in page, or its docs on signing in */
    signInUrl: string;
  };
  transport: ProviderTransport;
  /** Declared capabilities; empty until the provider has a driver */
  capabilities: ProviderCapability[];
}
