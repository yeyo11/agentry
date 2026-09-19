import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, screen, type BrowserWindow, type Rectangle } from 'electron';

interface WindowState extends Partial<Rectangle> {
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 860, maximized: false };
const SAVE_DEBOUNCE_MS = 400;

const stateFile = () => join(app.getPath('userData'), 'window-state.json');

function load(): WindowState {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<WindowState>;
    const state = { ...DEFAULT_STATE, ...saved };
    // A monitor that is gone would leave the window off-screen
    const bounds = { x: state.x ?? 0, y: state.y ?? 0, width: state.width, height: state.height };
    const area = screen.getDisplayMatching(bounds).workArea;
    const visible = state.x !== undefined && state.y !== undefined && bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    return visible ? state : { ...state, x: undefined, y: undefined };
  } catch {
    return DEFAULT_STATE;
  }
}

/** Initial bounds for a new window, plus a hook that keeps the state file current */
export function restoreWindowState(): { bounds: Partial<Rectangle> & { width: number; height: number }; maximized: boolean; track(win: BrowserWindow): void } {
  const state = load();
  return {
    bounds: { x: state.x, y: state.y, width: state.width, height: state.height },
    maximized: state.maximized,
    track(win) {
      let timer: NodeJS.Timeout | undefined;
      const save = () => {
        clearTimeout(timer);
        if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
        const maximized = win.isMaximized();
        // While maximized, getNormalBounds still holds the restorable size
        const next: WindowState = { ...win.getNormalBounds(), maximized };
        try {
          writeFileSync(stateFile(), JSON.stringify(next));
        } catch {
          // Non-critical: the window just opens at the default size next time
        }
      };
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(save, SAVE_DEBOUNCE_MS);
      };
      win.on('resize', schedule);
      win.on('move', schedule);
      win.on('maximize', schedule);
      win.on('unmaximize', schedule);
      win.on('close', save);
    },
  };
}
