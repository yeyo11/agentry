import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_MODES, type AppSettings, type AppSettingSource, type AppSettingValues, type PermissionMode } from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { AgentryEventInput } from './events.ts';
import { APP_SETTING_ENV, DEFAULT_APP_SETTINGS, hostPatternProblem, type CoreConfig } from './paths.ts';

/*
 * Settings that used to be read from the environment once, at startup, and can now change while
 * Agentry runs. Each is read from three layers in a fixed order: the environment, then
 * `app-settings.json` in the data directory, then the default. The environment wins because it is
 * what whoever deployed the install decided, and the UI must not quietly override a deploy; it
 * shows such a value read-only instead, the way `AGENTRY_AUTH_TOKEN` already works for the guard.
 */

const KEYS = Object.keys(APP_SETTING_ENV) as (keyof AppSettingValues)[];

/** A list typed in a form, not a place to paste a zone file: past this it is a mistake. */
const MAX_HOSTS = 100;
const MAX_CONCURRENT_RUNS = 64;
/** What a host name or an IP literal is made of, plus `*` for the one pattern form the guard knows */
const HOST_CHARS = /^[a-z0-9.*:-]+$/;
/** An exact DNS name of at least two labels: what a tunnel provider hands out */
const EXACT_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const HEADER_NAME = /^[a-z0-9-]+$/;

/** What the chats and the orchestrator read when a run starts, so a change applies to the next one. */
export interface RunDefaults {
  readonly maxConcurrentRuns: number;
  readonly defaultPermissionMode: PermissionMode;
}

/**
 * One allowlist entry as typed by a person: trimmed and lowercased like the environment's, then
 * held to the same rule, so `*.com` is refused from the file exactly as it is from
 * `AGENTRY_ALLOWED_HOSTS`. A port is refused rather than dropped: the guard ignores ports, and an
 * entry that looks narrower than what it lets in is a misunderstanding worth saying out loud.
 */
function parseHost(value: unknown): string {
  if (typeof value !== 'string') throw new Error('allowedHosts must be an array of host names');
  const host = value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new Error('allowedHosts: a host name cannot be empty');
  const problem = hostPatternProblem(host);
  if (problem) throw new Error(`allowedHosts: ${problem}`);
  if (!HOST_CHARS.test(host)) throw new Error(`allowedHosts: '${value}' is not a host name`);
  // One colon is a name followed by a port; two or more is an IPv6 address
  if (host.split(':').length === 2) throw new Error(`allowedHosts: '${value}' carries a port; name the host alone, the guard ignores ports`);
  return host;
}

function parseValue<K extends keyof AppSettingValues>(key: K, value: unknown): AppSettingValues[K];
function parseValue(key: keyof AppSettingValues, value: unknown): AppSettingValues[keyof AppSettingValues] {
  switch (key) {
    case 'allowedHosts': {
      if (!Array.isArray(value)) throw new Error('allowedHosts must be an array of host names');
      if (value.length > MAX_HOSTS) throw new Error(`allowedHosts has more than ${MAX_HOSTS} entries`);
      return [...new Set(value.map(parseHost))];
    }
    case 'maxConcurrentRuns':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT_RUNS) {
        throw new Error(`maxConcurrentRuns must be a whole number from 1 to ${MAX_CONCURRENT_RUNS}`);
      }
      return value;
    case 'defaultPermissionMode':
      if (typeof value !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value)) {
        throw new Error(`defaultPermissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
      }
      return value as PermissionMode;
    case 'providersStepSeen':
      if (typeof value !== 'boolean') throw new Error('providersStepSeen must be true or false');
      return value;
  }
}

/**
 * What a stored document is worth. A key whose value a `PUT` would refuse is dropped and falls back
 * to the default, so a hand-edited file can never widen the allowlist past what the UI could, and
 * one bad key does not take the others with it.
 */
function sanitize(raw: unknown): Partial<AppSettingValues> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const doc = raw as Record<string, unknown>;
  const out: Partial<Record<keyof AppSettingValues, unknown>> = {};
  for (const key of KEYS) {
    if (doc[key] === undefined) continue;
    try {
      out[key] = parseValue(key, doc[key]);
    } catch {
      // Dropped: the default stands in for it
    }
  }
  return out as Partial<AppSettingValues>;
}

export interface RuntimeHostOptions {
  /**
   * The request header that carries the real client address for traffic on this host. Everything
   * through a tunnel arrives from loopback, so without it ten wrong guesses by a stranger would make
   * the owner wait too. Only read on this host: anywhere else anybody on the machine could forge it.
   */
  clientIpHeader?: string;
}

/**
 * Exact host names answered at runtime, beside the configured allowlist, each added and removed by
 * its owner (the tunnel). Never a pattern: `*.lhr.life` would let in everybody else's tunnels too.
 */
export class RuntimeHosts {
  private readonly hosts = new Map<string, RuntimeHostOptions>();

  add(host: string, options: RuntimeHostOptions = {}): void {
    const name = host.trim().toLowerCase();
    if (!EXACT_HOST.test(name)) throw new Error(`a runtime host must be an exact name such as 'abc.example.com', not '${host}'`);
    const header = options.clientIpHeader?.trim().toLowerCase();
    if (header !== undefined && !HEADER_NAME.test(header)) throw new Error(`'${options.clientIpHeader}' is not a header name`);
    this.hosts.set(name, header ? { clientIpHeader: header } : {});
  }

  remove(host: string): void {
    this.hosts.delete(host.trim().toLowerCase());
  }

  /** The options a host was added with, or undefined when it is not one of them; `name` is lowercased already */
  get(name: string): RuntimeHostOptions | undefined {
    return this.hosts.get(name);
  }

  list(): string[] {
    return [...this.hosts.keys()];
  }
}

export interface AppSettingsDeps {
  emit?: (event: AgentryEventInput) => void;
}

/**
 * `app-settings.json`, layered under the environment and over the defaults. The file is read once:
 * this store is its only writer, and the guard reads `allowedHosts` on every request, which a disk
 * read each time would make the slowest thing a request does.
 */
export class AppSettingsStore implements RunDefaults {
  private readonly file: string;
  private readonly fromEnv: ReadonlySet<keyof AppSettingValues>;
  private readonly env: AppSettingValues;
  private stored: Partial<AppSettingValues> = {};
  /** Why the file could not be read: every write is refused until someone fixes or removes it */
  private readonly broken: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private current: AppSettings;
  /** Exact names the tunnel adds and removes; the guard answers them beside `allowedHosts` */
  readonly runtimeHosts = new RuntimeHosts();

  constructor(
    config: CoreConfig,
    private readonly deps: AppSettingsDeps = {},
  ) {
    this.file = join(config.dataDir, 'app-settings.json');
    this.fromEnv = config.settingsFromEnv;
    this.env = { allowedHosts: [...config.allowedHosts], maxConcurrentRuns: config.maxConcurrentRuns, defaultPermissionMode: config.defaultPermissionMode, providersStepSeen: config.providersStepSeen };
    if (existsSync(this.file)) {
      try {
        this.stored = sanitize(JSON.parse(readFileSync(this.file, 'utf8')));
      } catch {
        // Not thrown: the defaults are what an install that never wrote the file runs on, so they
        // are safe to start with, and a broken settings file must not keep Agentry from starting.
        // Writes are refused, or the next one would overwrite whatever the person meant to keep.
        this.broken = `${this.file} is not valid JSON; fix or remove it`;
      }
    }
    this.current = this.resolve();
  }

  get(): AppSettings {
    return { ...this.current, allowedHosts: [...this.current.allowedHosts], sources: { ...this.current.sources } };
  }

  /** The configured allowlist: the same array until a change replaces it, so a reader can cache what it builds from it */
  get allowedHosts(): readonly string[] {
    return this.current.allowedHosts;
  }

  get maxConcurrentRuns(): number {
    return this.current.maxConcurrentRuns;
  }

  get defaultPermissionMode(): PermissionMode {
    return this.current.defaultPermissionMode;
  }

  /**
   * Changes the settings the body names, and only those. A setting the environment set is refused
   * rather than written: it would do nothing until the variable goes away, and then change
   * behaviour by surprise. The whole body is checked before anything is written.
   */
  async update(input: unknown): Promise<AppSettings> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('app settings must be a JSON object');
    const body = input as Record<string, unknown>;
    const unknownKeys = Object.keys(body).filter((key) => !(KEYS as string[]).includes(key));
    if (unknownKeys.length) throw new Error(`unknown app settings: ${unknownKeys.join(', ')}; known are ${KEYS.join(', ')}`);
    const changes: Partial<Record<keyof AppSettingValues, unknown>> = {};
    for (const key of KEYS) {
      if (body[key] === undefined) continue;
      if (this.fromEnv.has(key)) throw new Error(`${key} is set by the environment (${APP_SETTING_ENV[key]}) and cannot be changed here`);
      changes[key] = parseValue(key, body[key]);
    }
    if (this.broken) throw new Error(this.broken);
    if (!Object.keys(changes).length) return this.get();

    // Chained, so two writes in flight land in the order they were made and never share a temp
    // file, and each builds on the one before it rather than on what was stored when it arrived
    const write = this.writing.then(async () => {
      const next = { ...this.stored, ...(changes as Partial<AppSettingValues>) };
      await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.stored = next;
      this.current = this.resolve();
    });
    this.writing = write.catch(() => undefined);
    await write;
    const settings = this.get();
    this.deps.emit?.({ type: 'settings.changed', title: 'Settings changed', settings });
    return settings;
  }

  private resolve(): AppSettings {
    const values: Partial<Record<keyof AppSettingValues, unknown>> = {};
    const sources = {} as Record<keyof AppSettingValues, AppSettingSource>;
    for (const key of KEYS) {
      const source: AppSettingSource = this.fromEnv.has(key) ? 'env' : this.stored[key] !== undefined ? 'file' : 'default';
      sources[key] = source;
      values[key] = source === 'env' ? this.env[key] : source === 'file' ? this.stored[key] : DEFAULT_APP_SETTINGS[key];
    }
    const resolved = values as AppSettingValues;
    return { ...resolved, allowedHosts: [...resolved.allowedHosts], sources };
  }
}
