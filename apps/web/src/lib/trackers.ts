/**
 * How the web names and reads an issue tracker: the rows of Integrations, the project's tracker
 * form, the import dialog and the chips on an item. Plain data, no React: tested without a
 * browser (test/trackers.test.ts). Issue text itself is untrusted and never passes through here
 * as anything but a string to draw as text.
 */
import type { IssueRef, IssueSyncState, IssueTriageMark, TrackerId, TrackerIssue, TrackerMappedStatus, TrackerSettingsEntry, TrackerStatus, TrackersSettings } from '@agentry/shared';

/** The order every list draws the trackers in: the two that work, then the two that do not yet. */
export const TRACKER_IDS: readonly TrackerId[] = ['github-issues', 'gitlab-issues', 'jira', 'youtrack'];

export interface TrackerWords {
  /** The tracker's own name, a proper noun that is never translated */
  label: string;
  /** `trackers` namespace: what the project's scope is called ("Repository", "Project key") */
  scopeKey: 'scope.repository' | 'scope.project';
}

const WORDS: Readonly<Record<TrackerId, TrackerWords>> = {
  'github-issues': { label: 'GitHub Issues', scopeKey: 'scope.repository' },
  'gitlab-issues': { label: 'GitLab Issues', scopeKey: 'scope.repository' },
  jira: { label: 'Jira', scopeKey: 'scope.project' },
  youtrack: { label: 'YouTrack', scopeKey: 'scope.project' },
};

export const trackerWords = (id: TrackerId): TrackerWords => WORDS[id];

/** GitHub and GitLab number their issues; Jira and YouTrack already write the key. */
export function issueRef(tracker: TrackerId, key: string): string {
  return tracker === 'github-issues' || tracker === 'gitlab-issues' ? `#${key}` : key;
}

/** Only these two have an adapter in this step; the others are shown with their reason and no action. */
export const isTrackerBuilt = (id: TrackerId): boolean => id === 'github-issues' || id === 'gitlab-issues';

export type TrackerTone = 'ok' | 'warn' | 'bad' | 'idle' | 'muted';

/** One word and one colour per readiness, the same meanings as the code hosts' rows. */
export function trackerTone(status: Pick<TrackerStatus, 'state'>, enabled = true): TrackerTone {
  if (!enabled) return 'muted';
  switch (status.state) {
    case 'ready': return 'ok';
    case 'signed-out': return 'warn';
    case 'incompatible': return 'bad';
    case 'not-installed': return 'muted';
    case 'unknown': return 'idle';
  }
}

export type TrackerActionKind = 'sign-in' | 'install' | 'choose-binary' | 'retry';

/**
 * The one thing a person can do about a tracker row. A tracker that is not built, or turned off,
 * offers nothing: nothing is built on a CLI fact nobody has seen. GitHub and GitLab reuse the CLI
 * of their code host, so the remedy is the host's.
 */
export function trackerAction(status: Pick<TrackerStatus, 'id' | 'state'>, enabled = true): TrackerActionKind | null {
  if (!enabled || !isTrackerBuilt(status.id)) return null;
  switch (status.state) {
    case 'ready': return null;
    case 'signed-out': return 'sign-in';
    case 'incompatible': return 'choose-binary';
    case 'not-installed': return 'install';
    case 'unknown': return 'retry';
  }
}

const DEFAULT_ENTRY: TrackerSettingsEntry = { enabled: true, binaryPath: null };

/** A tracker the document does not mention reads as on, with no override, as the server does. */
export const trackerEntry = (settings: TrackersSettings | undefined, id: TrackerId): TrackerSettingsEntry => settings?.trackers[id] ?? DEFAULT_ENTRY;

/** The document with one tracker's entry replaced; the rest are kept as they are. */
export function withTrackerEntry(settings: TrackersSettings, id: TrackerId, entry: TrackerSettingsEntry): TrackersSettings {
  return { trackers: { ...settings.trackers, [id]: entry } };
}

/** A tracker can be chosen for a project when it is built and ready; the form still lists the others, disabled. */
export const canChooseTracker = (status: Pick<TrackerStatus, 'id' | 'state'> | undefined): boolean => !!status && isTrackerBuilt(status.id) && status.state === 'ready';

/** The columns a project can map, in board order. */
export const MAPPED_COLUMNS: readonly TrackerMappedStatus[] = ['in_progress', 'in_review', 'done'];

/**
 * The statuses a column can be mapped to, in the tracker's words. GitHub and GitLab only act on
 * `done`, which closes the issue as completed; the other columns are saved but not written.
 */
export function statusChoices(id: TrackerId, column: TrackerMappedStatus): string[] {
  if (!isTrackerBuilt(id)) return [];
  return column === 'done' ? ['completed'] : [];
}

/** Whether a column's mapping does something on this tracker, so the form can say so beside the others. */
export const columnSyncs = (id: TrackerId, column: TrackerMappedStatus): boolean => statusChoices(id, column).length > 0;

/** The map without a column that was cleared (an empty string reads as not synced). */
export function setMapped(map: Partial<Record<TrackerMappedStatus, string>>, column: TrackerMappedStatus, value: string): Partial<Record<TrackerMappedStatus, string>> {
  const next = { ...map };
  if (value) next[column] = value;
  else delete next[column];
  return next;
}

export type IssueTone = 'ok' | 'warn' | 'bad' | 'idle' | 'muted';

/** The chip's sync mark: failed is bad, synced is ok, and nothing synced yet has no mark. */
export const SYNC_TONE: Record<IssueSyncState, IssueTone | null> = { none: null, synced: 'ok', failed: 'bad' };

export const syncLabelKey = (state: IssueSyncState): `sync.${IssueSyncState}` => `sync.${state}`;

/** Sync again is offered where a write failed; a person asks for it, and it is never retried by itself. */
export const canSyncAgain = (issue: Pick<IssueRef, 'syncState'>): boolean => issue.syncState === 'failed';

/** What a chip says: the key as its tracker writes it. */
export const issueChipText = (issue: Pick<IssueRef, 'tracker' | 'key'>): string => issueRef(issue.tracker, issue.key);

/** An issue is closed in the tracker's own words; both built trackers say `closed`. */
export const isIssueClosed = (state: string): boolean => state.toLowerCase() === 'closed';

/** The triage marks' tones: a mark is advice, so none of them is a status colour of failure. */
export const TRIAGE_TONE: Record<IssueTriageMark, IssueTone> = { ready: 'ok', 'needs-refining': 'warn', 'not-for-agents': 'muted' };

export const triageLabelKey = (mark: IssueTriageMark): `triage.${IssueTriageMark}` => `triage.${mark}`;

/** An issue already imported cannot be picked again; everything else in the page can. */
export const isSelectable = (issue: Pick<TrackerIssue, 'importedItemId'>): boolean => issue.importedItemId === null;

/** The most keys one import takes, as the route says. */
export const IMPORT_LIMIT = 100;

export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The keys to import: the selection in the page's order, those that can still be picked, and no more than the limit. */
export function importKeys(issues: readonly TrackerIssue[], selected: ReadonlySet<string>): string[] {
  return issues.filter((issue) => selected.has(issue.key) && isSelectable(issue)).map((issue) => issue.key).slice(0, IMPORT_LIMIT);
}

/** Select every pickable issue of the page, or clear the selection when all of them are already in it. */
export function toggleAll(issues: readonly TrackerIssue[], selected: ReadonlySet<string>): Set<string> {
  const pickable = issues.filter(isSelectable).map((issue) => issue.key);
  return pickable.every((key) => selected.has(key)) ? new Set() : new Set(pickable);
}
