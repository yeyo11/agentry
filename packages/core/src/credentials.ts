import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreConfig } from './paths.ts';
import { SecretVault } from './secret-vault.ts';

export interface StoredCredentials {
  oauthToken?: string;
  apiKey?: string;
}

const TOOL = 'claude-code';
const ENV_KEYS = { oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN', apiKey: 'ANTHROPIC_API_KEY' } as const;

/**
 * Claude Code's credential configured through the API: a token or a key, kept in the secret vault
 * under `claude-code` and handed to every `claude` process through `childEnv`, never through
 * `process.env` (which every other child, a project's checks included, would inherit too). It wins
 * over the one the container's environment passes; clearing it lets that one show through again.
 *
 * Before the vault it was `credentials.json`, plain at 0600: that file is read once, moved into the
 * vault and removed.
 */
export class CredentialStore {
  private readonly vault: SecretVault;

  constructor(config: Pick<CoreConfig, 'dataDir' | 'secretKey' | 'distribution'>, vault: SecretVault = new SecretVault(config)) {
    this.vault = vault;
    this.migrate(join(config.dataDir, 'credentials.json'));
  }

  /** True when the credential in use was configured through the API. */
  get active(): boolean {
    return this.vault.has(TOOL);
  }

  private migrate(file: string): void {
    if (!existsSync(file)) return;
    let stored: StoredCredentials;
    try {
      stored = JSON.parse(readFileSync(file, 'utf8')) as StoredCredentials;
    } catch {
      // Left where it is: nothing here can tell what the person meant it to hold
      return;
    }
    const values: Record<string, string> = {};
    if (typeof stored.oauthToken === 'string' && stored.oauthToken) values[ENV_KEYS.oauthToken] = stored.oauthToken;
    else if (typeof stored.apiKey === 'string' && stored.apiKey) values[ENV_KEYS.apiKey] = stored.apiKey;
    if (Object.keys(values).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    // The old file goes only once the vault holds its value: a failed write keeps it for the next start
    if (this.vault.importSync(TOOL, values, { replace: true })) rmSync(file, { force: true });
  }

  async set(credentials: StoredCredentials): Promise<void> {
    const oauthToken = credentials.oauthToken?.trim();
    const apiKey = credentials.apiKey?.trim();
    if (!oauthToken && !apiKey) throw new Error('provide oauthToken or apiKey');
    if (oauthToken && apiKey) throw new Error('provide only one of oauthToken or apiKey');
    // Exactly one credential type at a time, otherwise the CLI picks for us
    await this.vault.set(TOOL, oauthToken ? { [ENV_KEYS.oauthToken]: oauthToken } : { [ENV_KEYS.apiKey]: apiKey ?? '' }, { replace: true });
  }

  clear(): Promise<void> {
    return this.vault.clear(TOOL);
  }
}
