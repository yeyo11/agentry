// Theme: 'system' follows the OS; 'light' / 'dark' are stamped on <html data-theme> so the CSS
// token blocks (`:root[data-theme='…']`) win over prefers-color-scheme in both directions.
import { Monitor, Moon, Sun } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../components/controls/Tooltip';

export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'agentry-theme';
const ORDER: ThemePreference[] = ['system', 'light', 'dark'];

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

const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/** Cycles system → light → dark. The icon swaps with a small rotate/fade. */
export function ThemeToggle() {
  const { t } = useTranslation('components');
  const current = useThemePreference();
  const reduced = useReducedMotion();
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system';
  const Icon = ICON[current];
  const label = { current: t(`theme.${current}`), next: t(`theme.${next}`).toLowerCase() };
  return (
    <Tooltip content={t('theme.tooltip', label)}>
      <button
        type="button"
        className="theme-toggle"
        onClick={() => setThemePreference(next)}
        aria-label={t('theme.switch', label)}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={current}
            className="theme-toggle-icon"
            initial={reduced ? false : { opacity: 0, rotate: -60, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, rotate: 60, scale: 0.6 }}
            transition={{ duration: 0.16 }}
          >
            <Icon size={16} strokeWidth={1.75} aria-hidden />
          </motion.span>
        </AnimatePresence>
      </button>
    </Tooltip>
  );
}
