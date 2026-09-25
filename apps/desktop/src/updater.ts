import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { LiveSnapshot } from './live.ts';

/**
 * The desktop app's own updates, through electron-updater: `AppImageUpdater` replaces the AppImage in
 * place, `DebUpdater` installs the downloaded .deb through pkexec. Nothing happens unasked: the server's
 * release check says a release exists, and this only checks, downloads and installs when the person
 * says so. Free of Electron and of electron-updater itself (both are injected), so the state machine
 * is tested with a fake of the updater's events.
 */

/** The kind of package this app runs from; also AGENTRY_DISTRIBUTION for the server child */
export type Distribution = 'appimage' | 'deb';

export type UnsupportedReason = 'development' | 'read-only' | 'unknown-package' | 'no-elevation';

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'unsupported'; reason: UnsupportedReason; message: string }
  | { status: 'error'; message: string };

export interface PackageFacts {
  /** process.env.APPIMAGE: the AppImage's own path, set by its runtime */
  appImage: string | undefined;
  /** The contents of <resources>/package-type, which electron-builder writes into the .deb */
  packageType: string | undefined;
}

/** What electron-updater itself looks at to pick its Linux updater (out/main.js), in the same order */
export function distributionOf({ appImage, packageType }: PackageFacts): Distribution | undefined {
  if (appImage) return 'appimage';
  if (packageType?.trim() === 'deb') return 'deb';
  return undefined;
}

/** <resources>/package-type, or undefined outside a package that has one */
export function readPackageType(resourcesPath: string): string | undefined {
  try {
    return readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The updater unlinks the AppImage and moves the new one into its folder, so both must be writable */
export function appImageWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    accessSync(dirname(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The graphical sudo tools electron-updater tries for a .deb, in its order (LinuxUpdater.determineSudoCommand) */
const GRAPHICAL_SUDO = ['gksudo', 'kdesudo', 'pkexec', 'beesu'];

/**
 * Whether installing a .deb can ask for a password on screen. Without one of these tools
 * electron-updater falls back to plain `sudo`, which has no terminal to ask on and fails after the
 * download, with the server already stopped. Looked up on this process's PATH, as electron-updater does.
 */
export function debCanElevate(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.()): boolean {
  if (uid === 0) return true;
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return GRAPHICAL_SUDO.some((tool) =>
    dirs.some((dir) => {
      try {
        accessSync(join(dir, tool), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

export interface SupportFacts extends PackageFacts {
  dev: boolean;
  appImageWritable: (path: string) => boolean;
  debCanElevate: () => boolean;
}

export type Support = { supported: true; distribution: Distribution } | Extract<UpdateState, { status: 'unsupported' }>;

/** Whether this copy can update itself, and if not, why, in words the UI can show */
export function updateSupport(facts: SupportFacts): Support {
  if (facts.dev) {
    return { status: 'unsupported', reason: 'development', message: 'Updates are off in a development build.' };
  }
  const distribution = distributionOf(facts);
  if (!distribution) {
    return {
      status: 'unsupported',
      reason: 'unknown-package',
      message: 'This copy of Agentry was not installed from an AppImage or a .deb, so it cannot update itself.',
    };
  }
  if (distribution === 'appimage' && facts.appImage && !facts.appImageWritable(facts.appImage)) {
    return {
      status: 'unsupported',
      reason: 'read-only',
      message: `The AppImage at ${facts.appImage} cannot be replaced: the file or its folder is not writable.`,
    };
  }
  if (distribution === 'deb' && !facts.debCanElevate()) {
    return {
      status: 'unsupported',
      reason: 'no-elevation',
      message:
        'Installing the .deb needs a password prompt (pkexec), and none was found. Install policykit-1, or download the .deb and install it with apt.',
    };
  }
  return { supported: true, distribution };
}

/**
 * The part of electron-updater's `AppUpdater`/`BaseUpdater` this module drives, declared
 * structurally so a test can hand in a fake. Listeners take `unknown`: what the events carry is
 * checked here rather than trusted.
 */
export interface UpdaterEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: { info(message?: unknown): void; warn(message?: unknown): void; error(message?: unknown): void } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  /** Replaces the installed app with the downloaded one, synchronously; false when it could not */
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
}

export interface DesktopUpdaterOptions {
  support: Support;
  /** Called at most once, and only when this copy can update: nothing loads electron-updater otherwise */
  engine: () => UpdaterEngine;
  log: (line: string) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const versionOf = (info: unknown): string | undefined => {
  const version = (info as { version?: unknown } | null)?.version;
  return typeof version === 'string' ? version : undefined;
};

export class DesktopUpdater {
  private current: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private engineInstance: UpdaterEngine | undefined;
  /** Set by install({ whenIdle }): the quit path installs the downloaded update once the server is down */
  private installOnQuitRequested = false;
  /** Where the AppImage ended up: a hand-downloaded, versioned file name is replaced by the new version's */
  private appImagePath: string | undefined;

  constructor(private readonly opts: DesktopUpdaterOptions) {
    this.current = 'supported' in opts.support ? { status: 'idle' } : opts.support;
  }

  get state(): UpdateState {
    return this.current;
  }

  get distribution(): Distribution | undefined {
    return 'supported' in this.opts.support ? this.opts.support.distribution : undefined;
  }

  /** The version downloaded and waiting to be installed, if any */
  get readyVersion(): string | undefined {
    return this.current.status === 'ready' ? this.current.version : undefined;
  }

  get installOnQuit(): boolean {
    return this.installOnQuitRequested && this.current.status === 'ready';
  }

  /** The new AppImage's path when the updater renamed it, for the relaunch */
  get installedAppImage(): string | undefined {
    return this.appImagePath;
  }

  onState(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private set(state: UpdateState): void {
    // The engine's events and this module's own steps often say the same thing; say it once
    if (JSON.stringify(state) === JSON.stringify(this.current)) return;
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  private get engine(): UpdaterEngine | undefined {
    if (!('supported' in this.opts.support)) return undefined;
    if (this.engineInstance) return this.engineInstance;
    const engine = this.opts.engine();
    engine.autoDownload = false;
    engine.autoInstallOnAppQuit = false;
    engine.logger = {
      info: (m) => this.opts.log(`updater: ${String(m)}`),
      warn: (m) => this.opts.log(`updater warning: ${String(m)}`),
      error: (m) => this.opts.log(`updater error: ${String(m)}`),
    };
    engine.on('checking-for-update', () => this.set({ status: 'checking' }));
    engine.on('update-available', (info) => {
      const version = versionOf(info);
      if (version) this.set({ status: 'available', version });
    });
    engine.on('update-not-available', () => this.set({ status: 'idle' }));
    engine.on('download-progress', (progress) => {
      const percent = (progress as { percent?: unknown } | null)?.percent;
      const version = this.versionInFlight();
      if (typeof percent === 'number' && Number.isFinite(percent) && version) {
        this.set({ status: 'downloading', version, percent: Math.max(0, Math.min(100, Math.round(percent))) });
      }
    });
    engine.on('update-downloaded', (info) => {
      const version = versionOf(info) ?? this.versionInFlight();
      if (version) this.set({ status: 'ready', version });
    });
    engine.on('update-cancelled', () => this.set({ status: 'idle' }));
    engine.on('appimage-filename-updated', (path) => {
      if (typeof path === 'string') this.appImagePath = path;
    });
    engine.on('error', (err) => this.set({ status: 'error', message: messageOf(err) }));
    this.engineInstance = engine;
    return engine;
  }

  private versionInFlight(): string | undefined {
    const s = this.current;
    return s.status === 'available' || s.status === 'downloading' || s.status === 'ready' ? s.version : undefined;
  }

  /** Asks GitHub's latest-linux.yml whether there is a newer version; the state says what it found */
  async check(): Promise<UpdateState> {
    const engine = this.engine;
    if (!engine) return this.current;
    if (this.current.status === 'downloading' || this.current.status === 'ready') return this.current;
    this.set({ status: 'checking' });
    try {
      const result = await engine.checkForUpdates();
      // The events usually said it already; this covers an engine that answered without them
      if (this.current.status === 'checking') {
        const version = result?.isUpdateAvailable ? result.updateInfo.version : undefined;
        this.set(version ? { status: 'available', version } : { status: 'idle' });
      }
    } catch (err) {
      this.set({ status: 'error', message: messageOf(err) });
    }
    return this.current;
  }

  /** Downloads the newest release, checking first when nothing is known about it yet */
  async download(): Promise<UpdateState> {
    const engine = this.engine;
    if (!engine) return this.current;
    if (this.current.status === 'downloading' || this.current.status === 'ready') return this.current;
    const found = this.current.status === 'available' ? this.current : await this.check();
    if (found.status !== 'available') return found;
    this.set({ status: 'downloading', version: found.version, percent: 0 });
    try {
      await engine.downloadUpdate();
    } catch (err) {
      this.set({ status: 'error', message: messageOf(err) });
    }
    return this.current;
  }

  /**
   * The update applies the next time the app quits. electron-updater's own `autoInstallOnAppQuit`
   * only takes effect when it is already on as the download finishes, and it installs on Electron's
   * `quit` whatever the server child is doing; the quit path asks `installOnQuit` and calls `install`
   * itself instead, after the server is down.
   */
  requestInstallOnQuit(): boolean {
    if (this.current.status !== 'ready') return false;
    this.installOnQuitRequested = true;
    return true;
  }

  /** Replaces the installed app with the downloaded update; the caller has stopped the server and quits after */
  install(): boolean {
    const engine = this.engine;
    if (!engine || this.current.status !== 'ready') return false;
    try {
      // Silent, and no run after: the caller relaunches once this process has exited, so the new
      // instance does not lose the single-instance lock to the one still shutting down
      return engine.install(true, false);
    } catch (err) {
      this.set({ status: 'error', message: messageOf(err) });
      return false;
    }
  }
}

/**
 * How the new AppImage is started once this process is gone. Not `app.relaunch()`: on Linux that
 * hands the job to a helper run from Electron's own binary, which inside an AppImage lives in the
 * image's mount, and the mount goes away as this process exits, taking the helper with it before it
 * starts anything. A shell outside the mount waits for this process to exit, so the new instance
 * gets the single-instance lock, and then runs the AppImage's real path.
 *
 * Chromium leaves some descriptors inheritable (the DevTools socket among them), and whatever reaches
 * the new instance keeps files of the old mount open, so the old image's FUSE process never exits.
 * The shell closes everything above stderr before it runs the new one. Bash, because a plain sh
 * cannot close a descriptor above 9, and the AppImage's own AppRun already needs it.
 */
export function appImageRelaunch(pid: number, appImage: string, args: readonly string[]): { command: string; args: string[] } {
  const script = [
    'for fd in /proc/$$/fd/*; do n=${fd##*/}; if [ "$n" -gt 2 ]; then eval "exec $n>&-"; fi; done 2>/dev/null',
    'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done',
    'shift',
    'exec "$@"',
  ].join('\n');
  return { command: '/bin/bash', args: ['-c', script, 'agentry-relaunch', String(pid), appImage, ...args] };
}

/** What is live that a restart would stop */
export interface LiveWork {
  working: number;
  waiting: number;
  running: number;
}

export type InstallAnswer =
  | { status: 'restarting'; version: string }
  | { status: 'scheduled'; version: string }
  | { status: 'busy'; version: string; live: LiveWork }
  | { status: 'not-ready'; state: UpdateState };

export interface InstallRequest {
  /** Install the next time the app quits instead of now */
  whenIdle?: boolean;
  /** Restart even though work is live: the person was asked and said so */
  force?: boolean;
}

/**
 * What `install` does with the update, given what the tray knows is live. A restart stops the server,
 * and with it every chat and orchestration in flight, so it never happens over live work unless the
 * person was asked (`force`); a chat waiting for a permission answer counts too, its CLI is running.
 */
export function installDecision(state: UpdateState, live: LiveSnapshot, request: InstallRequest): InstallAnswer {
  if (state.status !== 'ready') return { status: 'not-ready', state };
  if (request.whenIdle) return { status: 'scheduled', version: state.version };
  const work = { working: live.working, waiting: live.waiting, running: live.running };
  if (!request.force && (work.working || work.waiting || work.running)) {
    return { status: 'busy', version: state.version, live: work };
  }
  return { status: 'restarting', version: state.version };
}

/** The request the page sent over IPC, reduced to the two flags it may carry */
export function parseInstallRequest(value: unknown): InstallRequest {
  if (!value || typeof value !== 'object') return {};
  const { whenIdle, force } = value as Record<string, unknown>;
  return { whenIdle: whenIdle === true, force: force === true };
}
