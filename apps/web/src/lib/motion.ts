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

/*
 * One timer per period, shared by everything that ticks with it: ten spinners on a page cost what
 * one costs and stay in step, which is also what makes them read as one machine working.
 */
interface Ticker {
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | undefined;
  count: number;
  subscribe: (listener: () => void) => () => void;
  read: () => number;
}

const tickers = new Map<number, Ticker>();

function tickerFor(periodMs: number): Ticker {
  const existing = tickers.get(periodMs);
  if (existing) return existing;
  const ticker: Ticker = {
    listeners: new Set(),
    timer: undefined,
    count: 0,
    subscribe: (listener) => {
      ticker.listeners.add(listener);
      ticker.timer ??= setInterval(() => {
        ticker.count += 1;
        ticker.listeners.forEach((l) => l());
      }, periodMs);
      return () => {
        ticker.listeners.delete(listener);
        if (ticker.listeners.size === 0 && ticker.timer !== undefined) {
          clearInterval(ticker.timer);
          ticker.timer = undefined;
        }
      };
    },
    read: () => ticker.count,
  };
  tickers.set(periodMs, ticker);
  return ticker;
}

const noSubscription = (): (() => void) => () => {};
const zero = () => 0;

/**
 * The spinner's frame time, read once from `--spin-frame` so the token stays the single source and
 * no render pays for a style read.
 */
let spinFrameMs: number | undefined;
function frameMs(): number {
  if (spinFrameMs !== undefined) return spinFrameMs;
  if (typeof document === 'undefined') return 80;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spin-frame'));
  spinFrameMs = Number.isFinite(value) && value > 0 ? value : 80;
  return spinFrameMs;
}

/** Which braille frame a spinner is on; frozen at 0 whenever decorative motion is not allowed. */
export function useAnimationFrameIndex(): number {
  const running = useDecorativeMotion();
  const ticker = tickerFor(frameMs());
  const tick = useSyncExternalStore(running ? ticker.subscribe : noSubscription, running ? ticker.read : zero, zero);
  return running ? tick : 0;
}

/**
 * A counter that steps every `periodMs`, for a clock rather than for decoration: elapsed time is
 * information, so it keeps counting at every motion level and only stops while the tab is hidden.
 */
export function useClockTick(periodMs = 1000): number {
  const hidden = useSyncExternalStore(subscribe, () => typeof document !== 'undefined' && document.hidden, () => false);
  const ticker = tickerFor(periodMs);
  const tick = useSyncExternalStore(hidden ? noSubscription : ticker.subscribe, ticker.read, zero);
  return hidden ? ticker.count : tick;
}
