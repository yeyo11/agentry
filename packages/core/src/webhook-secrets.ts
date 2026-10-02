import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

/** A registration id is Agentry's own (a UUID); anything else never becomes part of a file name. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The secrets that sign webhook deliveries, one 0600 file per registration (decision 3's rule for
 * secrets). They are kept out of the database so no row, export or API answer can carry one, and
 * they are read only by the receiver that verifies a delivery and by the registration that puts
 * one on a CLI's stdin.
 */
export class WebhookSecrets {
  private readonly dir: string;

  constructor(config: CoreConfig) {
    this.dir = join(config.dataDir, 'webhook-secrets');
  }

  /** 32 random bytes, hex: long enough that guessing is out of the question and plain text for a header-safe value. */
  static generate(): string {
    return randomBytes(32).toString('hex');
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('invalid webhook registration id');
    return join(this.dir, `${id}.secret`);
  }

  async set(id: string, secret: string): Promise<void> {
    await writeAtomic(this.file(id), secret, 0o600);
  }

  /** Null when there is none, and for an id that could not have been stored. */
  get(id: string): string | null {
    if (!SAFE_ID.test(id)) return null;
    const file = this.file(id);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf8') || null;
    } catch {
      return null;
    }
  }

  delete(id: string): void {
    if (SAFE_ID.test(id)) rmSync(this.file(id), { force: true });
  }
}
