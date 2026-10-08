import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { LoginErrorCode, LoginMethod, LoginSession, SetupTool, SignOutResult, StartLoginRequest } from '@agentry/shared';
import { childEnv } from '../child-env.ts';
import type { AgentryEventInput } from '../events.ts';
import { buildHostEnv } from '../hosts/env.ts';
import { runHostCall, type HostCall, type HostResult, type RunOptions } from '../hosts/exec.ts';
import { killGroup } from '../processes.ts';
import type { SecretVault } from '../secret-vault.ts';
import type { YoutrackCredentialStore } from '../trackers/youtrack/credentials.ts';
import { DEVICE_PATTERNS, readDeviceLine, type DevicePattern } from './device-patterns.ts';
import { isSetupTool, TOOL_LOGINS } from './methods.ts';

/** How long a device sign-in waits for the person, unless the code says less */
export const LOGIN_LIFETIME_MS = 15 * 60 * 1000;
/** A key login or a sign-out command that takes longer than this is stopped */
export const LOGIN_COMMAND_TIMEOUT_MS = 60_000;
/** Ended sessions stay readable this long, for a client that reconnects after the event */
const KEEP_ENDED_MS = 60 * 60 * 1000;
const MAX_SECRET = 4096;
/** A host name, with a port at most; it goes into argv, so it may never start with a dash */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;

/** A request that cannot start a sign-in; its message never carries the key */
export class LoginInputError extends Error {
  readonly statusCode = 400;
}

/** A sign-in this Agentry does not offer here: the request was understood, the deploy forbids it */
export class LoginRefusedError extends Error {
  readonly statusCode = 409;
}

/** The node name a managed tailscaled signs in with when the deps name none */
const DEFAULT_TAILSCALE_NAME = 'agentry';

export interface LoginServiceDeps {
  vault: Pick<SecretVault, 'set' | 'clear'>;
  youtrack: Pick<YoutrackCredentialStore, 'set' | 'clear'>;
  emit: (event: AgentryEventInput) => unknown;
  /** The tool's binary as its detector resolved it (an override included); null when it is not there */
  binary: (tool: SetupTool) => Promise<string | null>;
  /**
   * The tool's readiness, read again: true signed in, false not, null when the vendor offers no
   * probe. This is what decides whether a sign-in worked, never what the CLI printed.
   */
  readiness: (tool: SetupTool, host: string | null) => Promise<boolean | null>;
  /**
   * Why this deploy does not sign a tool in or out, or null when it does (every tool by default).
   * Tailscale is signed in only where Agentry runs its daemon: a machine's own is the person's.
   */
  refusal?: (tool: SetupTool) => string | null;
  /** Runs before a sign-out command: Tailscale's closes the tunnel first, while the daemon can still take its rule away */
  beforeSignOut?: (tool: SetupTool) => Promise<void>;
  /** The node name `tailscale up --hostname` signs in with */
  tailscaleName?: string;
  /** The environment children start from; the server's own by default */
  baseEnv?: NodeJS.ProcessEnv;
  /** Runs a call of gh or glab; the execution layer by default */
  runHost?: (call: HostCall, options: RunOptions) => Promise<HostResult>;
  now?: () => number;
  lifetimeMs?: number;
  commandTimeoutMs?: number;
  killGraceMs?: number;
}

interface Live {
  session: LoginSession;
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
}

type Outcome = { exitCode: number | null; error: LoginErrorCode | null };

const isHostCli = (tool: SetupTool): tool is 'gh' | 'glab' => tool === 'gh' || tool === 'glab';
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ENDED: ReadonlySet<LoginSession['state']> = new Set(['succeeded', 'failed', 'expired', 'cancelled']);

/**
 * Runs the documented sign-ins of the first setup (docs/setup.md), one live session per tool and
 * host. A key either goes into the vault (a tool that reads it from its environment) or once into
 * the CLI's own login command on stdin; a device sign-in runs the vendor's command with no
 * terminal and shows the person the URL and the code it printed. Whether it worked is the tool's
 * readiness probe, read again once the command ended. A key never goes into argv, a log, an event
 * or an answer, and nothing the CLI printed but the URL and the code leaves this class.
 */
export class LoginService {
  private readonly sessions = new Map<string, Live>();
  private readonly now: () => number;
  private readonly lifetimeMs: number;
  private readonly commandTimeoutMs: number;
  private readonly killGraceMs: number;

  constructor(private readonly deps: LoginServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.lifetimeMs = deps.lifetimeMs ?? LOGIN_LIFETIME_MS;
    this.commandTimeoutMs = deps.commandTimeoutMs ?? LOGIN_COMMAND_TIMEOUT_MS;
    this.killGraceMs = deps.killGraceMs ?? 5_000;
  }

  get(id: string): LoginSession | null {
    const live = this.sessions.get(id);
    return live ? { ...live.session } : null;
  }

  /**
   * Starts a sign-in. A key sign-in answers once it ended; a device sign-in answers at once, in
   * `starting`, and `login.updated` follows it. A live sign-in of the same tool and host is
   * cancelled first: the person pressed Sign in again.
   */
  async start(input: unknown): Promise<LoginSession> {
    const request = this.parse(input);
    this.refuse(request.tool);
    const login = TOOL_LOGINS[request.tool];
    const host = this.hostOf(request);
    // What a command takes in place of a host: Tailscale's node name, which is the deploy's and not the request's
    const target = request.tool === 'tailscale' ? (this.deps.tailscaleName ?? DEFAULT_TAILSCALE_NAME) : (host ?? '');
    this.prune();
    for (const live of this.sessions.values()) {
      if (live.session.tool === request.tool && live.session.host === host && !ENDED.has(live.session.state)) this.cancel(live.session.id);
    }
    if (request.method === 'device') {
      if (!login.deviceCommand) throw new LoginInputError(`${request.tool} has no device-code sign-in`);
      return this.device(request.tool, host, login.deviceCommand(target));
    }
    const secret = this.secretOf(request.secret);
    if (login.methods.key === 'env') {
      const variable = request.variable ?? login.methods.variables[0];
      if (!variable || !login.methods.variables.includes(variable)) throw new LoginInputError(`variable must be one of ${login.methods.variables.join(', ')}`);
      return this.envKey(request.tool, host, variable, secret);
    }
    if (!login.keyCommand) throw new LoginInputError(`${request.tool} takes no key`);
    if (login.methods.key === 'file') return this.fileKey(request.tool, host, login.keyCommand(target), secret);
    return this.stdinKey(request.tool, host, login.keyCommand(target), secret);
  }

  /** Stops a live sign-in and kills what it started; an ended one is answered as it is */
  cancel(id: string): LoginSession | null {
    const live = this.sessions.get(id);
    if (!live) return null;
    if (!ENDED.has(live.session.state)) this.end(live, 'cancelled', null);
    return { ...live.session };
  }

  /**
   * Signs a tool out with the vendor's documented command, or by forgetting what the vault keeps.
   * Copilot documents none, and says so rather than guessing at its files.
   */
  async signOut(toolInput: string, hostInput?: string): Promise<SignOutResult> {
    if (!isSetupTool(toolInput)) throw new LoginInputError(`unknown tool ${toolInput}`);
    const tool = toolInput;
    this.refuse(tool);
    const login = TOOL_LOGINS[tool];
    const host = isHostCli(tool) ? this.hostName(hostInput, login.methods.defaultHost) : null;
    const result = (signedOut: boolean, reason: SignOutResult['reason']): SignOutResult => ({ tool, host, signedOut, reason });
    if (!login.methods.signOut) return result(false, 'unsupported');

    let outcome: Outcome = { exitCode: 0, error: null };
    await this.deps.beforeSignOut?.(tool);
    if (tool === 'youtrack') await this.deps.youtrack.clear();
    else if (login.methods.key === 'env') await this.deps.vault.clear(tool);
    if (login.signOutCommand) outcome = await this.command(tool, host, login.signOutCommand(host ?? ''), null);
    await this.deps.readiness(tool, host).catch(() => null);
    if (outcome.error === 'cli-missing') return result(tool === 'claude-code', tool === 'claude-code' ? null : 'cli-missing');
    return outcome.exitCode === 0 ? result(true, null) : result(false, 'cli-refused');
  }

  /** Kills every live sign-in; the server is stopping */
  close(): void {
    for (const live of this.sessions.values()) if (!ENDED.has(live.session.state)) this.end(live, 'cancelled', null);
  }

  private refuse(tool: SetupTool): void {
    const why = this.deps.refusal?.(tool) ?? null;
    if (why) throw new LoginRefusedError(why);
  }

  private parse(input: unknown): StartLoginRequest {
    if (!isObject(input)) throw new LoginInputError('the body must be an object');
    if (!isSetupTool(input.tool)) throw new LoginInputError(`tool must be one of ${Object.keys(TOOL_LOGINS).join(', ')}`);
    const method = input.method;
    if (method !== 'key' && method !== 'device') throw new LoginInputError('method must be key or device');
    if (input.host !== undefined && typeof input.host !== 'string') throw new LoginInputError('host must be a string');
    if (input.variable !== undefined && typeof input.variable !== 'string') throw new LoginInputError('variable must be a string');
    return {
      tool: input.tool,
      method: method satisfies LoginMethod,
      ...(typeof input.host === 'string' ? { host: input.host } : {}),
      ...(typeof input.secret === 'string' ? { secret: input.secret } : input.secret === undefined ? {} : { secret: '' }),
      ...(typeof input.variable === 'string' ? { variable: input.variable } : {}),
    };
  }

  private hostOf(request: StartLoginRequest): string | null {
    const methods = TOOL_LOGINS[request.tool].methods;
    if (request.tool === 'youtrack') {
      // The instance's address; the YouTrack store checks and normalises it
      if (!request.host?.trim()) throw new LoginInputError('host is the YouTrack address and is required');
      return request.host.trim();
    }
    return isHostCli(request.tool) ? this.hostName(request.host, methods.defaultHost) : null;
  }

  private hostName(input: string | undefined, fallback: string | null): string {
    const host = (input?.trim() || fallback || '').toLowerCase();
    if (!HOST_NAME.test(host)) throw new LoginInputError('host must be a host name such as github.com');
    return host;
  }

  /** The message never echoes the value: a key pasted into the wrong field is still a key */
  private secretOf(input: string | undefined): string {
    const secret = input?.trim() ?? '';
    if (!secret || secret.length > MAX_SECRET || /\s/.test(secret)) throw new LoginInputError(`the key must be one token of at most ${String(MAX_SECRET)} characters, with no spaces`);
    return secret;
  }

  private open(tool: SetupTool, method: LoginMethod, host: string | null): Live {
    const at = this.now();
    const session: LoginSession = {
      id: randomUUID(),
      tool,
      method,
      host,
      state: 'starting',
      url: null,
      code: null,
      startedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.lifetimeMs).toISOString(),
      endedAt: null,
      error: null,
      ready: null,
    };
    const live: Live = { session, child: null, timer: null };
    this.sessions.set(session.id, live);
    this.publish(live);
    return live;
  }

  private publish(live: Live): void {
    this.deps.emit({ type: 'login.updated', title: `Sign-in ${live.session.state}`, login: { ...live.session } });
  }

  private end(live: Live, state: 'succeeded' | 'failed' | 'expired' | 'cancelled', error: LoginErrorCode | null, ready: boolean | null = null): void {
    if (ENDED.has(live.session.state)) return;
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    const child = live.child;
    live.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), this.killGraceMs).unref();
    }
    live.session = { ...live.session, state, error, ready, endedAt: new Date(this.now()).toISOString() };
    this.publish(live);
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_ENDED_MS;
    for (const [id, live] of this.sessions) {
      if (live.session.endedAt && Date.parse(live.session.endedAt) < cutoff) this.sessions.delete(id);
    }
  }

  /** Claude Code, Gemini, OpenCode, YouTrack: the key is theirs to read from the environment, so the vault keeps it */
  private async envKey(tool: SetupTool, host: string | null, variable: string, secret: string): Promise<LoginSession> {
    if (tool === 'youtrack') {
      // Checked before a session exists: an address that is not one is the request's fault
      try {
        await this.deps.youtrack.set({ host, token: secret });
      } catch (err) {
        throw new LoginInputError(err instanceof Error ? err.message : 'invalid YouTrack address');
      }
    } else {
      await this.deps.vault.set(tool, { [variable]: secret }, { replace: TOOL_LOGINS[tool].methods.exclusive || TOOL_LOGINS[tool].methods.variables.length === 1 });
    }
    const live = this.open(tool, 'key', host);
    const ready = await this.deps.readiness(tool, host).catch(() => null);
    // Stored is done: a probe that says signed out is shown beside it, the key is not taken back
    this.end(live, 'succeeded', null, ready);
    return { ...live.session };
  }

  /** Codex, Copilot, gh, glab: the key goes once to the CLI's own login on stdin, and the CLI stores it */
  private async stdinKey(tool: SetupTool, host: string | null, args: string[], secret: string): Promise<LoginSession> {
    const live = this.open(tool, 'key', host);
    const outcome = await this.command(tool, host, args, `${secret}\n`);
    return this.keyEnded(live, tool, host, outcome);
  }

  /**
   * Tailscale: its CLI takes a key in argv or from a file named there, never on stdin. The key goes
   * into a file of mode 0600 in a folder of mode 0700 that only this sign-in uses, the command is
   * told `--auth-key=file:<path>`, and the folder is removed once the command ended, whatever happened.
   */
  private async fileKey(tool: SetupTool, host: string | null, args: string[], secret: string): Promise<LoginSession> {
    const live = this.open(tool, 'key', host);
    let outcome: Outcome;
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'agentry-key-'));
      const file = join(dir, 'key');
      await writeFile(file, secret, { mode: 0o600, flag: 'wx' });
      outcome = await this.command(tool, host, [...args, `--auth-key=file:${file}`], null);
    } catch {
      outcome = { exitCode: null, error: 'spawn-failed' };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return this.keyEnded(live, tool, host, outcome);
  }

  /** A key login ended: it worked only when the command did and the readiness probe agrees */
  private async keyEnded(live: Live, tool: SetupTool, host: string | null, outcome: Outcome): Promise<LoginSession> {
    if (outcome.error) {
      this.end(live, 'failed', outcome.error);
    } else if (outcome.exitCode !== 0) {
      this.end(live, 'failed', 'cli-refused');
    } else {
      const ready = await this.deps.readiness(tool, host).catch(() => null);
      if (ready === true) this.end(live, 'succeeded', null, ready);
      else this.end(live, 'failed', 'not-signed-in', ready);
    }
    return { ...live.session };
  }

  /** Runs one command to its end: gh and glab through the execution layer, an agent through its binary */
  private async command(tool: SetupTool, host: string | null, args: string[], input: string | null): Promise<Outcome> {
    const binary = await this.deps.binary(tool);
    if (!binary) return { exitCode: null, error: 'cli-missing' };
    if (isHostCli(tool)) {
      const run = this.deps.runHost ?? runHostCall;
      const result = await run(
        { cli: tool, args, ...(input !== null ? { input } : {}), kind: 'write', class: 'write', host },
        { binaryPath: binary, cwd: tmpdir(), baseEnv: this.deps.baseEnv ?? process.env, timeoutMs: this.commandTimeoutMs, killGraceMs: this.killGraceMs },
      );
      if (result.reason === 'cli-missing') return { exitCode: null, error: 'cli-missing' };
      if (result.reason === 'timeout') return { exitCode: null, error: 'timeout' };
      return { exitCode: result.exitCode, error: null };
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (outcome: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      let child: ChildProcess;
      try {
        child = spawn(binary, args, { env: this.envOf(tool), cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false });
      } catch {
        resolve({ exitCode: null, error: 'spawn-failed' });
        return;
      }
      const timer = setTimeout(() => {
        killGroup(child, 'SIGKILL');
        done({ exitCode: null, error: 'timeout' });
      }, this.commandTimeoutMs);
      // What it prints is read by nobody: success is the readiness probe's
      child.stdout?.resume();
      child.stderr?.resume();
      child.on('error', (error: NodeJS.ErrnoException) => done({ exitCode: null, error: error.code === 'ENOENT' || error.code === 'EACCES' ? 'cli-missing' : 'spawn-failed' }));
      child.on('close', (code) => done({ exitCode: code, error: null }));
      child.stdin?.on('error', () => {});
      child.stdin?.end(input ?? '');
    });
  }

  private envOf(tool: SetupTool): NodeJS.ProcessEnv {
    const base = this.deps.baseEnv ?? process.env;
    return isHostCli(tool) ? buildHostEnv(tool, base) : childEnv(tool, base);
  }

  /**
   * The vendor's device-code command, with stdin closed and no terminal. Each line of stdout and
   * stderr is read for the URL and the code alone; once both are there the session waits for the
   * person. The command's exit ends it, and the readiness probe says whether it worked.
   */
  private async device(tool: SetupTool, host: string | null, args: string[]): Promise<LoginSession> {
    const pattern: DevicePattern | undefined = (DEVICE_PATTERNS as Readonly<Record<string, DevicePattern>>)[tool];
    const live = this.open(tool, 'device', host);
    const binary = await this.deps.binary(tool);
    if (!pattern || !binary) {
      this.end(live, 'failed', 'cli-missing');
      return { ...live.session };
    }
    if (ENDED.has(live.session.state)) return { ...live.session };
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env: this.envOf(tool), cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
    } catch {
      this.end(live, 'failed', 'spawn-failed');
      return { ...live.session };
    }
    live.child = child;
    live.timer = setTimeout(() => this.end(live, 'expired', null), this.lifetimeMs);

    // A sign-in with no code to type (Tailscale) is shown once its URL is
    const shown = (): boolean => live.session.url !== null && (live.session.code !== null || pattern.code === null);
    const read = (line: string): void => {
      if (ENDED.has(live.session.state) || shown()) return;
      const found = readDeviceLine(pattern, line);
      const url = live.session.url ?? found.url;
      const code = live.session.code ?? found.code;
      if (url === live.session.url && code === live.session.code) return;
      live.session = { ...live.session, url, code };
      if (shown()) {
        live.session = { ...live.session, state: 'waiting-for-person' };
        this.publish(live);
      }
    };
    if (child.stdout) createInterface({ input: child.stdout }).on('line', read);
    if (child.stderr) createInterface({ input: child.stderr }).on('line', read);

    child.on('error', (error: NodeJS.ErrnoException) => this.end(live, 'failed', error.code === 'ENOENT' || error.code === 'EACCES' ? 'cli-missing' : 'spawn-failed'));
    child.on('close', (code) => {
      if (live.child !== child || ENDED.has(live.session.state)) return;
      live.child = null;
      if (!shown()) {
        if (code !== 0) return this.end(live, 'failed', 'no-code');
      } else if (code !== 0) {
        return this.end(live, 'failed', 'cli-refused');
      }
      void this.deps
        .readiness(tool, host)
        .catch(() => null)
        .then((ready) => (ready === true ? this.end(live, 'succeeded', null, ready) : this.end(live, 'failed', 'not-signed-in', ready)));
    });
    return { ...live.session };
  }
}
