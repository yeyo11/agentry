import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AgentryEvent } from '@agentry/shared';

/*
 * The state of the app-wide event connection and who listens to it. Kept apart from the connection
 * itself (events.ts) so that api.ts can read it without importing a module that imports api.ts.
 */

export type FeedState = 'connecting' | 'open' | 'closed';
export type AgentryEventListener = (event: AgentryEvent) => void;

/** How often a query polls while the stream is down: only there to notice the server came back. */
export const FALLBACK_POLL_MS = 30_000;

let state: FeedState = 'connecting';
const stateListeners = new Set<() => void>();
const listeners = new Set<AgentryEventListener>();

export function setFeedState(next: FeedState): void {
  if (state === next) return;
  state = next;
  for (const listener of [...stateListeners]) listener();
}

/** Hands an event to everyone subscribed; one listener throwing must not deafen the rest. */
export function dispatchEvent(event: AgentryEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // that consumer's bug is its own
    }
  }
}

/** Hears every event as it arrives, once; replays after a reconnection are not repeated. */
export function subscribeEvents(listener: AgentryEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `subscribeEvents` for a component: the latest `listener` runs, without resubscribing on each render. */
export function useAgentryEvents(listener: AgentryEventListener): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => subscribeEvents((event) => latest.current(event)), []);
}

const subscribeState = (onChange: () => void) => {
  stateListeners.add(onChange);
  return () => stateListeners.delete(onChange);
};

export function useFeedState(): FeedState {
  return useSyncExternalStore(subscribeState, () => state);
}

/** For `refetchInterval`: nothing while the stream keeps the query fresh, a slow poll while it is down. */
export function useFallbackInterval(ms: number = FALLBACK_POLL_MS): number | false {
  return useFeedState() === 'open' ? false : ms;
}
