import { useSyncExternalStore } from 'react';

/*
 * One clock for every "5m ago" on screen. Relative times only move by the minute, so a single timer
 * that fires on the minute re-renders just the components that read it, instead of each row keeping
 * an interval of its own or the text standing still until something else re-renders the page.
 */

const MINUTE = 60_000;

let minute = Math.floor(Date.now() / MINUTE);
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function tick(): void {
  minute = Math.floor(Date.now() / MINUTE);
  for (const listener of [...listeners]) listener();
  schedule();
}

function schedule(): void {
  // Aligned to the wall clock, so every relative time on screen turns over together
  timer = setTimeout(tick, MINUTE - (Date.now() % MINUTE) + 50);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    minute = Math.floor(Date.now() / MINUTE);
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** The current minute (epoch minutes); the component re-renders when it turns over. */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, () => minute, () => minute);
}
