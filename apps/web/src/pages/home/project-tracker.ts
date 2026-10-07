/**
 * The project's tracker form as plain data: the draft a person edits, what the form says about each
 * tracker it offers, and what goes to `PUT /projects/:id/tracker`. No React, tested without a
 * browser (test/project-tracker.test.ts).
 */
import type { CodeHostId, ProjectTrackerSettings, TrackerId, TrackerMappedStatus, TrackerStatus } from '@agentry/shared';
import { canChooseTracker, hasNamedStatuses, isTrackerBuilt, setMapped, trackerTone, YOUTRACK_DEFAULT_STATES, type TrackerTone } from '../../lib/trackers';

export interface TrackerDraft {
  /** The chosen tracker; null is none */
  id: TrackerId | null;
  scope: string;
  query: string;
  statusMap: Partial<Record<TrackerMappedStatus, string>>;
}

export const NO_TRACKER: TrackerDraft = { id: null, scope: '', query: '', statusMap: {} };

export const draftOf = (saved: ProjectTrackerSettings | null | undefined): TrackerDraft =>
  saved ? { id: saved.id, scope: saved.scope, query: saved.query, statusMap: { ...saved.statusMap } } : NO_TRACKER;

/** What is saved: nothing when no tracker is chosen. The scope and query are kept as typed, minus the edges. */
export const settingsOf = (draft: TrackerDraft): ProjectTrackerSettings | null =>
  draft.id ? { id: draft.id, scope: draft.scope.trim(), query: draft.query.trim(), statusMap: trimmedMap(draft.statusMap) } : null;

/** A status typed by hand (YouTrack's State) is saved without its edges, and one left blank is not synced. */
function trimmedMap(map: TrackerDraft['statusMap']): TrackerDraft['statusMap'] {
  const out: TrackerDraft['statusMap'] = {};
  for (const [column, value] of Object.entries(map) as Array<[TrackerMappedStatus, string | undefined]>) {
    const trimmed = value?.trim();
    if (trimmed) out[column] = trimmed;
  }
  return out;
}

export const sameDraft = (a: TrackerDraft, b: TrackerDraft): boolean => JSON.stringify(settingsOf(a)) === JSON.stringify(settingsOf(b));

/** A tracker with no scope cannot be asked for anything. */
export const canSaveDraft = (draft: TrackerDraft): boolean => draft.id === null || draft.scope.trim() !== '';

/**
 * Choosing a tracker starts from what works: on GitHub and GitLab the repository of the origin
 * remote as scope and `done` closing the issue; on YouTrack an empty project short name and the
 * State names a new YouTrack project has. Choosing the same one again changes nothing, and another
 * tracker's query does not carry over.
 */
export function chooseTracker(draft: TrackerDraft, id: TrackerId | null, remotePath: string | null): TrackerDraft {
  if (id === null) return NO_TRACKER;
  if (draft.id === id) return draft;
  if (hasNamedStatuses(id)) return { id, scope: '', query: '', statusMap: { in_progress: YOUTRACK_DEFAULT_STATES.in_progress, done: YOUTRACK_DEFAULT_STATES.done } };
  return { id, scope: remotePath ?? '', query: '', statusMap: isTrackerBuilt(id) ? { done: 'completed' } : {} };
}

export const withMapped = (draft: TrackerDraft, column: TrackerMappedStatus, value: string): TrackerDraft => ({ ...draft, statusMap: setMapped(draft.statusMap, column, value) });

/** Why a tracker can or cannot be chosen: `tracker.reason.<key>` in the `projects` namespace. */
export type OptionReason = 'ready' | 'wrong-host' | 'signed-out' | 'incompatible' | 'not-installed' | 'unknown' | 'not-built' | 'disabled';

export interface TrackerOption {
  id: TrackerId;
  status: TrackerStatus;
  /** Whether it can be picked now; the others are listed disabled, with their reason */
  choosable: boolean;
  /** `tracker.state.<key>`: the badge's word */
  stateKey: 'ready' | 'unavailable' | 'signed-out' | 'incompatible' | 'not-installed' | 'unknown';
  tone: TrackerTone;
  reason: OptionReason;
}

/**
 * One row of the chooser. GitHub and GitLab issues reuse the CLI of their code host, so a tracker
 * whose host is not the project's cannot be chosen even when it is ready.
 */
export function trackerOption(status: TrackerStatus, projectHost: CodeHostId | null, enabled: boolean): TrackerOption {
  const base = { id: status.id, status };
  if (!isTrackerBuilt(status.id)) return { ...base, choosable: false, stateKey: 'unknown', tone: 'idle', reason: 'not-built' };
  if (!enabled) return { ...base, choosable: false, stateKey: 'unavailable', tone: 'muted', reason: 'disabled' };
  if (status.host !== null && status.host !== projectHost) return { ...base, choosable: false, stateKey: 'unavailable', tone: 'warn', reason: 'wrong-host' };
  const tone = trackerTone(status);
  switch (status.state) {
    case 'ready': return { ...base, choosable: canChooseTracker(status), stateKey: 'ready', tone, reason: 'ready' };
    case 'signed-out': return { ...base, choosable: false, stateKey: 'signed-out', tone, reason: 'signed-out' };
    case 'incompatible': return { ...base, choosable: false, stateKey: 'incompatible', tone, reason: 'incompatible' };
    case 'not-installed': return { ...base, choosable: false, stateKey: 'not-installed', tone, reason: 'not-installed' };
    case 'unknown': return { ...base, choosable: false, stateKey: 'unknown', tone, reason: 'unknown' };
  }
}

/** The chooser's rows in the order every list uses, for the trackers the server reported. */
export function trackerOptions(statuses: readonly TrackerStatus[], order: readonly TrackerId[], projectHost: CodeHostId | null, enabledOf: (id: TrackerId) => boolean): TrackerOption[] {
  return order.flatMap((id) => {
    const status = statuses.find((s) => s.id === id);
    return status ? [trackerOption(status, projectHost, enabledOf(id))] : [];
  });
}
