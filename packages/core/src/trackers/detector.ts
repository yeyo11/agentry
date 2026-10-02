import { tmpdir } from 'node:os';
import type { CodeHostId, CodeHostStatus, TrackerId, TrackerReason, TrackerState, TrackerStatus, TrackersSettings } from '@agentry/shared';
import type { CodeHostAdapter } from '../hosts/code-host.ts';
import { defaultHostRun, hostSearchPath, probeHostVersion, type HostRun, type HostRunWhere } from '../hosts/detector.ts';
import { resolveCommand } from '../providers/path.ts';
import { compareVersions } from '../version-check.ts';
import type { TrackerManifest } from './manifest.ts';
import { TrackerRegistry } from './registry.ts';

export interface TrackerDetectorDeps {
  registry?: TrackerRegistry;
  /** The code hosts' detector: a host's tracker reads its CLI, release and sign-in from there */
  hosts: {
    statuses(): Promise<CodeHostStatus[]>;
    refresh(): Promise<CodeHostStatus[]>;
  };
  /** The adapter of a host, to read the version of a binary the person chose for its tracker */
  adapter: (id: CodeHostId) => CodeHostAdapter | undefined;
  /** What the person chose; null (or a missing entry) means every tracker is on, using its host's binary */
  settings?: () => TrackersSettings | null;
  run?: HostRun;
  /** The PATH to search; defaults to the current one plus the install directories */
  resolvePath?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
}

/**
 * Says, for each tracker, whether it is ready on this machine. A tracker on a code host has no
 * detection of its own: it is the host's CLI and the host's sign-in, so its status is derived from
 * the host detector's cache and changes when that does (`hosts.changed`). Only a binary the person
 * chose for the tracker is probed here, for its version. A tracker whose CLI nobody recorded is
 * `unknown` with the reason `not-recorded` and is never probed.
 */
export class TrackerDetector {
  private readonly registry: TrackerRegistry;
  private readonly run: HostRun;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly now: () => number;
  /** The version read from a chosen binary, by path, so a status read does not spawn it every time */
  private readonly overrides = new Map<string, Awaited<ReturnType<typeof probeHostVersion>>>();

  constructor(private readonly deps: TrackerDetectorDeps) {
    this.registry = deps.registry ?? new TrackerRegistry();
    this.run = deps.run ?? defaultHostRun;
    this.env = deps.env ?? process.env;
    this.home = deps.home ?? (this.env.HOME ?? '');
    this.now = deps.now ?? Date.now;
  }

  async statuses(): Promise<TrackerStatus[]> {
    return this.derive(await this.deps.hosts.statuses());
  }

  async status(id: TrackerId): Promise<TrackerStatus | null> {
    return (await this.statuses()).find((status) => status.id === id) ?? null;
  }

  /** Detects the hosts again, then derives: a refresh of the trackers is a refresh of their CLIs. */
  async refresh(): Promise<TrackerStatus[]> {
    this.overrides.clear();
    return this.derive(await this.deps.hosts.refresh());
  }

  /** The settings changed: a tracker may have been turned off or given a binary of its own */
  settingsChanged(): Promise<TrackerStatus[]> {
    return this.refresh();
  }

  private async derive(hosts: CodeHostStatus[]): Promise<TrackerStatus[]> {
    const settings = this.deps.settings?.() ?? null;
    const checkedAt = new Date(this.now()).toISOString();
    return Promise.all(this.registry.list().map((manifest) => this.deriveOne(manifest, hosts, settings, checkedAt)));
  }

  private async deriveOne(manifest: TrackerManifest, hosts: CodeHostStatus[], settings: TrackersSettings | null, checkedAt: string): Promise<TrackerStatus> {
    const entry = settings?.trackers[manifest.id];
    const hostStatus = manifest.host ? hosts.find((host) => host.id === manifest.host) : undefined;
    const make = (state: TrackerState, reason: TrackerReason | null, extra: Partial<TrackerStatus> = {}): TrackerStatus => ({
      id: manifest.id,
      label: manifest.label,
      cli: manifest.cli,
      host: manifest.host,
      binaryPath: null,
      version: null,
      minimum: hostStatus?.minimum ?? null,
      recorded: hostStatus ? [...hostStatus.recorded] : [],
      state,
      reason,
      checkedAt,
      ...extra,
    });

    // Nothing was recorded for this CLI: not even a binary search, so nothing is built on a guess
    if (manifest.recording === null) return make('unknown', 'not-recorded');
    // Turned off is `unknown` with no reason: the person chose it, nothing is wrong
    if (entry && !entry.enabled) return make('unknown', null);
    // The host detector has not seen this host (or has it off): the tracker cannot be told apart from it
    if (!hostStatus) return make('unknown', 'probe-failed');

    const hostBinary = { binaryPath: hostStatus.binaryPath, version: hostStatus.version };
    const fromHost = (extra: Partial<TrackerStatus> = {}): TrackerStatus => {
      switch (hostStatus.state) {
        case 'ready':
        case 'degraded':
          return make('ready', null, extra);
        case 'signed-out':
          return make('signed-out', hostStatus.reason, extra);
        case 'incompatible':
          return make('incompatible', hostStatus.reason, extra);
        case 'not-installed':
          return make('not-installed', hostStatus.reason, extra);
        default:
          return make('unknown', hostStatus.reason, extra);
      }
    };

    if (!entry?.binaryPath) return fromHost(hostBinary);
    return this.withOwnBinary(manifest, entry.binaryPath, make, fromHost);
  }

  /** A binary the person chose for the tracker: its version is read; the sign-in is the CLI's own and comes from the host. */
  private async withOwnBinary(
    manifest: TrackerManifest,
    chosen: string,
    make: (state: TrackerState, reason: TrackerReason | null, extra?: Partial<TrackerStatus>) => TrackerStatus,
    fromHost: (extra?: Partial<TrackerStatus>) => TrackerStatus,
  ): Promise<TrackerStatus> {
    const searchPath = await (this.deps.resolvePath ? this.deps.resolvePath() : hostSearchPath(this.env, this.home));
    const binaryPath = await resolveCommand(chosen, searchPath);
    if (!binaryPath) return make('not-installed', null);
    const adapter = manifest.host ? this.deps.adapter(manifest.host) : undefined;
    if (!adapter) return make('unknown', 'probe-failed', { binaryPath });

    let version = this.overrides.get(binaryPath);
    if (!version) {
      const where: HostRunWhere = { binaryPath, cwd: tmpdir(), env: { ...this.env, PATH: searchPath } };
      version = await probeHostVersion(adapter, this.run, where);
      this.overrides.set(binaryPath, version);
    }
    if (version.kind === 'timeout') return make('unknown', 'timeout', { binaryPath });
    if (version.kind !== 'ok') return make('unknown', 'probe-failed', { binaryPath });
    const known = { binaryPath, version: version.version };
    const minimum = make('ready', null).minimum;
    if (minimum && compareVersions(version.version, minimum) < 0) return make('incompatible', 'below-minimum', known);
    return fromHost(known);
  }
}
