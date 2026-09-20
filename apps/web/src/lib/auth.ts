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
  return useSyncExternalStore(subscribe, () => challenge);
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
