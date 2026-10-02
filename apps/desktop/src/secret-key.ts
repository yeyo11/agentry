import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The part of Electron's `safeStorage` this needs, so a test can stand in for the keyring */
export interface KeyVault {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(sealed: Buffer): string;
}

/**
 * The key the server encrypts its secret files with (decision 3). It is 32 random bytes kept in a
 * file that only the operating system's keyring can open (`safeStorage`), and handed to the server
 * through its environment at launch. Null when the keyring is not available or the file cannot be
 * opened: the server then keeps its secrets plain at 0600, as it does on a server.
 */
export function secretKeyFor(file: string, vault: KeyVault): string | null {
  if (!vault.isEncryptionAvailable()) return null;
  try {
    if (existsSync(file)) return vault.decryptString(readFileSync(file));
    const key = randomBytes(32).toString('hex');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, vault.encryptString(key), { mode: 0o600 });
    return key;
  } catch {
    return null;
  }
}
