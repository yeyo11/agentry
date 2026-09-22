/** The channels between the preload and the main process */
export const IPC = {
  /** page → main: `{ color, symbolColor }` for the title bar's controls */
  titleBarTheme: 'agentry:title-bar-theme',
  /** main → page: an in-app path to open with the page's own router */
  navigate: 'agentry:navigate',
} as const;

/** Only a path inside the app: one slash, no scheme or host, so a message cannot send the page elsewhere */
export function isAppPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && path.length <= 512;
}
