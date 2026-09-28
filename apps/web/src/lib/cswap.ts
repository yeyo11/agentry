import type { CswapInfo } from '@agentry/shared';

/**
 * What the accounts page shows about claude-swap itself:
 * - `ready`: a claude-swap runs, whatever its version;
 * - `offer`: none, and Agentry can install its own;
 * - `installing` / `failed`: Agentry's own install, under way or broken;
 * - `unavailable`: none, and Agentry does not install it here (Docker, `CSWAP_BIN`, or turned off).
 */
/**
 * The server's report with every field the page reads in place. A server older than the page (a
 * wrapper not restarted after an update, or a dev server on another branch) sends no `managed` and
 * no `pinned`: read as "Agentry does not install it here", the page shows what it can instead of
 * failing on the first property it reads.
 */
export function normalizeCswap(cswap: Partial<CswapInfo> & Pick<CswapInfo, 'installed'>): CswapInfo {
  return {
    ...cswap,
    installed: cswap.installed,
    version: cswap.version ?? null,
    path: cswap.path ?? null,
    source: cswap.source ?? null,
    compatible: cswap.compatible ?? true,
    pinned: cswap.pinned ?? '',
    managed: cswap.managed ?? { available: false, state: 'absent', version: null },
  };
}

export type CswapView = 'ready' | 'offer' | 'installing' | 'failed' | 'unavailable';

export function cswapView(cswap: CswapInfo): CswapView {
  if (cswap.installed) return 'ready';
  if (!cswap.managed.available) return 'unavailable';
  // The server marks the copy installed a moment before it detects it again: still under way
  if (cswapInstalling(cswap)) return 'installing';
  return cswap.managed.state === 'failed' ? 'failed' : 'offer';
}

/** Agentry's install is running, or has landed and is not detected yet. */
export function cswapInstalling(cswap: CswapInfo): boolean {
  return cswap.managed.state === 'installing' || (cswap.managed.state === 'installed' && !cswap.installed);
}

/** How often the overview is read: fast while an install moves, at the usual pace otherwise. */
export function accountsRefetchInterval(cswap: CswapInfo | undefined): number {
  return cswap && cswapInstalling(cswap) ? 1_500 : 10_000;
}

/** Agentry's copy is the one in use and it may take it away again. */
export function cswapRemovable(cswap: CswapInfo): boolean {
  return cswap.installed && cswap.source === 'managed' && cswap.managed.available && !cswapInstalling(cswap);
}
