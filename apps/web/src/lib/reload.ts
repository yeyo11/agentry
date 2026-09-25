// A page that outlived a deploy: noticing it, and reloading into the build the server serves now.
//
// The page never reloads on its own. A half-written message in the composer is worth more than
// being current, so all this module does is raise an offer the shell shows as a banner, and carry
// out the reload once the person presses it.
import { useSyncExternalStore } from 'react';

// Replaced by Vite's `define` with the root package.json's version (vite.config.ts). Under the unit
// tests nothing replaces it, and `typeof` is the one way to read an undeclared name without throwing.
declare const __AGENTRY_VERSION__: string | undefined;

/** The Agentry version this bundle was built from; empty when the build did not say. */
export const BUILD_VERSION: string = typeof __AGENTRY_VERSION__ === 'string' ? __AGENTRY_VERSION__ : '';

/**
 * The version the server moved to, or null when the page is current. A server older than the
 * `version` field sends none, and a build that does not know its own version cannot tell: neither
 * is a reason to interrupt anyone.
 */
export function serverVersionChange(build: string, server: unknown): string | null {
  if (!build || typeof server !== 'string' || server === '' || server === build) return null;
  return server;
}

// Each engine words it its own way (Chrome, Safari, Firefox), and Vite has one for a stylesheet
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

/**
 * Whether an error is a lazy chunk that is no longer there. After a deploy the old build's hashed
 * files are gone from the server, so the first route this page has not visited yet fails to load.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return typeof error === 'string' && CHUNK_ERROR.test(error);
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'ChunkLoadError' || (typeof message === 'string' && CHUNK_ERROR.test(message));
}

// ---------- the offer ----------

export type ReloadOffer =
  /** The server says it runs another version */
  | { reason: 'updated'; version: string }
  /** A chunk of this build is gone, so the server changed even though no hello said to what */
  | { reason: 'stale' };

/** What the banner shows, for a page built as `build`. One per page; the tests make their own. */
export class ReloadOffers {
  private offer: ReloadOffer | null = null;
  /** The version the person already waved away: the next hello with it does not bring it back. */
  private dismissed: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly build: string) {}

  current = (): ReloadOffer | null => this.offer;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Called with every `stream.hello`, so a reconnection after a server restart is when the page notices. */
  serverVersion(server: unknown): void {
    const version = serverVersionChange(this.build, server);
    if (version === null) {
      // The server went back to this build (a rollback): what was offered is no longer true
      if (this.offer?.reason === 'updated' && server === this.build) this.set(null);
      return;
    }
    if (version === this.dismissed || (this.offer?.reason === 'updated' && this.offer.version === version)) return;
    this.set({ reason: 'updated', version });
  }

  /** A lazy chunk failed to load. It shows even after a dismissal: the route it broke is right there. */
  staleChunk(): void {
    // A hello already said which version replaced this one, which is the better sentence
    if (this.offer) return;
    this.set({ reason: 'stale' });
  }

  dismiss(): void {
    if (this.offer?.reason === 'updated') this.dismissed = this.offer.version;
    this.set(null);
  }

  private set(next: ReloadOffer | null): void {
    this.offer = next;
    this.listeners.forEach((listener) => listener());
  }
}

const offers = new ReloadOffers(BUILD_VERSION);

export const noticeServerVersion = (server: unknown): void => offers.serverVersion(server);
export const noticeStaleChunk = (): void => offers.staleChunk();
export const dismissReloadOffer = (): void => offers.dismiss();

export function useReloadOffer(): ReloadOffer | null {
  return useSyncExternalStore(offers.subscribe, offers.current, offers.current);
}

// ---------- the reload ----------

/** Long enough for a phone to fetch the new shell; short enough that the button does not seem dead. */
export const WORKER_HANDOVER_MS = 5000;

/** What of `navigator.serviceWorker` the reload uses, so the tests can hand in a fake. */
export interface WorkerContainer {
  readonly controller: unknown;
  getRegistration(): Promise<{ update(): Promise<unknown>; readonly installing: unknown; readonly waiting: unknown } | undefined>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * Reloads into the build the server serves now.
 *
 * With a service worker in control, a plain reload is answered by that worker from the shell of its
 * own build, and the page comes back exactly as stale as it was. So the worker is asked to update
 * first. The new one calls `skipWaiting()` and `clients.claim()` itself, and once it controls the
 * page (`controllerchange`) the reload reaches the new shell. When `update()` finds nothing newer,
 * the worker in control already is the new one and there is nothing to wait for. The wait has a
 * limit: a worker that never takes over must not leave the button doing nothing.
 */
export async function reloadApp({
  container = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? (navigator.serviceWorker as WorkerContainer) : undefined,
  reload = () => window.location.reload(),
  timeoutMs = WORKER_HANDOVER_MS,
}: { container?: WorkerContainer; reload?: () => void; timeoutMs?: number } = {}): Promise<void> {
  if (!container?.controller) return reload();
  let registration: Awaited<ReturnType<WorkerContainer['getRegistration']>>;
  try {
    registration = await container.getRegistration();
  } catch {
    return reload();
  }
  if (!registration) return reload();

  let onChange = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Listening before asking: the new worker may claim the page before `update()` resolves
  const handedOver = new Promise<void>((resolve) => {
    onChange = resolve;
    container.addEventListener('controllerchange', onChange);
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await registration.update();
    if (registration.installing || registration.waiting) await handedOver;
  } catch {
    // Offline or the script failed to parse: the reload is still the best there is
  } finally {
    clearTimeout(timer);
    container.removeEventListener('controllerchange', onChange);
  }
  reload();
}

/**
 * Listens for the chunk failures no route wrapper catches: Vite's own preload of a lazy module's
 * dependencies, and a dynamic import some component awaited without handling it.
 */
export function watchChunkErrors(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', noticeStaleChunk);
  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event.reason)) noticeStaleChunk();
  });
}
