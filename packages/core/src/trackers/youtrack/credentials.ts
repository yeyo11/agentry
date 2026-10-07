import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { YoutrackCredentialsStatus } from '@agentry/shared';
import { writeAtomic } from '../../config/files.ts';
import type { CoreConfig } from '../../paths.ts';
import { SecretBox } from '../../secret-box.ts';

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

/**
 * `youtrack-credentials.json`: the one secret Agentry keeps for a tracker (code hosts decision 3).
 * A 0600 file, the token sealed through the `SecretBox` when the desktop app handed the server its
 * key and plain on a server. The token is never returned by a route and never put in argv: it
 * reaches `youtrack-app` only through the child's environment (`hosts/env.ts`).
 */
export class YoutrackCredentialStore {
  private readonly file: string;
  private readonly box: SecretBox;
  private host: string | null = null;
  private token: string | null = null;

  constructor(config: Pick<CoreConfig, 'dataDir' | 'secretKey'>) {
    this.file = join(config.dataDir, 'youtrack-credentials.json');
    this.box = new SecretBox(config.secretKey);
    if (!existsSync(this.file)) return;
    try {
      const stored: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isObject(stored)) return;
      if (typeof stored.host === 'string' && stored.host) this.host = stored.host;
      // A token this box cannot open (another key, or sealed by another app) is as good as absent
      if (typeof stored.token === 'string' && stored.token) this.token = this.box.open(stored.token);
    } catch {
      this.host = null;
      this.token = null;
    }
  }

  /** For the execution layer and the detector only */
  get(): YoutrackCredentials | null {
    return this.host && this.token ? { host: this.host, token: this.token } : null;
  }

  status(): YoutrackCredentialsStatus {
    return { host: this.host, tokenSet: this.token !== null, encrypted: this.box.encrypts };
  }

  /**
   * Saves the host, and the token when one is given: a form that only changes the address keeps the
   * stored token, since the screen never shows it back.
   */
  async set(input: unknown): Promise<YoutrackCredentialsStatus> {
    if (!isObject(input)) throw new Error('credentials must be an object');
    if (typeof input.host !== 'string') throw new Error('host is required');
    const host = normalizeYoutrackHost(input.host);
    let token = this.token;
    if (input.token !== undefined && input.token !== null) {
      const given = typeof input.token === 'string' ? input.token.trim() : '';
      // The message never echoes the value: a token pasted into the wrong field is still a token
      if (!given || given.length > 1024 || /\s/.test(given)) throw new Error('token must be a single permanent token of at most 1024 characters');
      token = given;
    }
    if (!token) throw new Error('token is required the first time');
    await writeAtomic(this.file, JSON.stringify({ host, token: this.box.seal(token) }), 0o600);
    this.host = host;
    this.token = token;
    return this.status();
  }

  clear(): YoutrackCredentialsStatus {
    this.host = null;
    this.token = null;
    rmSync(this.file, { force: true });
    return this.status();
  }
}
