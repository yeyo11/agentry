import { useSyncExternalStore } from 'react';
import type { AuthMode } from '@agentry/shared';

/*
 * The credential this browser sends, and what happens when the API refuses it.
 *
 * Agentry is unguarded by default, so nothing here runs for a local install: the token is only
 * read from storage, and the challenge state only appears once a route has answered 401. The
 * 401's body carries the mode, which is how the UI knows what to ask for without an open route
 * to ask first.
 */

const TOKEN_KEY = 'agentry.token';

let token: string | null = read();

function read(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private mode: the token lives for this page only
  }
}

export function getToken(): string | null {
  return token;
}

export function setToken(value: string | null): void {
  token = value?.trim() || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // the token still applies to this page
  }
}

/** The header every `fetch` carries; nothing at all when no token is stored. */
export function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The credential in the query string, for the three GETs the browser makes itself: the two
 * `EventSource` streams and an attachment's `<img src>`. Nothing else may use it — a token in a
 * URL ends up in access logs, and anything called with `fetch` can send the header instead.
 */
export function withToken(url: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

// ---------- the 401 state ----------

let challenge: AuthMode | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** A route answered 401: the whole UI is replaced by the sign-in screen until one succeeds. */
export function setChallenge(mode: AuthMode | null): void {
  if (challenge === mode) return;
  challenge = mode;
  emit();
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export function useAuthChallenge(): AuthMode | null {
  const read = () => challenge;
  return useSyncExternalStore(subscribe, read, read);
}

// ---------- the first answer ----------

/** Guarded, and the cheapest read the API has: a small settings document, no CLI involved. */
const PROBE_PATH = '/api/security/auth';
/** A wrapper this slow to answer gets its shell anyway, and the first 401 still brings the sign-in. */
const PROBE_WAIT_MS = 1500;

// Settled unless a probe is running, so a page that never probes (a test) renders as it did
let settled = true;

function settle(): void {
  if (settled) return;
  settled = true;
  emit();
}

/**
 * Asks once, before the shell mounts, whether this browser's credential is accepted. Without it a
 * guarded wrapper first draws the whole shell as skeletons, and only swaps in the sign-in screen
 * when the first of its requests comes back 401: on a phone that flash is most of a second.
 */
export async function probeAuth(fetcher: typeof fetch = fetch, waitMs = PROBE_WAIT_MS): Promise<void> {
  settled = false;
  const timer = setTimeout(settle, waitMs);
  try {
    const res = await fetcher(PROBE_PATH, { headers: authHeaders() });
    if (res.status === 401) {
      const body = (await res.json().catch(() => null)) as { mode?: AuthMode } | null;
      setChallenge(body?.mode ?? 'token');
    }
  } catch {
    // Unreachable is not refused: the shell has its own way of saying the API is down
  } finally {
    clearTimeout(timer);
    settle();
  }
}

/** False while the first probe is out: the app draws nothing rather than a shell it may take back. */
export function useAuthSettled(): boolean {
  const read = () => settled;
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Stores a credential and proves it before the UI comes back: `GET /api/overview` is guarded, so
 * a token that is not accepted fails here instead of on every page at once.
 */
export async function signIn(credential: string): Promise<boolean> {
  const previous = token;
  setToken(credential);
  try {
    const res = await fetch('/api/overview', { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) {
      setToken(previous);
      return false;
    }
    setChallenge(null);
    return true;
  } catch (error) {
    setToken(previous);
    throw error;
  }
}
