import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { IPC, isAppPath } from './ipc.ts';
import { EMPTY_SNAPSHOT, progressOf, sameSnapshot, type LiveSnapshot, type TrayAction } from './live.ts';
import { LiveMonitor } from './live-monitor.ts';
import { LogFile } from './log.ts';
import { buildMenu } from './menu.ts';
import { ACTION_SCHEME, errorUrl, splashUrl } from './pages.ts';
import { missingResources, resolveResources } from './resources.ts';
import { ServerProcess } from './server-process.ts';
import { resolveUserPath } from './shell-path.ts';
import { SPLASH_TITLE_BAR, parseTitleBarTheme, titleBarOptions, type TitleBarTheme } from './title-bar.ts';
import { LiveTray } from './tray.ts';
import { restoreWindowState } from './window-state.ts';

const isDev = !app.isPackaged || process.argv.includes('--dev');

// Name before anything reads it: it decides the userData dir. (The X11 WM class the launcher matches on
// comes from the packaged package.json name instead; see extraMetadata in electron-builder.yml.)
// Dev gets its own userData so experiments never touch the installed app's data.
app.setName('Agentry');
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
let monitor: LiveMonitor | undefined;
let tray: LiveTray | undefined;
let live: LiveSnapshot = EMPTY_SNAPSHOT;

// Opened once the single-instance lock is ours, so a rejected second launch never rotates the running one's logs
let desktopLog: LogFile;
let serverLog: LogFile;

/** The window controls' colours; also the window background, seen while a page loads */
function paintTitleBar(theme: TitleBarTheme): void {
  if (!win) return;
  win.setBackgroundColor(theme.color);
  if (process.platform !== 'darwin') win.setTitleBarOverlay(theme);
}

/** Navigation superseded by a newer load rejects with ERR_ABORTED; that is not an error */
const load = (url: string) => win?.loadURL(url).catch(() => undefined);

function showError(title: string, detail: string): void {
  desktopLog.line(`${title}: ${detail}`);
  serverOrigin = undefined;
  stopMonitor();
  // The splash and error pages are dark whatever the UI's theme was
  paintTitleBar(SPLASH_TITLE_BAR);
  void load(errorUrl(title, detail, serverLog.path));
}

async function startServer(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    paintTitleBar(SPLASH_TITLE_BAR);
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
    startMonitor(serverOrigin);
    await load(url);
  } catch (err) {
    showError('Agentry could not start its server', err instanceof Error ? err.message : String(err));
  } finally {
    starting = false;
  }
}

/** Tray, taskbar progress and badge, redrawn only when what they show changed */
function showLive(snapshot: LiveSnapshot): void {
  if (sameSnapshot(snapshot, live)) return;
  live = snapshot;
  tray?.update(snapshot);
  const progress = progressOf(snapshot);
  if (progress.mode === 'none') win?.setProgressBar(-1);
  else if (progress.mode === 'indeterminate') win?.setProgressBar(2, { mode: 'indeterminate' });
  else win?.setProgressBar(progress.value);
  // Where the platform has no badge (most Linux docks, Windows) this does nothing and says so
  app.setBadgeCount(snapshot.waiting);
}

function startMonitor(origin: string): void {
  stopMonitor();
  // A guarded server (AGENTRY_AUTH_TOKEN in the environment the app inherited) wants the same token from the tray
  const token = process.env.AGENTRY_AUTH_TOKEN?.trim();
  monitor = new LiveMonitor({
    origin,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    onSnapshot: showLive,
    log: (line) => desktopLog.line(line),
  });
  monitor.start();
}

function stopMonitor(): void {
  monitor?.stop();
  monitor = undefined;
  showLive(EMPTY_SNAPSHOT);
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Opens an in-app path with the page's own router, so the UI keeps its state; a fresh load otherwise */
function openPath(path: string): void {
  if (!win || !serverOrigin || !isAppPath(path)) return;
  showWindow();
  const current = win.webContents.getURL();
  if (current.startsWith(`${serverOrigin}/`)) win.webContents.send(IPC.navigate, path);
  else void load(`${serverOrigin}${path}`);
}

function trayAction(action: TrayAction): void {
  if (action.kind === 'show') showWindow();
  else if (action.kind === 'open') openPath(action.path);
  else app.quit();
}

async function restartServer(): Promise<void> {
  stopMonitor();
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
    // The dock and the window switcher show this; the launcher entry's icon only covers the menu
    icon: resolveResources().icon,
    backgroundColor: '#101114',
    autoHideMenuBar: true,
    // The web's top bar is the title bar; dark until the page says which theme it shows (the splash is dark)
    ...titleBarOptions(process.platform, SPLASH_TITLE_BAR),
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
  // Before the server goes, so its dropped feed is not logged as a failure
  monitor?.stop();
  await server?.stop();
  await Promise.all([desktopLog.close(), serverLog.close()]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  // The page follows its theme (light, dark, or the system's) and tells the title bar to match
  ipcMain.on(IPC.titleBarTheme, (event, value: unknown) => {
    if (!win || event.sender !== win.webContents || !serverOrigin) return;
    if (!event.senderFrame?.url.startsWith(`${serverOrigin}/`)) return;
    const theme = parseTitleBarTheme(value);
    if (theme) paintTitleBar(theme);
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
    try {
      tray = new LiveTray(resolveResources().icon, trayAction);
      tray.update(live);
    } catch (err) {
      // A desktop without a status area is no reason to fail: the window still has everything
      desktopLog.line(`no tray: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
