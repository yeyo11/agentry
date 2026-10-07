import { tmpdir } from 'node:os';
import type { CodeHostId, CodeHostStatus, TrackerId, TrackerReason, TrackerState, TrackerStatus, TrackersSettings } from '@agentry/shared';
import type { CodeHostAdapter, HostCall } from '../hosts/code-host.ts';
import { defaultHostRun, hostSearchPath, probeHostVersion, type HostRun, type HostRunWhere } from '../hosts/detector.ts';
import { runHostCall } from '../hosts/exec.ts';
import { parseJson } from '../hosts/json.ts';
import { resolveCommand } from '../providers/path.ts';
import { compareVersions } from '../version-check.ts';
import type { TrackerManifest } from './manifest.ts';
import { TrackerRegistry } from './registry.ts';
import type { YoutrackCredentials } from './youtrack/credentials.ts';

/** Runs a call of a tracker with a CLI of its own, with the credentials Agentry keeps for it in the child's environment */
export type OwnTrackerRun = (call: HostCall, where: HostRunWhere, secrets: Record<string, string>) => Promise<import('../hosts/exec.ts').HostResult>;

const defaultOwnRun: OwnTrackerRun = (call, where, secrets) => runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env, secretEnv: secrets });

/** The environment `youtrack-app` reads its instance and token from (recorded); `--host`/`--token` would put them in argv */
export function youtrackSecrets(credentials: YoutrackCredentials): Record<string, string> {
  return { YOUTRACK_HOST: credentials.host, YOUTRACK_TOKEN: credentials.token };
}

/** `youtrack-app --version` prints the bare version (recorded: `1.0.3`) */
const VERSION = /^v?(\d+\.\d+\.\d+)\s*$/;

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
  /** The YouTrack instance and token Agentry keeps; absent where no tracker keeps credentials */
  youtrackCredentials?: () => YoutrackCredentials | null;
  /** Runs `youtrack-app` with its credentials; the execution layer by default */
  ownRun?: OwnTrackerRun;
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
  /** What a tracker with a CLI of its own was found to be, until the next refresh: a status read spawns nothing */
  private readonly own = new Map<TrackerId, Promise<Partial<TrackerStatus> & Pick<TrackerStatus, 'state' | 'reason'>>>();

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
    this.own.clear();
    return this.derive(await this.deps.hosts.refresh());
  }

  /** The credentials of a tracker changed: only that tracker is probed again */
  async credentialsChanged(id: TrackerId): Promise<TrackerStatus[]> {
    this.own.delete(id);
    return this.statuses();
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
    if (manifest.recording === 'own') {
      const own = make('unknown', null, { minimum: manifest.minimum ?? null, recorded: [...(manifest.recorded ?? [])], user: null });
      let found = this.own.get(manifest.id);
      if (!found) {
        found = this.probeOwn(manifest, entry?.binaryPath ?? null);
        this.own.set(manifest.id, found);
      }
      return { ...own, ...(await found) };
    }
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

  /**
   * A tracker with a CLI of its own (YouTrack): the binary, its release, then whether Agentry keeps
   * an address and a token, and whether the instance takes them. The sign-in probe is the one read
   * the recordings show is cheap and says who the token is: `/api/users/me`, exit 3 for a token
   * refused or missing.
   */
  private async probeOwn(manifest: TrackerManifest, chosen: string | null): Promise<Partial<TrackerStatus> & Pick<TrackerStatus, 'state' | 'reason'>> {
    const searchPath = await (this.deps.resolvePath ? this.deps.resolvePath() : hostSearchPath(this.env, this.home));
    const binaryPath = await resolveCommand(chosen ?? manifest.cli, searchPath);
    if (!binaryPath) return { state: 'not-installed', reason: null };
    const where: HostRunWhere = { binaryPath, cwd: tmpdir(), env: { ...this.env, PATH: searchPath } };
    const run = this.deps.ownRun ?? defaultOwnRun;
    const version = await run({ cli: manifest.cli as HostCall['cli'], args: ['--version'], kind: 'read', class: 'probe', host: null }, where, {});
    if (version.reason === 'timeout' || version.exitCode === null) return { binaryPath, state: 'unknown', reason: 'timeout' };
    const parsed = version.exitCode === 0 ? VERSION.exec(version.stdout.trim()) : null;
    if (!parsed?.[1]) return { binaryPath, state: 'unknown', reason: 'probe-failed' };
    const known = { binaryPath, version: parsed[1] };
    if (manifest.minimum && compareVersions(parsed[1], manifest.minimum) < 0) return { ...known, state: 'incompatible', reason: 'below-minimum' };
    const credentials = this.deps.youtrackCredentials?.() ?? null;
    if (!credentials) return { ...known, state: 'signed-out', reason: 'no-credentials' };
    const me = await run(
      { cli: manifest.cli as HostCall['cli'], args: ['rest', 'request', '--path', '/api/users/me?fields=login'], kind: 'read', class: 'probe', host: credentials.host },
      where,
      youtrackSecrets(credentials),
    );
    if (me.reason === 'timeout' || me.exitCode === null) return { ...known, state: 'unknown', reason: 'timeout' };
    if (me.exitCode === 3) return { ...known, state: 'signed-out', reason: 'token-rejected' };
    if (me.exitCode !== 0) return { ...known, state: 'unknown', reason: 'host-unreachable' };
    let user: string | null = null;
    try {
      const body = parseJson(me.stdout);
      if (typeof body === 'object' && body !== null && typeof (body as { login?: unknown }).login === 'string') user = (body as { login: string }).login;
    } catch {
      return { ...known, state: 'unknown', reason: 'probe-failed' };
    }
    return { ...known, state: 'ready', reason: null, user };
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
