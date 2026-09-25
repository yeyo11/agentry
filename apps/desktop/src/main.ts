import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { AppImageUpdater, DebUpdater } from 'electron-updater';
import { IPC, isAppPath } from './ipc.ts';
import { EMPTY_SNAPSHOT, liveWords, progressOf, sameSnapshot, type LiveSnapshot, type TrayAction } from './live.ts';
import { LiveMonitor } from './live-monitor.ts';
import { LogFile } from './log.ts';
import { buildMenu } from './menu.ts';
import { ACTION_SCHEME, errorUrl, splashUrl } from './pages.ts';
import { missingResources, resolveResources } from './resources.ts';
import { rememberedPort, rememberPort } from './server-port.ts';
import { ServerProcess } from './server-process.ts';
import { resolveUserPath } from './shell-path.ts';
import { SPLASH_TITLE_BAR, parseTitleBarTheme, titleBarOptions, type TitleBarTheme } from './title-bar.ts';
import { LiveTray } from './tray.ts';
import {
  appImageRelaunch,
  appImageWritable,
  debCanElevate,
  DesktopUpdater,
  distributionOf,
  installDecision,
  parseInstallRequest,
  readPackageType,
  updateSupport,
  type InstallAnswer,
  type InstallRequest,
  type UpdaterEngine,
  type UpdateState,
} from './updater.ts';
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
const RELEASES_URL = 'https://github.com/yeyo11/agentry/releases/latest';

// Which package this is, the way electron-updater tells: the AppImage runtime sets APPIMAGE, and
// electron-builder writes resources/package-type into the .deb
const packageFacts = { appImage: process.env.APPIMAGE, packageType: readPackageType(process.resourcesPath) };
const distribution = distributionOf(packageFacts);

let win: BrowserWindow | undefined;
let server: ServerProcess | undefined;
let serverOrigin: string | undefined;
let starting = false;
let quitting = false;
let monitor: LiveMonitor | undefined;
let tray: LiveTray | undefined;
let live: LiveSnapshot = EMPTY_SNAPSHOT;
let updater: DesktopUpdater;
/** A restart to install an update is under way: the server is going down on purpose */
let updating = false;

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
          // The port this install used last, so its address survives a restart; PORT still wins,
          // and 0 on a first start lets the operating system choose one to remember
          PORT: process.env.PORT || String(rememberedPort(userData) ?? 0),
          HOST: '127.0.0.1',
          AGENTRY_WEB_DIST: res.webDist,
          AGENTRY_DATA_DIR: dataDir,
          AGENTRY_WORKSPACE_DIR: workspaceDir,
          AGENTRY_VERSION: app.getVersion(),
          // The UI offers the install that fits: this app's own updater, or instructions
          ...(distribution ? { AGENTRY_DISTRIBUTION: distribution } : {}),
          // The desktop is not a sandbox: AGENTRY_DEFAULT_PERMISSION_MODE stays unset (core default: acceptEdits)
        },
      },
      serverLog,
      (detail) => showError('The Agentry server stopped unexpectedly', detail),
    );
    const url = await server.start();
    serverOrigin = new URL(url).origin;
    // What it bound, not what it was asked for: a taken port makes the server pick another
    rememberPort(userData, Number(new URL(url).port));
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
  tray?.update(snapshot, updater.readyVersion);
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
  else if (action.kind === 'update') void confirmRestart();
  else app.quit();
}

/** Only the local server's own page may drive the shell; a page it navigated to elsewhere may not */
function fromLocalPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!win || event.sender !== win.webContents || !serverOrigin) return false;
  return event.senderFrame?.url.startsWith(`${serverOrigin}/`) ?? false;
}

function createUpdater(): DesktopUpdater {
  const next = new DesktopUpdater({
    support: updateSupport({ ...packageFacts, dev: isDev, appImageWritable, debCanElevate: () => debCanElevate() }),
    // Picked the way electron-updater's own autoUpdater picks, from the same facts
    engine: () => (distribution === 'deb' ? new DebUpdater() : new AppImageUpdater()) satisfies UpdaterEngine,
    log: (line) => desktopLog.line(line),
  });
  next.onState((state) => {
    desktopLog.line(`update state: ${JSON.stringify(state)}`);
    tray?.update(live, next.readyVersion);
    if (win && serverOrigin && win.webContents.getURL().startsWith(`${serverOrigin}/`)) {
      win.webContents.send(IPC.updateChanged, state);
    }
  });
  return next;
}

/**
 * Restarts into the downloaded update. The server child goes first, so no chat or orchestration is
 * still writing while the updater replaces the files under it; the new version starts once this
 * process has exited, so it gets the single-instance lock.
 */
async function restartToUpdate(): Promise<void> {
  if (updating || quitting) return;
  updating = true;
  desktopLog.line(`restarting to update to ${updater.readyVersion ?? '?'}`);
  stopMonitor();
  await server?.stop();
  if (!updater.install()) {
    updating = false;
    desktopLog.line('the update could not be installed; starting the server again');
    await startServer();
    return;
  }
  // The AppImage's own path, not process.execPath: that points inside its mount, gone after the exit
  const appImage = distribution === 'appimage' ? (updater.installedAppImage ?? process.env.APPIMAGE) : undefined;
  if (appImage) {
    const relaunch = appImageRelaunch(process.pid, appImage, process.argv.slice(1));
    spawn(relaunch.command, relaunch.args, { detached: true, stdio: 'ignore', cwd: process.env.OWD ?? homedir() }).unref();
  } else {
    app.relaunch();
  }
  app.quit();
}

/** What the page's install() does: restart, schedule for the next quit, or say what is live */
function requestInstall(request: InstallRequest): InstallAnswer {
  const answer = installDecision(updater.state, live, request);
  if (answer.status === 'scheduled') {
    updater.requestInstallOnQuit();
    desktopLog.line(`update to ${answer.version} will install on quit`);
  } else if (answer.status === 'restarting') {
    void restartToUpdate();
  }
  return answer;
}

/** The shell's own restart (tray, Help menu): asks first when a restart would stop live work */
async function confirmRestart(): Promise<void> {
  const answer = installDecision(updater.state, live, {});
  if (answer.status === 'restarting') {
    void restartToUpdate();
    return;
  }
  if (answer.status !== 'busy') return;
  showWindow();
  const response = await message({
    type: 'question',
    message: `Restart to update to Agentry ${answer.version}?`,
    detail: `${liveWords(live) ?? 'Work is running'}. Restarting now stops it.`,
    buttons: ['Restart now', 'Update when I quit', 'Cancel'],
    defaultId: 1,
    cancelId: 2,
  });
  if (response === 0) requestInstall({ force: true });
  else if (response === 1) requestInstall({ whenIdle: true });
}

/** A dialog on the window when there is one; resolves with the index of the button pressed */
async function message(options: Electron.MessageBoxOptions): Promise<number> {
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response;
}

/** Asks with two buttons; true for the first */
async function ask(options: Omit<Electron.MessageBoxOptions, 'defaultId' | 'cancelId'>): Promise<boolean> {
  return (await message({ ...options, defaultId: 0, cancelId: 1 })) === 0;
}

/** Help → Check for updates…: the person asked, so this is where the updater talks to GitHub */
async function checkForUpdatesFromMenu(): Promise<void> {
  const state: UpdateState = await updater.check();
  const current = app.getVersion();
  switch (state.status) {
    case 'unsupported':
      if (
        await ask({
          type: 'info',
          message: 'Agentry cannot update itself here',
          detail: state.message,
          buttons: ['Open releases page', 'Close'],
        })
      ) {
        void shell.openExternal(RELEASES_URL);
      }
      return;
    case 'idle':
      await message({ type: 'info', message: 'Agentry is up to date', detail: `You are running ${current}, the newest release.` });
      return;
    case 'available': {
      const download = await ask({
        type: 'info',
        message: `Agentry ${state.version} is available`,
        detail: `You are running ${current}. It downloads in the background, and you choose when to restart.`,
        buttons: ['Download', 'Later'],
      });
      if (!download) return;
      const done = await updater.download();
      if (done.status === 'ready') await offerRestart(done.version);
      else if (done.status === 'error') {
        await message({ type: 'error', message: 'The update could not be downloaded', detail: done.message });
      }
      return;
    }
    case 'downloading':
      await message({
        type: 'info',
        message: `Downloading Agentry ${state.version}`,
        detail: `${state.percent}% so far. The tray offers the restart when it is done.`,
      });
      return;
    case 'ready':
      await offerRestart(state.version);
      return;
    case 'error':
      await message({ type: 'error', message: 'Could not check for updates', detail: state.message });
      return;
    case 'checking':
      return;
  }
}

async function offerRestart(version: string): Promise<void> {
  const restart = await ask({
    type: 'info',
    message: `Agentry ${version} is ready to install`,
    detail: 'Restart now to use it, or later from the tray.',
    buttons: ['Restart', 'Later'],
  });
  if (restart) await confirmRestart();
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
    backgroundColor: '#09090b',
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
  // install({ whenIdle }) left the update for now: the server is down, so nothing runs from the files it replaces
  if (!updating && updater?.installOnQuit) {
    desktopLog.line(`installing update to ${updater.readyVersion ?? '?'} on quit`);
    updater.install();
  }
  await Promise.all([desktopLog.close(), serverLog.close()]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  // The page follows its theme (light, dark, or the system's) and tells the title bar to match
  ipcMain.on(IPC.titleBarTheme, (event, value: unknown) => {
    if (!fromLocalPage(event)) return;
    const theme = parseTitleBarTheme(value);
    if (theme) paintTitleBar(theme);
  });

  // window.agentryDesktop.updates: the same local-page rule as the title bar
  const denied = () => Promise.reject(new Error('not allowed from this page'));
  ipcMain.handle(IPC.updateState, (event) => (fromLocalPage(event) ? updater.state : denied()));
  ipcMain.handle(IPC.updateDownload, (event) => (fromLocalPage(event) ? updater.download() : denied()));
  ipcMain.handle(IPC.updateInstall, (event, value: unknown) =>
    fromLocalPage(event) ? requestInstall(parseInstallRequest(value)) : denied(),
  );

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
    updater = createUpdater();
    Menu.setApplicationMenu(
      buildMenu({ data: dataDir, workspace: workspaceDir, logs: logsDir }, isDev, {
        quit: () => app.quit(),
        checkForUpdates: () => void checkForUpdatesFromMenu(),
      }),
    );
    createWindow();
    try {
      tray = new LiveTray(resolveResources().icon, trayAction);
      tray.update(live, updater.readyVersion);
    } catch (err) {
      // A desktop without a status area is no reason to fail: the window still has everything
      desktopLog.line(`no tray: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
