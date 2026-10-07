import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';
import { SecretBox } from '../secret-box.ts';

/** 32 random bytes, as the plan says, written as hex so it travels in JSON and in a header unchanged. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The secrets that sign the deliveries of the hooks Agentry registered, one per registration, in a
 * 0600 file (decision 3): each value encrypted through the `SecretBox` when the desktop app handed
 * the server its key, plain on a server. A plain file found while a key is set is encrypted at
 * start. The database never holds them and no route returns them: the receiver reads one to verify
 * a delivery, the registration service reads one to re-point a hook, and nothing else does.
 */
export class WebhookSecrets {
  private readonly file: string;
  private readonly box: SecretBox;
  /** Plain values, in memory only */
  private secrets: Record<string, string> = {};

  constructor(config: Pick<CoreConfig, 'dataDir' | 'secretKey'>) {
    this.file = join(config.dataDir, 'webhook-secrets.json');
    this.box = new SecretBox(config.secretKey);
    if (!existsSync(this.file)) return;
    let needsRewrite = false;
    try {
      const stored: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        for (const [id, value] of Object.entries(stored)) {
          if (typeof value !== 'string') continue;
          // A value this box cannot open (the key changed, or the app is not the one that sealed it)
          // is as good as absent: its hook fails verification until it is registered again
          const plain = this.box.open(value);
          if (plain === null) continue;
          this.secrets[id] = plain;
          if (this.box.encrypts && !this.box.isSealed(value)) needsRewrite = true;
        }
      }
    } catch {
      // An unreadable file holds nothing usable: its hooks fail verification until they are registered again
      this.secrets = {};
    }
    if (needsRewrite) this.migrate();
  }

  /** Encrypts a file written before the key existed, before anything else reads or extends it */
  private migrate(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, this.serialize(this.secrets), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private serialize(secrets: Record<string, string>): string {
    return JSON.stringify(Object.fromEntries(Object.entries(secrets).map(([id, value]) => [id, this.box.seal(value)])));
  }

  /** Every secret held, for masking them where they should not travel */
  values(): string[] {
    return Object.values(this.secrets);
  }

  get(registrationId: string): string | null {
    return this.secrets[registrationId] ?? null;
  }

  async set(registrationId: string, secret: string): Promise<void> {
    const next = { ...this.secrets, [registrationId]: secret };
    await writeAtomic(this.file, this.serialize(next), 0o600);
    this.secrets = next;
  }

  async delete(registrationId: string): Promise<void> {
    if (!(registrationId in this.secrets)) return;
    const next = { ...this.secrets };
    delete next[registrationId];
    await writeAtomic(this.file, this.serialize(next), 0o600);
    this.secrets = next;
  }
}
