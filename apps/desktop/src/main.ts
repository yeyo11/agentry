import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, Menu, shell } from 'electron';
import { LogFile } from './log.ts';
import { buildMenu } from './menu.ts';
import { ACTION_SCHEME, errorUrl, splashUrl } from './pages.ts';
import { missingResources, resolveResources } from './resources.ts';
import { ServerProcess } from './server-process.ts';
import { resolveUserPath } from './shell-path.ts';
import { restoreWindowState } from './window-state.ts';

const isDev = !app.isPackaged || process.argv.includes('--dev');

// Name before anything reads it: it decides the userData dir and the X11 WM class the launcher matches on.
// Dev gets its own userData so experiments never touch the installed app's data.
app.setName('Agentry');
app.commandLine.appendSwitch('class', 'Agentry');
app.setPath('userData', join(app.getPath('appData'), isDev ? 'Agentry-dev' : 'Agentry'));

const userData = app.getPath('userData');
const dataDir = join(userData, 'data');
// Projects the agent works on live where the user can see them, not hidden under ~/.config
const workspaceDir = process.env.AGENTRY_WORKSPACE_DIR ?? join(homedir(), 'Agentry', 'workspace');
const logsDir = join(userData, 'logs');

let win: BrowserWindow | undefined;
let server: ServerProcess | undefined;
let serverOrigin: string | undefined;
let starting = false;
let quitting = false;

// Opened once the single-instance lock is ours, so a rejected second launch never rotates the running one's logs
let desktopLog: LogFile;
let serverLog: LogFile;

/** Navigation superseded by a newer load rejects with ERR_ABORTED; that is not an error */
const load = (url: string) => win?.loadURL(url).catch(() => undefined);

function showError(title: string, detail: string): void {
  desktopLog.line(`${title}: ${detail}`);
  serverOrigin = undefined;
  void load(errorUrl(title, detail, serverLog.path));
}

async function startServer(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    void load(splashUrl());
    const res = resolveResources();
    const missing = missingResources(res);
    if (missing.length) {
      showError('Agentry is missing files', `Not found:\n${missing.join('\n')}`);
      return;
    }
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    const PATH = await resolveUserPath();
    server = new ServerProcess(
      {
        entry: res.serverEntry,
        cwd: userData,
        env: {
          ...process.env,
          PATH,
          PORT: '0',
          HOST: '127.0.0.1',
          AGENTRY_WEB_DIST: res.webDist,
          AGENTRY_DATA_DIR: dataDir,
          AGENTRY_WORKSPACE_DIR: workspaceDir,
          AGENTRY_VERSION: app.getVersion(),
          // The desktop is not a sandbox: AGENTRY_DEFAULT_PERMISSION_MODE stays unset (core default: acceptEdits)
        },
      },
      serverLog,
      (detail) => showError('The Agentry server stopped unexpectedly', detail),
    );
    const url = await server.start();
    serverOrigin = new URL(url).origin;
    desktopLog.line(`server ready at ${url}`);
    await load(url);
  } catch (err) {
    showError('Agentry could not start its server', err instanceof Error ? err.message : String(err));
  } finally {
    starting = false;
  }
}

async function restartServer(): Promise<void> {
  await server?.stop();
  await startServer();
}

function createWindow(): void {
  const state = restoreWindowState();
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    title: 'Agentry',
    backgroundColor: '#101114',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--agentry-version=${app.getVersion()}`],
    },
  });
  if (state.maximized) win.maximize();
  state.track(win);

  const { webContents } = win;
  // The web UI sets its own <title>; the window keeps the app name
  webContents.on('page-title-updated', (event) => event.preventDefault());

  // Anything that is not the local server goes to the system browser
  const openExternal = (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ACTION_SCHEME)) {
      event.preventDefault();
      const action = url.slice(ACTION_SCHEME.length);
      if (action === 'restart') void restartServer();
      else if (action === 'logs') void shell.openPath(logsDir);
      return;
    }
    if (serverOrigin && new URL(url).origin === serverOrigin) return;
    event.preventDefault();
    openExternal(url);
  });
  // The server can vanish under a loaded page (e.g. reload after a crash): offer a restart instead of Chromium's error page
  webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && serverOrigin && url.startsWith(serverOrigin)) {
      showError('Cannot reach the Agentry server', `${description} (${code})`);
    }
  });

  win.on('closed', () => {
    win = undefined;
  });
  void startServer();
}

async function shutdown(): Promise<void> {
  await server?.stop();
  await Promise.all([desktopLog.close(), serverLog.close()]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    // Hold the quit until the server child is gone, then re-enter
    event.preventDefault();
    quitting = true;
    desktopLog.line('quitting');
    void shutdown().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(() => {
    desktopLog = new LogFile(logsDir, 'desktop.log');
    serverLog = new LogFile(logsDir, 'server.log');
    Menu.setApplicationMenu(buildMenu({ data: dataDir, workspace: workspaceDir, logs: logsDir }, isDev, () => app.quit()));
    createWindow();
  });
}
