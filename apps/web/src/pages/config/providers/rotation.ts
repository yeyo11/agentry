import type {
  LimitAction,
  ModelMapEntry,
  ModelOption,
  ProviderId,
  ProviderLimit,
  ProviderMove,
  ProjectProvidersSettings,
  ProvidersSettings,
  RotationSettings,
} from '@agentry/shared';

// Pure edits of the `rotation` block of `providers.json` and of a project's `providers` override:
// the cards build the next document with these and send it whole, so a test can read every rule
// (what a missing block means, what keeps `allowed` honest) without a page.

export const ACTIONS: readonly LimitAction[] = ['handoff', 'restart', 'wait'];
export const WAIT_HOURS = { min: 1, max: 48 } as const;
export const MOVES = { min: 0, max: 5 } as const;

/** What a file written before phase 4 means: nothing leaves for a second vendor until a person says so. */
export const DEFAULT_ROTATION: RotationSettings = {
  onLimit: { action: 'wait', allowed: ['wait'], maxWaitHours: 6, maxMoves: 2 },
  modelMap: [],
};

export type OnLimit = RotationSettings['onLimit'];

export const rotationOf = (settings: ProvidersSettings): RotationSettings => settings.rotation ?? DEFAULT_ROTATION;

/** `onLimit` with a field changed. The chosen action is always one a decision may pick, listed in the cards' order. */
export function onLimitWith(on: OnLimit, patch: Partial<OnLimit>): OnLimit {
  const next = { ...on, ...patch };
  return { ...next, allowed: ACTIONS.filter((a) => a === next.action || next.allowed.includes(a)) };
}

/** Allow or disallow one action for a decision point. The action in force stays allowed. */
export function allowedWith(on: OnLimit, action: LimitAction, allow: boolean): OnLimit {
  if (action === on.action) return on;
  return onLimitWith(on, { allowed: allow ? [...on.allowed, action] : on.allowed.filter((a) => a !== action) });
}

/** The document with `onLimit` replaced; the model mapping and the rest are the document's own. */
export function withOnLimit(settings: ProvidersSettings, onLimit: OnLimit): ProvidersSettings {
  return { ...settings, rotation: { ...rotationOf(settings), onLimit } };
}

export const clampInt = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

/** The counterpart a person (or an accepted suggestion) chose for one model on one other provider. */
export function counterpart(map: readonly ModelMapEntry[], from: { provider: ProviderId; model: string }, to: ProviderId): ModelMapEntry | undefined {
  return map.find((e) => e.from.provider === from.provider && e.from.model === from.model && e.to.provider === to);
}

/**
 * The document with the counterpart of one model on one provider set, or removed with `null`.
 * Everything a person writes here has origin `person`.
 */
export function withCounterpart(
  settings: ProvidersSettings,
  from: { provider: ProviderId; model: string },
  to: { provider: ProviderId; model: string | null },
  at: string,
): ProvidersSettings {
  const rotation = rotationOf(settings);
  const rest = rotation.modelMap.filter((e) => !(e.from.provider === from.provider && e.from.model === from.model && e.to.provider === to.provider));
  const modelMap = to.model === null ? rest : [...rest, { from, to: { provider: to.provider, model: to.model }, origin: 'person' as const, at }];
  return { ...settings, rotation: { ...rotation, modelMap } };
}

/** True when an entry's model is no longer offered by its provider; a catalog not read yet cannot say so. */
export function isStale(entry: ModelMapEntry, catalog: readonly ModelOption[] | undefined): boolean {
  return catalog !== undefined && catalog.length > 0 && !catalog.some((m) => m.value === entry.to.model && !m.disabled);
}

/** The models of a catalog a person may pick: the ones the CLI can run. */
export const offered = (catalog: readonly ModelOption[] | undefined): ModelOption[] => (catalog ?? []).filter((m) => !m.disabled);

/** One bar of a provider's limit: the window, how much of it is used and when it resets. */
export interface LimitRow {
  name: string;
  percent: number;
  /** ISO time, or null when the provider did not say */
  resetsAt: string | null;
}

/** The windows a limit reports, the five-hour and seven-day ones first, then the rest by name. */
export function limitRows(limit: ProviderLimit): LimitRow[] {
  const rank = (name: string) => (name === '5h' ? 0 : name === '7d' ? 1 : 2);
  const rows = Object.entries(limit.windows).map(([name, w]) => ({
    name,
    percent: Math.max(0, Math.min(100, Math.round(w.utilization * 100))),
    resetsAt: w.resetsAt > 0 ? new Date(w.resetsAt * 1000).toISOString() : null,
  }));
  rows.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  // A provider that reports one figure and no windows still shows it
  if (rows.length === 0 && limit.utilization !== null) {
    return [{ name: limit.window ?? 'primary', percent: Math.max(0, Math.min(100, Math.round(limit.utilization * 100))), resetsAt: limit.resetsAt }];
  }
  return rows;
}

/** The pairs (source model, target provider) that open waits are waiting on: what the editor marks "asked by a job". */
export function waitingPairs(moves: readonly ProviderMove[]): Set<string> {
  const pairs = new Set<string>();
  for (const move of moves) {
    if (move.state !== 'waiting' && move.state !== 'resuming') continue;
    if (move.fromModel) pairs.add(`${move.fromProvider}\0${move.fromModel}`);
  }
  return pairs;
}

/** What goes in `ProjectSettings.providers`: nothing at all when nothing differs from the global. */
export function projectProvidersOf(order: ProviderId[] | null, onLimit: Partial<OnLimit>): ProjectProvidersSettings | undefined {
  const out: ProjectProvidersSettings = {};
  if (order) out.order = order;
  const kept: Partial<OnLimit> = {};
  if (onLimit.action !== undefined) kept.action = onLimit.action;
  if (onLimit.allowed !== undefined) kept.allowed = onLimit.allowed;
  if (onLimit.maxWaitHours !== undefined) kept.maxWaitHours = onLimit.maxWaitHours;
  if (onLimit.maxMoves !== undefined) kept.maxMoves = onLimit.maxMoves;
  if (Object.keys(kept).length > 0) out.onLimit = kept;
  return Object.keys(out).length > 0 ? out : undefined;
}
