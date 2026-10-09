import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { YoutrackCredentialsStatus } from '@agentry/shared';
import type { CoreConfig } from '../../paths.ts';
import { SecretBox } from '../../secret-box.ts';
import { SecretVault } from '../../secret-vault.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What `youtrack-app` is handed: the instance and the permanent token, as the environment it reads */
export interface YoutrackCredentials {
  host: string;
  token: string;
}

/**
 * The instance address the CLI is given. YouTrack Cloud lives under `/youtrack`, and a self-hosted
 * one may live under any path, so the path is kept as written and only a trailing slash goes (the
 * CLI joins `/api/...` onto it).
 */
export function normalizeYoutrackHost(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('host must be the address of a YouTrack instance, such as https://example.youtrack.cloud');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('host must be an http or https address');
  if (url.username || url.password) throw new Error('host must not carry a user or a password');
  if (url.search || url.hash) throw new Error('host must not carry a query or a fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const TOOL = 'youtrack';
const HOST = 'YOUTRACK_HOST';
const TOKEN = 'YOUTRACK_TOKEN';

/**
 * The one secret Agentry keeps for a tracker (code hosts decision 3): YouTrack's address and
 * permanent token, in the secret vault under `youtrack`, as the two variables `youtrack-app` reads.
 * The token is never returned by a route and never put in argv: it reaches `youtrack-app` only
 * through the child's environment (`childEnv`, by way of `hosts/env.ts`).
 *
 * Before the vault it was `youtrack-credentials.json`, the token sealed with the desktop app's key
 * when there was one. That file is read once and removed; one whose token this key cannot open (the
 * desktop app's keyring was locked) is left alone, so a later start with the key still moves it.
 */
export class YoutrackCredentialStore {
  private readonly vault: SecretVault;

  constructor(config: Pick<CoreConfig, 'dataDir' | 'secretKey' | 'distribution'>, vault: SecretVault = new SecretVault(config)) {
    this.vault = vault;
    this.migrate(join(config.dataDir, 'youtrack-credentials.json'), new SecretBox(config.secretKey));
  }

  private migrate(file: string, box: SecretBox): void {
    if (!existsSync(file)) return;
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (!isObject(stored)) return;
    const values: Record<string, string> = {};
    if (typeof stored.host === 'string' && stored.host) values[HOST] = stored.host;
    if (typeof stored.token === 'string' && stored.token) {
      const token = box.open(stored.token);
      if (token === null) return;
      values[TOKEN] = token;
    }
    if (Object.keys(values).length === 0 || this.vault.importSync(TOOL, values, { replace: true })) rmSync(file, { force: true });
  }

  private read(): { host: string | null; token: string | null } {
    const kept = this.vault.get(TOOL);
    return { host: kept[HOST] ?? null, token: kept[TOKEN] ?? null };
  }

  /** For the execution layer and the detector only */
  get(): YoutrackCredentials | null {
    const { host, token } = this.read();
    return host && token ? { host, token } : null;
  }

  status(): YoutrackCredentialsStatus {
    const { host, token } = this.read();
    return { host, tokenSet: token !== null, encrypted: this.vault.sealed };
  }

  /**
   * Saves the host, and the token when one is given: a form that only changes the address keeps the
   * stored token, since the screen never shows it back.
   */
  async set(input: unknown): Promise<YoutrackCredentialsStatus> {
    if (!isObject(input)) throw new Error('credentials must be an object');
    if (typeof input.host !== 'string') throw new Error('host is required');
    const host = normalizeYoutrackHost(input.host);
    let token = this.read().token;
    if (input.token !== undefined && input.token !== null) {
      const given = typeof input.token === 'string' ? input.token.trim() : '';
      // The message never echoes the value: a token pasted into the wrong field is still a token
      if (!given || given.length > 1024 || /\s/.test(given)) throw new Error('token must be a single permanent token of at most 1024 characters');
      token = given;
    }
    if (!token) throw new Error('token is required the first time');
    await this.vault.set(TOOL, { [HOST]: host, [TOKEN]: token }, { replace: true });
    return this.status();
  }

  async clear(): Promise<YoutrackCredentialsStatus> {
    await this.vault.clear(TOOL);
    return this.status();
  }
}
