import type { EditorSettings } from '@agentry/shared';
import { useSyncExternalStore } from 'react';
import { api } from '../api';
import { DEFAULT_EDITOR, LEGACY_EDITOR_KEY, planEditorLoad, sanitizeEditor } from './editor';

/*
 * The editor settings every link on the page is built from. Read from the server once, when the
 * first link or the settings tab needs them; until then this browser's old copy, if it has one, so
 * a link does not change under the cursor when the answer comes.
 */

interface EditorState {
  settings: EditorSettings;
  /** The server has answered: the settings tab waits for it before it fills its form */
  ready: boolean;
}

const listeners = new Set<() => void>();
let state: EditorState | null = null;
let loading = false;

function legacyCopy(): string | null {
  try {
    return localStorage.getItem(LEGACY_EDITOR_KEY);
  } catch {
    // storage blocked: there is nothing to move
    return null;
  }
}

function dropLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_EDITOR_KEY);
  } catch {
    // storage blocked: nothing was read from it either
  }
}

function initial(): EditorState {
  const legacy = legacyCopy();
  if (legacy) {
    try {
      return { settings: sanitizeEditor(JSON.parse(legacy)), ready: false };
    } catch {
      // corrupt: the load drops it
    }
  }
  return { settings: DEFAULT_EDITOR, ready: false };
}

function set(next: EditorState): void {
  state = next;
  listeners.forEach((l) => l());
}

async function load(): Promise<void> {
  if (loading || state?.ready) return;
  loading = true;
  try {
    const plan = planEditorLoad(await api.editorSettings(), legacyCopy());
    let settings = plan.settings;
    if (plan.migrate) {
      try {
        settings = sanitizeEditor((await api.putEditorSettings(plan.migrate)).settings);
        dropLegacy();
      } catch {
        // Refused (read-only mode, say): the copy stays for this browser and is offered again next time
      }
    }
    if (plan.dropLegacy) dropLegacy();
    set({ settings, ready: true });
  } catch {
    // The server did not answer: links keep what they have, and the next page that needs them asks again
  } finally {
    loading = false;
  }
}

function snapshot(): EditorState {
  return (state ??= initial());
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  void load();
  return () => listeners.delete(listener);
};

export const useEditorState = (): EditorState => useSyncExternalStore(subscribe, snapshot);

export const useEditorSettings = (): EditorSettings => useEditorState().settings;

/** Saves on the server, which checks the template again, and applies what it kept. */
export async function saveEditorSettings(next: EditorSettings): Promise<EditorSettings> {
  const saved = sanitizeEditor((await api.putEditorSettings(sanitizeEditor(next))).settings);
  set({ settings: saved, ready: true });
  return saved;
}
