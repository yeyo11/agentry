import type { ProviderCapability, ProviderId, ProviderTransport } from '@agentry/shared';
import type { GhFallback } from './gh-fallback.ts';

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
 * Where a state file lists who signed in: `list` is an array of accounts, `current` the one in use.
 * An account is an object with a `login` and, for a CLI that signs in to several hosts, a `host`.
 */
export interface ProviderSignedInUsers {
  list: string;
  current: string;
  /** The host an account belongs to when it names none; it is left out of the account's name */
  defaultHost: string;
}

/**
 * How to tell whether a provider is signed in. `file` is for a CLI whose login writes a file but
 * prints its state only for people: a JSON object with at least one key is signed in, unless
 * `users` names where the CLI lists the accounts that signed in, and then one must be listed (the
 * file holds other state too). Whole-line `//` comments are allowed: some CLIs head their state
 * file with one. `none` means the vendor documents no probe that spends nothing, so readiness for
 * that provider stays `unknown` with the reason `no-probe` instead of a guess.
 */
export type ProviderAuthProbe =
  | {
      kind: 'command';
      args: string[];
      /** How the answer reads: `json` has a boolean `loggedIn`, `exit-code` means 0 is signed in */
      result: 'json' | 'exit-code';
    }
  | { kind: 'file'; file: ProviderConfigHome; users?: ProviderSignedInUsers }
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
    /**
     * A variable of `credentialEnv` reads as signed in, not as unknowable: the vendor documents it
     * as the sign-in for programs and containers (Copilot). Without it, a variable with no state
     * file reads `no-probe`, since nothing that costs nothing says whether it is valid.
     */
    credentialEnvSignsIn?: boolean;
    /**
     * The GitHub CLI's sign-in to this host is the CLI's last documented credential source (Copilot
     * runs `gh auth token`). Detection runs the same command, with a timeout, and reads only its exit
     * code and whether it printed anything: the token itself is never kept. The host is `hostname`
     * unless one of `hostEnv` names another (GitHub Enterprise Cloud with data residency); the account
     * is the `user:` gh wrote for that host in its hosts.yml.
     */
    ghFallback?: GhFallback;
    /** The vendor's sign-in page, or its docs on signing in */
    signInUrl: string;
  };
  transport: ProviderTransport;
  /**
   * How a protocol driver starts the CLI: arguments and environment, as data. Absent for a provider
   * whose driver builds its own command line (Claude Code's `buildArgs`).
   */
  launch?: { args: string[]; env: Record<string, string>; unsetEnv: string[] };
  /** Declared capabilities; empty until the provider has a driver */
  capabilities: ProviderCapability[];
}
