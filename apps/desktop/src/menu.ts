import { Menu, shell, type MenuItemConstructorOptions } from 'electron';

export interface MenuFolders {
  data: string;
  workspace: string;
  logs: string;
}

export interface MenuActions {
  quit: () => void;
  checkForUpdates: () => void;
}

export function buildMenu(folders: MenuFolders, isDev: boolean, actions: MenuActions): Menu {
  const open = (path: string) => () => void shell.openPath(path);
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open data folder', click: open(folders.data) },
        { label: 'Open workspace folder', click: open(folders.workspace) },
        { label: 'Open logs folder', click: open(folders.logs) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CommandOrControl+Q', click: actions.quit },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(isDev ? [{ role: 'toggleDevTools' } as const] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [{ label: 'Check for updates…', click: actions.checkForUpdates }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
