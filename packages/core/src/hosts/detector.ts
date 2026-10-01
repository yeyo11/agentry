import { statSync, watch, type FSWatcher } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname } from 'node:path';
import type { CodeHostHostEntry, CodeHostId, CodeHostReason, CodeHostState, CodeHostStatus, CodeHostsSettings } from '@agentry/shared';
import type { AgentryEventInput } from '../events.ts';
import { installDirs, resolveCommand } from '../providers/path.ts';
import { compareVersions } from '../version-check.ts';
import type { CodeHostAdapter } from './code-host.ts';
import { runHostCall, type HostCall, type HostResult } from './exec.ts';
import { glabConfigCandidates, glabKnownHosts, type GlabKnownHost } from './known-hosts.ts';
import type { CodeHostManifest } from './manifest.ts';
import { CodeHostRegistry } from './registry.ts';

/** What a detection saw is served until it is this old: the providers' TTL */
export const HOSTS_TTL_MS = 5 * 60 * 1000;
/** Installing or signing in touches several files at once: wait for the burst to end */
export const HOSTS_WATCH_DEBOUNCE_MS = 1_500;
/** A busy config directory must not turn into a detection per write */
export const HOSTS_WATCH_MIN_GAP_MS = 10_000;

/** Where one call runs: the resolved binary, a directory that exists, and the environment to start from. */
export interface HostRunWhere {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Runs a call; injected so tests run a stub, and the default is the execution layer's. */
export type HostRun = (call: HostCall, where: HostRunWhere) => Promise<HostResult>;

export const defaultHostRun: HostRun = (call, where) => runHostCall(call, { binaryPath: where.binaryPath, cwd: where.cwd, baseEnv: where.env });

export type VersionProbe =
  | { kind: 'ok'; version: string }
  | { kind: 'unreadable' }
  | { kind: 'timeout' }
  | { kind: 'failed'; detail: string | null };

/** The version of a CLI, from the adapter's call and parser; a probe that did not answer says why. */
export async function probeHostVersion(adapter: CodeHostAdapter, run: HostRun, where: HostRunWhere): Promise<VersionProbe> {
  const result = await run(adapter.version(), where);
  if (result.reason === 'timeout') return { kind: 'timeout' };
  if (result.exitCode !== 0) return { kind: 'failed', detail: result.stderrFirstLine || null };
  const version = adapter.parseVersion(result.stdout);
  return version ? { kind: 'ok', version } : { kind: 'unreadable' };
}

/** The binary of a host: the person's override, else the CLI's name on the search path. */
export async function resolveHostBinary(manifest: CodeHostManifest, override: string | null, searchPath: string): Promise<string | undefined> {
  return resolveCommand(override ?? manifest.cli, searchPath);
}

/** The PATH to search: the current one plus the install directories, as the providers do. */
export async function hostSearchPath(env: NodeJS.ProcessEnv, home: string): Promise<string> {
  const dirs = [...(env.PATH ?? '').split(delimiter), ...(await installDirs(env, home))];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

/** The host names of `gh auth status --json hosts`; null when the output is not that shape. */
export function hostnamesOfAuthJson(stdout: string): string[] | null {
  try {
    const json: unknown = JSON.parse(stdout);
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
    const hosts = (json as { hosts?: unknown }).hosts;
    if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) return null;
    return Object.keys(hosts).map((name) => name.toLowerCase());
  } catch {
    return null;
  }
}

export interface CodeHostDetectorDeps {
  registry?: CodeHostRegistry;
  /** The adapter of a host; a host without one cannot be probed and reads `unknown` */
  adapter: (id: CodeHostId) => CodeHostAdapter | undefined;
  /** What the person chose; null (or a missing entry) means every host is on, searching for its binary */
  settings?: () => CodeHostsSettings | null;
  emit?: (event: AgentryEventInput) => unknown;
  run?: HostRun;
  /** The hosts glab's own configuration lists; defaults to reading its `config.yml` */
  glabHosts?: () => Promise<GlabKnownHost[]>;
  /** The PATH to search; defaults to the current one plus the install directories */
  resolvePath?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  ttlMs?: number;
  debounceMs?: number;
  minWatchGapMs?: number;
}

/** Two statuses that differ only by the moment they were read are the same status */
function sameStatus(a: CodeHostStatus, b: CodeHostStatus): boolean {
  return JSON.stringify({ ...a, checkedAt: '' }) === JSON.stringify({ ...b, checkedAt: '' });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds every code host's CLI on this machine and says, for each, whether it is ready, which hosts
 * it knows and who is signed in to them. The same shape as the provider detector, with its own
 * cache, TTL and watchers: a probe reads a version or asks a login status and never touches a
 * repository. `hosts.changed` goes out only when a status really differs from the last one.
 *
 * A project's readiness does not read this cache: it runs its own probes (hosts/readiness.ts), so
 * the calls a CLI receives for a project are the same every time.
 */
export class CodeHostDetector {
  private readonly registry: CodeHostRegistry;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly debounceMs: number;
  private readonly minWatchGapMs: number;
  private readonly run: HostRun;

  private cache: { at: number; statuses: Map<CodeHostId, CodeHostStatus> } | null = null;
  private pending: Promise<CodeHostStatus[]> | null = null;
  private pendingJoinable = false;
  private followUp: Promise<CodeHostStatus[]> | null = null;
  private watchers = new Map<string, FSWatcher>();
  private watching = false;
  private timer: NodeJS.Timeout | null = null;
  private lastWatchRun = 0;
  private closed = false;

  constructor(private readonly deps: CodeHostDetectorDeps) {
    this.registry = deps.registry ?? new CodeHostRegistry();
    this.env = deps.env ?? process.env;
    this.home = deps.home ?? homedir();
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? HOSTS_TTL_MS;
    this.debounceMs = deps.debounceMs ?? HOSTS_WATCH_DEBOUNCE_MS;
    this.minWatchGapMs = deps.minWatchGapMs ?? HOSTS_WATCH_MIN_GAP_MS;
    this.run = deps.run ?? defaultHostRun;
  }

  /** What the last detection saw, whatever its age, without starting one; null before the first */
  known(): CodeHostStatus[] | null {
    return this.cache ? this.ordered([...this.cache.statuses.values()]) : null;
  }

  /** Every status from the cache. The first call waits for a detection; an older answer is served while its replacement is on its way. */
  async statuses(): Promise<CodeHostStatus[]> {
    if (!this.cache) return this.pending ?? this.refresh();
    if (this.now() - this.cache.at > this.ttlMs) void this.refresh().catch(() => undefined);
    return this.known() ?? [];
  }

  async status(id: CodeHostId): Promise<CodeHostStatus | null> {
    return (await this.statuses()).find((status) => status.id === id) ?? null;
  }

  /** Detects now. Asked while one is running, the answer is a detection that starts after it, shared by everyone who asks meanwhile. */
  refresh(): Promise<CodeHostStatus[]> {
    if (this.pending) {
      // Asked in the same tick, the running detection has not read anything yet and answers both.
      // Asked later, a login may have happened since it read the files
      if (this.pendingJoinable) return this.pending;
      this.followUp ??= this.pending
        .catch(() => undefined)
        .then(() => {
          this.followUp = null;
          return this.refresh();
        });
      return this.followUp;
    }
    const run = this.detect().finally(() => {
      if (this.pending === run) this.pending = null;
    });
    this.pending = run;
    this.pendingJoinable = true;
    queueMicrotask(() => {
      if (this.pending === run) this.pendingJoinable = false;
    });
    return run;
  }

  /** The settings changed: a host may have been turned on or off, or given a binary of its own */
  settingsChanged(): Promise<CodeHostStatus[]> {
    return this.refresh();
  }

  /** Watches the PATH directories and the CLIs' config directories; a change re-detects after it settles */
  async startWatching(): Promise<void> {
    this.watching = true;
    await this.arm();
  }

  close(): void {
    this.closed = true;
    this.watching = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private ordered(statuses: CodeHostStatus[]): CodeHostStatus[] {
    const rank = (id: CodeHostId): number => this.registry.list().findIndex((m) => m.id === id);
    return [...statuses].sort((a, b) => rank(a.id) - rank(b.id));
  }

  private async searchPath(): Promise<string> {
    return this.deps.resolvePath ? this.deps.resolvePath() : hostSearchPath(this.env, this.home);
  }

  private async detect(): Promise<CodeHostStatus[]> {
    const settings = this.deps.settings?.() ?? null;
    const searchPath = await this.searchPath();
    const read = await Promise.all(this.registry.list().map((manifest) => this.detectOne(manifest, settings, searchPath)));

    const before = this.cache?.statuses;
    this.cache = { at: this.now(), statuses: new Map(read.map((status) => [status.id, status])) };
    // The first reading is not a change: nobody has seen a status yet, and `GET` serves it
    const changed = before !== undefined && before.size > 0 && read.some((status) => {
      const old = before.get(status.id);
      return !old || !sameStatus(old, status);
    });
    const all = this.known() ?? [];
    if (changed) this.deps.emit?.({ type: 'hosts.changed', title: 'Code hosts changed', hosts: all });
    if (this.watching && !this.closed) await this.arm();
    return all;
  }

  private async detectOne(manifest: CodeHostManifest, settings: CodeHostsSettings | null, searchPath: string): Promise<CodeHostStatus> {
    const entry = settings?.hosts[manifest.id];
    const make = (state: CodeHostState, reason: CodeHostReason | null, extra: Partial<CodeHostStatus> = {}): CodeHostStatus => ({
      id: manifest.id,
      label: manifest.label,
      cli: manifest.cli,
      binaryPath: null,
      version: null,
      minimum: manifest.versions.minimum,
      recorded: [...manifest.versions.recorded],
      state,
      reason,
      hosts: [],
      checkedAt: new Date(this.now()).toISOString(),
      ...extra,
    });

    // Turned off is `unknown` with no reason: the person chose it, nothing is wrong
    if (entry && !entry.enabled) return make('unknown', null);
    const binaryPath = await resolveHostBinary(manifest, entry?.binaryPath ?? null, searchPath);
    if (!binaryPath) return make('not-installed', null);
    const adapter = this.deps.adapter(manifest.id);
    if (!adapter) return make('unknown', 'probe-failed', { binaryPath });

    const where: HostRunWhere = { binaryPath, cwd: tmpdir(), env: { ...this.env, PATH: searchPath } };
    const version = await probeHostVersion(adapter, this.run, where);
    if (version.kind === 'timeout') return make('unknown', 'timeout', { binaryPath });
    if (version.kind !== 'ok') return make('unknown', 'probe-failed', { binaryPath });
    const known = { binaryPath, version: version.version };
    if (compareVersions(version.version, manifest.versions.minimum) < 0) return make('incompatible', 'below-minimum', known);

    const hosts = await this.probeHosts(manifest, adapter, where);
    if (hosts === 'timeout' || hosts === 'failed') return make('unknown', hosts === 'timeout' ? 'timeout' : 'probe-failed', known);
    const untested = manifest.versions.untested === 'degraded' && !manifest.versions.recorded.includes(version.version);
    const withHosts = { ...known, hosts: hosts.entries };
    if (!hosts.entries.some((host) => host.signedIn)) return make('signed-out', hosts.listed ? null : 'no-hosts', withHosts);
    return untested ? make('degraded', 'version-untested', withHosts) : make('ready', null, withHosts);
  }

  /**
   * Every host the CLI knows, with who is signed in: the default hosts always, so a person who has
   * not signed in to `github.com` yet still sees it. `listed` says whether the CLI itself named any
   * host, which is what tells "never signed in" from "signed in nowhere".
   */
  private async probeHosts(
    manifest: CodeHostManifest,
    adapter: CodeHostAdapter,
    where: HostRunWhere,
  ): Promise<{ entries: CodeHostHostEntry[]; listed: boolean } | 'timeout' | 'failed'> {
    const users = new Map<string, string | null>();
    let names: string[];
    let probed: Map<string, { signedIn: boolean; user: string | null }>;

    if (manifest.auth.kind === 'hosts-json') {
      // One call answers for every host
      const first = manifest.defaultHosts[0] ?? '';
      const result = await this.run(adapter.authStatus(first), where);
      if (result.reason === 'timeout') return 'timeout';
      if (result.exitCode !== 0) return 'failed';
      const listed = hostnamesOfAuthJson(result.stdout);
      if (!listed) return 'failed';
      names = listed;
      probed = new Map(listed.map((name) => [name, adapter.parseAuth(result, name)]));
    } else {
      const file = this.deps.glabHosts ? await this.deps.glabHosts() : await glabKnownHosts({ env: this.env, home: this.home });
      for (const host of file) users.set(host.hostname, host.user);
      names = file.map((host) => host.hostname);
      probed = new Map();
      // Only a host the CLI lists is asked about: an unknown one would be sent to glab for nothing
      for (const name of names) {
        const result = await this.run(adapter.authStatus(name), where);
        if (result.reason === 'timeout') return 'timeout';
        probed.set(name, adapter.parseAuth(result, name));
      }
    }

    const all = [...new Set([...manifest.defaultHosts, ...names])];
    const entries = all.map((hostname): CodeHostHostEntry => {
      const found = probed.get(hostname);
      return {
        hostname,
        default: manifest.defaultHosts.includes(hostname),
        signedIn: found ? found.signedIn : false,
        user: found?.user ?? users.get(hostname) ?? null,
      };
    });
    return { entries, listed: names.length > 0 };
  }

  /**
   * (Re)opens one watcher per directory that matters. A directory that does not exist yet, a config
   * directory before its first sign-in, is watched through its parent, filtered to its own name.
   */
  private async arm(): Promise<void> {
    const wanted = new Map<string, Set<string> | null>();
    const add = (dir: string, names: Set<string> | null): void => {
      const seen = wanted.get(dir);
      if (seen === undefined) wanted.set(dir, names);
      else wanted.set(dir, seen && names ? new Set([...seen, ...names]) : null);
    };
    const commands = new Set(this.registry.list().map((m) => m.cli));
    for (const dir of (await this.searchPath()).split(delimiter)) {
      if (dir && isDirectory(dir)) add(dir, commands);
    }
    for (const home of this.configDirs()) {
      if (isDirectory(home)) add(home, null);
      else add(dirname(home), new Set([basename(home)]));
    }
    for (const [dir, watcher] of this.watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    for (const [dir, names] of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (_kind, file) => {
          if (names && file && !names.has(String(file))) return;
          this.touched();
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // A directory that cannot be watched (permissions, limits) is covered by the TTL and Refresh
      }
    }
  }

  /** The CLIs' own configuration directories; glab's has three possible places, all watched */
  private configDirs(): string[] {
    const dirs: string[] = [];
    for (const manifest of this.registry.list()) {
      const { env, default: fallback } = manifest.configHome;
      const value = env ? this.env[env] : undefined;
      dirs.push(value || fallback.replace(/^~(?=$|\/)/, this.home));
      // The CLI whose hosts live in a file of its own can keep that file in any of three places
      if (manifest.auth.kind === 'exit-code') dirs.push(...glabConfigCandidates({ env: this.env, home: this.home }).map((file) => dirname(file)));
    }
    return [...new Set(dirs)];
  }

  private touched(): void {
    if (this.closed || this.timer) return;
    const wait = Math.max(this.debounceMs, this.lastWatchRun + this.minWatchGapMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastWatchRun = this.now();
      void this.refresh().catch(() => undefined);
    }, wait);
    this.timer.unref();
  }
}
