import type { NotificationKind } from '@agentry/shared';

/*
 * The part of Web Push that is a pure function of where the page is running: whether this browser
 * can be pushed to at all, what to call this install in the Settings list, and the two encodings
 * the API and the `PushManager` disagree about.
 *
 * It is a module of its own because the answers matter most where there is no browser to ask. An
 * insecure origin and an iOS tab are the two states in which every push API is simply `undefined`,
 * and a switch that silently does nothing is the difference between a feature and a bug report —
 * so what the UI says in each is decided here, and tested here.
 */

/**
 * Where the page leaves what the service worker needs and cannot ask for. The worker re-subscribes
 * on its own when the browser rotates a subscription (`pushsubscriptionchange`), long after the
 * page that registered it is gone; without this it would not know the application server key, the
 * kinds this install asked for, or what language to fall back to. The same two names are written
 * into `public/sw.js`, and a test asserts they still match.
 */
export const PUSH_STATE_CACHE = 'agentry-push';
export const PUSH_STATE_KEY = '/__agentry-push-state';

export interface PushFallbackText {
  title: string;
  body: string;
}

/** What the worker reads out of the cache above. Small on purpose: it outlives every page. */
export interface PushState {
  /** URL-safe base64 VAPID public key, exactly as `GET /push/key` returned it */
  applicationServerKey: string;
  /** The kinds this install asked to be woken for */
  kinds: NotificationKind[];
  label: string;
  /** Shown for a push that arrives with no payload at all, in the language the page was in */
  fallback: PushFallbackText;
}

export type PushPermission = 'granted' | 'denied' | 'default' | 'unsupported';

/** What the page can see about this browser, gathered once so the decision below stays pure. */
export interface PushEnvironment {
  /** `window.isSecureContext`: false for `http://192.168.1.10:8787`, which is how most run Agentry */
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  permission: PushPermission;
  ios: boolean;
  /** Running from the home screen, rather than in a browser tab */
  standalone: boolean;
  /** Whether the server has a VAPID keypair; null until `GET /push/key` has answered */
  configured: boolean | null;
}

/**
 * Why this browser cannot be pushed to, or null when it can. Each one is a sentence the UI shows
 * in place of the switch, because every one of them makes the switch a lie:
 *
 * - `insecure` — `navigator.serviceWorker` and `window.PushManager` do not exist off a secure
 *   origin. It is checked first because it is what makes all the others undecidable.
 * - `iosTab` — Safari delivers Web Push only to a PWA on the Home Screen, never to a tab. Checked
 *   before `unsupported`, or an iPhone would be told its browser cannot do this at all, which is
 *   both false and unactionable.
 * - `unsupported` — no service worker, no `PushManager`, or no `Notification`.
 * - `unconfigured` — the server has no keypair, so nothing it sent could be delivered.
 * - `denied` — permission was refused, and asking again does nothing until it is changed in the
 *   browser's own settings.
 */
export type PushBlocker = 'insecure' | 'iosTab' | 'unsupported' | 'unconfigured' | 'denied';

export function pushBlocker(env: PushEnvironment): PushBlocker | null {
  if (!env.secure) return 'insecure';
  if (env.ios && !env.standalone) return 'iosTab';
  if (!env.serviceWorker || !env.pushManager || env.permission === 'unsupported') return 'unsupported';
  if (env.configured === false) return 'unconfigured';
  if (env.permission === 'denied') return 'denied';
  return null;
}

/** iPadOS calls itself a Mac, and gives itself away only by having a touch screen. */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  return /iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

// Product names, in the order a user agent has to be read: every Chrome says Safari, every Edge
// says Chrome, and every iOS browser says both.
const PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/android/i, 'Android'],
  [/iphone/i, 'iPhone'],
  [/ipad/i, 'iPad'],
  [/cros/i, 'ChromeOS'],
  [/windows/i, 'Windows'],
  [/macintosh|mac os x/i, 'macOS'],
  [/linux/i, 'Linux'],
];

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/edg[ea]?\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox\/|fxios\//i, 'Firefox'],
  [/crios\/|chrome\//i, 'Chrome'],
  [/safari\//i, 'Safari'],
];

const match = (userAgent: string, table: ReadonlyArray<readonly [RegExp, string]>): string | null =>
  table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;

/**
 * What the Settings list calls this install. Names of products and one acronym, so it reads the
 * same in every language — the label is stored on the server, where there is no locale to pick.
 * An installed app and a tab on the same phone are two subscriptions, and `PWA` is what tells the
 * two rows apart.
 */
export function deviceLabel(userAgent: string, { standalone = false, ios = false } = {}): string {
  const platform = (ios && match(userAgent, PLATFORMS) === 'macOS' ? 'iPad' : match(userAgent, PLATFORMS)) ?? 'Web';
  const browser = match(userAgent, BROWSERS);
  const name = browser ? `${platform} · ${browser}` : platform;
  return standalone ? `${name} · PWA` : name;
}

/**
 * The VAPID public key as `pushManager.subscribe` wants it. The API hands out URL-safe base64, and
 * while the specification also allows that string, Firefox has only ever accepted the bytes.
 */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(publicKey.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The id the server files this endpoint under — `sha256(endpoint)`, first 16 hex characters, the
 * same derivation as `idOfEndpoint` in `@agentry/core`. Computed here rather than remembered from
 * the registration, so a page that has only just loaded still knows which row of the list is the
 * device it is running on.
 */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
