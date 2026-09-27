import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AuthMode, Localized, LocalizedParams, TunnelSettings, TunnelState, TunnelStatus } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { AgentryEventInput } from './events.ts';
import type { RuntimeHostOptions } from './app-settings.ts';

/*
 * Reaching Agentry from a phone or another network through localhost.run, over the system's own
 * `ssh` (docs/plans/tunnel.md). One provider, no account, nothing to install. What has to hold
 * before a byte crosses: no tunnel without authentication, only the tunnel's exact host joins the
 * allowlist and only once it answers, and the provider's host key is pinned, because a network
 * that could swap the SSH endpoint would otherwise receive every request, the token included.
 */

/**
 * localhost.run's host key, as read on 2026-09-27 (`ssh-ed25519`,
 * `SHA256:pG6qrBxubYfWa1Zadu/V0NUgjEDiBds/7e2xzte/QNM`). It ships with Agentry and is the only
 * key its `known_hosts` holds: a key the provider rotates fails the tunnel with `tunnel.hostKey`
 * rather than being learned, which is what trust on first use would do on a hostile network.
 */
export const LOCALHOST_RUN_KNOWN_HOSTS = 'localhost.run ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILVqOuSMnyeGDVO1lG6EaG5In/dXABCchhmHKkuRU2s9\n';

const DESTINATION = 'nokey@localhost.run';

const NAME = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+';
/**
 * The one banner line the address comes from, as localhost.run prints it:
 * `<id>.lhr.life tunneled with tls termination, https://<id>.lhr.life`. The same banner links to
 * the provider's docs, so any `https://` in the output would not do; and the name has to be the
 * same on both sides of the line, or it is not the line we think it is.
 */
const BANNER = new RegExp(`^(${NAME}) tunneled with tls termination, https://(${NAME})$`, 'i');

/** The public address in a line of ssh's output, or null when the line is not the banner. */
export function parseTunnelUrl(line: string): string | null {
  const match = BANNER.exec(line.trim());
  if (!match?.[1] || match[1].toLowerCase() !== match[2]?.toLowerCase()) return null;
  return `https://${match[1].toLowerCase()}`;
}

/**
 * localhost.run adds no header that carries the client's address, and passes the client's own
 * `X-Forwarded-For` through untouched (measured on 2026-09-27), so trusting one would let a
 * stranger pick whose failure budget they spend. The tunnel's host is therefore registered
 * without a header, and its traffic gets a backoff bucket of its own, apart from loopback.
 */
export const TUNNEL_HOST_OPTIONS: RuntimeHostOptions = {};

export interface TunnelTiming {
  /** How long to keep asking the public address for `/api/health` before giving up on it */
  verifyTimeoutMs: number;
  verifyIntervalMs: number;
  /** Waits between reconnects, the last one repeating */
  backoffMs: readonly number[];
  /** Attempts in a row that never reach `active` before the tunnel is reported failed */
  maxAttempts: number;
  /** How long ssh gets to leave after SIGTERM before SIGKILL */
  killGraceMs: number;
}

const DEFAULT_TIMING: TunnelTiming = {
  verifyTimeoutMs: 60_000,
  verifyIntervalMs: 2_000,
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  maxAttempts: 6,
  killGraceMs: 3_000,
};

export interface TunnelDeps {
  dataDir: string;
  sshBin: string;
  /** Read on every decision rather than copied: the mode can change while the tunnel is open */
  security: { readonly mode: AuthMode };
  /** Where the verified host is registered for the guard, and removed from again */
  hosts: { add(host: string, options?: RuntimeHostOptions): void; remove(host: string): void };
  emit?: (event: AgentryEventInput) => void;
  /** One row in the security history; the routes' own requests are audited by the API already */
  audit?: (row: { method: string; path: string; summary: string }) => void;
  /** Whether `/api/health` answers `200` through the public address; replaced by the tests */
  verify?: (url: string, signal: AbortSignal) => Promise<boolean>;
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
  authRequired: () => reason('tunnel.authRequired', 'The tunnel needs authentication: turn on a token or OIDC in Security first.'),
  noPort: () => reason('tunnel.noPort', 'Agentry is not listening yet, so there is nothing to open a tunnel to.'),
  sshMissing: () => reason('tunnel.sshMissing', 'No ssh was found to run. Install the OpenSSH client (openssh-client) and try again.'),
  hostKey: () => reason('tunnel.hostKey', "localhost.run answered with a host key that is not the one Agentry pins, so the tunnel was not opened."),
  unverified: (host: string) => reason('tunnel.unverified', `localhost.run handed out ${host}, but Agentry could not reach itself through it.`, { host }),
  exited: (detail: string) => reason('tunnel.exited', `ssh ended before localhost.run handed out an address: ${detail}`, { detail }),
};

/** Is `bin` something this process can execute: a path that is, or a name found on the `PATH`. */
function findExecutable(bin: string): boolean {
  const runnable = (file: string): boolean => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(bin) || bin.includes('/')) return runnable(bin);
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir !== '' && runnable(join(dir, bin)));
}

/** The command line of a live process, or null when it is gone or cannot be read. */
function commandOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    // Not Linux, or no such process: `ps` answers on macOS, and fails for a pid that is gone
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
    } catch {
      return null;
    }
  }
}

async function defaultVerify(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/health', url), { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'manual' });
    if (res.status !== 200) return false;
    // The provider's own pages answer too; only Agentry's health has this shape
    const body = (await res.json()) as { ok?: unknown };
    return typeof body.ok === 'boolean';
  } catch {
    return false;
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const DEFAULT_SETTINGS: TunnelSettings = { startWithAgentry: false };

/**
 * The tunnel: one `ssh -R` child at a time, its state, and the host it lends the guard.
 *
 * `stopped → starting → verifying → active`, with `failed` and `stopping`. A dropped connection or
 * a new address goes back through `starting` or `verifying`: the old host leaves the allowlist at
 * once, the new one joins only once `/api/health` answers through it, and each move is a
 * `tunnel.changed` on the feed. The child dies with Agentry, and a pid file clears the one a crash
 * left behind on the next start.
 */
export class TunnelManager {
  private readonly dir: string;
  private readonly knownHosts: string;
  private readonly pidFile: string;
  private readonly settingsFile: string;
  private readonly timing: TunnelTiming;
  /**
   * Whether Agentry answers through an address. Public so a test that builds a whole `Core` can
   * route the check through the fake ssh's loopback proxy: the real one would ask the internet.
   */
  verify: (url: string, signal: AbortSignal) => Promise<boolean>;
  private settings: TunnelSettings = { ...DEFAULT_SETTINGS };
  private state: TunnelState = 'stopped';
  private reason: Localized | null = null;
  /** The address ssh last printed, verified or not */
  private address: string | null = null;
  /** The host lent to the guard: set only while `active` */
  private lent: string | null = null;
  private since: string | null = null;
  private sshAvailable: boolean;
  private target: { host: string; port: number } | null = null;
  private child: ChildProcess | null = null;
  /** Whether the person wants the tunnel open; reconnects only happen while it is true */
  private wanted = false;
  private attempts = 0;
  /** Aborted whenever the child it belongs to is replaced or the tunnel stops */
  private run = new AbortController();
  private stopping: Promise<void> | null = null;

  constructor(private readonly deps: TunnelDeps) {
    this.dir = join(deps.dataDir, 'tunnel');
    this.knownHosts = join(this.dir, 'known_hosts');
    this.pidFile = join(this.dir, 'ssh.pid');
    this.settingsFile = join(deps.dataDir, 'tunnel-settings.json');
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.verify = deps.verify ?? defaultVerify;
    this.sshAvailable = findExecutable(deps.sshBin);
    this.settings = this.readSettings();
    this.clearOrphan();
  }

  status(): TunnelStatus {
    const active = this.state === 'active';
    return {
      state: this.state,
      url: active ? this.address : null,
      since: active ? this.since : null,
      reason: this.state === 'failed' ? this.reason : null,
      sshAvailable: this.sshAvailable,
      settings: { ...this.settings },
    };
  }

  /** The PID of the ssh child, while there is one; for tests and diagnostics */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Where the tunnel forwards to: the port the server actually bound to, which is not always the
   * one it asked for. Opens the tunnel when "start with Agentry" is on.
   */
  attach(port: number, host = '127.0.0.1'): void {
    this.target = { host, port };
    if (!this.settings.startWithAgentry) return;
    this.start('agentry').catch((error: unknown) => {
      // Not thrown at startup: a tunnel that cannot open must not keep Agentry from starting
      if (error instanceof TunnelRefusedError) this.fail(error.reason);
    });
  }

  /**
   * Opens the tunnel. Refused under `mode: 'none'`: the tunnel would turn "whoever reaches the port
   * owns the machine" into "whoever has the URL does". A missing `ssh` is a state, not an error.
   */
  async start(actor: 'request' | 'agentry' = 'request'): Promise<TunnelStatus> {
    if (this.deps.security.mode === 'none') throw new TunnelRefusedError(REASONS.authRequired());
    if (!this.target) throw new TunnelRefusedError(REASONS.noPort());
    await this.stopping;
    if (this.wanted) return this.status();
    this.sshAvailable = findExecutable(this.deps.sshBin);
    if (!this.sshAvailable) {
      this.fail(REASONS.sshMissing());
      return this.status();
    }
    this.wanted = true;
    this.attempts = 0;
    if (actor !== 'request') this.deps.audit?.({ method: 'POST', path: '/api/tunnel/start', summary: 'Start the tunnel with Agentry' });
    this.connect();
    return this.status();
  }

  /** Closes the tunnel and takes its host off the allowlist before it answers. */
  async stop(why: 'request' | 'unguarded' = 'request'): Promise<TunnelStatus> {
    if (!this.wanted && !this.child) {
      if (this.state === 'failed') this.set('stopped');
      return this.status();
    }
    this.wanted = false;
    if (why === 'unguarded') this.deps.audit?.({ method: 'POST', path: '/api/tunnel/stop', summary: 'Stop the tunnel: authentication was turned off' });
    this.stopping ??= (async () => {
      this.run.abort();
      this.withdraw();
      this.set('stopping');
      await this.kill();
      this.address = null;
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
    if (body.startWithAgentry === undefined) return this.status();
    if (typeof body.startWithAgentry !== 'boolean') throw new Error('startWithAgentry must be a boolean');
    const next = { ...this.settings, startWithAgentry: body.startWithAgentry };
    await writeAtomic(this.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = next;
    this.changed();
    return this.status();
  }

  /**
   * Synchronous, for the process that is going away: there is no later to wait for the child in.
   * SIGTERM is enough for ssh, and whatever survives it is what the pid file is for.
   */
  shutdown(): void {
    this.wanted = false;
    this.run.abort();
    this.withdraw();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    rmSync(this.pidFile, { force: true });
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

  /**
   * A crash leaves the child behind, still forwarding to a port that may belong to somebody else
   * by now. It is only killed when its command line names this wrapper's `known_hosts`: a pid the
   * system handed to another process since is none of our business.
   */
  private clearOrphan(): void {
    if (!existsSync(this.pidFile)) return;
    const pid = Number(readFileSync(this.pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && commandOf(pid)?.includes(this.knownHosts)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Gone in between
      }
    }
    rmSync(this.pidFile, { force: true });
  }

  /**
   * Everything ssh needs is named here, and nothing is read from the person's `~/.ssh`: no config
   * file (`-F none`), no keys or agent (the `nokey` user authenticates with `none`), and a
   * `known_hosts` of Agentry's own that holds the pinned key and is never written by ssh.
   */
  private args(target: { host: string; port: number }): string[] {
    return [
      '-F', 'none',
      '-T',
      '-n',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=20',
      '-o', `UserKnownHostsFile=${this.knownHosts}`,
      '-o', 'GlobalKnownHostsFile=none',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UpdateHostKeys=no',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'IdentityAgent=none',
      '-o', 'IdentityFile=none',
      '-R', `80:${target.host}:${target.port}`,
      DESTINATION,
    ];
  }

  private connect(): void {
    const target = this.target;
    if (!target || !this.wanted) return;
    if (this.deps.security.mode === 'none') {
      void this.stop('unguarded');
      return;
    }
    this.run = new AbortController();
    const run = this.run;
    this.attempts++;
    this.address = null;
    this.set('starting');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Written on every attempt, so a file somebody edited is the pin again before ssh reads it
    writeFileSync(this.knownHosts, LOCALHOST_RUN_KNOWN_HOSTS, { mode: 0o600 });

    const child = spawn(this.deps.sshBin, this.args(target), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    if (child.pid) writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 });
    let failure: Localized | null = null;
    let lastLine = '';

    const onLine = (line: string): void => {
      if (run.signal.aborted) return;
      const url = parseTunnelUrl(line);
      if (url) {
        if (url !== this.address) void this.onAddress(url, run);
        return;
      }
      if (/host key verification failed|remote host identification has changed/i.test(line)) failure = REASONS.hostKey();
      // The banner names the caller's public address; it has no place in a reason shown on screen
      else if (line.trim() && !/connection id|^=+$/i.test(line.trim())) lastLine = line.trim();
    };
    if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine);
    if (child.stderr) createInterface({ input: child.stderr }).on('line', onLine);

    let ended = false;
    const onEnd = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (ended) return;
      ended = true;
      if (this.child === child) {
        this.child = null;
        rmSync(this.pidFile, { force: true });
      }
      if (run.signal.aborted || !this.wanted) return;
      run.abort();
      // The address it had is gone with it, and so is the host lent to the guard
      this.withdraw();
      const sawAddress = this.address !== null;
      this.address = null;
      if (failure?.code === 'tunnel.hostKey' || failure?.code === 'tunnel.sshMissing') {
        this.giveUp(failure);
        return;
      }
      this.retry(failure ?? (sawAddress ? null : REASONS.exited(lastLine || (signal ? `killed by ${signal}` : `exit code ${String(code)}`))));
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        this.sshAvailable = false;
        failure = REASONS.sshMissing();
      } else failure = REASONS.exited(error.message);
      // A child that never started emits no `close` to wait for
      if (child.pid === undefined) onEnd(null, null);
    });
    child.once('close', onEnd);
  }

  private retry(why: Localized | null): void {
    if (why) this.reason = why;
    if (this.attempts >= this.timing.maxAttempts) {
      this.giveUp(this.reason ?? REASONS.exited('the connection kept dropping'));
      return;
    }
    const wait = this.timing.backoffMs[Math.min(this.attempts - 1, this.timing.backoffMs.length - 1)] ?? 0;
    this.set('starting');
    const run = this.run = new AbortController();
    void sleep(wait, run.signal).then(() => {
      if (!run.signal.aborted && this.wanted) this.connect();
    });
  }

  private giveUp(why: Localized): void {
    this.wanted = false;
    void this.kill();
    this.fail(why);
  }

  /**
   * A new address, the first one or a change on the same connection. The old host leaves the
   * allowlist now; the new one joins only once Agentry answers through it, so nobody is sent to an
   * address that does not work yet, and a resolver asked too early does not cache it as missing.
   */
  private async onAddress(url: string, run: AbortController): Promise<void> {
    this.withdraw();
    this.address = url;
    this.set('verifying');
    const host = new URL(url).hostname;
    const deadline = Date.now() + this.timing.verifyTimeoutMs;
    const current = (): boolean => !run.signal.aborted && this.address === url && this.wanted;
    while (current()) {
      if (await this.verify(url, run.signal)) {
        if (!current()) return;
        if (this.deps.security.mode === 'none') {
          void this.stop('unguarded');
          return;
        }
        this.deps.hosts.add(host, TUNNEL_HOST_OPTIONS);
        this.lent = host;
        this.since = new Date().toISOString();
        this.attempts = 0;
        this.reason = null;
        this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${host} joined the allowlist` });
        this.set('active');
        return;
      }
      if (Date.now() >= deadline) break;
      await sleep(this.timing.verifyIntervalMs, run.signal);
    }
    if (!current()) return;
    // An address that never answers is a failed attempt: drop the connection and try another
    this.reason = REASONS.unverified(host);
    run.abort();
    this.address = null;
    await this.kill();
    if (this.wanted) this.retry(null);
  }

  /** Takes the lent host back from the guard, and writes down that it left. */
  private withdraw(): void {
    if (!this.lent) return;
    this.deps.hosts.remove(this.lent);
    this.deps.audit?.({ method: 'PUT', path: '/api/tunnel', summary: `Tunnel host ${this.lent} left the allowlist` });
    this.lent = null;
    this.since = null;
  }

  private async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    rmSync(this.pidFile, { force: true });
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), this.timing.killGraceMs);
    await closed;
    clearTimeout(timer);
  }

  private fail(why: Localized): void {
    this.reason = why;
    this.set('failed');
  }

  private set(state: TunnelState): void {
    if (state === this.state && state !== 'failed') return;
    this.state = state;
    // Kept while reconnecting, as what the next failure will say if it comes to that
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
