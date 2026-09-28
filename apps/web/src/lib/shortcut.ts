/**
 * A keyboard shortcut as the person's keyboard names it: `⌘S` on a Mac, an iPhone or an iPad,
 * `Ctrl+S` everywhere else. The editors bind both (`Mod-s`); only the label has to choose.
 */
export function isApple(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

export function shortcut(key: string, platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return isApple(platform) ? `⌘${key}` : `Ctrl+${key}`;
}
