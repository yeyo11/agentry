// Pure helpers for editing settings.json as a plain object while preserving everything the
// guided editor does not know about.

import i18n from '../../i18n';

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseObject(text: string): { value: Json | null; error: string | null } {
  try {
    const value: unknown = JSON.parse(text.trim() || '{}');
    if (!isObject(value)) return { value: null, error: i18n.t('config:settings.notObject') };
    return { value, error: null };
  } catch (err) {
    return { value: null, error: (err as Error).message };
  }
}

export function getIn(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isObject(value) && Object.keys(value).length === 0;
}

/**
 * Immutable set. Empty values (undefined, '', [], {}) delete the key, and parents left empty
 * by that deletion are pruned too, so the file does not fill up with `"permissions": {}`.
 */
export function setIn(root: Json, path: string[], value: unknown): Json {
  const [head, ...rest] = path;
  if (head === undefined) return root;
  const next: Json = { ...root };
  if (rest.length === 0) {
    if (isEmpty(value)) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = setIn(isObject(root[head]) ? root[head] : {}, rest, value);
  if (Object.keys(child).length === 0) delete next[head];
  else next[head] = child;
  return next;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Top-level keys that differ between the saved document and the draft. */
export function changedKeys(saved: Json, draft: Json): Array<{ key: string; change: 'added' | 'removed' | 'changed' }> {
  const result: Array<{ key: string; change: 'added' | 'removed' | 'changed' }> = [];
  for (const key of new Set([...Object.keys(saved), ...Object.keys(draft)])) {
    if (!(key in saved)) result.push({ key, change: 'added' });
    else if (!(key in draft)) result.push({ key, change: 'removed' });
    else if (JSON.stringify(saved[key]) !== JSON.stringify(draft[key])) result.push({ key, change: 'changed' });
  }
  return result;
}

// ---------- Hooks ----------

// Each event's hint lives in the `config` locale under settingsGuided.hookEvents
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
] as const;

export interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [extra: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [extra: string]: unknown;
}

export function hookGroups(settings: Json, event: string): HookGroup[] {
  const raw = getIn(settings, ['hooks', event]);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map((group) => ({
    ...group,
    hooks: Array.isArray(group.hooks) ? (group.hooks.filter(isObject) as HookCommand[]) : [],
  })) as HookGroup[];
}

/** Keys the guided editor has a control for; everything else is listed as "preserved". */
export const GUIDED_KEYS = new Set([
  'model',
  'outputStyle',
  'cleanupPeriodDays',
  'includeCoAuthoredBy',
  'apiKeyHelper',
  'statusLine',
  'permissions',
  'env',
  'hooks',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enabledPlugins',
  'extraKnownMarketplaces',
]);
