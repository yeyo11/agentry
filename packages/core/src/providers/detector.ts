import { execFile } from 'node:child_process';
import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import type {
  AuthStatus,
  CliInfo,
  ModelOption,
  PermissionMode,
  ProviderCapability,
  ProviderId,
  ProviderReasonCode,
  ProviderReadinessState,
  ProviderStatus,
  ProvidersSettings,
} from '@agentry/shared';
import { detectCli, getAuthStatus } from '../cli.ts';
import type { AgentryEventInput } from '../events.ts';
import type { CoreConfig } from '../paths.ts';
import { compareVersions } from '../version-check.ts';
import { ProviderCatalogsStore } from './catalogs.ts';
import { ClaudeCodeDriver } from './claude-code/driver.ts';
import type { CapabilityConfirmation, HandshakeResult, ProviderDriver } from './driver.ts';
import type { ProviderConfigHome, ProviderManifest } from './manifest.ts';
import { installDirs, resolveCommand } from './path.ts';
import { limitAt, type HandshakeLimits, type ProviderLimits } from './limits.ts';
import { DRIVER_TRANSPORTS, ProviderRegistry } from './registry.ts';

/** One TTL for every provider: what a detection saw is served until it is this old */
export const PROVIDERS_TTL_MS = 5 * 60 * 1000;
/** Each probe (version, auth) has its own clock, so one stuck binary cannot hold the others */
export const PROBE_TIMEOUT_MS = 10_000;
/** Installing or signing in touches several files at once: wait for the burst to end */
export const WATCH_DEBOUNCE_MS = 1_500;
/** A busy config home (a chat writing its history) must not turn into a detection per write */
export const WATCH_MIN_GAP_MS = 10_000;

/** What Claude Code's two probes read: the shape `detectCli` and `getAuthStatus` return */
export interface ClaudeReading {
  cli: CliInfo;
  auth: AuthStatus;
}

export interface ProviderDetectorDeps {
  /** Its `claudeBin` and `configDir` feed the Claude Code probes */
  config: CoreConfig;
  registry?: ProviderRegistry;
  /** What the person chose; null (or a missing entry) means every provider is on, searching for its binary */
  settings?: () => ProvidersSettings | null;
  emit?: (event: AgentryEventInput) => unknown;
  /**
   * Where Claude Code's reading comes from. Core passes its shared system read, so the CLI is not
   * spawned twice for the same question; without it the probes run `detectCli` and `getAuthStatus`.
   * Ignored when the person pointed at a binary of their own, which that read knows nothing of.
   */
  readClaude?: () => Promise<ClaudeReading>;
  /**
   * Where each provider's usage limit is read from and kept. A provider that has reached or neared
   * its limit is `degraded` while it lasts, and a handshake that read the limits records them here.
   */
  limits?: ProviderLimits;
  /** Where the models a handshake listed are kept between runs; defaults to `provider-catalogs.json` in the data directory */
  catalogs?: ProviderCatalogsStore;
  /** Extra command names tried before a manifest's own, per provider (Claude Code's `CLAUDE_BIN`) */
  commandAliases?: Record<ProviderId, string[]>;
  /** The PATH to search; defaults to the current one plus the install directories */
  resolvePath?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  ttlMs?: number;
  probeTimeoutMs?: number;
  debounceMs?: number;
  minWatchGapMs?: number;
}

type VersionProbe =
  | { kind: 'ok'; version: string }
  | { kind: 'unreadable' }
  | { kind: 'timeout' }
  | { kind: 'denied' }
  | { kind: 'failed' };

type AuthProbe =
  | { kind: 'ok'; account: string | null }
  | { kind: 'signed-out' }
  | { kind: 'timeout' }
  | { kind: 'denied' }
  | { kind: 'failed' }
  | { kind: 'none' };

/** What one handshake saw, kept for the binary and version it was read from: a handshake is not repeated every TTL */
type HandshakeEntry = { at: number; result: HandshakeResult } | { at: number; failed: true };

/** What a detection learns from a driver, beyond the probes: modes, and the handshake's reading when the driver has one */
interface DriverReading {
  permissionModes: PermissionMode[];
  handshake: HandshakeResult | null;
}

interface Exec {
  outcome: 'done' | 'timeout' | 'denied' | 'failed';
  code: number;
  stdout: string;
}

const VERSION_TEXT = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** Whether `version` is inside a range of space-separated comparators (`>=2.1 <3`); an empty range holds every version */
export function satisfiesRange(version: string, range: string): 'in' | 'below' | 'above' {
  for (const term of range.split(/\s+/).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(term);
    if (!match) continue;
    const op = match[1] ?? '=';
    const diff = compareVersions(version, match[2] ?? '0');
    if ((op === '>=' && diff < 0) || (op === '>' && diff <= 0)) return 'below';
    if ((op === '<' && diff >= 0) || (op === '<=' && diff > 0)) return 'above';
    if (op === '=') {
      if (diff < 0) return 'below';
      if (diff > 0) return 'above';
    }
  }
  return 'in';
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A credentials file a CLI's login writes: absent or an empty object is signed out, a JSON object
 * with a key is signed in, and anything else is a file we cannot read rather than a missing login.
 */
function readCredentialsFile(path: string): AuthProbe {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'signed-out' };
    return code === 'EACCES' || code === 'EPERM' ? { kind: 'denied' } : { kind: 'failed' };
  }
  try {
    const json: unknown = JSON.parse(text);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return { kind: 'failed' };
    return Object.keys(json).length > 0 ? { kind: 'ok', account: null } : { kind: 'signed-out' };
  } catch {
    return { kind: 'failed' };
  }
}

/** Two statuses that differ only by the moment they were read are the same status */
function sameStatus(a: ProviderStatus, b: ProviderStatus): boolean {
  return JSON.stringify({ ...a, checkedAt: '' }) === JSON.stringify({ ...b, checkedAt: '' });
}

/**
 * Finds every provider on this host and says, for each, whether it is ready and why not: the one
 * place that answers, shared by the server, the desktop app and the Docker image. Nothing here
 * spends tokens or quota: a probe reads a version or asks a login status, and never starts a chat.
 *
 * Results live in one cache with one TTL. A refresh, a settings change or a change on the PATH
 * directories or config homes re-detects, and `providers.changed` is emitted only when a status
 * actually differs, so nobody presses Refresh after installing or signing in.
 */
export class ProviderDetector {
  private readonly registry: ProviderRegistry;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly probeTimeoutMs: number;
  private readonly debounceMs: number;
  private readonly minWatchGapMs: number;

  /** `full` is false while only some providers were read (Claude Code's, fed by Core's system read) */
  private cache: { at: number; full: boolean; statuses: Map<ProviderId, ProviderStatus> } | null = null;
  /**
   * Whether the last auth probe found each provider signed in. A status cannot say it for an
   * incompatible version (that state wins over `signed-out`), and `/health` still has to.
   */
  private readonly signedIn = new Map<ProviderId, boolean>();
  private readonly catalogs: ProviderCatalogsStore;
  /** Keyed by provider, binary and version: a new version or another binary is read again */
  private readonly handshakes = new Map<string, HandshakeEntry>();
  private pending: Promise<ProviderStatus[]> | null = null;
  private pendingJoinable = false;
  private followUp: Promise<ProviderStatus[]> | null = null;
  /** Bumped by every detection that starts, so an older one that finishes late never overwrites a newer */
  private seq = 0;
  private readonly applied = new Map<ProviderId, number>();
  private watchers = new Map<string, FSWatcher>();
  private watching = false;
  private timer: NodeJS.Timeout | null = null;
  private lastWatchRun = 0;
  private closed = false;

  constructor(private readonly deps: ProviderDetectorDeps) {
    this.registry = deps.registry ?? new ProviderRegistry();
    this.env = deps.env ?? process.env;
    this.home = deps.home ?? homedir();
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? PROVIDERS_TTL_MS;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.minWatchGapMs = deps.minWatchGapMs ?? WATCH_MIN_GAP_MS;
    this.catalogs = deps.catalogs ?? new ProviderCatalogsStore(deps.config);
    if (deps.limits) this.useLimits(deps.limits);
    // The models of the last run serve until this run's handshake has read them again
    for (const manifest of this.registry.list()) {
      const cached = this.catalogs.get(manifest.id);
      if (cached) this.giveCatalog(manifest.id, cached.models);
    }
  }

  /**
   * Where the limits are read from. Core builds the detector before the runtime that keeps them, so
   * it hands them over here once they exist; without them no status carries its limit.
   */
  useLimits(limits: ProviderLimits): void {
    this.deps.limits = limits;
    // A limit reached or left changes what a status says without any detection
    limits.onChange(() => {
      if (this.cache && !this.closed) this.deps.emit?.({ type: 'providers.changed', title: 'Providers changed', providers: this.known() ?? [] });
    });
  }

  /** What the last detection saw, whatever its age, without starting one; null before the first */
  known(): ProviderStatus[] | null {
    return this.cache ? this.ordered([...this.cache.statuses.values()].map((status) => this.withLimit(status))) : null;
  }

  /**
   * A status with the provider's limit laid over it, when the detector has somewhere to read it. The
   * cache keeps statuses without it, so a limit that moves never counts as a detection that changed.
   */
  private withLimit(status: ProviderStatus): ProviderStatus {
    const store = this.deps.limits;
    if (!store) return status;
    const limit = store.get(status.id);
    const next: ProviderStatus = { ...status, limit };
    if (status.state !== 'ready' || !limit) return next;
    if (limit.state === 'exhausted') return { ...next, state: 'degraded', reason: 'limit-reached' };
    if (limit.state === 'near') return { ...next, state: 'degraded', reason: 'limit-near' };
    return next;
  }

  /**
   * A session's first event confirmed what the installed version can do. The status takes it, and
   * `providers.changed` goes out only when that changes something a reader sees.
   */
  confirm(id: ProviderId, confirmation: CapabilityConfirmation): void {
    if (!confirmation.version) return;
    if (!this.registry.confirm(id, confirmation, new Date(this.now()).toISOString())) return;
    const old = this.cache?.statuses.get(id);
    if (!this.cache || !old) return;
    const next = this.withConfirmation(this.unconfirmed(old));
    if (sameStatus(old, next)) return;
    this.cache.statuses.set(id, next);
    this.deps.emit?.({ type: 'providers.changed', title: 'Providers changed', providers: this.known() ?? [] });
  }

  /** What a provider can do now: confirmed by its last session's first event, else declared */
  capabilities(id: ProviderId): ProviderCapability[] {
    return this.registry.capabilities(id);
  }

  /** What the last auth probe found, whatever the state that came of it; null when it never ran or was inconclusive */
  knownSignedIn(id: ProviderId): boolean | null {
    return this.signedIn.get(id) ?? null;
  }

  knownOne(id: ProviderId): ProviderStatus | null {
    const status = this.cache?.statuses.get(id);
    return status ? this.withLimit(status) : null;
  }

  /**
   * Every provider's status from the cache. The first call waits for a detection; after that an
   * answer older than the TTL is served while its replacement is on its way.
   */
  async statuses(): Promise<ProviderStatus[]> {
    // A reader only needs a full reading, not one newer than this call: it joins the one on its way
    if (!this.cache?.full) return this.pending ?? this.refresh();
    if (this.now() - this.cache.at > this.ttlMs) void this.refresh().catch(() => undefined);
    return this.known() ?? [];
  }

  async status(id: ProviderId): Promise<ProviderStatus | null> {
    return (await this.statuses()).find((status) => status.id === id) ?? null;
  }

  /**
   * Detects now. With `only`, just those providers are read and the rest keep their cached status.
   * `claude` hands over a reading Core has just taken, so nothing is spawned for it again.
   */
  refresh(options: { only?: ProviderId[]; claude?: ClaudeReading } = {}): Promise<ProviderStatus[]> {
    const full = !options.only && !options.claude;
    if (full && this.pending) {
      // Asked in the same tick, the running detection has not read anything yet and answers both.
      // Asked later, something may have changed since it read the settings and the files (a new
      // binary override, a login), so the answer is a detection that starts after it, one shared
      // by everyone who asks meanwhile.
      if (this.pendingJoinable) return this.pending;
      this.followUp ??= this.pending
        .catch(() => undefined)
        .then(() => {
          this.followUp = null;
          return this.refresh();
        });
      return this.followUp;
    }
    const run = this.detect(options).finally(() => {
      if (this.pending === run) this.pending = null;
    });
    if (full) {
      this.pending = run;
      this.pendingJoinable = true;
      queueMicrotask(() => {
        if (this.pending === run) this.pendingJoinable = false;
      });
    }
    return run;
  }

  /** The settings changed: a provider may have been turned on or off, or given a binary of its own */
  settingsChanged(): Promise<ProviderStatus[]> {
    return this.refresh();
  }

  /** Watches the PATH directories and config homes; a change re-detects after it settles */
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

  private ordered(statuses: ProviderStatus[]): ProviderStatus[] {
    const order = this.deps.settings?.()?.order ?? [];
    const rank = (id: ProviderId): number => {
      const at = order.indexOf(id);
      return at === -1 ? order.length + this.registry.list().findIndex((m) => m.id === id) : at;
    };
    return [...statuses].sort((a, b) => rank(a.id) - rank(b.id));
  }

  private async searchPath(): Promise<string> {
    if (this.deps.resolvePath) return this.deps.resolvePath();
    const dirs = [...(this.env.PATH ?? '').split(delimiter), ...(await installDirs(this.env, this.home))];
    return [...new Set(dirs.filter(Boolean))].join(delimiter);
  }

  private async detect(options: { only?: ProviderId[]; claude?: ClaudeReading }): Promise<ProviderStatus[]> {
    const seq = ++this.seq;
    const settings = this.deps.settings?.() ?? null;
    const searchPath = await this.searchPath();
    const manifests = this.registry.list().filter((m) => !options.only || options.only.includes(m.id));
    const read = (await Promise.all(manifests.map((m) => this.detectOne(m, settings, searchPath, options.claude)))).map((status) => this.withConfirmation(status));
    // A detection that finished late must not put an older reading over a newer one. Newer is per
    // provider: a reading of Claude Code alone, taken meanwhile, wins for Claude Code only, and the
    // rest of this detection still lands
    const fresh = read.filter((status) => (this.applied.get(status.id) ?? 0) < seq);
    for (const status of fresh) this.applied.set(status.id, seq);

    const before = this.cache?.statuses;
    const next = new Map(before ?? []);
    for (const status of fresh) next.set(status.id, status);
    this.cache = { at: this.now(), full: !options.only || (this.cache?.full ?? false), statuses: next };

    // The first reading is not a change: nobody has seen a status yet, and `GET` serves it
    const changed = before !== undefined && before.size > 0 && fresh.some((s) => { const old = before.get(s.id); return !old || !sameStatus(old, s); });
    const all = this.known() ?? [];
    if (changed) this.deps.emit?.({ type: 'providers.changed', title: 'Providers changed', providers: all });
    if (this.watching && !this.closed) await this.arm();
    return all;
  }

  /** A status as detection made it, before a session's confirmation was laid over it */
  private unconfirmed(status: ProviderStatus): ProviderStatus {
    const manifest = this.registry.get(status.id);
    const base: ProviderStatus = { ...status, confirmed: null, capabilities: manifest ? [...manifest.capabilities] : status.capabilities };
    if (status.reason === 'capability-missing') return { ...base, state: 'ready', reason: null };
    return base;
  }

  /**
   * Lays what a session confirmed over a status, for the version it confirmed and no other. A
   * declared capability the init contradicted makes a ready provider `degraded`.
   */
  private withConfirmation(status: ProviderStatus): ProviderStatus {
    const found = this.registry.confirmation(status.id);
    if (!found || !status.version || found.version !== status.version) return { ...status, confirmed: null };
    const capabilities = this.registry.capabilities(status.id);
    const next: ProviderStatus = {
      ...status,
      capabilities,
      confirmed: { at: found.at, version: found.version, capabilities: found.confirmed },
    };
    return found.missing.length > 0 && status.state === 'ready' ? { ...next, state: 'degraded', reason: 'capability-missing' } : next;
  }

  private configHome(manifest: ProviderManifest): { existing: string | null; candidates: string[] } {
    const candidates = manifest.configHomes.map((home) => this.locate(home));
    return { existing: candidates.find(isDirectory) ?? null, candidates };
  }

  private locate(place: ProviderConfigHome): string {
    const value = place.env ? this.env[place.env] : undefined;
    if (value) return place.insideEnv ? join(value, place.insideEnv) : value;
    return place.default.replace(/^~(?=$|\/)/, this.home);
  }

  private async detectOne(
    manifest: ProviderManifest,
    settings: ProvidersSettings | null,
    searchPath: string,
    claude: ClaudeReading | undefined,
  ): Promise<ProviderStatus> {
    const { existing: configHome } = this.configHome(manifest);
    const entry = settings?.providers[manifest.id];
    const make = (
      state: ProviderReadinessState,
      reason: ProviderReasonCode | null,
      extra: Partial<ProviderStatus> = {},
    ): ProviderStatus => ({
      id: manifest.id,
      label: manifest.label,
      state,
      reason,
      version: null,
      compatibleRange: manifest.versions.range ?? '',
      binaryPath: null,
      configHome,
      account: null,
      capabilities: [...manifest.capabilities],
      checkedAt: new Date(this.now()).toISOString(),
      ...extra,
    });

    this.signedIn.delete(manifest.id);
    if (entry && !entry.enabled) return make('unknown', 'disabled');
    if (manifest.commands.unsupportedPlatforms.includes(this.platform)) return make('not-installed', 'unsupported-platform');

    const override = entry?.binaryPath ?? null;
    let binaryPath: string | undefined;
    if (override) binaryPath = await resolveCommand(override, searchPath);
    else {
      for (const name of [...(this.deps.commandAliases?.[manifest.id] ?? []), ...manifest.commands.names]) {
        binaryPath = await resolveCommand(name, searchPath);
        if (binaryPath) break;
      }
    }
    if (!binaryPath) {
      if (configHome) return make('used-before', override ? 'binary-not-found' : 'config-home-only');
      return make('not-installed', 'binary-not-found');
    }

    for (const required of manifest.commands.requires) {
      if (!(await resolveCommand(required, searchPath))) return make('unknown', 'missing-required-command', { binaryPath });
    }

    const env = { ...this.env, PATH: searchPath };
    const [version, auth]: [VersionProbe, AuthProbe] = manifest.id === 'claude-code'
      ? await this.probeClaude(manifest, binaryPath, override, claude)
      : await Promise.all([this.probeVersion(manifest, binaryPath, env), this.probeAuth(manifest, binaryPath, env)]);

    if (auth.kind === 'ok' || auth.kind === 'signed-out') this.signedIn.set(manifest.id, auth.kind === 'ok');
    else this.signedIn.delete(manifest.id);

    const failure = (kind: 'timeout' | 'denied' | 'failed'): ProviderReasonCode =>
      kind === 'timeout' ? 'probe-timeout' : kind === 'denied' ? 'spawn-denied' : 'spawn-failed';
    if (version.kind === 'timeout' || version.kind === 'denied' || version.kind === 'failed') {
      return make('unknown', failure(version.kind), { binaryPath });
    }
    if (version.kind === 'unreadable') return make('unknown', 'version-unreadable', { binaryPath });

    if (manifest.versions.range) {
      const fit = satisfiesRange(version.version, manifest.versions.range);
      if (fit !== 'in') {
        return make('incompatible', fit === 'below' ? 'version-below-range' : 'version-above-range', { binaryPath, version: version.version });
      }
    }

    const known = { binaryPath, version: version.version };
    // Signed out, nothing the protocol could add changes the answer; any other reading may carry a
    // handshake, which spends nothing and adds the account, the models and what the version can do
    const reading = auth.kind === 'signed-out' ? null : await this.readDriver(manifest, binaryPath, version.version, env);
    const modes = reading ? { permissionModes: reading.permissionModes } : {};
    switch (auth.kind) {
      case 'ok':
        return make('ready', null, { ...known, ...modes, account: reading?.handshake?.account ?? auth.account });
      case 'signed-out':
        return make('signed-out', 'missing-credentials', known);
      case 'none':
        // The vendor documents no probe that costs nothing. A variable holding credentials cannot
        // prove they are valid, so it does not change the answer, and neither does a handshake: an
        // agent answers `initialize` signed in or not
        return make('unknown', 'no-probe', { ...known, ...modes });
      default:
        return make('unknown', failure(auth.kind), known);
    }
  }

  /**
   * The driver's half of a reading. It is built here for the binary that was found (an override
   * included), so the modes and the handshake describe the program that will run. The handshake
   * is kept for that binary and version; a failed one is retried after the TTL, and never changes
   * the status: the probes already said what could be said.
   */
  private async readDriver(manifest: ProviderManifest, binaryPath: string, version: string, env: NodeJS.ProcessEnv): Promise<DriverReading | null> {
    const driver = this.probeDriver(manifest, binaryPath);
    if (!driver) return null;
    const permissionModes = (this.registry.driverFor(manifest.id) ?? driver).permissionModes().map((m) => m.mode);
    if (!driver.handshake) return { permissionModes, handshake: null };

    const key = `${manifest.id}\0${binaryPath}\0${version}`;
    const kept = this.handshakes.get(key);
    // A provider at or near its limit is read again every TTL, so its recovery is seen without a chat
    const watching = this.deps.limits?.raw(manifest.id)?.state;
    const aged = kept ? this.now() - kept.at >= this.ttlMs : false;
    const refresh = aged && (watching === 'near' || watching === 'exhausted');
    if (kept && ('result' in kept ? !refresh : !aged)) return { permissionModes, handshake: 'result' in kept ? kept.result : null };

    const abort = new AbortController();
    const outcome = await this.timed(driver.handshake(env, abort.signal).catch(() => null), this.probeTimeoutMs * 2);
    if (outcome === 'timeout') abort.abort();
    const result = outcome === 'timeout' ? null : outcome;
    this.handshakes.set(key, result ? { at: this.now(), result } : { at: this.now(), failed: true });
    if (!result) return { permissionModes, handshake: null };
    const read = (result as HandshakeResult & HandshakeLimits).rateLimits;
    if (read) this.deps.limits?.observeProbe(manifest.id, read);

    // The handshake's version is the agent's own and may read differently from `--version`, so what
    // it confirmed is filed under the version the probe read, the one a status is compared with
    this.registry.confirm(manifest.id, { version, confirmed: result.confirmed, missing: [] }, new Date(this.now()).toISOString());
    if (result.models.length > 0) {
      this.giveCatalog(manifest.id, result.models);
      void this.catalogs.set(manifest.id, { version, models: result.models }).catch(() => undefined);
    }
    return { permissionModes, handshake: result };
  }

  /** A driver for this binary, to ask what it offers and to run its handshake; null for a provider with no driver yet */
  private probeDriver(manifest: ProviderManifest, binaryPath: string): ProviderDriver | null {
    if (manifest.id === 'claude-code') return new ClaudeCodeDriver(binaryPath);
    const build = DRIVER_TRANSPORTS[manifest.transport];
    return build ? build({ ...manifest, commands: { ...manifest.commands, names: [binaryPath] } }) : null;
  }

  /** Hands a catalog to the driver that serves the model picker, when it takes one */
  private giveCatalog(id: ProviderId, models: ModelOption[]): void {
    const driver: (ProviderDriver & { setCatalog?: (models: ModelOption[]) => void }) | null = this.registry.driverFor(id);
    driver?.setCatalog?.(models);
  }

  /** Claude Code reads through `detectCli` and `getAuthStatus`, the same two calls the rest of core makes */
  private async probeClaude(
    manifest: ProviderManifest,
    binaryPath: string,
    override: string | null,
    given: ClaudeReading | undefined,
  ): Promise<[VersionProbe, AuthProbe]> {
    const read = async (): Promise<ClaudeReading> => {
      if (given) return given;
      if (this.deps.readClaude && !override) return this.deps.readClaude();
      const config = { ...this.deps.config, claudeBin: binaryPath };
      const cli = await detectCli(config);
      const auth = cli.installed
        ? await getAuthStatus(config)
        : { loggedIn: false, tokenSource: 'none' as const, error: cli.error ?? '' };
      return { cli, auth };
    };
    const reading = await this.timed(read(), this.probeTimeoutMs * 2);
    if (reading === 'timeout') return [{ kind: 'timeout' }, { kind: 'timeout' }];
    if (!reading.cli.installed || !reading.cli.version) {
      return [reading.cli.installed ? { kind: 'unreadable' } : { kind: 'failed' }, { kind: 'failed' }];
    }
    const account = reading.auth.email ?? reading.auth.orgName ?? null;
    return [
      { kind: 'ok', version: reading.cli.version },
      reading.auth.loggedIn ? { kind: 'ok', account } : { kind: 'signed-out' },
    ];
  }

  private async probeVersion(manifest: ProviderManifest, binaryPath: string, env: NodeJS.ProcessEnv): Promise<VersionProbe> {
    const res = await this.exec(binaryPath, manifest.versions.args, env);
    if (res.outcome !== 'done') return { kind: res.outcome };
    const version = VERSION_TEXT.exec(res.stdout)?.[0];
    if (res.code !== 0 || !version) return res.code === 0 ? { kind: 'unreadable' } : { kind: 'failed' };
    return { kind: 'ok', version };
  }

  private async probeAuth(manifest: ProviderManifest, binaryPath: string, env: NodeJS.ProcessEnv): Promise<AuthProbe> {
    const probe = manifest.auth.probe;
    if (probe.kind === 'none') return { kind: 'none' };
    if (probe.kind === 'file') return readCredentialsFile(this.locate(probe.file));
    const res = await this.exec(binaryPath, probe.args, env);
    if (res.outcome !== 'done') return { kind: res.outcome };
    if (probe.result === 'exit-code') return res.code === 0 ? { kind: 'ok', account: null } : { kind: 'signed-out' };
    try {
      const json = JSON.parse(res.stdout) as Record<string, unknown>;
      if (json.loggedIn !== true) return { kind: 'signed-out' };
      const label = typeof json.email === 'string' ? json.email : typeof json.orgName === 'string' ? json.orgName : null;
      return { kind: 'ok', account: label };
    } catch {
      return { kind: 'failed' };
    }
  }

  private exec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Exec> {
    return new Promise((resolve) => {
      execFile(file, args, { timeout: this.probeTimeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env }, (error, stdout) => {
        if (!error) return resolve({ outcome: 'done', code: 0, stdout });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.killed) return resolve({ outcome: 'timeout', code: 1, stdout });
        if (typeof failure.code === 'number') return resolve({ outcome: 'done', code: failure.code, stdout });
        const denied = failure.code === 'EACCES' || failure.code === 'EPERM';
        resolve({ outcome: denied ? 'denied' : 'failed', code: 1, stdout });
      });
    });
  }

  private async timed<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const clock = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    try {
      return await Promise.race([work, clock]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * (Re)opens one watcher per directory that matters. A directory that does not exist yet, a config
   * home before its first run, is watched through its parent, filtered to its own name.
   */
  private async arm(): Promise<void> {
    const wanted = new Map<string, Set<string> | null>();
    const add = (dir: string, names: Set<string> | null): void => {
      const seen = wanted.get(dir);
      if (seen === undefined) wanted.set(dir, names);
      else wanted.set(dir, seen && names ? new Set([...seen, ...names]) : null);
    };
    const commands = new Set(this.registry.list().flatMap((m) => [...m.commands.names, ...(this.deps.commandAliases?.[m.id] ?? [])]));
    for (const dir of (await this.searchPath()).split(delimiter)) {
      if (dir && isDirectory(dir)) add(dir, commands);
    }
    for (const manifest of this.registry.list()) {
      for (const home of this.configHome(manifest).candidates) {
        if (isDirectory(home)) add(home, null);
        else add(dirname(home), new Set([basename(home)]));
      }
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
