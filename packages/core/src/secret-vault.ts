import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';
import { SecretBox } from './secret-box.ts';

/** The file every secret Agentry hands a CLI through its environment lives in */
export const VAULT_FILE = 'secrets.json';
/** The key made beside the data when the environment brings none (Docker only, see `keyFor`) */
export const KEY_FILE = 'secret.key';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type Stored = Record<string, Record<string, string>>;

export type VaultConfig = Pick<CoreConfig, 'dataDir' | 'secretKey' | 'distribution'>;

/** Where the key comes from: the environment, a file beside the data, or nowhere (values stay plain) */
type KeySource = { kind: 'env'; hex: string } | { kind: 'file'; hex: string } | { kind: 'to-make' } | { kind: 'none' };

function readKeyFile(file: string): string {
  const hex = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${file} must hold a 32-byte key as hex; remove it to have a new one made (every secret sealed with it is lost)`);
  return hex;
}

/**
 * The key, in the order decision 3 of docs/plans/in-app-setup.md sets: `AGENTRY_SECRET_KEY` (the
 * desktop app's, or one an operator passes), else a key file already beside the data, else, in the
 * Docker image only, a key file made on first use. A desktop or source install without a key keeps
 * what it always did: plain values in a 0600 file, so nothing changes under it.
 */
function keyFor(config: VaultConfig): KeySource {
  if (config.secretKey) return { kind: 'env', hex: config.secretKey };
  const file = join(config.dataDir, KEY_FILE);
  if (existsSync(file)) return { kind: 'file', hex: readKeyFile(file) };
  return config.distribution === 'docker' ? { kind: 'to-make' } : { kind: 'none' };
}

/**
 * `secrets.json`: every secret a CLI reads from its environment (Claude Code's token, Gemini's and
 * OpenCode's keys, YouTrack's address and token), keyed by tool and variable and sealed with the
 * `SecretBox` when there is a key. A CLI that has a login command of its own keeps its credential
 * itself (decision 4), so nothing for Codex, Copilot, gh or glab is ever stored here.
 *
 * The file is read again before every write, so two stores built on the same data directory (a
 * test, or a store a route builds) never undo each other's change. Values are never logged, and
 * leave this class only through `get`, which `childEnv` and the stores call.
 */
export class SecretVault {
  private readonly file: string;
  private readonly keyFile: string;
  private source: KeySource;
  private box: SecretBox;
  private stored: Stored;
  private writing: Promise<void> = Promise.resolve();

  constructor(config: VaultConfig) {
    this.file = join(config.dataDir, VAULT_FILE);
    this.keyFile = join(config.dataDir, KEY_FILE);
    this.source = keyFor(config);
    this.box = new SecretBox(this.source.kind === 'env' || this.source.kind === 'file' ? this.source.hex : null);
    this.stored = this.read();
  }

  /** Whether what this vault writes is encrypted (or will be, once the Docker key is made on the first write) */
  get sealed(): boolean {
    return this.source.kind !== 'none';
  }

  /**
   * Whether the key sits in the data directory beside what it seals. It then protects a copy of the
   * files (a backup, a file sent by mistake), not the volume itself; Settings says so.
   */
  get keyBeside(): boolean {
    return this.source.kind === 'file' || this.source.kind === 'to-make';
  }

  /** The variables kept for one tool, opened; a value this key cannot open is as good as absent */
  get(tool: string): Record<string, string> {
    const entry = this.stored[tool] ?? {};
    const out: Record<string, string> = {};
    for (const [name, sealed] of Object.entries(entry)) {
      const value = this.box.open(sealed);
      if (value !== null) out[name] = value;
    }
    return out;
  }

  has(tool: string): boolean {
    return Object.keys(this.get(tool)).length > 0;
  }

  /** Every value kept, for the redaction of Agentry's own secrets in what leaves the machine */
  values(): string[] {
    return Object.keys(this.stored).flatMap((tool) => Object.values(this.get(tool)));
  }

  /**
   * Writes the variables of one tool. `replace` drops whatever else the tool had, for a tool that
   * takes exactly one credential at a time (Claude Code: the CLI would otherwise pick between them).
   */
  set(tool: string, values: Record<string, string>, options: { replace?: boolean } = {}): Promise<void> {
    return this.change((stored) => {
      const entry = options.replace ? {} : { ...(stored[tool] ?? {}) };
      for (const [name, value] of Object.entries(values)) entry[name] = this.box.seal(value);
      stored[tool] = entry;
    });
  }

  /** Forgets some variables of a tool, or all of them; the CLI then sees what the container's environment says */
  clear(tool: string, names?: readonly string[]): Promise<void> {
    return this.change((stored) => {
      const entry = stored[tool];
      if (!entry) return;
      if (names) for (const name of names) delete entry[name];
      if (!names || Object.keys(entry).length === 0) delete stored[tool];
    });
  }

  /**
   * Moves what an older store kept in a file of its own into the vault, synchronously: it runs while
   * Core is built, before anything reads a credential or spawns a CLI. False when it could not write.
   */
  importSync(tool: string, values: Record<string, string>, options: { replace?: boolean } = {}): boolean {
    try {
      this.ensureKey();
      const next = this.read();
      const entry = options.replace ? {} : { ...(next[tool] ?? {}) };
      for (const [name, value] of Object.entries(values)) entry[name] = this.box.seal(value);
      next[tool] = entry;
      mkdirSync(join(this.file, '..'), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
      this.stored = next;
      return true;
    } catch {
      return false;
    }
  }

  private change(apply: (stored: Stored) => void): Promise<void> {
    const write = this.writing.then(async () => {
      this.ensureKey();
      const next = this.read();
      apply(next);
      await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
      this.stored = next;
    });
    this.writing = write.catch(() => undefined);
    return write;
  }

  /** Makes the Docker key the first time something is written, so an install that stores nothing gets no key file */
  private ensureKey(): void {
    if (this.source.kind !== 'to-make') return;
    if (existsSync(this.keyFile)) {
      this.source = { kind: 'file', hex: readKeyFile(this.keyFile) };
    } else {
      const hex = randomBytes(32).toString('hex');
      mkdirSync(join(this.keyFile, '..'), { recursive: true });
      // `wx`: two servers on one volume must not each make a key and seal with different ones
      try {
        writeFileSync(this.keyFile, `${hex}\n`, { mode: 0o600, flag: 'wx' });
        this.source = { kind: 'file', hex };
      } catch {
        this.source = { kind: 'file', hex: readKeyFile(this.keyFile) };
      }
    }
    this.box = new SecretBox(this.source.hex);
  }

  private read(): Stored {
    if (!existsSync(this.file)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isObject(raw)) return {};
      const out: Stored = {};
      for (const [tool, entry] of Object.entries(raw)) {
        if (!isObject(entry)) continue;
        const kept: Record<string, string> = {};
        for (const [name, value] of Object.entries(entry)) if (typeof value === 'string' && value) kept[name] = value;
        out[tool] = kept;
      }
      return out;
    } catch {
      return {};
    }
  }
}
