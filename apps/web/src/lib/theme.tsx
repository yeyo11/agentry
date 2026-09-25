// Theme: dark unless the user chose otherwise. The preference is always stamped on
// <html data-theme>: 'light' and 'dark' pick a token block outright, and 'system' is the only value
// under which tokens.css lets prefers-color-scheme switch to light. With nothing stamped the bare
// :root tokens are dark, so a page that paints before any script runs is already right.
import { useSyncExternalStore } from 'react';
import { syncDesktopTitleBar } from './desktop';

export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'agentry-theme';
export const DEFAULT_THEME: ThemePreference = 'dark';

/** What a stored value means: anything unknown, or nothing at all, is the default. */
export function resolvePreference(stored: string | null | undefined): ThemePreference {
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_THEME;
}

/** The theme on screen for a preference, given whether the OS asks for light. */
export function resolveEffective(preference: ThemePreference, osPrefersLight: boolean): EffectiveTheme {
  if (preference === 'system') return osPrefersLight ? 'light' : 'dark';
  return preference;
}

const listeners = new Set<() => void>();
const osLight =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

function readPreference(): ThemePreference {
  try {
    return resolvePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // storage blocked (or none at all under node): the default
    return DEFAULT_THEME;
  }
}

let preference: ThemePreference = readPreference();

/**
 * The browser bar's colour. index.html carries one theme-color per scheme, keyed to the OS; a
 * stored 'dark' or 'light' wins over the OS, so the meta of that theme is made to match always and
 * the other never. Under 'system' both go back to their own query.
 */
function syncThemeColor(): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = (meta.dataset.scheme ??= /light/.test(meta.media) ? 'light' : 'dark');
    meta.media = preference === 'system' ? `(prefers-color-scheme: ${scheme})` : preference === scheme ? 'all' : 'not all';
  }
}

function apply(): void {
  document.documentElement.dataset.theme = preference;
  syncThemeColor();
  // The desktop app's window controls sit on the top bar and follow its colours
  syncDesktopTitleBar();
}

// Applied at import time, before React renders; index.html's pre-paint script has already stamped
// the same value, so this only confirms it.
if (typeof document !== 'undefined') apply();
osLight?.addEventListener('change', () => {
  if (preference === 'system') syncDesktopTitleBar();
  listeners.forEach((l) => l());
});

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    // 'system' is stored too: nothing stored now means dark
    localStorage.setItem(THEME_STORAGE_KEY, next);
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

const effective = (): EffectiveTheme => resolveEffective(preference, osLight?.matches ?? false);

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

/** The theme actually on screen; re-renders on toggle and on OS changes while in 'system'. */
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(subscribe, effective);
}
