import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AccountConfig,
  AccountsOverview,
  AccountsSnapshot,
  AccountSummary,
  AccountUsage,
  AccountUsageWindow,
  AutoSwitchEvent,
  AutoSwitchSettings,
  CswapInfo,
  SwitchResult,
  SwitchStrategy,
  UpdateAccountConfigRequest,
  UsageHistoryPoint,
} from '@agentry/shared';
import { AccountConfigs, pickAccount } from './account-config.ts';
import { writeAtomic } from './config/files.ts';
import type { Db } from './db.ts';
import type { CoreConfig } from './paths.ts';

// Identifiers become CLI arguments: nothing that could be parsed as a flag gets through
const ACCOUNT_RE = /^[A-Za-z0-9][\w.@+-]{0,99}$/;
const ALIAS_RE = /^[A-Za-z0-9][\w.-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][\w.-]{0,31}$/;
const LIST_TTL_MS = 30_000;
const DETECT_TTL_MS = 60_000;
const CMD_TIMEOUT_MS = 90_000;
const RESTART_DELAY_MS = 5_000;
/** How often the usage is read for the history when nobody is looking at the accounts page. */
const SAMPLE_INTERVAL_MS = 5 * 60_000;
/** A reading that did not move is still kept this often, so a flat stretch of the line has points. */
const SAMPLE_KEEPALIVE_MS = 30 * 60_000;
const KEEP_USAGE_DAYS = 90;
/** A rate-limited account is not offered again by a policy for this long, whatever the usage says. */
const EXHAUSTED_TTL_MS = 30 * 60_000;
/** How much of the rotation history `overview()` carries; the rest is a query away. */
const OVERVIEW_EVENTS = 200;

/**
 * Claude Code reads these before the credentials file claude-swap swaps, so a child that
 * inherits them would ignore the selected account (claude-swap scrubs them for the same reason).
 */
export const AUTH_ENV_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'];

export const DEFAULT_AUTO_SWITCH: AutoSwitchSettings = {
  enabled: false,
  threshold: 90,
  strategy: 'best',
  models: [],
  intervalSec: 60,
  rotateOnLimit: true,
};

/** Where a chat runs: the account that decides its credential, and the config dir its process gets. */
export interface Launch {
  /** Slot number as a string, or the identifier the chat was pinned with; null leaves the active credential */
  account: string | null;
  /** `CLAUDE_CONFIG_DIR` of that account, when it has one of its own */
  configDir: string | null;
}

/** The environment a `claude` (or `cswap`) child gets while claude-swap owns the credentials. */
export function authFreeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of AUTH_ENV_VARS) delete clean[key];
  return clean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function toWindow(raw: unknown): AccountUsageWindow | null {
  const o = obj(raw);
  const pct = o ? num(o.pct) : null;
  if (!o || pct === null) return null;
  const name = str(o.name);
  return { pct, resetsAt: str(o.resetsAt), countdown: str(o.countdown), ...(name ? { name } : {}) };
}

function toUsage(raw: unknown): AccountUsage | null {
  const o = obj(raw);
  if (!o) return null;
  const scoped = Array.isArray(o.scoped) ? o.scoped.map(toWindow).filter((w): w is AccountUsageWindow => w !== null) : [];
  return { fiveHour: toWindow(o.fiveHour), sevenDay: toWindow(o.sevenDay), scoped };
}

/** Quota left in the binding window — the same number `cswap auto` reports as headroom. */
function headroom(usage: AccountUsage | null): number | null {
  const used = [usage?.fiveHour?.pct, usage?.sevenDay?.pct].filter((p): p is number => typeof p === 'number');
  return used.length ? Math.max(0, Math.round((100 - Math.max(...used)) * 10) / 10) : null;
}

function toAccount(raw: unknown): AccountSummary | null {
  const o = obj(raw);
  const number = o ? num(o.number) : null;
  if (!o || number === null) return null;
  const usage = toUsage(o.usage);
  return {
    number,
    email: str(o.email) ?? `account-${number}`,
    organizationName: str(o.organizationName),
    alias: str(o.alias),
    active: o.active === true,
    disabled: o.disabled === true,
    usageStatus: str(o.usageStatus) ?? 'unknown',
    usage,
    usageFetchedAt: str(o.usageFetchedAt),
    headroomPct: headroom(usage),
  };
}

/** `from`/`to` in a switch payload are either a label or an account object. */
function label(raw: unknown): string | null {
  const o = obj(raw);
  if (o) return str(o.email) ?? (num(o.number) !== null ? `account-${String(o.number)}` : null);
  return str(raw) ?? (typeof raw === 'number' ? `account-${raw}` : null);
}

/** One `cswap auto --json` line; an unparseable one is reported as an error event. */
export function toAutoEvent(line: string): Omit<AutoSwitchEvent, 'seq' | 'ts'> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { event: 'error', detail: line.slice(0, 300) };
  }
  return {
    event: str(raw.event) ?? 'poll',
    reason: str(raw.reason) ?? undefined,
    detail: str(raw.detail) ?? undefined,
    from: label(raw.from) ?? undefined,
    to: label(raw.to) ?? undefined,
    data: raw,
  };
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Thin layer over `cswap …`: claude-swap stays the owner of the account credentials, the
 * usage polling and the rotation policy. Everything degrades to "not installed" without it.
 */
export class AccountManager extends EventEmitter {
  private readonly file: string;
  private settings: AutoSwitchSettings = { ...DEFAULT_AUTO_SWITCH };
  private detectCache: { at: number; value: CswapInfo } | null = null;
  private listCache: { at: number; value: AccountSummary[] } | null = null;
  private auto: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Config directories and per-project rotation policies */
  readonly configs: AccountConfigs;
  /** The project id a working directory belongs to; set by Core, which owns the projects */
  projectOf: ((cwd: string) => string | null) | null = null;
  private readonly exhausted = new Map<number, number>();
  private sampler: NodeJS.Timeout | null = null;
  /** Serializes rotations so a reactive one never interleaves with a manual one */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: CoreConfig,
    private readonly db: Db,
  ) {
    super();
    this.file = join(config.dataDir, 'accounts.json');
    this.configs = new AccountConfigs(config);
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { autoSwitch?: Partial<AutoSwitchSettings> };
        this.settings = this.sanitize(saved.autoSwitch ?? {});
      } catch {
        this.settings = { ...DEFAULT_AUTO_SWITCH };
      }
    }
  }

  // ---------- process plumbing ----------

  private exec(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
    return new Promise((resolvePromise) => {
      const child = execFile(
        this.config.cswapBin,
        args,
        { timeout: opts.timeoutMs ?? CMD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: authFreeEnv() },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolvePromise({ stdout, stderr: stderr || (error && code !== 0 ? error.message : ''), code });
        },
      );
      if (opts.input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(opts.input.endsWith('\n') ? opts.input : `${opts.input}\n`);
      }
    });
  }

  private async json(args: string[], opts?: { input?: string }): Promise<Record<string, unknown>> {
    const res = await this.exec([...args, '--json'], opts);
    // The payload is pretty-printed and may follow a banner; notices go to stderr
    const start = res.stdout.indexOf('{');
    if (start !== -1) {
      try {
        return JSON.parse(res.stdout.slice(start)) as Record<string, unknown>;
      } catch {
        /* falls through to the error below */
      }
    }
    throw new Error((res.stderr || res.stdout).trim().slice(0, 500) || `cswap ${args.join(' ')} failed`);
  }

  private static account(identifier: unknown): string {
    const value = typeof identifier === 'number' ? String(identifier) : identifier;
    if (typeof value !== 'string' || !ACCOUNT_RE.test(value)) throw new Error('invalid account (number, email or alias)');
    return value;
  }

  // ---------- reads ----------

  async detect(force = false): Promise<CswapInfo> {
    if (!force && this.detectCache && Date.now() - this.detectCache.at < DETECT_TTL_MS) return this.detectCache.value;
    const res = await this.exec(['--version'], { timeoutMs: 15_000 });
    const value: CswapInfo =
      res.code === 0
        ? { installed: true, version: res.stdout.trim().split(' ').at(-1) ?? null, path: this.config.cswapBin }
        : {
            installed: false,
            version: null,
            path: null,
            error: res.stderr.trim().slice(0, 300) || `'${this.config.cswapBin}' was not found in PATH`,
          };
    this.detectCache = { at: Date.now(), value };
    return value;
  }

  async list(refresh = false): Promise<AccountSummary[]> {
    if (!refresh && this.listCache && Date.now() - this.listCache.at < LIST_TTL_MS) return this.listCache.value;
    if (!(await this.detect()).installed) return [];
    let accounts: AccountSummary[] = [];
    try {
      const json = await this.json(['list']);
      accounts = Array.isArray(json.accounts)
        ? json.accounts.map(toAccount).filter((a): a is AccountSummary => a !== null)
        : [];
    } catch {
      accounts = this.listCache?.value ?? []; // usage polling can fail transiently; keep the last picture
      this.listCache = { at: Date.now(), value: accounts };
      return accounts;
    }
    this.sample(accounts);
    this.listCache = { at: Date.now(), value: accounts };
    return accounts;
  }

  /** Forces the next read to hit claude-swap again, without losing the last known accounts. */
  private staleList(): void {
    if (this.listCache) this.listCache.at = 0;
  }

  /** True once claude-swap manages at least one account: from then on it owns the credential. */
  get managed(): boolean {
    return (this.listCache?.value.length ?? 0) > 0;
  }

  get autoSwitch(): AutoSwitchSettings {
    return { ...this.settings };
  }

  async overview(refresh = false): Promise<AccountsOverview> {
    const [cswap, accounts] = await Promise.all([this.detect(refresh), this.list(refresh)]);
    return {
      cswap,
      accounts,
      activeNumber: accounts.find((a) => a.active)?.number ?? null,
      autoSwitch: this.autoSwitch,
      autoSwitchRunning: this.auto !== null,
      events: this.db.rotationEvents({ limit: OVERVIEW_EVENTS }),
      configs: this.configs.list(),
      policies: this.configs.policies(),
    };
  }

  // ---------- usage history ----------

  /**
   * Keeps what claude-swap just reported as rows. The reading's own timestamp is the key, so the
   * same cached fetch seen twice is one row; a window that has not moved is written again only
   * after a while, which keeps a quiet account from filling the table with one value.
   */
  private sample(accounts: readonly AccountSummary[]): void {
    const now = Date.now();
    const points: UsageHistoryPoint[] = [];
    for (const account of accounts) {
      const at = account.usageFetchedAt ?? new Date(now).toISOString();
      for (const [window, reading] of [['5h', account.usage?.fiveHour], ['7d', account.usage?.sevenDay]] as const) {
        if (!reading) continue;
        const last = this.db.latestUsagePoint(account.number, window);
        if (last && (last.at >= at || (last.pct === reading.pct && now - Date.parse(last.at) < SAMPLE_KEEPALIVE_MS))) continue;
        points.push({ at, pct: reading.pct, window, account: account.number });
      }
    }
    this.db.appendUsagePoints(points);
  }

  /** Readings of one or every account, oldest first, for a chart. */
  usageHistory(opts: { account?: number; window?: UsageHistoryPoint['window']; since?: string; until?: string; limit?: number } = {}): UsageHistoryPoint[] {
    return this.db.usageHistory(opts);
  }

  // ---------- where a chat runs ----------

  private find(identifier: string): AccountSummary | undefined {
    return this.listCache?.value.find((a) => identifier === String(a.number) || identifier === a.email || identifier === a.alias);
  }

  private exhaustedNumbers(): Set<number> {
    const now = Date.now();
    for (const [number, until] of this.exhausted) if (until <= now) this.exhausted.delete(number);
    return new Set(this.exhausted.keys());
  }

  /** The policy governing the project a directory is in, if any. */
  private policyOf(cwd: string) {
    const project = this.projectOf?.(cwd) ?? null;
    return project ? this.configs.policyFor(project) : null;
  }

  /**
   * Decides where a chat runs, from what is cached: a chat is spawned synchronously, and a usage
   * read is a subprocess. A chat pinned by hand keeps its account whatever a policy says; one under
   * a project's policy takes the account that policy picks; any other stays on the active credential.
   * Either way the account's own config directory, if it has one, rides along.
   */
  launchFor(chat: { account: string | null; cwd: string }): Launch {
    const accounts = this.listCache?.value ?? [];
    const active = accounts.find((a) => a.active);
    let target = chat.account ? this.find(chat.account) : undefined;
    if (!chat.account) {
      const policy = this.policyOf(chat.cwd);
      const picked = policy ? pickAccount(policy, accounts, { current: active?.number ?? null, exhausted: this.exhaustedNumbers() }) : null;
      target = picked ?? undefined;
    }
    const account = target ? String(target.number) : chat.account;
    const owner = target ?? (chat.account ? undefined : active);
    return { account, configDir: owner ? this.configs.configDirOf(owner.number) : null };
  }

  /**
   * A chat under a project's policy hit its limit: that account is set aside for a while and the
   * policy is asked again, which moves the chat without touching the credential every other chat
   * shares. Null when no policy governs the chat, so the global rotation handles it as before.
   */
  async rotateWithinPolicy(chat: { account: string | null; cwd: string }, reason: string): Promise<SwitchResult | null> {
    if (chat.account || !this.policyOf(chat.cwd)) return null;
    const from = this.launchFor(chat).account;
    const fromAccount = from ? this.find(from) : undefined;
    if (fromAccount) this.exhausted.set(fromAccount.number, Date.now() + EXHAUSTED_TTL_MS);
    await this.list(true);
    const to = this.launchFor(chat).account;
    const toAccount = to && to !== from ? this.find(to) : undefined;
    const fromLabel = fromAccount?.email ?? from ?? null;
    if (!toAccount) {
      const result = { switched: false, from: fromLabel, to: null, reason: 'no account the project\'s policy allows has quota left' };
      this.record({ event: 'no-switch', reason: result.reason, detail: reason });
      return result;
    }
    const result = { switched: true, from: fromLabel, to: toAccount.email, reason: 'project rotation policy' };
    this.record({ event: 'rotate', from: result.from ?? undefined, to: result.to, reason: result.reason, detail: reason });
    return result;
  }

  // ---------- config directory ----------

  /** Sets or clears an account's config directory; the account has to be one claude-swap manages. */
  async setConfig(identifier: unknown, request: UpdateAccountConfigRequest): Promise<AccountConfig | null> {
    const account = this.find(AccountManager.account(identifier));
    if (!account) throw new Error('account not found');
    return this.configs.setConfigDir(account.number, request);
  }

  /** Cheap, cache-only view for the dashboard; null until claude-swap is known to be there. */
  snapshot(): AccountsSnapshot | null {
    if (!this.detectCache?.value.installed) return null;
    const accounts = this.listCache?.value ?? [];
    return {
      installed: true,
      total: accounts.length,
      active: accounts.find((a) => a.active) ?? null,
      autoSwitchRunning: this.auto !== null,
    };
  }

  /** The account a pinned run would resolve to, so the runner can skip `cswap run` for it. */
  isActive(identifier: string): boolean {
    const active = this.listCache?.value.find((a) => a.active);
    if (!active) return false;
    return identifier === String(active.number) || identifier === active.email || identifier === active.alias;
  }

  // ---------- writes ----------

  /** Every rotation goes through here, so two of them never interleave. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  switch(target?: string, strategy?: SwitchStrategy): Promise<SwitchResult> {
    const args = ['switch'];
    if (target !== undefined) args.push(AccountManager.account(target));
    if (strategy !== undefined) {
      if (strategy !== 'best' && strategy !== 'next-available') throw new Error("strategy must be 'best' or 'next-available'");
      args.push('--strategy', strategy);
    }
    return this.serialize(async () => {
      const json = await this.json(args);
      const result: SwitchResult = {
        switched: json.switched === true,
        from: label(json.from),
        to: label(json.to),
        reason: str(json.reason),
      };
      if (result.switched) {
        this.markActive(result.to);
        this.record({ event: 'switch', from: result.from ?? undefined, to: result.to ?? undefined, reason: result.reason ?? undefined });
        this.emit('switched', result);
      }
      this.staleList();
      return result;
    });
  }

  /** Moves the `active` flag in the cached picture, so pinning decisions follow a switch at once. */
  private markActive(target: string | null): void {
    const accounts = this.listCache?.value;
    if (!accounts || !target) return;
    const matches = (a: AccountSummary) => a.email === target || String(a.number) === target || `account-${a.number}` === target;
    if (!accounts.some(matches)) return;
    this.listCache = { at: 0, value: accounts.map((a) => ({ ...a, active: matches(a) })) };
  }

  /**
   * Rotation driven by the wrapper itself (a run that hit its limit). Picks the account with
   * the most headroom left and reports why it moved.
   */
  async rotate(reason: string): Promise<SwitchResult> {
    const result = await this.switch(undefined, 'best');
    if (!result.switched) this.record({ event: 'no-switch', reason: result.reason ?? 'no viable target', detail: reason });
    return result;
  }

  async addToken(token: unknown, opts: { slot?: number; email?: string } = {}): Promise<SwitchResult> {
    if (typeof token !== 'string' || !token.trim()) throw new Error('token is required');
    if (/\s/.test(token.trim())) throw new Error('invalid token');
    const args = ['add-token', '-'];
    if (opts.slot !== undefined) {
      if (!Number.isInteger(opts.slot) || opts.slot < 1 || opts.slot > 99) throw new Error('slot must be between 1 and 99');
      args.push('--slot', String(opts.slot));
    }
    if (opts.email !== undefined) {
      if (!ACCOUNT_RE.test(opts.email)) throw new Error('invalid email label');
      args.push('--email', opts.email);
    }
    // The token goes in on stdin: an argv would be visible in the process table
    const res = await this.exec(args, { input: token.trim() });
    this.staleList();
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().slice(0, 500) || 'cswap add-token failed');
    return { switched: false, from: null, to: null, reason: 'account registered' };
  }

  private async action(args: string[]): Promise<void> {
    const res = await this.exec(args);
    this.staleList();
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().slice(0, 500) || `cswap ${args[0]} failed`);
  }

  remove(identifier: unknown): Promise<void> {
    return this.action(['remove', AccountManager.account(identifier)]);
  }

  enable(identifier: unknown): Promise<void> {
    return this.action(['enable', AccountManager.account(identifier)]);
  }

  disable(identifier: unknown): Promise<void> {
    return this.action(['disable', AccountManager.account(identifier)]);
  }

  setAlias(identifier: unknown, alias: unknown): Promise<void> {
    const account = AccountManager.account(identifier);
    if (alias === null || alias === undefined || alias === '') return this.action(['alias', account, '--unset']);
    if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) throw new Error('invalid alias (letters, digits, _ . -)');
    return this.action(['alias', account, alias]);
  }

  // ---------- auto-switch supervisor ----------

  private sanitize(input: Partial<AutoSwitchSettings>): AutoSwitchSettings {
    const base = { ...DEFAULT_AUTO_SWITCH, ...input };
    if (base.strategy !== 'best' && base.strategy !== 'consume-first') throw new Error("strategy must be 'best' or 'consume-first'");
    const threshold = Number(base.threshold);
    if (!Number.isFinite(threshold) || threshold < 50 || threshold > 99.9) throw new Error('threshold must be between 50 and 99.9');
    const intervalSec = Math.round(Number(base.intervalSec));
    if (!Number.isFinite(intervalSec) || intervalSec < 15 || intervalSec > 3600) throw new Error('intervalSec must be between 15 and 3600');
    const models = Array.isArray(base.models) ? base.models.map(String) : [];
    for (const model of models) if (!MODEL_RE.test(model)) throw new Error(`invalid model name '${model}'`);
    return {
      enabled: base.enabled === true,
      threshold: Math.round(threshold * 10) / 10,
      strategy: base.strategy,
      models,
      intervalSec,
      rotateOnLimit: base.rotateOnLimit !== false,
    };
  }

  async setAutoSwitch(input: Partial<AutoSwitchSettings>): Promise<AutoSwitchSettings> {
    this.settings = this.sanitize({ ...this.settings, ...input });
    await writeAtomic(this.file, `${JSON.stringify({ autoSwitch: this.settings }, null, 2)}\n`);
    this.stopAuto();
    if (this.settings.enabled) await this.startAuto();
    return this.autoSwitch;
  }

  /**
   * Every rotation event is appended to the store, so a restart no longer takes the history
   * with it — diagnosing "the account changed on its own" needs the record to outlive the process.
   */
  private record(event: Omit<AutoSwitchEvent, 'seq' | 'ts'>): AutoSwitchEvent {
    const full = this.db.appendRotationEvent({ ts: new Date().toISOString(), ...event });
    this.emit('event', full);
    return full;
  }

  /** Rotation history beyond the window `overview()` carries. */
  history(opts: { limit?: number; since?: string } = {}): AutoSwitchEvent[] {
    return this.db.rotationEvents(opts);
  }

  /** Supervises `cswap auto --json`, reusing its cooldown, hysteresis and quarantine logic. */
  async startAuto(): Promise<void> {
    if (this.auto || this.stopped || !this.settings.enabled) return;
    if (!(await this.detect()).installed) return;
    const args = [
      'auto',
      '--json',
      '--interval', String(this.settings.intervalSec),
      '--threshold', String(this.settings.threshold),
      '--strategy', this.settings.strategy,
    ];
    if (this.settings.models.length) args.push('--model', this.settings.models.join(','));

    const child = spawn(this.config.cswapBin, args, { env: authFreeEnv(), stdio: 'pipe' });
    this.auto = child;
    createInterface({ input: child.stdout }).on('line', (line) => this.handleAutoLine(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) this.record({ event: 'error', detail: line.slice(0, 300) });
    });
    child.on('error', (err) => this.record({ event: 'error', detail: err.message }));
    child.on('exit', (code) => {
      this.auto = null;
      if (this.stopped || !this.settings.enabled) return;
      this.record({ event: 'error', detail: `cswap auto exited (${String(code)}); restarting` });
      this.restartTimer = setTimeout(() => void this.startAuto(), RESTART_DELAY_MS);
      this.restartTimer.unref();
    });
  }

  private handleAutoLine(line: string): void {
    if (!line.trim()) return;
    const record = this.record(toAutoEvent(line));
    if (record.event === 'switch') {
      this.markActive(record.to ?? null);
      this.staleList();
      this.emit('switched', { switched: true, from: record.from ?? null, to: record.to ?? null, reason: record.reason ?? null });
    }
  }

  stopAuto(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.auto?.kill('SIGTERM');
    this.auto = null;
  }

  /** Called at boot: learns whether claude-swap owns the credentials and starts the supervisor. */
  async init(): Promise<void> {
    await this.list(true).catch(() => []);
    this.startSampler();
    if (this.settings.enabled) await this.startAuto().catch(() => {});
  }

  /** Reads the usage now and then, so the history has points while nobody has the page open. */
  private startSampler(): void {
    if (this.sampler || this.stopped || !this.detectCache?.value.installed) return;
    this.db.pruneUsageHistory(new Date(Date.now() - KEEP_USAGE_DAYS * 86_400_000).toISOString());
    this.sampler = setInterval(() => void this.list(true).catch(() => []), SAMPLE_INTERVAL_MS);
    this.sampler.unref();
  }

  shutdown(): void {
    this.stopped = true;
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
    this.stopAuto();
  }
}
