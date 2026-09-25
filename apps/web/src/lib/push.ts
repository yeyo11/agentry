import { useSyncExternalStore } from 'react';
import type { NotificationKind } from '@agentry/shared';
import { api } from '../api';
import i18n from '../i18n';
import { getPrefs, KINDS } from './notifications';
import { isStandalone } from './pwa';
import {
  applicationServerKey,
  deviceLabel,
  isIosDevice,
  pushBlocker,
  PUSH_STATE_CACHE,
  PUSH_STATE_KEY,
  subscriptionId,
  type PushBlocker,
  type PushState,
} from './push-model';

/*
 * Web Push as this browser lives it: whether it can be pushed to, the subscription it holds, and
 * the two calls that take it out and give it back.
 *
 * What is true here and nowhere else: the subscription *is* the state. There is no flag in
 * localStorage saying push is on — `pushManager.getSubscription()` is asked, because it is the only
 * answer the browser will act on. A person who cleared site data, reinstalled the app or revoked
 * the permission has no subscription, and the switch is off without anything having to notice.
 *
 * The decision of what to show when push cannot work at all is in `push-model.ts`, which has no
 * browser in it and is tested directly.
 */

export interface PushDeviceState {
  /** Why this browser cannot be pushed to, or null when it can */
  blocker: PushBlocker | null;
  /** This browser holds a subscription: the switch is on */
  enabled: boolean;
  /** The id the server files this install under, so the device list can mark which row is here */
  id: string | null;
  /** A subscribe or an unsubscribe is in flight */
  busy: boolean;
  /** The origin as the browser sees it, so the insecure-origin sentence can name it */
  origin: string;
  /** False until the browser and the server have both been asked */
  ready: boolean;
}

const listeners = new Set<() => void>();

let state: PushDeviceState = { blocker: null, enabled: false, id: null, busy: false, origin: '', ready: false };

function set(change: Partial<PushDeviceState>): void {
  state = { ...state, ...change };
  for (const listener of [...listeners]) listener();
}

const supported = (): boolean =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';

/** Null when the server has not been asked yet; false when it has no keypair and can send nothing. */
let configured: boolean | null = null;
let publicKey: string | null = null;

function blockerNow(): PushBlocker | null {
  if (typeof window === 'undefined') return 'unsupported';
  return pushBlocker({
    secure: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints),
    standalone: isStandalone(),
    configured,
  });
}

// What can be known before anything is asked: the origin to name, and whether this browser is out
// of the running whatever the server says. `ready` stays false until the browser has been asked
// whether it holds a subscription, which is what keeps the switch from flicking on by itself.
if (typeof window !== 'undefined') state = { ...state, origin: window.location.origin, blocker: blockerNow() };

/** The subscription this browser holds, or null. Never registers a worker: only reads one. */
async function current(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** The public key, read once. `configured: false` is an answer, and it is remembered as one. */
async function serverKey(): Promise<string | null> {
  if (configured !== null) return publicKey;
  const info = await api.pushKey();
  configured = info.configured && Boolean(info.publicKey);
  publicKey = info.publicKey;
  return publicKey;
}

/** The kinds this install wants to be woken for: the same per-kind preferences the list uses. */
const wantedKinds = (): NotificationKind[] => KINDS.filter((kind) => getPrefs().kinds[kind]);

const label = (): string =>
  deviceLabel(navigator.userAgent, { standalone: isStandalone(), ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints) });

/**
 * What the service worker needs when it wakes with no page anywhere: the key to re-subscribe with,
 * the kinds this install asked for, and words for a push that arrives with no payload, in the
 * language this page is in. A worker has no bundle and no translations of its own.
 */
async function rememberState(key: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  const stored: PushState = {
    applicationServerKey: key,
    kinds: wantedKinds(),
    label: label(),
    fallback: { title: i18n.t('components:push.fallbackTitle'), body: i18n.t('components:push.fallbackBody') },
  };
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(PUSH_STATE_KEY, new Response(JSON.stringify(stored), { headers: { 'content-type': 'application/json' } }));
  } catch {
    // Without it a rotated subscription re-registers for every kind, in English: worth no more
  }
}

async function forgetState(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await (await caches.open(PUSH_STATE_CACHE)).delete(PUSH_STATE_KEY);
  } catch {
    // Nothing reads it while no subscription exists
  }
}

/** How long to wait for a service worker to become active before saying there is none. */
const WORKER_WAIT_MS = 10_000;

const rejectAfter = (ms: number): Promise<never> =>
  new Promise((_, reject) => window.setTimeout(() => reject(new Error(i18n.t('components:push.noWorker'))), ms));

/** Registers or refreshes this browser's subscription with the server, and marks the state on. */
async function register(subscription: PushSubscription, key: string): Promise<void> {
  const json = subscription.toJSON();
  const { endpoint } = json;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error(i18n.t('components:push.incomplete'));
  await api.registerPush({ endpoint, keys: { p256dh, auth }, kinds: wantedKinds(), level: getPrefs().level, label: label() });
  await rememberState(key);
  set({ enabled: true, id: await subscriptionId(endpoint), blocker: blockerNow(), ready: true });
}

/**
 * Turns push on for this browser. Called from a click and from nowhere else: a permission asked on
 * load is a permission a browser ignores, and one a person refuses is refused for good.
 */
export async function enablePush(): Promise<void> {
  set({ busy: true });
  try {
    if (!supported()) return void set({ blocker: blockerNow(), ready: true });
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') return void set({ blocker: blockerNow(), ready: true });
    const key = await serverKey();
    if (!key) return void set({ blocker: blockerNow(), ready: true });
    // `ready` rather than `getRegistration`: the switch may be flipped before the worker is active.
    // It never rejects and never resolves where no worker was registered at all — a dev server, the
    // desktop app — so it is raced, or the switch would spin for ever with nothing to say.
    const registration = await Promise.race([navigator.serviceWorker.ready, rejectAfter(WORKER_WAIT_MS)]);
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) }));
    await register(subscription, key);
  } finally {
    set({ busy: false });
  }
}

/** Turns it off: the browser drops the subscription, and the server drops the row it could send to. */
export async function disablePush(): Promise<void> {
  set({ busy: true });
  try {
    const subscription = await current();
    await subscription?.unsubscribe().catch(() => false);
    await forgetState();
    // Off here first, and only then on the server: if that call fails the switch still says what
    // this browser is, and the row it left behind is pruned the first time a send gets its 410.
    set({ enabled: false, id: null, blocker: blockerNow(), ready: true });
    // Even when the browser refused to unsubscribe: an endpoint nobody listens on is a dead row
    if (subscription) await api.removePush({ endpoint: subscription.endpoint });
  } finally {
    set({ busy: false });
  }
}

/**
 * Brings the server in line with what this browser holds, on every load and whenever the per-kind
 * preferences change. It is what repairs a subscription the browser rotated while the app was
 * closed — the worker tries first, but it cannot send the credential a guarded wrapper asks for,
 * and this runs where that credential exists.
 */
export async function syncPush(): Promise<void> {
  started = true;
  try {
    const subscription = await current();
    if (!subscription) {
      set({ enabled: false, id: null, blocker: blockerNow(), ready: true });
      return;
    }
    const key = await serverKey();
    if (!key) return void set({ blocker: blockerNow(), ready: true });
    await register(subscription, key);
  } catch {
    // The list still shows what the server has; nothing here is worth an error in a person's face
    set({ ready: true });
  }
}

/**
 * Asks the server whether it can send at all. Only from where the answer is shown: `GET /push/key`
 * makes the keypair on first use, and a page load that will never subscribe has no business
 * causing that.
 */
export async function ensurePushConfigured(): Promise<void> {
  if (configured === null && blockerNow() === null) {
    try {
      await serverKey();
    } catch {
      // The server is unreachable; the switch stays as it is rather than accusing this browser
    }
  }
  set({ blocker: blockerNow(), ready: true });
}

/**
 * Whether a push will reach this browser for what just happened. The page's own hidden-tab
 * notification stands down when it will, so the same news never arrives twice.
 */
export const pushIsActive = (): boolean => state.enabled;

let started = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) void syncPush();
  return () => void listeners.delete(listener);
}

/** What Settings shows about push on this device. */
export function usePushState(): PushDeviceState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
