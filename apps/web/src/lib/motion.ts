/**
 * Motion level: how much of the UI is allowed to move.
 *
 * - `full` (default): everything, including the loops that say something is alive.
 * - `subtle`: transitions only. No spinner frames, no pulsing rail, no energy border.
 * - `off`: what `prefers-reduced-motion: reduce` has always meant here.
 *
 * Built like the theme (`lib/theme.tsx`): stored in localStorage, stamped on `<html>` before the
 * first paint, read with `useSyncExternalStore`. The operating system wins: when it asks for
 * reduced motion the level is `off` whatever is stored, and the stored value is kept so turning
 * the system setting back off restores the person's own choice.
 *
 * `data-hidden` on `<html>` follows the tab's visibility: `styles/motion.css` pauses every
 * animation while it is set, so a tab left open in the background is not burning frames.
 */
import { useSyncExternalStore } from 'react';

export type MotionLevel = 'full' | 'subtle' | 'off';

const STORAGE_KEY = 'agentry-motion';
const LEVELS: readonly MotionLevel[] = ['full', 'subtle', 'off'];

const listeners = new Set<() => void>();
const osReduced = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

const isLevel = (value: unknown): value is MotionLevel => typeof value === 'string' && (LEVELS as readonly string[]).includes(value);

function readPreference(): MotionLevel {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLevel(stored)) return stored;
  } catch {
    // storage blocked: fall through to the default
  }
  return 'full';
}

let preference: MotionLevel = readPreference();

const effective = (): MotionLevel => (osReduced?.matches ? 'off' : preference);

function apply(): void {
  document.documentElement.dataset.motion = effective();
}

function notify(): void {
  apply();
  listeners.forEach((listener) => listener());
}

// Applied at import time, before React renders, so nothing moves once and then stops.
if (typeof document !== 'undefined') {
  apply();
  document.documentElement.dataset.hidden = String(document.hidden);
  osReduced?.addEventListener('change', notify);
  document.addEventListener('visibilitychange', () => {
    document.documentElement.dataset.hidden = String(document.hidden);
    listeners.forEach((listener) => listener());
  });
}

export function setMotionPreference(next: MotionLevel): void {
  preference = next;
  try {
    if (next === 'full') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // not persisted; still applied for this visit
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What is stored, which is what the Appearance setting shows as chosen. */
export function useMotionPreference(): MotionLevel {
  return useSyncExternalStore(subscribe, () => preference);
}

/** The level actually in force; `off` while the system asks for reduced motion. */
export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(subscribe, effective);
}

/** True while the operating system is overriding the stored preference, so the UI can say so. */
export function useReducedMotionForced(): boolean {
  return useSyncExternalStore(subscribe, () => (osReduced?.matches ?? false) && preference !== 'off');
}

/**
 * Whether a looping, decorative animation may run: only at `full`, and only while someone is
 * looking at the tab. Spinners, pulsing rails and tickers ask this before starting a timer.
 */
export function useDecorativeMotion(): boolean {
  const level = useMotionLevel();
  const hidden = useSyncExternalStore(
    subscribe,
    () => typeof document !== 'undefined' && document.hidden,
    () => false,
  );
  return level === 'full' && !hidden;
}

/**
 * A frame counter shared by every looping glyph on the page: one timer, one tick, so ten spinners
 * stay in step and cost what one costs. Returns 0 when decorative motion is not allowed.
 */
const tickListeners = new Set<() => void>();
let frame = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function frameMs(): number {
  if (typeof document === 'undefined') return 80;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spin-frame'));
  return Number.isFinite(value) && value > 0 ? value : 80;
}

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(() => {
      frame = (frame + 1) % 1000;
      tickListeners.forEach((l) => l());
    }, frameMs());
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const noSubscription = (): (() => void) => () => {};

export function useAnimationFrameIndex(): number {
  const running = useDecorativeMotion();
  const tick = useSyncExternalStore(
    running ? subscribeTick : noSubscription,
    () => frame,
    () => 0,
  );
  return running ? tick : 0;
}
