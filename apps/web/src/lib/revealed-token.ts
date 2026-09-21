import { useSyncExternalStore } from 'react';

/*
 * The token Agentry just generated, held only until the person says they have it.
 *
 * It lives here and not in the component because setting a token invalidates the one this browser
 * was sending: a poll that lands in that gap gets a 401, the sign-in screen replaces the shell, and
 * component state would be lost with it, leaving a token that exists nowhere else. Memory only,
 * never storage: the server keeps a hash, and this is the one plaintext copy.
 */

let revealed: string | null = null;
const listeners = new Set<() => void>();

export function reveal(token: string | null): void {
  revealed = token;
  for (const listener of [...listeners]) listener();
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

export function useRevealedToken(): string | null {
  return useSyncExternalStore(subscribe, () => revealed);
}
