// Theme: 'system' follows the OS; 'light' / 'dark' are stamped on <html data-theme> so the CSS
// token blocks (`:root[data-theme='…']`) win over prefers-color-scheme in both directions.
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'agentry-theme';

const listeners = new Set<() => void>();
const osLight = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: light)') : null;

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // storage blocked: fall through to system
  }
  return 'system';
}

let preference: ThemePreference = readPreference();

function apply(): void {
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
}

// Applied at import time, before React renders, so there is no flash of the wrong theme.
if (typeof document !== 'undefined') apply();
osLight?.addEventListener('change', () => listeners.forEach((l) => l()));

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // not persisted; still applied for this visit
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const effective = (): EffectiveTheme => (preference === 'system' ? (osLight?.matches ? 'light' : 'dark') : preference);

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

/** The theme actually on screen; re-renders on toggle and on OS changes while in 'system'. */
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(subscribe, effective);
}
