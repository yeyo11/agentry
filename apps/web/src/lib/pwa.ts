// Installing Agentry on a device: the service worker, and what Settings can offer about it.
//
// The worker itself is public/sw.js, a plain file the build fills in; nothing here knows what it
// caches. What this module owns is when it is registered and what the person is told about making
// the app a real one on their phone.
import { useSyncExternalStore } from 'react';

/**
 * Chrome's own install prompt, fired at the page and kept for later. It is not in the DOM lib
 * because no other engine implements it, and `prompt()` may only be called from a real click.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallStatus =
  /** Running from the home screen already: there is nothing to offer */
  | 'installed'
  /** The browser handed us its install prompt and we are holding it */
  | 'prompt'
  /** Safari has no install API at all: the only thing we can do is say which button to tap */
  | 'ios'
  /** Installable in principle, but this browser never offered us a prompt */
  | 'manual';

export interface InstallState {
  status: InstallStatus;
  /** Shows the browser's install prompt. Only present while `status` is `prompt`. */
  install?: () => void;
  /**
   * A service worker — and so an immediate cold start, and later any Web Push — exists only on a
   * secure origin. `http://192.168.1.10:8787`, which is how most people run Agentry, is not one.
   */
  secure: boolean;
  /** The origin as the browser sees it, so the message can name it instead of being abstract */
  origin: string;
}

const listeners = new Set<() => void>();
const announce = (): void => listeners.forEach((listener) => listener());

let deferred: BeforeInstallPromptEvent | null = null;

// Captured at import time, from the shell bundle: the event fires once, early, and a listener
// added when Settings mounts would have missed it.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own banner and never lets us place the button
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    announce();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    announce();
  });
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // `navigator.standalone` is Safari's own, and the only signal an installed iOS app gives
  const safari = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || safari.standalone === true;
}

/** iPadOS reports itself as a Mac, and gives itself away only by having a touch screen. */
function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

function read(): InstallState {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const secure = typeof window === 'undefined' ? false : window.isSecureContext;
  const status: InstallStatus = isStandalone() ? 'installed' : deferred ? 'prompt' : isIos() ? 'ios' : 'manual';
  const install =
    status === 'prompt'
      ? () => {
          const event = deferred;
          if (!event) return;
          // Whatever the person answers, the event is spent: a second `prompt()` throws
          deferred = null;
          void event.prompt().finally(announce);
        }
      : undefined;
  return { status, install, secure, origin };
}

// useSyncExternalStore compares snapshots by identity, so the object is built once per change
let snapshot: InstallState = read();
const refresh = (): void => {
  snapshot = read();
};
listeners.add(refresh);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** What Settings should offer about installing this app, and whether the origin allows it at all. */
export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/**
 * Registers the service worker, once the page has painted and its own resources are in.
 *
 * Only from a production build: in `pnpm dev` the shell list is empty and the worker would answer
 * nothing, but it would still outlive the dev server in the browser's registrations. And not in
 * the desktop app, which starts its API on a port the operating system picks: the bundle is
 * already local there, and every launch would leave behind one more registration and one more
 * copy of the shell, filed under an origin that will never come back.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (/electron/i.test(navigator.userAgent)) return;
  const register = (): void => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      // An insecure origin has no worker and that is not a fault of ours; Settings says so
      console.warn('[agentry] the service worker was not registered:', error);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
