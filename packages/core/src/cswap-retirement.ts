import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './config/files.ts';
import type { CoreConfig } from './paths.ts';

/*
 * What claude-swap left behind (decision P4-4). Agentry no longer switches Claude accounts, and a
 * person who used it keeps the account it left active. Nothing here deletes what Agentry did not
 * write for itself: claude-swap's own data and the two documents it kept in the data directory stay
 * where they are, unread. The one thing that can be removed is Agentry's managed copy of the binary,
 * and only when the person asks.
 */

export type CswapTrace = 'accounts' | 'account-config' | 'managed-copy' | 'cswap-bin';

export interface CswapRetirement {
  /** What was found at boot: the reason the notice is there */
  found: CswapTrace[];
  /** Agentry's own copy of claude-swap is on disk: the one thing the notice offers to remove */
  managedCopy: boolean;
  /** Projects that had a rotation policy. The policies are gone; their provider order is what applies now */
  policyProjects: string[];
}

const DISMISSED_FILE = 'cswap-retirement.json';

function policyProjectsOf(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const policies = typeof doc === 'object' && doc !== null ? (doc as { policies?: unknown }).policies : undefined;
    if (!Array.isArray(policies)) return [];
    const projects = new Set<string>();
    for (const policy of policies) {
      const list = typeof policy === 'object' && policy !== null ? (policy as { projects?: unknown }).projects : undefined;
      if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') projects.add(id);
    }
    return [...projects];
  } catch {
    return [];
  }
}

export class CswapRetirementNotice {
  private readonly dismissedFile: string;
  private readonly tools: string;

  constructor(
    private readonly config: Pick<CoreConfig, 'dataDir'>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.dismissedFile = join(config.dataDir, DISMISSED_FILE);
    this.tools = join(config.dataDir, 'tools');
  }

  /** Traces of claude-swap, whatever the person did with the notice. */
  private trace(): CswapRetirement | null {
    const accounts = join(this.config.dataDir, 'accounts.json');
    const accountConfig = join(this.config.dataDir, 'account-config.json');
    const found: CswapTrace[] = [];
    if (existsSync(accounts)) found.push('accounts');
    if (existsSync(accountConfig)) found.push('account-config');
    const managedCopy = existsSync(this.tools);
    if (managedCopy) found.push('managed-copy');
    if (this.env.CSWAP_BIN?.trim()) found.push('cswap-bin');
    return found.length > 0 ? { found, managedCopy, policyProjects: policyProjectsOf(accountConfig) } : null;
  }

  isDismissed(): boolean {
    return existsSync(this.dismissedFile);
  }

  /** The notice to show; null when there is nothing of claude-swap's here, or the person dismissed it. */
  read(): CswapRetirement | null {
    return this.isDismissed() ? null : this.trace();
  }

  async dismiss(): Promise<void> {
    await writeAtomic(this.dismissedFile, `${JSON.stringify({ dismissedAt: new Date().toISOString() }, null, 2)}\n`);
  }

  /** Removes Agentry's managed copy (`data/tools`) and nothing else; false when there was none. */
  async removeManagedCopy(): Promise<boolean> {
    if (!existsSync(this.tools)) return false;
    await rm(this.tools, { recursive: true, force: true });
    return true;
  }
}
