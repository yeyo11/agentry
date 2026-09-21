import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * The desktop shell (apps/desktop) loads this same UI in an Electron window whose title bar is
 * drawn by the page: the top bar becomes the window's drag region and leaves room for the window
 * controls. The preload exposes `window.agentryDesktop`; when it is there, `<html>` gets
 * `is-desktop` and `desktop-<platform>` before the first paint, and the CSS in `styles/shell.css`
 * does the rest. In a browser nothing is stamped and nothing changes.
 */

export interface TitleBarTheme {
  /** The top bar's background, painted behind the window controls (a hex colour) */
  color: string;
  /** The window controls' glyphs (a hex colour) */
  symbolColor: string;
}

/**
 * What the preload (apps/desktop/src/preload.ts) exposes, kept minimal on purpose. The methods are
 * optional so a UI served to an older shell, or a browser, just skips them.
 */
export interface DesktopBridge {
  platform: string;
  version: string;
  /** The window controls follow the page's theme */
  setTitleBarTheme?: (theme: TitleBarTheme) => void;
  /** The tray asks the page to open an in-app path; returns the unsubscribe function */
  onNavigate?: (listener: (path: string) => void) => () => void;
}

declare global {
  interface Window {
    agentryDesktop?: DesktopBridge;
  }
}

/** The classes `<html>` carries inside the desktop app; none in a browser. */
export function desktopClasses(bridge: unknown): string[] {
  if (!bridge || typeof bridge !== 'object') return [];
  const platform = (bridge as { platform?: unknown }).platform;
  // Only a plain token becomes a class name: whatever the bridge says cannot inject another one
  const safe = typeof platform === 'string' && /^[a-z0-9]+$/i.test(platform) ? platform.toLowerCase() : null;
  return safe ? ['is-desktop', `desktop-${safe}`] : ['is-desktop'];
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const classes = desktopClasses(window.agentryDesktop);
  if (classes.length) document.documentElement.classList.add(...classes);
}

/**
 * The title bar colours for the theme on screen: the top bar's `--bg` behind the window controls,
 * `--text` for their glyphs. Read from the computed tokens rather than repeated here, so a token
 * change reaches the title bar by itself.
 */
export function titleBarTheme(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): TitleBarTheme | null {
  const color = style.getPropertyValue('--bg').trim();
  const symbolColor = style.getPropertyValue('--text').trim();
  const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  return hex.test(color) && hex.test(symbolColor) ? { color, symbolColor } : null;
}

/** Tells the desktop shell which colours the theme now shows; nothing in a browser. */
export function syncDesktopTitleBar(): void {
  const bridge = typeof window !== 'undefined' ? window.agentryDesktop : undefined;
  if (!bridge?.setTitleBarTheme) return;
  // A frame later: the theme attribute has applied and, on first load, the stylesheets have too
  requestAnimationFrame(() => {
    const theme = titleBarTheme(getComputedStyle(document.documentElement));
    if (theme) bridge.setTitleBarTheme?.(theme);
  });
}

/** Opens what the tray picks (a live chat, New chat…) with the app's router, keeping its state. */
export function useDesktopNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window.agentryDesktop?.onNavigate : undefined;
    return subscribe?.((path) => {
      if (path.startsWith('/') && !path.startsWith('//')) navigate(path);
    });
  }, [navigate]);
}
