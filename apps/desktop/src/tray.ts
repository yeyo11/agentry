import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { trayMenu, trayTooltip, type LiveSnapshot, type TrayAction } from './live.ts';

/** The tray: what is live at a glance, and a way back to it without finding the window */
export class LiveTray {
  private readonly tray: Tray;

  constructor(
    iconPath: string,
    private readonly act: (action: TrayAction) => void,
  ) {
    // The window icon is 512 px; trays want their own small size (22 on Linux panels, 16 elsewhere)
    const size = process.platform === 'linux' ? 22 : 16;
    this.tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: size, height: size }));
    // Windows and macOS open the app on a plain click; Linux AppIndicators only ever show the menu
    this.tray.on('click', () => act({ kind: 'show' }));
  }

  update(snapshot: LiveSnapshot, updateReady?: string): void {
    this.tray.setToolTip(trayTooltip(snapshot));
    const template = trayMenu(snapshot, updateReady).map((entry): MenuItemConstructorOptions => {
      if (entry.type === 'separator') return { type: 'separator' };
      const { label, action } = entry;
      return action ? { label, click: () => this.act(action) } : { label, enabled: false };
    });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray.destroy();
  }
}
