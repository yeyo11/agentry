import { Menu, shell, type MenuItemConstructorOptions } from 'electron';

export interface MenuFolders {
  data: string;
  workspace: string;
  logs: string;
}

export function buildMenu(folders: MenuFolders, isDev: boolean, quit: () => void): Menu {
  const open = (path: string) => () => void shell.openPath(path);
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open data folder', click: open(folders.data) },
        { label: 'Open workspace folder', click: open(folders.workspace) },
        { label: 'Open logs folder', click: open(folders.logs) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CommandOrControl+Q', click: quit },
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
  ];
  return Menu.buildFromTemplate(template);
}
