/**
 * The window draws its own title bar: the web UI's top bar is the drag region (see `styles/shell.css`
 * in apps/web, stamped by `is-desktop`), and the system only keeps its window controls: macOS's
 * traffic lights, or the controls overlay Electron paints on Linux and Windows. Pure, so the options
 * and the colours the page may ask for are tested without a window.
 */

/** The web's top bar height (`--topbar-h` in apps/web/src/styles/tokens.css); the overlay matches it */
export const TITLE_BAR_HEIGHT = 52;

export interface TitleBarTheme {
  /** Background of the controls overlay: the top bar's own background */
  color: string;
  /** The controls' glyphs */
  symbolColor: string;
}

/** The splash and error pages' colours (src/pages.ts), used until the UI says which theme it shows */
export const SPLASH_TITLE_BAR: TitleBarTheme = { color: '#09090b', symbolColor: '#f4f4f5' };

export interface TitleBarOptions {
  titleBarStyle: 'hidden';
  titleBarOverlay?: TitleBarTheme & { height: number };
  trafficLightPosition?: { x: number; y: number };
}

export function titleBarOptions(platform: NodeJS.Platform, theme: TitleBarTheme): TitleBarOptions {
  if (platform === 'darwin') {
    // Traffic lights are 12 px tall circles with a 16 px hit box: centre them in the top bar's row
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: Math.round((TITLE_BAR_HEIGHT - 16) / 2) } };
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...theme, height: TITLE_BAR_HEIGHT } };
}

/** Only plain hex colours pass: the value crosses from the page to a native call */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The theme a page sent over IPC, or null when it is not one */
export function parseTitleBarTheme(value: unknown): TitleBarTheme | null {
  if (!value || typeof value !== 'object') return null;
  const { color, symbolColor } = value as Record<string, unknown>;
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return null;
  if (!HEX.test(color) || !HEX.test(symbolColor)) return null;
  return { color: color.toLowerCase(), symbolColor: symbolColor.toLowerCase() };
}
