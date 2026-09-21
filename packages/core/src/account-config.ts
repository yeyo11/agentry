import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AccountConfig,
  AccountSummary,
  RotationPolicy,
  RotationPolicyRequest,
  UpdateAccountConfigRequest,
} from '@agentry/shared';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

/**
 * Settings a per-account config directory can borrow from the shared one. Symlinks, as claude-swap
 * does for its own session profiles: Claude Code writes through a symlink, so editing them from
 * inside the account still lands in the one file.
 */
const SHARED_SETTINGS = ['settings.json', 'CLAUDE.md', 'keybindings.json', 'agents', 'commands', 'skills'];

/**
 * Always linked: Agentry reads transcripts from the shared `projects/`, so an account whose chats
 * wrote theirs anywhere else would vanish from every list the moment the chat ended.
 */
const HISTORY = 'projects';

const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 99.9;

interface Stored {
  configs: Record<string, { configDir: string; links: string[] }>;
  policies: RotationPolicy[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A symlink at `path` that points at `target`; anything else at that path is not ours to touch. */
function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Usage of the account's binding window, or null when claude-swap reported none. */
function usedPct(account: AccountSummary): number | null {
  const used = [account.usage?.fiveHour?.pct, account.usage?.sevenDay?.pct].filter((p): p is number => typeof p === 'number');
  return used.length ? Math.max(...used) : null;
}

/**
 * The account a chat under `policy` should run on. Staying put wins over the order: the order says
 * where to go when the account in use has crossed the threshold, not that every chat should hop
 * back to the first entry the moment it frees up. Null when no account the policy allows has room.
 */
export function pickAccount(
  policy: RotationPolicy,
  accounts: readonly AccountSummary[],
  opts: { current: number | null; exhausted?: ReadonlySet<number> },
): AccountSummary | null {
  const byNumber = new Map(accounts.map((a) => [a.number, a]));
  const order = policy.order ?? [...byNumber.keys()].sort((a, b) => a - b);
  const usable = (a: AccountSummary | undefined): a is AccountSummary => {
    if (!a || a.disabled || opts.exhausted?.has(a.number)) return false;
    const used = usedPct(a);
    // Unknown usage is only trusted from an account claude-swap says is healthy
    return used === null ? a.usageStatus === 'ok' : used < policy.threshold;
  };
  const current = opts.current !== null && order.includes(opts.current) ? byNumber.get(opts.current) : undefined;
  if (usable(current)) return current;
  for (const number of order) {
    const candidate = byNumber.get(number);
    if (usable(candidate)) return candidate;
  }
  return null;
}

/**
 * Agentry's own per-account settings (a config directory) and the rotation policies of projects and
 * of the chats that belong to none.
 */
export class AccountConfigs {
  private readonly file: string;
  private stored: Stored = { configs: {}, policies: [] };

  constructor(private readonly config: CoreConfig) {
    this.file = join(config.dataDir, 'account-config.json');
    if (!existsSync(this.file)) return;
    try {
      const doc: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (isRecord(doc)) this.stored = AccountConfigs.parse(doc);
    } catch {
      // Overwriting a document that does not parse would drop the policies in it
      throw new Error(`${this.file} is not valid JSON; fix or remove it`);
    }
  }

  private static parse(doc: Record<string, unknown>): Stored {
    const configs: Stored['configs'] = {};
    if (isRecord(doc.configs)) {
      for (const [number, value] of Object.entries(doc.configs)) {
        if (!isRecord(value) || typeof value.configDir !== 'string') continue;
        const links = Array.isArray(value.links) ? value.links.filter((l): l is string => typeof l === 'string') : [];
        configs[number] = { configDir: value.configDir, links };
      }
    }
    const policies = Array.isArray(doc.policies)
      ? doc.policies
          .filter((p): p is RotationPolicy => isRecord(p) && typeof p.id === 'string' && typeof p.threshold === 'number' && Array.isArray(p.projects))
          .map(({ looseChats, ...p }) => ({ ...p, ...(looseChats === true ? { looseChats: true } : {}) }))
      : [];
    return { configs, policies };
  }

  private save(): Promise<void> {
    return writeAtomic(this.file, `${JSON.stringify(this.stored, null, 2)}\n`);
  }

  // ---------- config directories ----------

  list(): AccountConfig[] {
    return Object.entries(this.stored.configs)
      .map(([number, c]) => ({ number: Number(number), configDir: c.configDir, links: [...c.links] }))
      .sort((a, b) => a.number - b.number);
  }

  configDirOf(account: number): string | null {
    return this.stored.configs[String(account)]?.configDir ?? null;
  }

  /**
   * Points an account at a config directory of its own, or back at the shared one. Nothing is moved
   * or copied: the directory is created empty, and what Agentry adds to it is symlinks recorded in
   * the config, so clearing it takes exactly those away and leaves the rest where it is.
   */
  async setConfigDir(account: number, request: UpdateAccountConfigRequest): Promise<AccountConfig | null> {
    if (!Number.isInteger(account) || account < 1) throw new Error('invalid account number');
    const key = String(account);
    const previous = this.stored.configs[key];
    const dir = this.normalize(request.configDir, account);
    // Created before anything is undone, so a directory that cannot be made leaves the account as it was
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (previous) this.unlink(previous);
    if (!dir) {
      delete this.stored.configs[key];
      await this.save();
      return null;
    }
    const links = this.link(dir, request.shareSettings === true);
    this.stored.configs[key] = { configDir: dir, links };
    await this.save();
    return { number: account, configDir: dir, links: [...links] };
  }

  /** Null means "share the wrapper's directory", which is what a path equal to it says too. */
  private normalize(value: string | null, account: number): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('configDir must be a path or null');
    if (!isAbsolute(value)) throw new Error('configDir must be an absolute path');
    const dir = resolve(value);
    if (dir === this.config.configDir) return null;
    if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`);
    // Two accounts in one directory would share a login, which is the mix-up this setting prevents
    for (const [number, other] of Object.entries(this.stored.configs)) {
      if (number !== String(account) && other.configDir === dir) throw new Error(`${dir} is already account ${number}'s config directory`);
    }
    return dir;
  }

  private link(dir: string, shareSettings: boolean): string[] {
    const made: string[] = [];
    for (const item of [HISTORY, ...(shareSettings ? SHARED_SETTINGS : [])]) {
      const source = join(this.config.configDir, item);
      const dest = join(dir, item);
      // Never over something that is there: an existing entry is the account's own
      if (!entryExists(source) || entryExists(dest)) continue;
      symlinkSync(source, dest);
      made.push(item);
    }
    return made;
  }

  /** Removes the links Agentry made, and only while they still point where it pointed them. */
  private unlink(entry: { configDir: string; links: string[] }): void {
    for (const item of entry.links) {
      const dest = join(entry.configDir, item);
      if (isLinkTo(dest, join(this.config.configDir, item))) unlinkSync(dest);
    }
  }

  // ---------- rotation policies ----------

  policies(): RotationPolicy[] {
    return this.stored.policies.map((p) => ({ ...p, projects: [...p.projects], ...(p.order ? { order: [...p.order] } : {}) }));
  }

  /** The policy governing a project; the global auto-switch stays in charge of a project with none. */
  policyFor(projectId: string): RotationPolicy | null {
    return this.stored.policies.find((p) => p.projects.includes(projectId)) ?? null;
  }

  /** The policy governing the chats under no imported project; the global auto-switch when none does. */
  looseChatsPolicy(): RotationPolicy | null {
    return this.stored.policies.find((p) => p.looseChats === true) ?? null;
  }

  private validPolicy(request: RotationPolicyRequest, id: string | null): Omit<RotationPolicy, 'id'> {
    const threshold = Number(request.threshold);
    if (!Number.isFinite(threshold) || threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX) {
      throw new Error(`threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}`);
    }
    if (request.looseChats !== undefined && typeof request.looseChats !== 'boolean') throw new Error('looseChats must be a boolean');
    const looseChats = request.looseChats === true;
    if (!Array.isArray(request.projects) || request.projects.some((p) => typeof p !== 'string' || !p)) {
      throw new Error('projects must be a list of project ids');
    }
    // A policy that governs nothing would sit in the list and never be applied
    if (!request.projects.length && !looseChats) throw new Error('projects must list at least one project id, or looseChats must be true');
    if (looseChats) {
      // Two would leave the choice to whichever was read first, as with a project
      const other = this.stored.policies.find((p) => p.id !== id && p.looseChats === true);
      if (other) throw new Error(`chats without a project are already governed by policy ${other.id}`);
    }
    const projects = [...new Set(request.projects)];
    for (const project of projects) {
      const other = this.stored.policies.find((p) => p.id !== id && p.projects.includes(project));
      if (other) throw new Error(`project ${project} is already governed by policy ${other.id}`);
    }
    let order: number[] | undefined;
    if (request.order !== undefined) {
      if (!Array.isArray(request.order) || !request.order.length || request.order.some((n) => !Number.isInteger(n) || n < 1)) {
        throw new Error('order must list account numbers');
      }
      order = [...new Set(request.order)];
    }
    return { threshold: Math.round(threshold * 10) / 10, projects, ...(order ? { order } : {}), ...(looseChats ? { looseChats: true } : {}) };
  }

  async createPolicy(request: RotationPolicyRequest): Promise<RotationPolicy> {
    const policy: RotationPolicy = { id: randomUUID(), ...this.validPolicy(request, null) };
    this.stored.policies.push(policy);
    await this.save();
    return policy;
  }

  async updatePolicy(id: string, request: RotationPolicyRequest): Promise<RotationPolicy> {
    const index = this.stored.policies.findIndex((p) => p.id === id);
    if (index === -1) throw new Error('policy not found');
    const policy: RotationPolicy = { id, ...this.validPolicy(request, id) };
    this.stored.policies[index] = policy;
    await this.save();
    return policy;
  }

  async deletePolicy(id: string): Promise<void> {
    const before = this.stored.policies.length;
    this.stored.policies = this.stored.policies.filter((p) => p.id !== id);
    if (this.stored.policies.length === before) throw new Error('policy not found');
    await this.save();
  }
}
