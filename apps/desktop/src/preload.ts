import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc.ts';

// The main process hands the app version over as a renderer argument (see webPreferences.additionalArguments)
const VERSION_ARG = '--agentry-version=';
const version = process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? '';

/*
 * What the UI can reach of the desktop shell, and nothing more: which platform it runs on, the title
 * bar colours to follow its theme, the paths the tray asks it to open, and the app's own updates
 * (`UpdateState` and `InstallAnswer` in src/updater.ts). No ipcRenderer, no Node.
 * Mirrored by `DesktopBridge` in apps/web/src/lib/desktop.ts.
 */
contextBridge.exposeInMainWorld('agentryDesktop', {
  platform: process.platform,
  version,
  setTitleBarTheme: (theme: { color: string; symbolColor: string }) => {
    ipcRenderer.send(IPC.titleBarTheme, { color: String(theme?.color), symbolColor: String(theme?.symbolColor) });
  },
  onNavigate: (listener: (path: string) => void) => {
    const handler = (_event: unknown, path: unknown) => {
      if (typeof path === 'string') listener(path);
    };
    ipcRenderer.on(IPC.navigate, handler);
    return () => void ipcRenderer.off(IPC.navigate, handler);
  },
  updates: {
    state: (): Promise<unknown> => ipcRenderer.invoke(IPC.updateState),
    onState: (listener: (state: unknown) => void) => {
      const handler = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on(IPC.updateChanged, handler);
      return () => void ipcRenderer.off(IPC.updateChanged, handler);
    },
    download: (): Promise<unknown> => ipcRenderer.invoke(IPC.updateDownload),
    install: (options?: { whenIdle?: boolean; force?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke(IPC.updateInstall, { whenIdle: options?.whenIdle === true, force: options?.force === true }),
  },
});
