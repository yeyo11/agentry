/**
 * The desktop shell (apps/desktop) loads this same UI in an Electron window whose title bar is
 * drawn by the page: the top bar becomes the window's drag region and leaves room for the window
 * controls. The preload exposes `window.agentryDesktop`; when it is there, `<html>` gets
 * `is-desktop` and `desktop-<platform>` before the first paint, and the CSS in `styles/shell.css`
 * does the rest. In a browser nothing is stamped and nothing changes.
 */

/** What the preload exposes. Kept minimal on purpose; the desktop task may add typed members. */
export interface DesktopBridge {
  platform: string;
  version: string;
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
