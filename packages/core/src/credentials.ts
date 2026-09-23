import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

export interface StoredCredentials {
  oauthToken?: string;
  apiKey?: string;
}

const ENV_KEYS = { oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN', apiKey: 'ANTHROPIC_API_KEY' } as const;

/**
 * Account credentials configured through the API. They are persisted in the data dir and
 * injected into process.env, which every spawned `claude` process inherits. Credentials set
 * here take precedence over the ones passed through the container environment.
 */
export class CredentialStore {
  private readonly file: string;
  private readonly bootEnv: Record<string, string | undefined>;
  private stored: StoredCredentials = {};
  private suspended = false;

  constructor(config: CoreConfig) {
    this.file = join(config.dataDir, 'credentials.json');
    this.bootEnv = Object.fromEntries(Object.values(ENV_KEYS).map((k) => [k, process.env[k]]));
    if (existsSync(this.file)) {
      try {
        this.stored = JSON.parse(readFileSync(this.file, 'utf8')) as StoredCredentials;
      } catch {
        this.stored = {};
      }
    }
    this.apply();
  }

  /** True when the credential in use was configured through the API. */
  get active(): boolean {
    return Boolean(this.stored.oauthToken || this.stored.apiKey);
  }

  /** True while claude-swap owns the credential and the wrapper injects nothing. */
  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * claude-swap swaps `.credentials.json`, which Claude Code only reads when no token is in the
   * environment. While it manages the accounts, the wrapper must keep that environment clean —
   * including a token that came from the container environment.
   */
  suspend(value: boolean): void {
    if (this.suspended === value) return;
    this.suspended = value;
    this.apply();
  }

  private apply(): void {
    if (this.suspended) {
      for (const key of Object.values(ENV_KEYS)) delete process.env[key];
      return;
    }
    if (!this.active) {
      for (const [key, value] of Object.entries(this.bootEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return;
    }
    // Exactly one credential type at a time, otherwise the CLI picks for us
    for (const [field, key] of Object.entries(ENV_KEYS) as Array<[keyof StoredCredentials, string]>) {
      const value = this.stored[field];
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  }

  async set(credentials: StoredCredentials): Promise<void> {
    const oauthToken = credentials.oauthToken?.trim();
    const apiKey = credentials.apiKey?.trim();
    if (!oauthToken && !apiKey) throw new Error('provide oauthToken or apiKey');
    if (oauthToken && apiKey) throw new Error('provide only one of oauthToken or apiKey');
    this.stored = oauthToken ? { oauthToken } : { apiKey };
    await writeAtomic(this.file, JSON.stringify(this.stored), 0o600);
    this.apply();
  }

  clear(): void {
    this.stored = {};
    rmSync(this.file, { force: true });
    this.apply();
  }
}
