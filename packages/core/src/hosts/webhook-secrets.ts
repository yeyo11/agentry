import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../config/files.ts';
import type { CoreConfig } from '../paths.ts';

/** 32 random bytes, as the plan says, written as hex so it travels in JSON and in a header unchanged. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The secrets that sign the deliveries of the hooks Agentry registered, one per registration, in a
 * 0600 file like the other secrets (decision 3). The database never holds them and no route returns
 * them: the receiver reads one to verify a delivery, the registration service reads one to re-point
 * a hook, and nothing else does.
 */
export class WebhookSecrets {
  private readonly file: string;
  private secrets: Record<string, string> = {};

  constructor(config: Pick<CoreConfig, 'dataDir'>) {
    this.file = join(config.dataDir, 'webhook-secrets.json');
    if (!existsSync(this.file)) return;
    try {
      const stored: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        this.secrets = Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      }
    } catch {
      // An unreadable file holds nothing usable: its hooks fail verification until they are registered again
      this.secrets = {};
    }
  }

  get(registrationId: string): string | null {
    return this.secrets[registrationId] ?? null;
  }

  async set(registrationId: string, secret: string): Promise<void> {
    const next = { ...this.secrets, [registrationId]: secret };
    await writeAtomic(this.file, JSON.stringify(next), 0o600);
    this.secrets = next;
  }

  async delete(registrationId: string): Promise<void> {
    if (!(registrationId in this.secrets)) return;
    const next = { ...this.secrets };
    delete next[registrationId];
    await writeAtomic(this.file, JSON.stringify(next), 0o600);
    this.secrets = next;
  }
}
