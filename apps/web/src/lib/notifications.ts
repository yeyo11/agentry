import { useSyncExternalStore } from 'react';
import type { AgentryEvent } from '@agentry/shared';
import {
  addNotifications,
  notificationsFor,
  parseStored,
  serializeStored,
  settle,
  settlesWaiting,
  STORAGE_KEY,
  type AppNotification,
  type NotificationDraft,
  type NotificationPrefs,
  type StoredNotifications,
} from './notifications-model';

/*
 * The notification list and its preferences, kept per browser in localStorage. It is a plain
 * external store so that the bell, the panel and the host that shows toasts share one state without
 * a provider; `ingest` is the only way events get in.
 */

export * from './notifications-model';

let state: StoredNotifications | null = null;
const listeners = new Set<() => void>();

function load(): StoredNotifications {
  if (state) return state;
  try {
    state = parseStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    // storage blocked: notifications still work for this page's lifetime
    state = parseStored(null);
  }
  return state;
}

function commit(next: StoredNotifications): void {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, serializeStored(next));
  } catch {
    // private mode or a full quota: the list just does not survive a reload
  }
  for (const listener of [...listeners]) listener();
}

// Another tab wrote: adopt it, so read state and preferences agree across tabs
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    state = null;
    for (const listener of [...listeners]) listener();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useNotifications(): AppNotification[] {
  return useSyncExternalStore(subscribe, () => load().items);
}

export function useNotificationPrefs(): NotificationPrefs {
  return useSyncExternalStore(subscribe, () => load().prefs);
}

/** For code that runs outside a render (event handlers); components use `useNotificationPrefs`. */
export const getPrefs = (): NotificationPrefs => load().prefs;

export interface Ingested {
  /** New notifications that the person has not already seen where they are */
  added: AppNotification[];
  /** Notifications an event settled: their toasts should go */
  settled: AppNotification[];
}

/**
 * Turns an event into notifications, and settles the waiting ones it answers. `seen` says whether
 * the person is already looking at what a draft is about.
 */
export function ingest(event: AgentryEvent, seen: (draft: NotificationDraft) => boolean): Ingested {
  const current = load();
  let items = current.items;
  let settled: AppNotification[] = [];

  const matches = settlesWaiting(event);
  if (matches) {
    const result = settle(items, matches);
    items = result.items;
    settled = result.changed;
  }
  const applied = addNotifications(items, notificationsFor(event), current.prefs, seen);
  if (settled.length > 0 || applied.added.length > 0) commit({ ...current, items: applied.items });
  return { added: applied.added.filter((n) => !n.read), settled };
}

/**
 * Brings the list in line with the prompts chats hold right now, for a page that has just loaded:
 * the ones it never heard about are added, and a `waiting` notification whose prompt is gone (it
 * was answered while no page was open) is settled. Notifications newer than `checkedAt` are left
 * alone, because the live feed may have told of a prompt the read did not see yet.
 */
export function seedWaiting(drafts: NotificationDraft[], checkedAt: number, seen: (draft: NotificationDraft) => boolean): Ingested {
  const current = load();
  const pending = new Set(drafts.map((d) => d.key));
  const { items, changed } = settle(current.items, (n) => n.kind === 'waiting' && !pending.has(n.key) && Date.parse(n.at) < checkedAt);
  const applied = addNotifications(items, drafts, current.prefs, seen);
  if (changed.length > 0 || applied.added.length > 0) commit({ ...current, items: applied.items });
  return { added: applied.added.filter((n) => !n.read), settled: changed };
}

function update(change:(items: AppNotification[]) => AppNotification[]): void {
  const current = load();
  commit({ ...current, items: change(current.items) });
}

export const markRead = (id: string): void =>
  update((items) => items.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n)));

export const markAllRead = (): void => update((items) => (items.some((n) => !n.read) ? items.map((n) => (n.read ? n : { ...n, read: true })) : items));

/** A prompt answered from the list is done with: it leaves rather than stays as answered. */
export const removeNotification = (id: string): void => update((items) => (items.some((n) => n.id === id) ? items.filter((n) => n.id !== id) : items));

export const clearNotifications = (): void => update((items) => (items.length > 0 ? [] : items));

export function setPrefs(change: (prefs: NotificationPrefs) => NotificationPrefs): void {
  const current = load();
  commit({ ...current, prefs: change(current.prefs) });
}

// ---------- browser notifications ----------

export type BrowserPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function browserPermission(): BrowserPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Asks the browser for permission; call it from a click, browsers ignore or block it otherwise.
 * The preference only turns on when the answer is yes.
 */
export async function enableBrowserNotifications(): Promise<BrowserPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  let permission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }
  setPrefs((prefs) => ({ ...prefs, browser: permission === 'granted' }));
  return permission;
}

/**
 * Shows a system notification when the tab is hidden, since a visible tab already has the toast.
 * `tag` makes a second tab's identical notification replace this one instead of stacking.
 */
export function showBrowserNotification(notification: AppNotification, onOpen: (href: string | null) => void): void {
  if (!load().prefs.browser || document.visibilityState !== 'hidden') return;
  if (browserPermission() !== 'granted') return;
  try {
    const shown = new Notification(notification.title, { body: notification.body, tag: notification.key, icon: '/favicon.svg', requireInteraction: notification.priority === 'high' });
    shown.onclick = () => {
      window.focus();
      onOpen(notification.href);
      shown.close();
    };
  } catch {
    // some platforms only allow notifications from a service worker
  }
}
