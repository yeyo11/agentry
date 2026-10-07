import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthMode, Localized, LocalizedParams, TailscaleReadiness, TunnelSettings, TunnelState, TunnelStatus } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { AgentryEventInput } from './events.ts';
import type { RuntimeHostOptions } from './app-settings.ts';

/*
 * Reaching Agentry from a phone or another computer on the person's tailnet, through the Tailscale
 * CLI (docs/plans/tunnel.md). Agentry adds one `tailscale serve` rule (tailnet-only, never Funnel)
 * on a port of its own, and takes exactly that rule away again. Tailscale is reached only through
 * its CLI's flags and `--json` output, with the person's own session: no LocalAPI socket, no tsnet,
 * no sign-in of Agentry's own. What has to hold before a byte crosses: no tunnel without
 * authentication, only the node's exact name joins the allowlist and only while the rule holds, and
 * nothing in the node's Serve config that Agentry did not add is ever changed.
 */

/** The HTTPS port of Agentry's Serve rule unless `AGENTRY_TUNNEL_PORT` says otherwise: not 443, which the person's own `tailscale serve` takes by default. */
export const DEFAULT_TUNNEL_PORT = 8443;

/** `tailscale serve` took its current arguments (`--bg`, `--https=<port>`, `off`) in 1.52 */
export const MIN_TAILSCALE_VERSION: readonly [number, number] = [1, 52];

/**
 * Tailscale Serve sets `Tailscale-User-Login` and friends, and is documented to replace a client's
 * own copies, but whether it also sets `X-Forwarded-For` could not be measured here (the node's
 * Serve settings need an operator this machine's user is not). Trusting an unmeasured header would
 * let a client pick whose failure budget they spend, so the host is registered without one, and
 * all tunnel traffic shares one backoff bucket of its own, apart from loopback.
 */
export const TUNNEL_HOST_OPTIONS: RuntimeHostOptions = {};

export interface TunnelTiming {
  /** How often an active tunnel re-reads Tailscale's state and its Serve rule */
  monitorMs: number;
  /** How long one `tailscale` call may take before it counts as failed */
  commandTimeoutMs: number;
  /** How long a readiness probe is reused before `refresh` asks the CLI again */
  probeTtlMs: number;
  /** Readings in a row that find Tailscale down or the rule gone before an active tunnel gives up */
  maxMisses: number;
}

const DEFAULT_TIMING: TunnelTiming = {
  monitorMs: 30_000,
  commandTimeoutMs: 10_000,
  probeTtlMs: 2_000,
  maxMisses: 2,
};

export interface TunnelDeps {
  dataDir: string;
  /** The `tailscale` CLI, from `TAILSCALE_BIN` */
  tailscaleBin: string;
  /** The HTTPS port on the node's tailnet name; `DEFAULT_TUNNEL_PORT` when left out */
  port?: number;
  /**
   * Whether this deploy offers the tunnel (`CoreConfig.tunnelEnabled`); true when left out. False
   * refuses every start, "start with Agentry" included, and the status says so.
   */
  enabled?: boolean;
  /** Read on every decision rather than copied: the mode can change while the tunnel is open */
  security: { readonly mode: AuthMode };
  /** Where the node's name is registered for the guard, and removed from again */
  hosts: { add(host: string, options?: RuntimeHostOptions): void; remove(host: string): void };
  emit?: (event: AgentryEventInput) => void;
  /** One row in the security history; the routes' own requests are audited by the API already */
  audit?: (row: { method: string; path: string; summary: string }) => void;
  timing?: Partial<TunnelTiming>;
}

/** A refusal the API answers with `409`: the request was understood, the wrapper's state forbids it. */
export class TunnelRefusedError extends Error {
  constructor(
    readonly reason: Localized,
    readonly statusCode = 409,
  ) {
    super(reason.text);
  }
}

const reason = (code: string, text: string, params?: LocalizedParams): Localized => (params ? { code, params, text } : { code, text });

const REASONS = {
  disabled: () => reason('tunnel.disabled', 'This Agentry does not offer the tunnel. Whoever runs it can turn it on with AGENTRY_TUNNEL=on.'),
  authRequired: () => reason('tunnel.authRequired', 'The tunnel needs authentication: turn on a token or OIDC in Security first.'),
  noPort: () => reason('tunnel.noPort', 'Agentry is not listening yet, so there is nothing to open a tunnel to.'),
  missing: () => reason('tunnel.tailscaleMissing', 'The Tailscale CLI (tailscale) was not found. Install Tailscale on this machine and sign in, then try again.'),
  unsupported: (version: string) =>
    reason('tunnel.tailscaleUnsupported', `Tailscale ${version} is too old: the tunnel needs 1.52 or later. Update Tailscale, then try again.`, { version }),
  daemonDown: () => reason('tunnel.tailscaleDaemonDown', 'The tailscale CLI could not reach the Tailscale service (tailscaled). Start it, then try again.'),
  loggedOut: () => reason('tunnel.tailscaleLoggedOut', 'This machine is not signed in to a tailnet. Run tailscale up in a terminal, then try again.'),
  notConnected: (state: string) =>
    reason('tunnel.tailscaleNotConnected', `Tailscale is not connected on this machine (${state}). Run tailscale up in a terminal, then try again.`, { state }),
  magicDnsOff: () => reason('tunnel.magicDnsOff', 'MagicDNS is off for this tailnet. Turn it on in the DNS page of the Tailscale admin console, then try again.'),
  httpsOff: () => reason('tunnel.httpsOff', 'HTTPS certificates are off for this tailnet. Turn them on in the DNS page of the Tailscale admin console, then try again.'),
  permission: () =>
    reason('tunnel.servePermission', "Tailscale refused to change this machine's Serve settings for this user. Run sudo tailscale set --operator=$USER once, then try again."),
  // A string, so the page does not group its digits as it would a count
  portTaken: (port: number) =>
    reason('tunnel.portTaken', `Port ${port} of this machine's tailnet name is already served by something else, and Agentry leaves it alone. Free it, or set AGENTRY_TUNNEL_PORT to another port.`, { port: String(port) }),
  serveFailed: (detail: string) => reason('tunnel.serveFailed', `tailscale serve did not accept the rule: ${detail}`, { detail }),
  unverified: () => reason('tunnel.unverified', "The Serve rule was sent, but this machine's Serve config does not show it pointing at Agentry."),
  ruleRemoved: () => reason('tunnel.ruleRemoved', "Agentry's Serve rule was removed or changed outside Agentry, so the tunnel is closed."),
};

interface CliResult {
  ok: boolean;
  /** The CLI could not be run at all */
  missing: boolean;
  stdout: string;
  stderr: string;
}

function runCli(bin: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, missing: false, stdout, stderr });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      resolve({ ok: false, missing: code === 'ENOENT' || code === 'EACCES', stdout, stderr: stderr || error.message });
    });
  });
}

/** The first line a CLI wrote on stderr, short enough to show; it never carries a secret here. */
const firstLine = (text: string): string => (text.split('\n').find((line) => line.trim())?.trim() ?? '').slice(0, 200);

/** `1.102.4` from the first line of `tailscale version`, as numbers; null when it is not a version. */
export function parseTailscaleVersion(output: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** What `tailscale status --json` says, reduced to what the tunnel needs. */
interface StatusJson {
  BackendState?: unknown;
  Self?: { DNSName?: unknown } | null;
  CurrentTailnet?: { MagicDNSEnabled?: unknown } | null;
  CertDomains?: unknown;
}

/**
 * Readiness from `tailscale status --json` (measured on 1.102.4): `BackendState` says whether the
 * node is signed in and connected, `Self.DNSName` is its name with a trailing dot, and
 * `CertDomains` is only filled while HTTPS certificates are on for the tailnet.
 */
export function readinessFromStatus(json: StatusJson, version: string): TailscaleReadiness {
  const state = typeof json.BackendState === 'string' ? json.BackendState : 'NoState';
  const dns = typeof json.Self?.DNSName === 'string' ? json.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  const host = dns || null;
  if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') return { state: 'loggedOut', version, host, reason: REASONS.loggedOut() };
  if (state !== 'Running') return { state: 'stopped', version, host, reason: REASONS.notConnected(state) };
  if (json.CurrentTailnet?.MagicDNSEnabled !== true) return { state: 'httpsDisabled', version, host, reason: REASONS.magicDnsOff() };
  const certs = Array.isArray(json.CertDomains) ? json.CertDomains.filter((name): name is string => typeof name === 'string').map((name) => name.toLowerCase()) : [];
  if (!host || !certs.includes(host)) return { state: 'httpsDisabled', version, host, reason: REASONS.httpsOff() };
  return { state: 'ready', version, host, reason: null };
}

/** The parts of `tailscale serve status --json` (an `ipn.ServeConfig`) the tunnel reads. */
interface ServeConfigJson {
  TCP?: Record<string, unknown> | null;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown } | null> | null } | null> | null;
  Foreground?: Record<string, ServeConfigJson | null> | null;
}

/** Whether a port of the node's Serve config is free, holds exactly the rule Agentry would add, or holds anything else. */
export type ServePortUse = 'free' | 'match' | 'other';

const sameTarget = (a: unknown, b: string): boolean => typeof a === 'string' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * How `port` is used in a Serve config. Only one shape is Agentry's: an HTTPS listener on the port
 * with a single `/` handler that proxies to this server. A path the person added beside it, a TCP
 * forwarder, or a foreground `tailscale serve` on the port is theirs.
 */
export function servePortUse(config: ServeConfigJson, port: number, host: string, target: string): ServePortUse {
  const key = String(port);
  const uses = (c: ServeConfigJson | null | undefined): boolean => !!c && (c.TCP?.[key] !== undefined || Object.keys(c.Web ?? {}).some((name) => name.endsWith(`:${key}`)));
  const foreground = Object.values(config.Foreground ?? {}).some(uses);
  if (!uses(config) && !foreground) return 'free';
  if (foreground) return 'other';
  const webKeys = Object.keys(config.Web ?? {}).filter((name) => name.endsWith(`:${key}`));
  const handlers = config.Web?.[`${host}:${key}`]?.Handlers ?? {};
  const tcp = config.TCP?.[key] as { HTTPS?: unknown } | undefined;
  const paths = Object.keys(handlers);
  const only = webKeys.length === 1 && paths.length === 1 && paths[0] === '/';
  return only && tcp?.HTTPS === true && sameTarget(handlers['/']?.Proxy, target) ? 'match' : 'other';
}

/** The rule Agentry added, kept on disk so a crash cannot leave it behind unnoticed. */
interface ServeRecord {
  port: number;
  host: string;
  target: string;
}

const DEFAULT_SETTINGS: TunnelSettings = { startWithAgentry: false };

/** What the status says before the CLI was first asked: nothing is known, so nothing is offered. */
const UNPROBED: TailscaleReadiness = { state: 'missing', version: null, host: null, reason: null };

const versionAtLeast = (version: [number, number, number], min: readonly [number, number]): boolean =>
  version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);

/**
 * The tunnel: one Serve rule at a time, its state, and the host it lends the guard.
 *
 * `stopped → starting → verifying → active`, with `failed` and `stopping`. Tailscale keeps a
 * background Serve rule in the node's own config, beyond Agentry's life, so the rule is recorded in
 * `<dataDir>/tunnel/serve-rule.json` before it is added, removed on stop and on shutdown, and a
 * rule a crash left behind is reconciled away when Agentry starts again. Removal only ever touches
 * a port that still holds exactly the rule Agentry added.
 */
export class TunnelManager {
  private readonly dir: string;
  private readonly recordFile: string;
  private readonly settingsFile: string;
  private readonly timing: TunnelTiming;
  private readonly port: number;
  private settings: TunnelSettings = { ...DEFAULT_SETTINGS };
  private state: TunnelState = 'stopped';
  private reason: Localized | null = null;
  private tailscale: TailscaleReadiness = UNPROBED;
  private probedAt = 0;
  private probing: Promise<TailscaleReadiness> | null = null;
  /** The host lent to the guard: set only while `active` */
  private lent: string | null = null;
  private since: string | null = null;
  private target: { host: string; port: number } | null = null;
  /** Whether the person wants the tunnel open */
  private wanted = false;
  /** Aborted whenever the tunnel stops or gives up, so a call still in flight changes nothing after it */
  private run = new AbortController();
  private opening: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  /** A leftover rule being taken away; a start waits for it, so it never removes the new one */
  private cleaning: Promise<void> = Promise.resolve();
  private monitor: NodeJS.Timeout | null = null;
  private checking = false;
  private misses = 0;

  constructor(private readonly deps: TunnelDeps) {
    this.dir = join(deps.dataDir, 'tunnel');
    this.recordFile = join(this.dir, 'serve-rule.json');
    this.settingsFile = join(deps.dataDir, 'tunnel-settings.json');
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.port = deps.port ?? DEFAULT_TUNNEL_PORT;
    this.settings = this.readSettings();
  }

  status(): TunnelStatus {
    const active = this.state === 'active';
    return {
      state: this.state,
      url: active && this.lent ? this.urlOf(this.lent) : null,
      since: active ? this.since : null,
      reason: this.state === 'failed' ? this.reason : null,
      enabled: this.enabled,
      tailscale: { ...this.tailscale },
      port: this.port,
      settings: { ...this.settings },
    };
  }

  private get enabled(): boolean {
    return this.deps.enabled ?? true;
  }

  private urlOf(host: string): string {
    return this.port === 443 ? `https://${host}` : `https://${host}:${this.port}`;
  }

  /**
   * Asks the CLI again when the last answer is older than a moment, and says so on the feed when
   * the answer changed. The routes call it before answering, so the tab reflects a `tailscale up`
   * run in a terminal without a restart. Where the deploy does not offer the tunnel, the CLI is
   * never run.
   */
  async refresh(force = false): Promise<TunnelStatus> {
    if (this.enabled && (force || Date.now() - this.probedAt > this.timing.probeTtlMs)) {
      const before = JSON.stringify(this.tailscale);
      await this.probe();
      if (JSON.stringify(this.tailscale) !== before) this.changed();
    }
    return this.status();
  }

  private probe(): Promise<TailscaleReadiness> {
    this.probing ??= this.readReadiness()
      .then((readiness) => {
        this.tailscale = readiness;
        this.probedAt = Date.now();
        return readiness;
      })
      .finally(() => {
        this.probing = null;
      });
    return this.probing;
  }

  private async readReadiness(): Promise<TailscaleReadiness> {
    const version = await this.cli(['version']);
    if (version.missing || !version.ok) return { state: 'missing', version: null, host: null, reason: REASONS.missing() };
    const text = firstLine(version.stdout);
    const parsed = parseTailscaleVersion(text);
    if (!parsed || !versionAtLeast(parsed, MIN_TAILSCALE_VERSION)) return { state: 'unsupported', version: text || null, host: null, reason: REASONS.unsupported(text || 'unknown') };
    const shown = parsed.join('.');
    const status = await this.cli(['status', '--json']);
    // `--json` prints the state even when the node is stopped; only a daemon that does not answer leaves no JSON
    let json: StatusJson | null = null;
    try {
      json = JSON.parse(status.stdout) as StatusJson;
    } catch {
      json = null;
    }
    if (!json || typeof json !== 'object') return { state: 'daemonDown', version: shown, host: null, reason: REASONS.daemonDown() };
    return readinessFromStatus(json, shown);
  }

  private cli(args: string[]): Promise<CliResult> {
    return runCli(this.deps.tailscaleBin, args, this.timing.commandTimeoutMs);
  }

  /**
   * Where the tunnel forwards to: the port the server actually bound to, which is not always the
   * one it asked for. Takes away a rule a crash left behind, then opens the tunnel when "start with
   * Agentry" is on.
   */
  attach(port: number, host = '127.0.0.1'): void {
    this.target = { host, port };
    if (existsSync(this.recordFile)) this.cleaning = this.removeRule().catch(() => undefined);
    // A setting saved before the operator turned the tunnel off is not a reason to open it
    if (!this.settings.startWithAgentry || !this.enabled) return;
    this.start('agentry').catch((error: unknown) => {
      // Not thrown at startup: a tunnel that cannot open must not keep Agentry from starting
      if (error instanceof TunnelRefusedError) this.fail(error.reason);
    });
  }

  /**
   * Opens the tunnel. Refused under `mode: 'none'`: the tunnel would turn "whoever reaches the port
   * owns the machine" into "whoever on the tailnet has the URL does". Refused as well where the
   * deploy does not offer it. A Tailscale that is not ready is a state, not an error.
   */
  async start(actor: 'request' | 'agentry' = 'request'): Promise<TunnelStatus> {
    if (!this.enabled) throw new TunnelRefusedError(REASONS.disabled());
    if (this.deps.security.mode === 'none') throw new TunnelRefusedError(REASONS.authRequired());
    if (!this.target) throw new TunnelRefusedError(REASONS.noPort());
    await this.stopping;
    await this.cleaning;
    if (this.wanted) return this.status();
    const readiness = await this.probe();
    if (readiness.state !== 'ready' || !readiness.host) {
      this.fail(readiness.reason ?? REASONS.missing());
      return this.status();
    }
    this.wanted = true;
    this.misses = 0;
    this.run = new AbortController();
    if (actor !== 'request') this.deps.audit?.({ method: 'POST', path: '/api/tunnel/start', summary: 'Start the tunnel with Agentry' });
    this.set('starting');
    const run = this.run;
    this.opening = this.open(readiness.host, run).finally(() => {
      if (this.run === run) this.opening = null;
    });
    return this.status();
  }

  /** Closes the tunnel: its host leaves the allowlist first, then Agentry's Serve rule goes. */
  async stop(why: 'request' | 'unguarded' = 'request'): Promise<TunnelStatus> {
    if (!this.wanted && !this.opening && !this.stopping) {
      if (this.state === 'failed') this.set('stopped');
      return this.status();
    }
    this.wanted = false;
    if (why === 'unguarded') this.deps.audit?.({ method: 'POST', path: '/api/tunnel/stop', summary: 'Stop the tunnel: authentication was turned off' });
    this.stopping ??= (async () => {
      this.run.abort();
      this.stopMonitor();
      this.withdraw();
      this.set('stopping');
      await this.opening;
      await this.removeRule();
      this.set('stopped');
    })().finally(() => {
      this.stopping = null;
    });
    await this.stopping;
    return this.status();
  }

  async updateSettings(input: unknown): Promise<TunnelStatus> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('tunnel settings must be a JSON object');
    const body = input as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((key) => key !== 'startWithAgentry');
    if (unknownKeys.length) throw new Error(`unknown tunnel settings: ${unknownKeys.join(', ')}; the known one is startWithAgentry`);
    if (body.startWithAgentry === undefined) return this.refresh();
    if (typeof body.startWithAgentry !== 'boolean') throw new Error('startWithAgentry must be a boolean');
    const next = { ...this.settings, startWithAgentry: body.startWithAgentry };
    await writeAtomic(this.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = next;
    // The event carries the whole status, readiness included, so it is read first
    await this.refresh();
    this.changed();
    return this.status();
  }

  /**
   * Synchronous, for the process that is going away: there is no later to wait in. The Serve rule
   * outlives the process unless it is taken away now; when that fails, the record stays for the
   * next start to reconcile.
   */
  shutdown(): void {
    this.wanted = false;
    this.run.abort();
    this.stopMonitor();
    this.withdraw();
    const record = this.readRecord();
    if (!record) return;
    const run = (args: string[]) => spawnSync(this.deps.tailscaleBin, args, { encoding: 'utf8', timeout: this.timing.commandTimeoutMs });
    try {
      const status = run(['serve', 'status', '--json']);
      if (status.status !== 0) return;
      const use = servePortUse(JSON.parse(status.stdout) as ServeConfigJson, record.port, record.host, record.target);
      if (use === 'match') {
        const off = run(['serve', '--yes', `--https=${record.port}`, 'off']);
        if (off.status !== 0 && !/handler does not exist/i.test(off.stderr)) return;
      }
      rmSync(this.recordFile, { force: true });
    } catch {
      // The record stays: the next start takes the rule away
    }
  }

  private readSettings(): TunnelSettings {
    if (!existsSync(this.settingsFile)) return { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<TunnelSettings>;
      return { startWithAgentry: raw.startWithAgentry === true };
    } catch {
      // Off is the safe reading of a file nobody can read: the tunnel only opens when asked
      return { ...DEFAULT_SETTINGS };
    }
  }

  private readRecord(): ServeRecord | null {
    try {
      const raw = JSON.parse(readFileSync(this.recordFile, 'utf8')) as Partial<ServeRecord>;
      if (typeof raw.port === 'number' && typeof raw.host === 'string' && typeof raw.target === 'string') return { port: raw.port, host: raw.host, target: raw.target };
    } catch {
      // No record, or one nobody can read: nothing is known to be Agentry's
    }
    return null;
  }

  private writeRecord(record: ServeRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.recordFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  private async serveConfig(): Promise<ServeConfigJson | null> {
    const result = await this.cli(['serve', 'status', '--json']);
    if (!result.ok) return null;
    try {
      const json = JSON.parse(result.stdout) as unknown;
      return json && typeof json === 'object' ? (json as ServeConfigJson) : null;
    } catch {
      return null;
    }
  }

  private targetUrl(): string | null {
    return this.target ? `http://${this.target.host}:${this.target.port}` : null;
  }

  /**
   * Adds the rule, unless the port is already someone else's, and reads the config back before the
   * host is lent to the guard. The record is written before the rule is sent, so a crash in between
   * leaves something to reconcile rather than a rule nobody knows about.
   */
  private async open(host: string, run: AbortController): Promise<void> {
    const target = this.targetUrl();
    if (!target) return;
    const live = (): boolean => !run.signal.aborted && this.wanted;
    const before = await this.serveConfig();
    if (!live()) return;
    if (!before) return this.giveUp(REASONS.daemonDown());
    if (servePortUse(before, this.port, host, target) !== 'free') return this.giveUp(REASONS.portTaken(this.port));
    this.writeRecord({ port: this.port, host, target });
    const added = await this.cli(['serve', '--bg', '--yes', `--https=${this.port}`, target]);
    if (!added.ok) {
      const detail = firstLine(added.stderr);
      return this.giveUp(/access denied/i.test(added.stderr) ? REASONS.permission() : REASONS.serveFailed(detail || 'no output'));
    }
    if (!live()) return;
    this.set('verifying');
    const after = await this.serveConfig();
    if (!live()) return;
    if (!after || servePortUse(after, this.port, host, target) !== 'match') return this.giveUp(REASONS.unverified());
    if (this.deps.security.mode === 'none') {
      void this.stop('unguarded');
      return;
    }
    this.lend(host);
    this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${host} joined the allowlist` });
    this.set('active');
    this.startMonitor(run);
  }

  private lend(host: string): void {
    this.deps.hosts.add(host, TUNNEL_HOST_OPTIONS);
    this.lent = host;
    this.since = new Date().toISOString();
  }

  /**
   * Takes Agentry's rule away, if the port still holds exactly it. A port that is free, or that
   * someone else took over, is not Agentry's any more: the record goes and nothing is touched. When
   * Tailscale cannot be asked, the record stays for the next try.
   */
  private async removeRule(): Promise<void> {
    const record = this.readRecord();
    if (!record) {
      rmSync(this.recordFile, { force: true });
      return;
    }
    const config = await this.serveConfig();
    if (!config) return;
    if (servePortUse(config, record.port, record.host, record.target) === 'match') {
      const off = await this.cli(['serve', '--yes', `--https=${record.port}`, 'off']);
      if (!off.ok && !/handler does not exist/i.test(off.stderr)) return;
    }
    rmSync(this.recordFile, { force: true });
  }

  /**
   * While active, Tailscale is read again now and then: a `tailscale down`, a sign-out or a
   * `tailscale serve reset` in a terminal would otherwise leave the tab saying open over an address
   * that no longer answers. A node renamed in the admin console moves the lent host with it.
   */
  private startMonitor(run: AbortController): void {
    this.stopMonitor();
    this.monitor = setInterval(() => void this.check(run), this.timing.monitorMs);
    this.monitor.unref();
  }

  private stopMonitor(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }

  private async check(run: AbortController): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const readiness = await this.probe();
      if (run.signal.aborted || this.state !== 'active') return;
      if (readiness.state !== 'ready' || !readiness.host) {
        if (++this.misses >= this.timing.maxMisses) this.giveUp(readiness.reason ?? REASONS.daemonDown());
        return;
      }
      const record = this.readRecord();
      const config = await this.serveConfig();
      if (run.signal.aborted || this.state !== 'active') return;
      if (!config || !record) {
        if (++this.misses >= this.timing.maxMisses) this.giveUp(REASONS.daemonDown());
        return;
      }
      // Read under the name the node has now: a rename moves the rule's key in the Serve config with it
      if (servePortUse(config, record.port, readiness.host, record.target) !== 'match') {
        this.giveUp(REASONS.ruleRemoved());
        return;
      }
      this.misses = 0;
      if (readiness.host !== this.lent) {
        // The node was renamed: the rule follows the node, and the old name stops answering
        this.withdraw();
        this.lend(readiness.host);
        this.writeRecord({ ...record, host: readiness.host });
        this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${readiness.host} joined the allowlist` });
        this.changed();
      }
    } finally {
      this.checking = false;
    }
  }

  private giveUp(why: Localized): void {
    this.wanted = false;
    this.run.abort();
    this.stopMonitor();
    this.withdraw();
    this.fail(why);
    this.cleaning = this.removeRule().catch(() => undefined);
  }

  /** Takes the lent host back from the guard, and writes down that it left. */
  private withdraw(): void {
    if (!this.lent) return;
    this.deps.hosts.remove(this.lent);
    this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${this.lent} left the allowlist` });
    this.lent = null;
    this.since = null;
  }

  private fail(why: Localized): void {
    this.reason = why;
    this.set('failed');
  }

  private set(state: TunnelState): void {
    if (state === this.state && state !== 'failed') return;
    this.state = state;
    if (state === 'stopped') this.reason = null;
    this.changed();
  }

  private changed(): void {
    const tunnel = this.status();
    // The title stays generic: the address travels in `tunnel` only, never in a line that a
    // notification or a log could carry somewhere else
    this.deps.emit?.({ type: 'tunnel.changed', title: `Tunnel ${tunnel.state}`, tunnel });
  }
}
