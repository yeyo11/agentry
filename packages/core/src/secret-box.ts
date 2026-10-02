import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;

/**
 * Decision 3: a secret is kept in a 0600 file, encrypted when the desktop app can encrypt and plain
 * on a server. Electron's `safeStorage` exists only in the app's main process and the server runs
 * beside it, so the app keeps a master key under `safeStorage` and hands it to the server at launch
 * (`AGENTRY_SECRET_KEY`, 32 bytes as hex). This box seals each value with that key (AES-256-GCM);
 * with no key it leaves values as they are.
 */
export class SecretBox {
  private readonly key: Buffer | null;

  constructor(keyHex?: string | null) {
    const key = keyHex ? Buffer.from(keyHex.trim(), 'hex') : null;
    if (key && key.length !== KEY_BYTES) throw new Error('AGENTRY_SECRET_KEY must be 32 bytes as hex');
    this.key = key;
  }

  /** Whether the values this box writes are encrypted */
  get encrypts(): boolean {
    return this.key !== null;
  }

  isSealed(stored: string): boolean {
    return stored.startsWith(PREFIX);
  }

  seal(plain: string): string {
    if (!this.key) return plain;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  /** The plain value, or null for a sealed one this box cannot open (no key, another key, tampered). */
  open(stored: string): string | null {
    if (!this.isSealed(stored)) return stored;
    if (!this.key) return null;
    try {
      const bytes = Buffer.from(stored.slice(PREFIX.length), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
